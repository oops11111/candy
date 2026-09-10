---
description: "Candy 从执行断言到已准入运行的调度路径:断言、nonce、凭据与运行时池在一次调用中完成解析。"
kind: "package-library"
---

# @deepseek-ai/dsh-run-admission

[English](README.md) | 中文

## 概述

`dsh-run-admission` 是 Candy 调度器在开始工作之前所做的那一次调用。`admitRun` 校验执行断言、消费其 nonce、打开断言所命名的提供方凭据,并解析该凭据可以运行于其中的运行时池——返回提供方调用所需的一切,或者拒绝它的那一步。它的存在,是为了让这些检查的顺序成为一项约定,而不是每条调度路径各自记住的事情;也是为了让身份从已校验的令牌流向凭据与目录,中间没有任何可供调用方替换的参数。`RunRequest` 只携带一个令牌,别无其他。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 准入一次运行

```ts
import { admitRun, type RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'

declare const policy: RunAdmissionPolicy
declare const token: string

const admission = await admitRun({ token }, policy, Date.now())

export const outcome = admission.admitted
  ? { pool: admission.run.poolRoot, claims: admission.run.claims }
  : admission.rejection
```

被准入的运行携带已校验的声明、已打开的凭据、池键、池的目录、它可以花费的额度,以及它所持有的工作区授权。拒绝会指明产生它的阶段——`assertion`、`lineage`、`device`、`workspace`、`budget`、`session`、`replay` 或 `credential`——因此运维人员可以区分伪造令牌与已吊销账户,而调用方不会因此得到任何可用于重试的信息。`assertion` 之后的每一个阶段还会携带已校验的声明,因此调用方能说出被拒绝的是哪个租户、哪个账户、哪一次运行;被重放的 nonce 是本调用最清晰的攻击信号,而一个不带租户的重放报告记下的是「发生了某件事」,而不是发生了什么。`assertion` 阶段不携带任何身份,因为它在任何声明被校验之前就拒绝了该令牌,而未经校验的载荷正是本控制平面拒绝复述的、由调用方提供的身份。两种结果都携带 `audits`:没有任何路径会丢弃保险库产生的记录。

### 提供 policy

`RunAdmissionPolicy` 持有本运行时的期望、断言密钥、保险库密钥环、池基准目录,以及六个由部署方满足的端口:

```ts
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import { RunReplayStore } from '@deepseek-ai/dsh-run-replay'

declare const partial: Omit<
  RunAdmissionPolicy,
  'findBudget' | 'findParentIdentity' | 'findDevice' | 'findWorkspaceGrant' | 'findSessionRun' | 'spendNonce' | 'findCredential'
>
declare const store: {
  budgetFor: (userId: string) => Promise<undefined>
  parentRemaining: (parentRunId: string) => Promise<undefined>
  envelopeFor: (userId: string, accountId: string) => Promise<undefined>
  runDriving: (sessionId: string) => Promise<undefined>
  runIdentity: (runId: string) => Promise<undefined>
  deviceFor: (deviceId: string) => Promise<undefined>
  grantFor: (grantId: string) => Promise<undefined>
}

const replay = new RunReplayStore()

export const policy: RunAdmissionPolicy = {
  ...partial,
  findBudget: claims => claims.parentRunId === undefined
    ? store.budgetFor(claims.userId)
    : store.parentRemaining(claims.parentRunId),
  findParentIdentity: parentRunId => store.runIdentity(parentRunId),
  findDevice: deviceId => store.deviceFor(deviceId),
  findWorkspaceGrant: grantId => store.grantFor(grantId),
  findSessionRun: claims => store.runDriving(claims.sessionId),
  spendNonce: claims => Promise.resolve(replay.spend(claims, Date.now())),
  findCredential: claims => store.envelopeFor(claims.userId, claims.accountId),
}
```

`spendNonce` 只在首次见到某个 nonce 时返回 true,而本调用从不重试一个被报告为已消费的 nonce,因此那个端口就是重放防护的全部。[`dsh-run-replay`](../run-replay/README.zh.md) 为单个进程满足它;运行多于一个运行时进程的部署,需要一个仍然守住同样三项义务的持久化存储 —— 一个不可分割的决定、由断言界定的保留期,以及一条既以租户也以 nonce 为键的记录。

`findBudget` 返回 `undefined` 表示拒绝该运行:存储不认识的租户并不等于额度无限的租户,而意在「不计量」的部署应当用一个显式的大额度来表达。它与 `findCredential` 在本仓库中都没有实现,这正是它们都仍作为参数的原因:在部署方回答了世系、设备、工作区授权、额度、会话、重放与凭据查找之前,运行无法开始。

`findParentIdentity` 报告父运行是为哪个租户、哪个账户、哪一份工作区授权被准入的,而且只在一次运行确有父运行时才被询问。一个指名了另一个租户或另一个账户的子运行会被拒绝:父运行各自只持有一个,而一对之中任何一个都不是另一个的子集。它所报告的授权,也是子代唯一可以指名的那一份。

`findDevice` 把断言携带的设备 id 变成一条记录。返回 `undefined` 表示拒绝该运行:存储不持有的设备从未被配对过。

`findWorkspaceGrant` 把断言携带的授权 id 变成一条记录。返回 `undefined` 表示拒绝该运行:存储不持有的授权并不等于没有边界的权限。

`findSessionRun` 返回已经在驱动这些声明所指名会话的那次运行,会话空闲时返回 `undefined`。模型请求携带的是它所面向的那个会话,而不携带任何别的能标识运行的东西,因此同一个会话上的两次运行就是没有人能归属的花费;在这里拒绝第二次运行,把冲突止在它被制造出来的地方。

`findBudget` 回答的是这次运行将据以启动的那份额度，而这对每一种运行并不是同一次查询。子运行 —— claims 携带 `parentRunId` 的那种 —— 据以启动的是它**父运行**的剩余额度，从 [`dsh-run-ledger`](../run-ledger/README.zh.md) 里读出。给子运行回答租户预算会让这项检查失去意义：一个额度充裕的租户完全可能有一个已耗尽的父运行，而子运行要到自己的份额被预留时才会被拒绝 —— 那已经是在它的一次性 nonce 被消费、凭据被打开之后一步了。

这项检查问的是「这次运行还有没有东西可花」，而不是承诺某个具体的子运行请求装得下。只剩一个 token 的父运行仍会让一个子运行通过准入，而 `RunLedger.openChild` 随后会拒绝它 —— 这是在额度的大小尚未可知之前就检查它所留下的残余。

额度与会话都在消费 nonce 之前读取。两者都是调用方能够修复并重试的拒绝 —— 充值,或者等那个会话的运行结算完 —— 之后再出示同一个仍然有效的断言,因此为其中任何一个烧掉一次性令牌,都会把一次可恢复的拒绝变成一次回到控制面的往返。nonce 仍然在凭据之前被消费,因为它会把并发的重复请求串行化,使同一个令牌的两份副本不可能都抵达密钥。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `RunRequest`、`RunAdmissionPolicy`、`AdmittedRun`、`RunRejection` 与 `admitRun` |
| — | 未发布运行时不变式伴生模块;本模块不拥有事件流或可变运行时数据;其准入顺序由单元测试强制保证。 |

### 顺序就是约定

断言最先被校验,因此下游永远不会看到未经认证的声明——本运行时不接受的令牌,会在任何一个端口被调用之前就被拒绝。接下来检查子运行的世系,因为一个并非其父运行子集的子运行,不该去查询一份它无权动用的额度;它的设备与工作区授权在旁边一并解析 —— 那是一次运行靠指名而非靠证明所主张的另外两项权限,设备在前,因为授权正是为它书写的。额度第四个、会话第五个被读取:两者都是调用方能够修复并重试的拒绝,因此都绝不能烧掉 nonce,而且都不触碰任何密钥。nonce 第六个被消费,把并发的重复请求串行化,使同一个令牌的两份副本不可能都抵达凭据。凭据第七个被打开,使用声明所携带的绑定。池最后被解析,因为它不需要任何密钥。

### 为什么子运行不得指名另一个租户或账户

`dsh-run-ledger` 从父运行的记录里为子运行拨款,并把它的花费结算回去;而 `dsh-credential-vault` 打开声明所指名的那份凭据。两者都不知道对方的主体。于是一个属于某租户、挂在另一个租户父运行之下的子运行,会跑在子运行自己的凭据上,而它的花费结算进父运行那棵树:父运行的租户为它从未授权的工作买单,而子运行的租户一分钱也没被记。在这项检查存在之前,一次已启动的运行时证实的正是这一点。

这条规则就是边界页所陈述的那一条 —— 子运行继承其父运行授权的一个子集,且不得扩大其中任何一项。租户与账户是可裁定的,因为父运行各自只持有一个;而工作区授权出于同样的理由也是可裁定的,经由 `findWorkspaceGrant`。

### 为什么一次运行的设备在这里解析

一份断言携带一个 `DeviceId`,而在这个阶段存在之前没有任何东西解析它。一次运行想指名哪台设备就指名哪台,而工作区授权自身的设备检查,比较的是这项主张与授权上的设备——两个未经验证的字符串彼此吻合。`findDevice` 把这个 id 变成一条记录,而 [`dsh-device-registry`](../device-registry/README.zh.md) 裁定这次运行是否可以以它的身份行事,拒绝解析不到任何东西的 id、已被撤销的绑定,以及属于另一个租户的设备。

这也是撤销得以立即生效的原因。断言在其整个有效期内都保持有效,因此如果没有记录,撤销了某台主机的租户仍会看到它的运行被服务到那个有效期走完为止。记录才是权威,令牌只是指名它,于是下一次运行就被拦住。

这次拒绝位于 nonce 之前,理由与授权的拒绝相同:重新配对的主机出示的是同一份仍然有效的断言,而烧掉的 nonce 会把一次可恢复的拒绝变成永久的。

### 为什么一次运行的工作区授权在这里解析

一份断言携带一个 `WorkspaceGrantId`,除此之外关于文件系统什么都不带,因此在这个 id 解析到一条记录之前,它是一项没有任何东西检查过的主张:一次运行想指名哪份授权就指名哪份。`findWorkspaceGrant` 把它变成一条记录,而 [`dsh-workspace-grant`](../workspace-grant/README.zh.md) 裁定这次运行是否可以持有它 —— 拒绝解析不到任何东西的 id、已被吊销的授权、属于另一个租户或另一台设备的授权,以及指名了其父代之外任何一份授权的子代。

这一步不做的,是裁定某条路径是否落在该授权的根目录之下。那些根目录是为签发它们的设备拼写的,而拿路径去对它们求解,是那台设备的文件系统语义;另一台主机上的控制面靠比较字符串,只会是在近似一个它看不见的边界。根目录随被准入的运行一起传递,好让拥有它们的那台设备在文件操作发生的地方去执行它们。

### 为什么一个会话只能被一次运行驱动

模型请求携带的是它所面向的那个会话,而不携带任何别的能标识运行的东西,因此同一个会话上的两次运行就是没有人能归属的花费。`findSessionRun` 把第二次运行拒绝在冲突被制造出来的地方。把它留给之后读取这份映射的东西,意味着两次运行都会开启并占住各自的额度,而那个会话里的每一次模型调用都会被一次次地拒绝 —— 而一个被铸到另一个租户会话上的租户,会拦住那个租户的工作,而不是自己被拦住。

子运行也不例外。它需要属于自己的会话,理由与它的父运行相同,这让「一次运行一个会话」成为对签发断言的控制平面的一项要求,而不是一种惯例。

### 为什么身份无法在组合过程中被替换

每个部分各自都拒绝由调用方指明的租户,而把它们组合起来仍有可能重新引入这个漏洞:如果调度器用请求指明的租户去打开凭据,却用认证了另一个租户的断言,它会满足每一个部分,同时击败所有部分。`RunRequest` 只携带一个令牌,而凭据绑定与池身份都读自已准入的声明,因此这种配对根本无法被表达。

这些声明中的 `provider` 出于同样的原因也被签名。提供方账户是与提供方绑定的,把它与另一个提供方配对,会把一次运行放进一个控制平面从未组合过的池中。

### 为什么凭据不会被序列化

拿到一次被准入的运行,运维人员做的第一件事就是把它打日志,而这次运行携带着租户已解密的提供方密钥。一个普通对象会把那把密钥一个字节一个字节地写进日志:对一次成功启动结果做 `JSON.stringify`,里面完整地含着它。

因此 `secret` 是不可枚举的,而这次运行带有一个把它替换成 `[redacted]` 的 `toJSON`。两者覆盖不同的调用方:`JSON.stringify` 会使用 `toJSON`,而 `console.log`、`util.inspect` 以及每一个遍历自有属性的结构化日志器都会忽略它,并会从一个普通属性上把密钥打出来。读取 `run.secret` 不受影响,而那正是启动提供方的调用方要做的事。

池根目录仍然可读。它是一条由摘要推导出来的路径而不是秘密,一个运维人员问"这次运行落到了哪个池"是一个真实的问题,而任何能在宿主上读取那个目录的人,拥有的已经比这条路径多得多。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

阅读这些页面,了解本调用所组合的各个部分,以及它所服务的架构。

- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md)——已接受的信任边界,包括本组合端到端持续关闭的混淆代理规则。
- [`dsh-execution-assertion`](../execution-assertion/README.zh.md)——本调用最先校验的令牌。
- [`dsh-credential-vault`](../credential-vault/README.zh.md)——它使用已准入的绑定打开的信封。
- [`dsh-workspace-grant`](../workspace-grant/README.zh.md) —— 一个授权 id 所解析到的记录,以及本调用对它施加的规则。
- [`dsh-runtime-pool`](../runtime-pool/README.zh.md)——它最后解析的键与目录。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前包的约束,不是任务积压。

- **准入止于一个决定,而不是一次调用**——本调用返回提供方进程所需的内容;启动它、注入密钥、限制其输出与取消它,都属于 R2 的适配器。
- **审计记录只被返回,不被持久化**——每一种结果都携带该次尝试产生的保险库记录,而边界页面所要求的按租户分区存储由调用方拥有。这里不写入、不保留、也不排序它们。
- **只有保险库操作会被审计**——从未抵达保险库的拒绝(未被准入的令牌、已用掉的 nonce、没有存储凭据的账户)携带空轨迹,因为没有任何凭据被触碰。需要记录这些拒绝的调用方,应自行记录该 rejection,而它在 `assertion` 之后的每一个阶段都会指明租户。
- **nonce 的消费与运行不构成同一事务**——nonce 在读取凭据之前就被消费,因此在凭据一步被拒绝的运行,其断言已经被消耗掉。这是安全的方向,同时也意味着客户端必须重新签发断言,而不能在修好账户后重试同一个。
- **授权的根目录被解析,而不是被执行** —— 本调用裁定一次运行是否可以持有一份授权。某条给定路径是否落在它的某个根目录之下,是签发设备的文件系统语义,而这里没有任何东西读 `roots`;被准入的运行携带它们,交给文件操作发生的地方去检查。
- **会话检查只和它的端口一样宽** —— `findSessionRun` 依据部署方给它的东西作答,因此两个对开启中运行没有共同视图的运行时,无法拒绝对方的冲突。`dsh-run-scheduler` 依据它自己那个运行时的记录作答,并且把这一点说了出来。
- **不检查配额、并发与父级子集授权**——这些属于调度器与 R3 的编排;本调用只准入一次运行的身份与资源,而不是它的预算。
- **没有 Cordis 服务**——本包中没有任何东西注册到 `Context` 上;它被直接导入。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
