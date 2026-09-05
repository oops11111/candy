---
description: "一个 Candy 运行时的实时运行状态:一次运行据以被准入的账本与重放存储,以及释放无人结算之占用的那个时钟。"
kind: "package-reference"
---

# @deepseek-ai/dsh-run-scheduler

[English](README.md) | 中文

## 概述

本服务所组合的每一样东西,原本都已经作为库存在。原本不存在的是一个主人。账本与重放存储是按运行时存在的对象,却没有任何东西持有它们;准入策略必须在每一个调用点手工拼装;而 `RunLedger.expire` 是一次没有任何时钟去发起的调用,于是一次未经结算就被遗弃的运行,会一直占着它父运行的额度,直到有人想起来去回收。

`ctx.runScheduler` 持有那份状态,从一份执行断言启动一次运行,驱动那个时钟,并把一棵已结算的树记到它的出资方头上。它是租户的持久额度与其存活运行相遇之处,而这次相遇就是 Candy 租户级界限的全部:单独去读,任何一半都会准入一次它本该拒绝的运行。

它还会计量一次运行发起的那些提供方流,而那正是额度不再只是一个记账数字的地方:在运行已经什么都不剩时,调用在抵达提供方之前就被拒绝;在调用跑过运行尚存的挂钟时间时,它被切断。

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
```

它需要 [`dsh-control-plane-store`](../control-plane-store/README.zh.md) 来读取账户与额度,以及 `timer` 服务来提供时钟。两个秘密都以环境变量名的形式指名,而不是写进组合里:`assertionSecretEnv`(默认 `CANDY_ASSERTION_SECRET`)与 `credentialKeyEnv`(默认 `CANDY_CREDENTIAL_KEY`)。其中任何一个未设置都会让启动失败,而一个不是 32 字节的凭据密钥同样会 —— 保险库正是以那个长度密封的。

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

### 计量一次运行发起的那些调用

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

`meter` 在这次调用的终止块抵达消费方之前,就把它记上账 —— 而且是持久地 —— 因此下一次调用是针对一份已经知道这一次的账本被准入的。一次什么都不剩的运行根本到不了提供方,而一次跑过其运行所剩挂钟时间的调用会被一个终止的 `error` finish 切断。一次切断结束的是这次调用,不是那次运行:记录仍然开着,带着这次调用消耗掉的东西。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`、`RunScheduler` 服务、它的准入策略、结算、恢复,以及计量 |
| — | 不发布运行时不变量伴随模块;这里的关系属于账本与存储,而组合测试端到端地检查它们。 |

### 为什么一个实例拥有一个账本

这个运行时准入的每一次运行,都记在同一批委派树与同一批已消费 nonce 上。两个实例会各自认为自己持有全部额度,而委派上限在哪一个里都不成立 —— 这与 `dsh-run-ledger` 要求父运行与它的子运行共享一个实例,是同一个理由。

### 为什么预算查找是被组合出来的,而不是被转交出去的

子运行是针对它**父运行**的剩余被准入的,那份剩余由本服务的账本持有。一个还剩很多的租户,可以有一个已经耗尽的父运行,因此拿租户自己的额度去回答子运行会让这项检查失效。

根运行则是针对它租户的持久额度、**减去该租户在这里仍然开启中的每一次运行的预留**被准入的。任何一半单独都不是答案:一份没有减去消耗的授予额度,会为该租户曾经启动的每一次运行拨款;而一份没有减去开启中占用的授予额度,会让两棵不相关的树同时各自持有整份额度。这两种生命周期 —— 按部署持久的,与按运行时在内存里的 —— 只在这里相遇。

### 为什么结算先写、后关闭

一次结算是这个介质无法合并成一次的两次写入:为出资方记账,然后忘掉那次运行。先在内存里做、后写,会在写入失败时丢掉那笔账,而那恰恰是它最要紧的时候。因此这笔账用 `RunLedger.settlementOf` 算出来,作为该次运行自己的已结算数字写下,施加到它的出资方身上,之后才忘掉那些记录并释放占用。一次被拒绝的写入让运行在两边都保持开启,而它的租约会把下一次清扫带回来重试。

每一个出资方 —— 根运行对应租户的额度,子运行对应父运行的记录 —— 都在与记账同一次原子写入中,存下它最后吸收的那次结算的 id。重复同一个 id 是空操作,因此重启中的运行时可以在不知道上次走到哪一步的情况下重新驱动一次被打断的结算。这项保证只在没有两次结算彼此交错时成立,而这正是为什么这里每一次对运行记录的写入都排在同一条链上。

### 为什么重启是结算而不是恢复

本运行时写下的记录,就是它当时在驱动的运行,而驱动它的那个进程已经没了。`Service.init` 完成每一次被打断的结算,把剩下的恢复进账本,并关闭每一个被恢复的根 —— 于是租户被按照其运行实际消耗的量计费。改成让它们保持开启,会把额度一直占到各自租约到期;而恢复它们则意味着恢复那些已经不存在的提供方。

恢复只读它自己那个运行时的记录,依据是每条记录上的 audience 戳记。无法构成完整树的记录会让启动失败,而不是被丢弃:对一个并不存在的父运行的占用,是没有任何东西能结算的。

### 为什么一次运行的租户写在它的记录上

`RunRecord` 指名的是一次运行和它的父运行,而不是一个身份,因此一棵树被记到哪个租户头上,改为写在持久记录上。那是它唯一存在的地方,于是结算、恢复与租户剩余额度查询读到的是同一个事实;账本旁边的一张映射会是第二份副本,而重启并不拥有它。

### 为什么时钟是服务该操心的事

`expire` 释放租约已过的占用,而 `evict` 丢掉那些已经无法拒绝任何东西的 nonce 记录。两者都不改变调用方本可以自己做出的决定;两者界定的都是运行时持有多少。持有自己决策时间戳的调用方可以直接调用 `sweep`,测试正是这么做的。

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
- **只有一个凭据密钥** —— 配置只指名一个版本,因此这个密钥环打不开一个用已退役密钥密封的信封。轮换需要密钥环携带的不止当前那一把。
- **一次计费在结算之前不可见** —— `charge` 会立刻把一次运行的花费写进它自己的记录,而租户的消耗只在这棵树的根关闭时才移动。在运行开启期间这是对的,因为它的预留已经被从租户的剩余里扣住了;这意味着租户的消耗比它的实时花费滞后一棵树。
- **每一次写入都是串行的** —— 一条链为运行时内每一次运行记录写入定序,而这正是让那个「恰好一次」标记成为保证的东西。它同时也意味着,一个缓慢的介质会把不相关租户之间的计费也串起来。
- **被拒绝的清扫只记日志,不立刻重试** —— 它未能结算的那些运行会带着已过期的租约保持开启,因此下一次清扫会重试它们。持续不可用的介质会把那些额度一直占到它恢复为止。
- **它不运行提供方** —— 绑定与取消都仍归调用方;`meter` 包裹的是调用方打开的一条流,而本服务不持有任何进程。
- **踪迹是一扇窗,不是一个档案库** —— 每个租户 `auditRetention` 条记录,对于没有指名租户的尝试则按运行时计;更老的记录被丢弃,而不是被送往任何地方。需要保留它们的部署从这里读取并把它们送出去。
- **踪迹覆盖的是调度,不是运行的工作** —— 启动、拒绝,以及一次尝试产出的那些保险库操作。路由、委派、工具授权与终止状态没有被记录,因为还没有任何东西产出那些记录。
- **被计量的调用有界,沉默的调用没有** —— `meter` 在块抵达时检查挂钟时间,因此一个不发出任何东西就卡住的提供方会一直跑过它的截止时刻,直到租约清扫触及它的运行。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景 —— 点击展开</summary>

无。

</details>
