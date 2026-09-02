---
description: "Candy 控制平面按运行签发、Candy 运行时在调度工作前校验的短时效、受众绑定执行断言的签发与准入。"
kind: "package-library"
---

# @deepseek-ai/dsh-execution-assertion

[English](README.md) | 中文

## 概述

`dsh-execution-assertion` 拥有授权一次 Candy 运行的凭据:控制平面签发一份带签名、短时效的断言,命名租户、设备、提供方账户、工作区授权、对话、会话与运行,Candy 运行时在调度任何工作之前对其进行准入。`admitExecutionAssertion` 是获得该身份的唯一途径,而它所接受的期望只命名部署事实——签发方、受众、最大生存期——没有任何字段可供调用方提供租户或账户。因此身份只有在 HMAC 校验通过之后才会离开本包,这正是把边界规则"绝不接受客户端选择的租户"落实在做出该决定的操作之中,而不是依赖每个调用点的约定。本包是一个普通模块,没有 Cordis 服务,也没有存储;签名密钥是由调用方拥有的参数。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 在控制平面中签发断言

```ts
import {
  ConversationId, DeviceId, ProviderAccountId, RunId, UserId, WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import { mintExecutionAssertion } from '@deepseek-ai/dsh-execution-assertion'
import { SessionId } from '@deepseek-ai/dsh-session'

declare const secret: Uint8Array
declare const nonce: string
declare const now: number

export const token = mintExecutionAssertion({
  issuer: 'candy-control-plane',
  audience: 'candy-runtime-debian-1',
  userId: UserId('user-1'),
  deviceId: DeviceId('device-1'),
  accountId: ProviderAccountId('account-1'),
  provider: 'deepseek-api',
  workspaceGrantId: WorkspaceGrantId('grant-1'),
  conversationId: ConversationId('conversation-1'),
  sessionId: SessionId('session-1'),
  runId: RunId('run-1'),
  parentRunId: undefined,
  nonce,
  issuedAt: now,
  expiresAt: now + 60_000,
}, secret)
```

每一项声明都由调用方提供:本包只为控制平面的决定签名,不自行派生任何身份。`provider` 由签名携带而不是由请求指明,因为提供方账户是与提供方绑定的——把它与另一个提供方配对,会把运行放进一个控制平面从未组合过的池中。密钥必须至少为 32 个随机字节,与 `dsh-client-connection` 为其浏览器会话所存储的长度一致;更短的密钥会抛出错误,而不是以弱强度签名。

### 在运行时中准入断言

```ts
import {
  admitExecutionAssertion, type ExecutionAssertionClaims, type ExecutionAssertionRejection,
} from '@deepseek-ai/dsh-execution-assertion'

declare const token: string
declare const secret: Uint8Array
declare const deny: (rejection: ExecutionAssertionRejection) => void
declare const schedule: (claims: ExecutionAssertionClaims) => void

const admission = admitExecutionAssertion(token, secret, {
  issuer: 'candy-control-plane',
  audience: 'candy-runtime-debian-1',
  maxLifetimeMs: 60_000,
}, Date.now())

if (admission.admitted) schedule(admission.claims)
else deny(admission.rejection)
```

检查按顺序进行:令牌结构、版本、签名、声明形状、签发方、受众、生存期,最后是时钟。签名在读取任何声明之前完成校验,因此伪造的载荷永远不会进入任何比较。`rejection` 是一组封闭的原因,供运维诊断使用——`malformed`、`unsupported-version`、`signature`、`issuer`、`audience`、`not-yet-valid`、`expired`、`lifetime`——其中每一个都会拒绝该次运行。

当前时间是参数,而不是对进程时钟的读取,因此已经持有决策时间戳的调度器可以针对那一刻进行准入,测试也无需控制时钟。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

令牌格式为 `v1.<base64url 载荷>.<base64url HMAC-SHA256>`,这正是本仓库中 `dsh-client-connection` 浏览器会话 cookie 已经使用的格式。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 声明与期望类型、拒绝原因集合、`mintExecutionAssertion` 与 `admitExecutionAssertion` |
| — | 未发布运行时不变式伴生模块;这个纯模块不拥有事件流或可变运行时数据;其准入代数由单元测试强制保证。 |

### 签名覆盖了什么

HMAC 是在收到的载荷文本上计算的,因此准入过程从不对解码后的对象重新序列化:JSON 键顺序、空白字符与重复键的处理都无法改变被校验的内容。载荷与签名都必须是规范的 base64url——重新编码后与原文不一致的文本,携带了签发令牌绝不会有的填充、字母表或尾部比特,会被判为 malformed。签名比较先检查长度,再进行常数时间比较。

### 为什么调用方无法提供身份

`ExecutionAssertionExpectation` 只命名 `issuer`、`audience` 与 `maxLifetimeMs`。它没有用户、设备、账户、工作区授权、对话、会话或运行字段,因此不存在任何参数能让请求断言这次运行属于谁;被准入的声明是唯一来源。将来若在该类型上增加一个命名租户的字段,就会重新打开本包所关闭的混淆代理路径。

### 为什么即便 TypeScript 已描述载荷仍要校验

令牌来自另一个进程,因此其解码后的载荷是一处 wire 边界,而不是同进程内的类型化值。每一项声明都会检查存在性与类型,id 必须是非空字符串,时间戳必须是非负安全整数;其余一律判为 malformed。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

阅读这些页面,了解本凭据所强制执行的架构,以及其格式所遵循的先例。

- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md)——已接受的信任边界,包括 Candy 拒绝客户端提供的租户与账户字段这一规则。
- [多租户 CLI 代理运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)——提议中的 R1–R6 交付计划;本包对应 R1 的执行断言条目。
- [`dsh-control-plane`](../control-plane/README.zh.md)——本包每项声明所携带的品牌化 id。
- [浏览器启动令牌认证](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)——本包在令牌格式与密钥长度上所遵循的仓库内 HMAC 承载凭据。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前包的约束,不是任务积压;每一条都指出交付计划中由后续部分拥有的工作。

- **准入不会消费 nonce**——nonce 被绑定进签名并被返回,但单次使用的强制执行需要一个按租户划分的持久重放存储,该存储由调度器拥有且尚不存在。在该存储出现之前,任何捕获到断言的人都可以在其生存期内重放它,只有短生存期与受众绑定限制了这个窗口。
- **签名密钥是参数,而不是受管密钥**——密钥存储、轮换与吊销属于 R1 的凭据保险库条目。本包只校验密钥至少为 32 字节;它无法区分已轮换的密钥与已泄露的密钥。
- **每对签发方/受众共用一个对称密钥**——HMAC 意味着进行准入的运行时同样可以签发。用非对称签名把签发与准入分开,需要一套目前还没有消费者需要的密钥分发设计。
- **没有传输、请求头或请求绑定**——断言授权的是一次运行的身份;它不与特定的 HTTP 请求、请求体或连接绑定,因此跨请求重放的问题与 nonce 存储一样由调用方拥有。
- **没有 Cordis 服务**——本包中没有任何东西注册到 `Context` 上;它像 `dsh-brand` 一样被直接导入。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
