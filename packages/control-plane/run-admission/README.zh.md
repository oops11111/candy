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

被准入的运行携带已校验的声明、已打开的凭据、池键、池的目录,以及它可以花费的额度。拒绝会指明产生它的阶段——`assertion`、`budget`、`replay` 或 `credential`——因此运维人员可以区分伪造令牌与已吊销账户,而调用方不会因此得到任何可用于重试的信息。两种结果都携带 `audits`:被拒绝的运行正是审计轨迹之所以存在的那个事件,因此没有任何路径会丢弃保险库产生的记录。

### 提供 policy

`RunAdmissionPolicy` 持有本运行时的期望、断言密钥、保险库密钥环、池基准目录,以及两个由部署方满足的端口:

```ts
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'

declare const partial: Omit<RunAdmissionPolicy, 'findBudget' | 'spendNonce' | 'findCredential'>
declare const store: {
  budgetFor: (userId: string) => Promise<undefined>
  markSpent: (nonce: string, expiresAt: number) => Promise<boolean>
  envelopeFor: (userId: string, accountId: string) => Promise<undefined>
}

export const policy: RunAdmissionPolicy = {
  ...partial,
  findBudget: claims => store.budgetFor(claims.userId),
  spendNonce: claims => store.markSpent(claims.nonce, claims.expiresAt),
  findCredential: claims => store.envelopeFor(claims.userId, claims.accountId),
}
```

`spendNonce` 只在首次见到某个 nonce 时返回 true。`findBudget` 返回 `undefined` 表示拒绝该运行:存储不认识的租户并不等于额度无限的租户,而意在「不计量」的部署应当用一个显式的大额度来表达。这三个端口在本仓库中都不存在,这正是它们作为参数的原因:在部署方回答了额度、重放与凭据查找之前,运行无法开始。

额度在消费 nonce 之前读取。额度耗尽是这里唯一一种调用方能够修复并重试的拒绝——充值后再出示同一个仍然有效的断言——因此烧掉它的一次性令牌,会把一次可恢复的拒绝变成一次回到控制面的往返。nonce 仍然在凭据之前被消费,因为它会把并发的重复请求串行化,使同一个令牌的两份副本不可能都抵达密钥。

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

断言最先被校验,因此下游永远不会看到未经认证的声明——本运行时不接受的令牌,会在任何一个端口被调用之前就被拒绝。额度第二个被读取:它是调用方唯一能够修复并重试的拒绝,因此绝不能烧掉 nonce,而且它不触碰任何密钥。nonce 第三个被消费,把并发的重复请求串行化,使同一个令牌的两份副本不可能都抵达凭据。凭据第四个被打开,使用声明所携带的绑定。池最后被解析,因为它不需要任何密钥。

### 为什么身份无法在组合过程中被替换

每个部分各自都拒绝由调用方指明的租户,而把它们组合起来仍有可能重新引入这个漏洞:如果调度器用请求指明的租户去打开凭据,却用认证了另一个租户的断言,它会满足每一个部分,同时击败所有部分。`RunRequest` 只携带一个令牌,而凭据绑定与池身份都读自已准入的声明,因此这种配对根本无法被表达。

这些声明中的 `provider` 出于同样的原因也被签名。提供方账户是与提供方绑定的,把它与另一个提供方配对,会把一次运行放进一个控制平面从未组合过的池中。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

阅读这些页面,了解本调用所组合的各个部分,以及它所服务的架构。

- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md)——已接受的信任边界,包括本组合端到端持续关闭的混淆代理规则。
- [`dsh-execution-assertion`](../execution-assertion/README.zh.md)——本调用最先校验的令牌。
- [`dsh-credential-vault`](../credential-vault/README.zh.md)——它使用已准入的绑定打开的信封。
- [`dsh-runtime-pool`](../runtime-pool/README.zh.md)——它最后解析的键与目录。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前包的约束,不是任务积压。

- **准入止于一个决定,而不是一次调用**——本调用返回提供方进程所需的内容;启动它、注入密钥、限制其输出与取消它,都属于 R2 的适配器。
- **审计记录只被返回,不被持久化**——每一种结果都携带该次尝试产生的保险库记录,而边界页面所要求的按租户分区存储由调用方拥有。这里不写入、不保留、也不排序它们。
- **只有保险库操作会被审计**——从未抵达保险库的拒绝(未被准入的令牌、已用掉的 nonce、没有存储凭据的账户)携带空轨迹,因为没有任何凭据被触碰。需要记录这些拒绝的调用方,应自行记录该 rejection。
- **nonce 的消费与运行不构成同一事务**——nonce 在读取凭据之前就被消费,因此在凭据一步被拒绝的运行,其断言已经被消耗掉。这是安全的方向,同时也意味着客户端必须重新签发断言,而不能在修好账户后重试同一个。
- **不检查配额、并发与父级子集授权**——这些属于调度器与 R3 的编排;本调用只准入一次运行的身份与资源,而不是它的预算。
- **没有 Cordis 服务**——本包中没有任何东西注册到 `Context` 上;它被直接导入。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
