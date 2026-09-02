---
description: "Candy 控制平面唯一拥有权威的实体所对应的品牌化 id，以及供子运行授权检查遍历的运行谱系记录。"
kind: "package-library"
---

# @deepseek-ai/dsh-control-plane

[English](README.md) | 中文

## 概述

`dsh-control-plane` 为 Candy 控制平面唯一拥有权威的实体打上品牌：`UserId`、`DeviceId`、`ProviderAccountId`、`WorkspaceGrantId` 与 `ConversationId`，并定义了 `RunLineage`——记录某次运行父级的记录。它是一个无外部依赖的身份基础包，没有 Cordis 服务，也没有存储：它的存在是为了让之后每一个控制平面包(租户/凭据模型、提供方适配器、编排授权检查、Web 账户 API,以及 Windows Harness Host 设备绑定)从一开始就共用同一套互不可替换的词汇,而不是各自发明自己的 `string` 类型租户 id。同样处于控制平面权威之下的 `SessionId`,则直接复用 [`dsh-session`](../../core/session/README.zh.md) 中已有的定义;本包从不重新定义它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 为控制平面 id 打上品牌

```ts
import { UserId, DeviceId, ProviderAccountId, WorkspaceGrantId, ConversationId } from '@deepseek-ai/dsh-control-plane'

const userId = UserId('user-1')
const deviceId = DeviceId('device-1')
const accountId = ProviderAccountId('account-1')
const workspaceGrantId = WorkspaceGrantId('grant-1')
const conversationId = ConversationId('conversation-1')
```

每个构造函数只为输入打上品牌,不做校验或转换:目前还没有签发方来定义这些构造函数可以校验的语法,因此每个函数都注明不执行任何校验。等控制平面的签发服务出现后,由它在接纳原始字符串的那个点上添加校验——本包始终只是共享的品牌,而不是校验器。

### 命名一次运行的谱系

```ts
import { RunId, type RunLineage } from '@deepseek-ai/dsh-control-plane'

const rootRun: RunLineage = { runId: RunId('run-1'), parentRunId: undefined }
const childRun: RunLineage = { runId: RunId('run-2'), parentRunId: rootRun.runId }
```

"子运行"是一个设置了 `RunLineage.parentRunId` 的 `RunId`,而不是一个独立的 id 品牌——除了这条链接之外,没有任何东西能把子运行的身份与根运行区分开。`RunLineage` 只是命名这条链;它并不执行或编码准入子运行时所需的父级子集授权检查(参见[已知限制](#known-limitations-and-deferred-work))。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

每个 id 都是来自 [`dsh-brand`](../../util/brand/README.zh.md) 的 `Branded<'...'>` 字符串,通过一个同名构造函数应用——这正是 `dsh-session` 的 `SessionId` 与 `dsh-workspace` 的 `WorkspaceId` 已经使用的模式。`RunLineage` 是一个普通接口,本身不带任何品牌。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `UserId`、`DeviceId`、`ProviderAccountId`、`WorkspaceGrantId`、`ConversationId`、`RunId` 与 `RunLineage` |
| — | 未发布运行时不变式伴生模块;这个纯工具不拥有事件流或可变运行时数据;其值代数由单元测试强制保证。 |

### 为什么这里不重新定义 `SessionId`

[Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md) 把 `sessionId` 与本包所拥有的这些 id 并列为控制平面权威,但 Harness 会话日志——以及命名它的 `SessionId` 品牌——已经存在,且由 `dsh-session` 拥有。在这里重新定义它会把同一个实体的身份拆分到两个不兼容的品牌上。`ConversationId` 则保持独立:控制平面的会话是面向租户可见的线程,在其生命周期内可以拥有不止一个 `SessionId`(例如经过一次 fork 或 resume),因此这两个 id 命名的是不同的东西,谁也不能替代谁。

### 为什么没有 `ChildRunId`

[已接受的边界页面](../../../docs/candy-runtime-boundaries.zh.md) 把"子运行谱系"列为控制平面权威,而不是一个独立的 id 空间。一次运行本身的身份始终是一个 `RunId`,无论它是根运行还是子运行;只有 `RunLineage.parentRunId` 才能区分两者。一个未加说明的独立 `ChildRunId` 品牌只会重复 `RunId`,却不会增加任何真实约束。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

阅读这些页面,了解本包 id 所命名的已接受架构,以及本包所开启的计划。

- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md)——已接受的信任边界、滥用场景,以及本包 id 所实现的完整权威列表(`userId`、`deviceId`、`accountId`、`workspaceGrantId`、`conversationId`、`sessionId`、子运行谱系)。
- [多租户 CLI 代理运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)——提议中的 R1–R6 交付计划;本包是 R1 的第一个切片。
- [`dsh-brand`](../../util/brand/README.zh.md)——本包每个 id 所依赖的名义类型化原语。
- [`dsh-session`](../../core/session/README.zh.md)——`SessionId` 的拥有者,本包原样复用它。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前包的约束,不是任务积压;每一条都是交付计划中本包刻意尚未开始的后续 R1 条目。

- **没有校验语法**——每个构造函数只为输入打上品牌,不检查格式、唯一性或来源,因为目前还没有签发服务。在签发方存在之前在这里添加校验,只会发明一套没有依据的语法;签发方落地后由它拥有这项检查。
- **没有凭据、授权或账户存储**——本包只定义 id。加密凭据信封、执行断言的签发与校验、工作区授权记录都是尚未构建的独立 R1 工作。
- **没有运行时池键辅助函数**——[Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md) 把 `userId + provider + accountId` 定为运行时池隔离键,但本包并不推导它:目前还没有 `provider` 的表示形式(例如 `ProviderKind` 枚举),在这里发明一个只会抢先替代 R2 提供方适配器的设计,而不是遵循它。
- **没有 Cordis 服务**——本包中没有任何东西注册到 `Context` 上;它像 `dsh-brand` 一样由 TypeScript 直接导入。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
