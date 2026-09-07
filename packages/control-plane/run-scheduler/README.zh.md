---
description: "一个 Candy 运行时的实时运行账本、持久准入组合,以及释放无人结算之占用的那个时钟。"
kind: "package-reference"
---

# @deepseek-ai/dsh-run-scheduler

[English](README.md) | 中文

## 概述

本服务所组合的每一样东西,原本都已经作为库存在。原本不存在的是一个主人。账本是按运行时存在的对象,却没有任何东西持有它;准入策略必须在每一个调用点手工拼装;而 `RunLedger.expire` 是一次没有任何时钟去发起的调用,于是一次未经结算就被遗弃的运行,会一直占着它父运行的额度,直到有人想起来去回收。nonce 决定现在位于持久控制平面存储中,而不再是另一个调度器本地对象。

`ctx.runScheduler` 持有那份状态,从一份执行断言启动一次运行,驱动那个时钟,并把一棵已结算的树记到它的出资方头上。它是租户的持久额度与其存活运行相遇之处,而这次相遇就是 Candy 租户级界限的全部:单独去读,任何一半都会准入一次它本该拒绝的运行。

它还会计量一次运行发起的那些提供方流,而那正是额度不再只是一个记账数字的地方:在运行已经什么都不剩时,调用在抵达提供方之前就被拒绝;在调用跑过运行尚存的挂钟时间时,它被切断。它按请求所面向的那个会话找到这些流,因此一个跑在某次运行的会话上的 agent 会被计量,而无需任何人把 run id 穿进模型请求。

它的记录是持久的,而且每一次结算跨越崩溃都恰好发生一次;它做出的每一次调度尝试都会留下一条记录 —— 一次启动、一次拒绝及它所拒绝的租户,以及每次尝试产出的那些保险库操作。排队的请求以什么顺序运行,这个决定这里仍然不做。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 组合它

```yaml
- id: run-scheduler
  name: '@deepseek-ai/dsh-run-scheduler'
  config:
    issuer: candy-control-plane
    audience: candy-runtime-debian-1
    credentialKeyVersion: 2026-09-a
    poolBase: /srv/candy/pools
    auditRetention: 200
    endedSessionMemory: 1000
```

它需要 [`dsh-control-plane-store`](../control-plane-store/README.zh.md) 来读取账户与额度,以及 `timer` 服务来提供时钟。两个秘密都以环境变量名的形式指名,而不是写进组合里:`assertionSecretEnv`(默认 `CANDY_ASSERTION_SECRET`)与 `credentialKeyEnv`(默认 `CANDY_CREDENTIAL_KEY`)。其中任何一个未设置都会让启动失败,而一个不是 32 字节的凭据密钥同样会 —— 保险库正是以那个长度密封的。

### 轮换凭据密钥

每个被密封的信封都指名它是用哪个版本密封的,因此改动 `credentialKeyVersion` 及其背后的密钥,会让这个运行时打不开在此之前密封的任何东西:在旧值被放回来之前,每个租户的每一次运行都会被以 `unknown-key` 拒绝。`retiredCredentialKeys` 正是让一次轮换成为迁移而不是故障的东西——旧版本保持可打开,而新版本负责密封:

```yml
    credentialKeyVersion: 2026-09-b
    retiredCredentialKeys:
      - version: 2026-09-a
        env: CANDY_CREDENTIAL_KEY_PREVIOUS
```

一个同时也是当前版本的退役版本,或者被退役两次的版本,会让启动失败。两者都会悄悄决定一个版本意味着哪把密钥,而错误的答案是某个租户的凭据用错误的密钥打开、或者根本打不开。一个变量未设置的条目会让启动失败,理由与每个秘密都相同。

让一把密钥退役并不等于完成轮换。信封由推动那一轮的人用当前密钥重新封装,只有在那之后,退役条目才能被移除。

### 启动一次运行

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const token: string

const outcome = await ctx.runScheduler.start(token)

export const started = outcome.started ? outcome.value.run.poolRoot : outcome.rejection.stage
```

`start` 接收那份断言,以及可选的、这次运行据以开启的额度。根运行默认用准入为它给出的那一份;子运行则用它父运行所委派的份额开启,而账本会拒绝超出该父运行所持有量的份额。

返回的东西不在运行。把提供方绑定到它上面仍归调用方 —— `charge` 与 `close` 在本服务上,而这次运行的记录在 `close` 之前一直开着。

### 为一个被委派的会话铸造一次子运行

`start` 需要一份由认证了这次请求的东西铸造出来的断言。而一个从某次已开启运行那里委派出来的会话——比如一个子代理——不需要任何新的认证:它的身份恰好就是它父运行的身份,早已在父运行自己开启时被验证过。`startChildRun` 就是把这种情况直接处理掉,不需要任何外部的签发权威:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const parentSessionId: SessionId
declare const childSessionId: SessionId
declare const share: (run: { budget: RunBudget }) => RunBudget

const result = await ctx.runScheduler.startChildRun(parentSessionId, childSessionId, share)

export const started = result.ok ? result.outcome.started : false
```

它解析出父会话开启中的运行,复制它的租户、账户、provider、设备、workspace 授权与对话,铸造一份指名子会话、并把父运行当作 `parentRunId` 的全新断言,再把它推过本节前面已经记录过的同一个 `start`——因此一次铸造出来的子运行,会像一份调用方自带的断言一样被资助、记账、审计,包括 `dsh-run-budget` 早已为任何指名了 `parentRunId` 的断言强制执行的、父级子集式的预算。铸造出来的 token 从不被传输或持久化;它存在的唯一目的就是推动这一次调用。`share` 没有默认值:一个被委派的子运行应该拿到父运行剩余预算的多少,是一个策略选择,本服务没有依据去猜测,因此每次都由调用方陈述。

`result.ok` 只在父会话本身没能解析出唯一一个开启中、可用的运行时才是 `false`——这与 `runIdentityFor` 和 `tenantOf` 所拒绝的是同一种歧义。一旦铸造得以进行,子运行自己的准入决定——启动,或者一个被指名的拒绝——就会原样携带在 `result.outcome` 里,与 `start` 自己会报告的完全一致。

### 读出一个租户的尝试做了什么

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { UserId } from '@deepseek-ai/dsh-control-plane'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const userId: UserId

export const recent = ctx.runScheduler.auditsOfTenant(userId)
export const unattributed = ctx.runScheduler.auditsOfRuntime()
```

断言之后的每一个步骤都基于已验证的声明,因此它的记录会指名它所拒绝的租户、账户与运行。一份验证不通过的断言指名不出任何这个运行时可以相信的租户,因此那条记录去到 `auditsOfRuntime`,而不是进入某个租户的踪迹 —— 它是准入所能观察到的最清晰的攻击信号,而另一个选择是把它丢掉。两条踪迹都由 `auditRetention` 设上限。

被拒绝的*调用*以同样方式归档,记在 `event: 'refused'` 与 `action: 'meter'` 之下,并以失败码作为其结果。

关于某次运行的每一条记录,在该运行是从另一次运行委派而来时都带上 `parentRunId`。承载这一血缘的持久运行记录会在结算时被删除,因此没有它,一个委派型 agent 的运行树读回来就是同一租户下几次恰好重叠的、彼此无关的运行。

一次已结算的运行归档在 `event: 'settled'` 与 `action: 'settle'` 之下,以它如何结束作为其结果:`closed` 表示调用方结束了自己正在驱动的运行,`expired` 表示租约在其背后已无存活会话时失效,`revoked` 表示账户不再能为该工作授权,`recovered` 表示本运行时在启动时发现的、来自一个已消失进程的开着的运行。这是一次已结束的运行留下的唯一痕迹——它的持久记录已被删除——也是把一次仍在工作的运行与一次几分钟前被某个原因结束的运行区分开来的东西。只有结算所针对的那一次运行会被记录:随其祖先一同关闭的后代,可以从它自己那条指名了该祖先的 `started` 记录到达。

在一次被计量的调用期间启动的进程同样会被归档,记在 `event: 'launched'` 之下,以可执行文件作为其 action。`dsh-subprocess` 会为它启动的每一个受管子进程自报,而它对租户一无所知;补上其余部分的,是本服务在每次拉取被计量流时进入的一个运行作用域。提供方进程是在适配器深处被启动的,没有会话,也没有属于自己的运行可指名——它是在哪次调用期间被启动的,是唯一把它连回某次运行的东西。

作用域是围绕每一次拉取进入的,而不是围绕整条流。异步生成器的函数体是在其消费方索要块时才运行的,运行在消费方的上下文里,而不是生成器被创建时的那个上下文;因此一个包在创建处的作用域触及不到函数体的任何部分,也就归属不了任何东西。

发生在任何被计量调用之外的启动——harness 自己的 bash、pwsh 与语言服务器子进程——会被放过。它不属于任何租户,而把它归档进去,会把某个租户自己的记录挤出一条按主体有界的踪迹。准入永远看不到这些:一次运行只打开一次凭据,随后就一直发起调用,因此一个被吊销却仍在花费的账户、一个已用尽额度的运行,以及一个没有任何开着的运行认领的会话,都只在这里可见。记录在调用方被告知之前就已持久,因此读取踪迹的运维人员不会落后于一个已经据此行动的消费者。一次其会话指名不出任何本运行时仍持有的运行的拒绝,会被归档到运行时名下,理由与无法验证的断言相同:没有可以相信的租户。

### 同步解析一个会话的租户

harness 里别处的某个调用方,有时需要在不打开凭据的情况下知道一个会话属于哪个租户——比如一个同步的策略钩子就无法 await 任何东西。`tenantOf` 只从计量本就在读的那份内存运行索引里作答,不多不少:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const sessionId: SessionId

// The session's tenant, or undefined when this runtime has no single open,
// usable run for it — the same ambiguity `runIdentityFor` refuses.
export const userId = ctx.runScheduler.tenantOf(sessionId)
```

[`dsh-tenant-preset-policy`](../tenant-preset-policy/README.zh.md) 是第一个消费方:它用这个方法解析一个会话的租户,在一个同步的 `AgentPresets` 守卫里判断某个预设 id 是否在该租户的白名单上。

### 计量一次运行发起的那些调用

无需任何人开口。harness 组装的每一个模型请求都携带它所面向的那个会话,而执行断言又指名了它那次运行所驱动的会话 —— 因此,一个其会话属于本运行时某次开启中运行的请求,会自动被记到那次运行头上:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const request: GenerateOptions

// Charged to the run whose claims named `request.sessionId`, if there is one.
export const stream = ctx.llm.stream(request)
```

一个不指名会话的请求,或者一个指名了本运行时从未为之开过运行的会话的请求,会原样通过 —— 它不归本运行时计费。而一个其运行在这里**结束过**的会话则会被拒绝:一次运行可能在一个仍在工作的 agent 之下结束 —— 它的账户被吊销、它周围的树被关闭、它的根被一次重启关闭 —— 而那时运行记录已经没了,于是若不记住这次结束,它的下一次调用看起来就像一次本运行时从未有过的调用,从而免费跑掉。

这份映射在它被制造出来的地方就被保持为无歧义:一次其会话已被另一次运行驱动的运行会在 `start` 就被拒绝,而且是在它的 nonce 被消费之前,因此在那个会话结算之后它可以被重试。一个其会话仍被两条记录同时认领的请求会被拒绝,并给出一个终止的 `error` finish —— 那种状态只可能来自 `start` 之外,而给其中任何一棵树记账都是调用方无法察觉的错账。

运行的账户在每次调用时都会被重新读取,而不是从准入那里沿用。一次运行只在一开始打开它的凭据,并在其存活期间一直持有,因此吊销账户会销毁存储的信封,却触及不到一个已经用它完成认证的进程。按次调用读取记录,正是让吊销停下已经在进行中的工作的原因:调用在触及提供方之前就被以 `CREDENTIAL_REVOKED` 拒绝,并且不计任何费用。

随后由清扫来结束这次运行本身。只拒绝它的调用,会让它一直开着——占着出资方的额度,而它已经花掉的部分未被记账——直到几分钟后租约耗尽。清扫正是这个运行时结束那些它认为该结束的运行的地方,因此一次其账户已无法为它授权的运行也在那里结束,依据与 `meterRequest` 所做的判断相同。而一次存储无法为其作答的运行,则会被留给它的租约:基于一次什么都没返回的读取去结束运行,是更大的错误。

### 按一次运行所驱动的会话来关闭它

`closeSessionRun(sessionId)` 会结算驱动某个会话的那一次开启中的运行，供一个只知道会话、而不知道运行的调用方使用——比如一个受委派的子会话：为它开启运行的那一方是按会话指名它的，而它的结算指名的也是同一个会话。对于本运行时没有唯一一次开启中运行的会话，它回答 `undefined` 而不是失败，与 `tenantOf` 对同一个会话什么也不回答完全一致。

如果不关闭而是等待租约，就会在工作已经结束之后，仍然把出资方的额度与它的一个并发名额占上好几分钟，于是一个按顺序委派的父会话会耗尽那些已经没有任何东西在使用的名额。

### 为什么一份到期的租约不会结束一次仍在工作的运行

租约回答的是一个问题:持有这次运行的运行时是否已经消失。一个仍然持有该运行所属会话的运行时,就是在直接回答这个问题,因此清扫会续期这次运行的租约——在账本里,也在持久记录上——而不是释放它的占用。若没有这一点,每一次运行都会在开启 `leaseMs` 之后结束,无论它的 agent 当时工作得多努力,而那个会话在其余下的整个生命期里都会被拒绝。

存活不等于活动。一个在两轮之间停驻的会话——等待一个工具、一次审批,或者一个人——依然归本运行时出资,只有在会话本身消失时才会失去它的运行。一个没有组装会话存储的组合会把每一次运行都留给它的租约,与这条规则存在之前完全一样;而一个被吊销的账户依然会结束它的运行,无论其会话多么存活:这条规则判定的是遗弃,从来不是授权。

### 手工计量一条流

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RunId } from '@deepseek-ai/dsh-control-plane'
import type { LlmAdapter, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const runId: RunId
declare const adapter: LlmAdapter
declare const request: GenerateOptions

export const stream = ctx.runScheduler.meter(runId, adapter.stream(request))
```

同时持有运行与流的调用方可以跳过那次查找。`meter` 在这次调用的终止块抵达消费方之前,就把它记上账 —— 而且是持久地 —— 因此下一次调用是针对一份已经知道这一次的账本被准入的。一次什么都不剩的运行根本到不了提供方,而一次跑过其运行所剩挂钟时间的调用会被一个终止的 `error` finish 切断。一次切断结束的是这次调用,不是那次运行:记录仍然开着,带着这次调用消耗掉的东西。

### 一次运行因故结算时,处置它的进程

结算是记账:它写下一笔费用,然后忘掉这条记录。一次因故结束的运行——账户被吊销、租约到期、所在的树被围着它一起关闭——这个决定发生在清扫内部、本服务的深处,而它触及不到该运行自己那次调用仍在运行的进程。`registerDisposer` 就是持有该资源的调用方所拥有的这份触及能力:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RunId } from '@deepseek-ai/dsh-control-plane'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const runId: RunId
declare const subprocess: SubprocessRuntime

// Every process this spawns for `runId` is terminated the moment the run
// settles, however it settles, and left alone once it exits on its own.
export const spawn = ctx.runScheduler.disposableSpawn(runId, (spec: SubprocessSpawnSpec) => subprocess.spawn(spec))
```

围绕某个提供方绑定交给其适配器的 `spawn` 函数组合出 `disposableSpawn`,就是全部的接线工作:直接持有原始句柄的调用方则改为直接调用 `registerDisposer(runId, () => handle.terminate())`,并在该句柄自己的 `done` 落定后取消注册。除非调用方主动去调,否则两者都不会被触发——本服务依旧不运行任何提供方,而一处既不 `registerDisposer` 也不 `disposableSpawn` 就直接生成进程的组装,会让一次已结算运行的进程一如既往地继续跑着。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`、`RunScheduler` 服务、它的准入策略、结算、恢复、计量,以及处置器注册表 |
| — | 不发布运行时不变量伴随模块;这里的关系属于账本与存储,而组合测试端到端地检查它们。 |

### 为什么一个实例拥有一个账本

这个运行时准入的每一次运行,都记在同一批委派树上。两个实例会各自认为自己持有全部额度,而委派上限在哪一个里都不成立 —— 这与 `dsh-run-ledger` 要求父运行与它的子运行共享一个实例,是同一个理由。已消费 nonce 不同:它们位于持久控制平面存储中,由多个进程共享。

### 为什么预算查找是被组合出来的,而不是被转交出去的

子运行是针对它**父运行**的剩余被准入的,那份剩余由本服务的账本持有。一个还剩很多的租户,可以有一个已经耗尽的父运行,因此拿租户自己的额度去回答子运行会让这项检查失效。

根运行则是针对它租户的持久额度、**减去该租户在这里仍然开启中的每一次运行的预留**被准入的。任何一半单独都不是答案:一份没有减去消耗的授予额度,会为该租户曾经启动的每一次运行拨款;而一份没有减去开启中占用的授予额度,会让两棵不相关的树同时各自持有整份额度。这两种生命周期 —— 按部署持久的,与按运行时在内存里的 —— 只在这里相遇。

### 为什么启动也跑在这条链上

一次启动所做的每一项检查，读的都是这次启动后面某一步会改变的状态：租户的剩余额度、父运行的额度、会话的持有者。在临界区之外读取时，同一个租户的两次并发启动都会看到整份剩余额度并都据此开启，于是这个租户最终持有它授予额度的两倍 —— 在这一条成立之前，这是针对一个已启动运行时量出来的。

因此这条链排的是整个操作，而不是写入。一个决定所依据的状态，在那个决定被施加之前不会改变，而这正是让租户剩余额度、一会话一运行规则与父集规则成为界限、而不是概率的东西。

### 为什么结算先写、后关闭

一次结算是这个介质无法合并成一次的两次写入:为出资方记账,然后忘掉那次运行。先在内存里做、后写,会在写入失败时丢掉那笔账,而那恰恰是它最要紧的时候。因此这笔账用 `RunLedger.settlementOf` 算出来,作为该次运行自己的已结算数字写下,施加到它的出资方身上,之后才忘掉那些记录并释放占用。一次被拒绝的写入让运行在两边都保持开启,而它的租约会把下一次清扫带回来重试。

每一个出资方 —— 根运行对应租户的额度,子运行对应父运行的记录 —— 都在与记账同一次原子写入中,存下它最后吸收的那次结算的 id。重复同一个 id 是空操作,因此重启中的运行时可以在不知道上次走到哪一步的情况下重新驱动一次被打断的结算。这项保证只在没有两次结算彼此交错时成立,而这正是为什么这里每一次对运行记录的写入都排在同一条链上。

### 为什么处置发生在结算写入之前

调用方在为某次运行启动进程时注册一次处置器即可;不需要按调用重复注册,而一次运行的第二次连续调用会覆盖第一次的处置器而不是叠加——第一次的进程届时早已退出,只有那个仍活着的进程才需要被释放。`settle` 会在写下这笔账或忘掉这条记录之前,先对该运行以及 `RunLedger.settlementOf` 一并关闭的每一个后代调用其已注册的处置器:一个即将被这次结算停止计费的进程,应当在这个决定做出的那一刻就停下,而不是等到随后的持久写入成功之后。一个抛出异常的处置器会被记录并吞掉,因为它自身的失败不构成让这次运行的账目卡在打开状态的理由——它本可能阻塞的那次结算此刻已经被决定了。

### 为什么重启是结算而不是恢复

本运行时写下的记录,就是它当时在驱动的运行,而驱动它的那个进程已经没了。`Service.init` 完成每一次被打断的结算,把剩下的恢复进账本,并关闭每一个被恢复的根 —— 于是租户被按照其运行实际消耗的量计费。改成让它们保持开启,会把额度一直占到各自租约到期;而恢复它们则意味着恢复那些已经不存在的提供方。

恢复只读它自己那个运行时的记录,依据是每条记录上的 audience 戳记。

一条指名了存储并不持有的父运行的记录是损坏——一次部分写入,或者一次带走了父运行却留下子运行的删除。它会被收养为一个根:它的父运行在存储里被清空,然后它像任何别的根一样被结算。改为在它面前拒绝启动,会因为一条被损坏的记录而让这个运行时上的每个租户都停摆,其影响面远大于损坏本身。收养不损失任何账目,因为恢复本来就会结算它所恢复的每一个根;这次运行无论如何都会在片刻之后被结算,唯一悬而未决的问题是"它花掉的东西记在谁头上"。而记录指名了它的租户,那也正是它父运行自己的结算本会把这笔账带到的地方。

父运行是在存储里被清空的,而不只是在被恢复的账本里,因为随后的结算会把记录读回来:一条仍然指名着那个缺失父运行的记录,会把账记到那个父运行头上,也就是记到没有人头上。

### 为什么会话就是那个接合点

模型请求不携带任何 Candy 概念,也不该携带:`dsh-llm` 是继承来的缝隙,而往 `GenerateOptions` 里加一个 `runId`,会让一个消费方去支配所有消费方共享的一份服务契约。请求本来就携带的是 `sessionId`,由循环打上;而执行断言本来就指名了它那次运行所驱动的会话。两者相遇,而任何一方都不必知道对方 —— 这与 [`dsh-session-checkpoint-policy`](../../session/session-checkpoint-policy/README.zh.md) 为它自己的那些流所做的选择是同一种。

这留下了一种这份映射回答不了的情形:一个被两次开启中运行同时认领的会话。它意味着控制平面为一个会话铸出了两次运行,于是这次调用被拒绝,而不是记到先被找到的那一棵树上,因为一个被错记账的租户不会被任何人察觉。

### 为什么一次运行的租户写在它的记录上

`RunRecord` 指名的是一次运行和它的父运行,而不是一个身份,因此一棵树被记到哪个租户头上,改为写在持久记录上。那是它唯一存在的地方,于是结算、恢复与租户剩余额度查询读到的是同一个事实;账本旁边的一张映射会是第二份副本,而重启并不拥有它。

### 为什么时钟是服务该操心的事

`expire` 释放租约已过的占用,而存储的 nonce 清理会丢掉那些已经无法拒绝任何东西的记录。两者都不改变调用方本可以自己做出的决定;它们共同界定实时账本状态与持久重放状态的规模。持有自己决策时间戳的调用方可以直接调用 `sweep`,测试正是这么做的。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Candy 控制平面](../../../docs/subsystems/candy-control-plane.zh.md) —— 本服务所执行的组合顺序。
- [`dsh-run-start`](../run-start/README.zh.md) —— 准入、开启与放置,以及它们之间的回滚。
- [`dsh-run-ledger`](../run-ledger/README.zh.md) —— 本服务开启、计费、关闭并令其到期的那条记录。
- [`dsh-control-plane-store`](../control-plane-store/README.zh.md) —— 它所读取的持久账户、额度与运行记录。
- [`dsh-run-metering`](../run-metering/README.zh.md) —— `meter` 绑定到本运行时账本上的那个流包装器。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是本包当前的约束,不是任务积压。

- **没有队列** —— 它启动调用方要求的那次运行,或者拒绝它。被拒的运行是否等待、排队的请求以什么顺序运行,这些决定目前还没有任何东西做出;而一个租户同时能有多少个存活,现在由它授予额度的 `children` 回答。
- **重启会结束每一次运行** —— 恢复结算它找到的东西,而不是恢复它,因为提供方进程随运行时一同死去。在负载下重启一个运行时的部署,会结束它的存活运行,并按它们已经花掉的量为其租户计费。
- **没有东西做重新封装** —— 一把退役密钥要一直保留到每个信封都用当前密钥重新封装过为止,而推动这一轮是运维人员的事;本包只打开信封,不迁移它们,因此一把永远退役不掉的密钥就是一把从未真正退役的密钥。
- **一次计费在结算之前不可见** —— `charge` 会立刻把一次运行的花费写进它自己的记录,而租户的消耗只在这棵树的根关闭时才移动。在运行开启期间这是对的,因为它的预留已经被从租户的剩余里扣住了;这意味着租户的消耗比它的实时花费滞后一棵树。
- **一次运行的多次调用同样是串行的** —— `meter` 把一次运行的多次调用排成一列,于是每一次读到的剩余额度,都是它前面那一次已被记账之后的。两个租户永不彼此等待,但一次运行无法同时发起两次调用,无论第一次要花多久。
- **每一个操作都是串行的** —— 一条链为运行时内每一次启动、计费与结算定序,而这正是让「恰好一次」标记与额度检查成为保证的东西。它同时也意味着,一个租户的启动要排在另一个租户的启动之后,包括每次启动所创建的那个池目录。
- **被拒绝的清扫只记日志,不立刻重试** —— 它未能结算的那些运行会带着已过期的租约保持开启,因此下一次清扫会重试它们。持续不可用的介质会把那些额度一直占到它恢复为止。
- **它不运行提供方** —— 绑定与取消都仍归调用方;`meter` 包裹的是调用方打开的一条流,本服务自己不持有任何进程。`registerDisposer` 与 `disposableSpawn` 让调用方把自己持有的一个进程系到某次运行的结算上,但除非组装去调用它们,否则两者都不会自己触发。
- **踪迹是一扇窗,不是一个档案库** —— 每个租户 `auditRetention` 条记录,对于没有指名租户的尝试则按运行时计;更老的记录被丢弃,而不是被送往任何地方。需要保留它们的部署从这里读取并把它们送出去。
- **结束会话的缓存有上限，归属记录持久保存** —— `endedSessionMemory` 限制缓存大小。控制平面存储在结算后仍保留会话归属，因此缓存淘汰和重启都不会允许受管会话在没有有效运行时发起调用。排队中的流若在轮到它之前被关闭，就不会启动其提供方数据源。
- **一个会话,一次运行** —— 一次指名了本运行时已经开启的会话的第二次运行会被拒绝。一个为父运行与其子运行铸出同一个会话的控制平面会看到子运行被拒,这让「一次运行一个会话」成为对控制平面的一项要求,而不是一种惯例。
- **计量跟随会话,而不是进程** —— 一个为某次运行的会话组装的请求,无论在哪里发出都会被计量;而在那个会话之外发出的请求根本不会被计量,即便是同一次运行引起的。一个不带自己会话就为租户干活的部署不会被计量。
- **踪迹覆盖的是调度,不是运行的工作** —— 启动、拒绝,以及一次尝试产出的那些保险库操作。路由、委派、工具授权与终止状态没有被记录,因为还没有任何东西产出那些记录。
- **被切断的调用不会自行收割提供方** —— `meter` 会按运行的挂钟时间结束这条流,包括对一个陷入沉默的提供方,但关闭该提供方的进程仍是启动它的那一方要去安排的事:为该运行注册一个处置器就是那个办法,而没有什么会自动去做。
- **处置是按运行、按调用的自愿选择** —— 从不调用 `registerDisposer` 或 `disposableSpawn` 的调用方什么都得不到;调用了的一方也必须为该运行的每一次连续调用重新注册,因为只有那次仍活着的调用的进程值得被释放。目前没有任何提供方绑定接上这条线——会去接的组装正是尚未建成的 R3 编排接合点。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景 —— 点击展开</summary>

无。

</details>
