---
description: "Candy 的租户绑定凭据信封:AES-256-GCM 封装、密钥环轮换、以销毁方式吊销、脱敏读取,以及每次操作都产出的审计记录。"
kind: "package-library"
---

# @deepseek-ai/dsh-credential-vault

[English](README.md) | 中文

## 概述

`dsh-credential-vault` 负责在静态存储中保管租户的提供方账户密钥。`sealCredential` 使用密钥环的当前密钥以 AES-256-GCM 加密它;`openCredential` 只把它返回给指明了其封装时所属租户与账户的调用方;`rewrapCredential` 把它迁移到新密钥上;`revokeCredential` 销毁它。每次操作还会返回一个 `CredentialAuditEvent`,因此调用方无法在不同时取得"曾经读取过"这一记录的情况下获得密钥,而 `redactCredential` 提供可安全记录日志或返回的元数据视图。本包是一个普通模块,没有 Cordis 服务,也没有存储:密钥环是由调用方拥有的参数,信封写在何处也由调用方决定。它与 harness 自身的 `dsh-credentials` seam 相互独立——后者以 `scope/id` 寻址记录,没有租户维度,且以明文存储。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 封装与打开一个密钥

```ts
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import {
  openCredential, sealCredential,
  type CredentialBinding, type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'

declare const keyring: CredentialKeyring
declare const apiKey: Uint8Array

const binding: CredentialBinding = {
  userId: UserId('user-1'),
  accountId: ProviderAccountId('account-1'),
}

const { envelope, audit } = sealCredential(apiKey, binding, keyring, Date.now())
const opened = openCredential(envelope, binding, keyring, Date.now())

export const secret = opened.opened ? opened.secret : undefined
export const records = [audit, opened.audit]
```

`envelope` 是持久化的,可安全地以 JSON 存储。它不携带明文,但并不适合写入日志——请先经过 `redactCredential`。读取失败时会给出 `revoked`、`unknown-key`、`binding-mismatch`、`unsupported-version` 或 `corrupt` 之一;其中每一个都会拒绝返回密钥。

### 轮换密钥

向密钥环加入新密钥,将其设为当前密钥,重新封装每个信封,然后不再保留旧版本:

```ts
import { rewrapCredential } from '@deepseek-ai/dsh-credential-vault'
import type { CredentialBinding, CredentialEnvelope, CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'

declare const stored: CredentialEnvelope
declare const binding: CredentialBinding
declare const rotated: CredentialKeyring

const moved = rewrapCredential(stored, binding, rotated, Date.now())

export const next = moved.rewrapped ? moved.envelope : undefined
```

重新封装后的信封保留原有的 `sealedAt`,并记录 `rewrappedAt`。从未被重新封装的信封,在其版本离开密钥环后将永久无法打开——这正是退役密钥的用意。

### 吊销一个密钥

`revokeCredential` 会清空 nonce、密文与认证标签,而不是设置一个需要打开方自觉遵守的标记。密钥就此消失:没有任何密钥能恢复它,忽略 `revoked` 拒绝原因的调用方也无从解密。记录本身被保留,使其元数据仍可审计。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 信封、绑定、密钥环与审计类型,以及 `sealCredential`、`openCredential`、`rewrapCredential`、`revokeCredential` 与 `redactCredential` |
| — | 未发布运行时不变式伴生模块;这个纯模块不拥有事件流或可变运行时数据;其封装代数由单元测试强制保证。 |

### 是什么让密钥留在它的租户处

两种机制,各自拦截不同的攻击。`openCredential` 首先把信封中记录的 `userId` 与 `accountId` 同调用方指明的绑定做比较,这会拒绝那些放错记录、但存储字段仍指向真实所有者的信封(`binding-mismatch`)。这些字段同时也进入附加认证数据,从而拒绝那些既被移动、其存储字段又被改写为与新记录一致的信封(`corrupt`)——这种改写是比较无法察觉的,因为此时每个存储字段都与攻击者自己的绑定一致。

附加认证数据取自调用方的绑定,而不是信封的字段。由于上述比较先行执行,二者在每一条能够抵达解密的路径上都相等,因此这个选择不会改变本包测试所能观察到的任何行为。它的存在是为了让将来某次调整或删除该比较的改动仍然快速失败。请勿把它"简化"成读取信封。

进入附加认证数据的字段都带有长度前缀,因此任何取值都无法通过包含分隔符来伪造字段边界——控制平面 id 是本包不加约束的不透明字符串。

### 为什么吊销采用销毁而不是标记

一个吊销标记的可靠程度,取决于遵守它的那个打开方,而且在标记设置之前的每一份备份中密文都依然存在。销毁密文使吊销成为记录本身的属性,而不是读取它的代码的属性。

### 为什么密钥环是参数

密钥来自何处——文件、环境变量,还是密钥管理服务——是一个部署决策,在本仓库中尚无消费者。以参数形式接收密钥环可以保持机制可测试,并把选择权留给最终的拥有者,代价是本包无法区分已轮换的密钥与已泄露的密钥。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

阅读这些页面,了解本保险库所服务的架构,以及它所绑定的标识符。

- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md)——已接受的信任边界,其中凭据窃取与租户混淆正是本包必须持续关闭的滥用场景。
- [多租户 CLI 代理运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)——提议中的 R1–R6 交付计划;本包对应 R1 的加密凭据存储条目。
- [`dsh-control-plane`](../control-plane/README.zh.md)——构成一个绑定的 `UserId` 与 `ProviderAccountId`。
- [`dsh-credentials`](../../credentials/credentials/README.zh.md)——harness 自身的凭据 seam,本包并不取代它。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前包的约束,不是任务积压。

- **密钥环是参数,而不是受管密钥**——密钥的生成、存储与分发属于部署方。本包只校验每个密钥为 32 字节;它无法区分已轮换的密钥与已泄露的密钥,既不安排轮换,也不知道哪些信封仍待重新封装。
- **审计记录只被返回,从不被持久化**——每次操作都把 `CredentialAuditEvent` 交回调用方,由调用方拥有边界页面所要求的、按租户分区的仅追加存储。本包不会持久记录某个密钥曾被读取。
- **不控制明文的生命周期**——`openCredential` 返回一个由调用方拥有的 `Uint8Array`。JavaScript 没有可靠的清零手段,因此解密后的密钥会一直留在堆中可读,直到被回收。
- **信封不会作为不可信 JSON 被校验**——这些函数接收类型化的 `CredentialEnvelope`。从磁盘或数据库读回信封的调用方,需自行负责在传入之前解析并校验该记录;字段畸形会表现为 `corrupt`,而不是指出具体错误字段的解析错误。
- **没有 Cordis 服务,也没有存储**——本包中没有任何东西注册到 `Context` 上,也不决定信封存放在哪里;二者都属于 R1 尚未构建的控制平面运行时。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
