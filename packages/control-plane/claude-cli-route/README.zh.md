---
description: "A Claude CLI dsh-llm route resolved per call to the Candy run driving the request's session, for a multi-tenant runtime that cannot pin one tenant's isolation to one adapter instance."
kind: "package-reference"
---

# @deepseek-ai/dsh-claude-cli-route

[English](README.md) | 中文

## 概述

`dsh-claude-cli-route` 挂载一条名为 `claude-cli` 的 `dsh-llm` 提供方路由,其凭据、工作池与花费上限在每次调用时都从驱动该请求所属会话的那次 Candy 运行中重新解析,而不是在组装时一次性钉死。请在多租户 Candy 运行时里挂载它,而不是直接挂载 `dsh-llm-claude-cli`:那个包自身的组装把一个租户的隔离信息钉在适配器实例上,这对一个进程服务一个租户来说是对的,而它自己的 README 也说明了这正是主循环无法把它当作共享路由使用的原因。本包就是那道接合点,让一条挂载的路由能为一个 `dsh-run-scheduler` 准入的每一个租户服务,也让因故结束一次运行——账户被吊销、租约到期、所在的树被围着它一起关闭——能够触及该运行自己那次调用所启动的进程。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在每个 Candy 运行时里挂载一次即可,与 `dsh-run-scheduler`、`dsh-llm` 以及一个 `dsh-subprocess` 提供方放在一起。每一个 `GenerateOptions.provider` 为 `claude-cli`、且 `sessionId` 指名了该运行时调度器某次开启中运行的调用,都会针对那次运行自己的租户被服务。

### 何时选择它

为一个通过一次组装为多个租户服务 Claude CLI 调用的 Candy 部署选择它。为单租户部署,或为那些已经自行为每个池构造一个适配器的辅助性一次性调用(`dsh-compaction`、`dsh-session-title`)直接选择 `dsh-llm-claude-cli`——这些场景都不需要本包新增的会话解析。

### 最小配置

```yml
- id: claude-cli-route
  name: '@deepseek-ai/dsh-claude-cli-route'
  config:
    executable: /opt/candy/bin/claude
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executable` | `claude` | 本主机所运行 `claude` 可执行文件的绝对路径 |
| `graceMs` | `5000` | 进程树终止宽限期,单位毫秒 |
| `maxOutputBytes` | `16777216` | 一次调用在被判失败并回收之前最多可写入的 stdout 字节数 |
| `maxStderrBytes` | `8192` | 从一次调用保留的最多 stderr 字节数,作为该流的尾部 |

每一个字段都是主机层面的事实——对本路由服务的每个租户都一样——这正是它们都不从运行本身读取的原因。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-claude-cli-route)是每个可接受字段及其 JSDoc 的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionRoutedClaudeCliAdapter`、该插件、它的 `Config`,以及 `resolveDeployment` |
| — | 不发布运行时不变量伴生模块:本包在两次调用之间不持有任何自己的状态,而这道缝隙自身的 `dsh-llm/invariant` 已经在每一次提供方流周围检查 chunk 语法。 |

### 一次调用、一次解析、什么都不保留

`stream()` 就是本包逻辑的全部:读取 `options.sessionId`,询问 `RunScheduler.runIdentityFor` 哪次运行驱动着它、那次运行可以用什么去认证,把答案绑定成一次 Claude CLI 启动,再委托给一个新构造出来的 `ClaudeCliAdapter`。两次调用之间不留存任何东西,即便是同一次运行的两次调用也是如此——`runIdentityFor` 打开的凭据每次都从保险库重新读取,因此一次账户在第一次和第二次调用之间被吊销的运行,其第二次调用会被拒绝,而不是用一个本不该再生效的密钥继续服务。这正是 `dsh-run-scheduler` 自身计量出于同一个理由已经具备的性质,它的 README 里写道:一次运行只在一开始打开它的凭据并一直持有,因此吊销账户会销毁存储的信封,却触及不到一个已经用它完成认证的进程,而每次重新读取正是让吊销能够停下已经在进行中的工作的原因。

### 终止能够触及本路由启动的那个进程

`RunScheduler.disposableSpawn(runId, spawn)` 把本路由交给 `ClaudeCliAdapter` 的那个 `spawn` 函数包了一层,于是它启动的进程被登记到那次运行自己的生命周期上。因故结束这次运行——来自调度器的清扫,与这次调用的调用方做了什么无关——会以取消这次调用相同的方式终止那个进程。本包并不自己实现处置;它是今天唯一一处把 `disposableSpawn` 接进一次真实启动的组装,补上了 [`dsh-run-scheduler` 自己的笔记](../../../.agents/notes/implemented/architecture/2026-09-06-a-run-that-settled-but-kept-running.zh.md)所指名的那个"有触及能力却没人去触及"的缺口。

### 为什么提供方要对着账户核对,而不只是靠配置

`runIdentityFor` 会如实回答这次运行的账户到底是哪个提供方——它并不假设一定是 `claude-cli`。本路由在绑定一次启动之前先核对这个事实:一次因配置失误而抵达本路由、其运行认证的却是一个 DeepSeek 账户的会话,会被指名拒绝(`PROVIDER_MISMATCH`),而不是被交给一个它从未打算去认证的 Claude CLI 进程。

### 为什么拒绝是抛出一个 `LlmError`,而不是悄悄放行

本包可能产生的每一种失败——没有会话、没有开启中的运行、账户不可用、凭据打不开、提供方不匹配,或者一次已耗尽的预算撑不起的启动——都会在任何进程生成之前抛出。`dsh-llm-claude-cli` 自己的 README 提到,这个选择只有在出现一个宁愿绕开拒绝也不愿失败的调用方时才值得重新考虑;目前还没有这样的调用方,因此本包和它一样选择大声抛出。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-run-scheduler`](../run-scheduler/README.zh.md) —— `runIdentityFor`、`disposableSpawn`,以及本路由所组合的那份按运行生命周期做的处置。
- [`dsh-claude-cli-binding`](../claude-cli-binding/README.zh.md) —— `bindClaudeCliCredential`,从一份已打开的凭据到一次启动的纯函数接合点。
- [`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.zh.md) —— `ClaudeCliAdapter`,本路由把每次调用都委托给它的进程生命周期与协议。
- [多租户 CLI 智能体运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— 本包是其 R3 编排接合点的第一块拼图。

-----

<a id="model-experience"></a>
## 模型体验

间接地,通过 `dsh-llm-claude-cli`——本路由每次调用构造出来的 `ClaudeCliAdapter` 所产生的每一段提示词、响应与 token 影响,都归它所有。

#### KV 缓存影响

按调用独立,原因与 `dsh-llm-claude-cli` 自身相同:每次调用都会在一个全新的进程之上构造一个全新的适配器,因此本路由所服务的两次调用之间——即便是同一次运行的两次调用——都不会携带任何前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是本包当前的约束,不是任务清单。

- **一个提供方,一个包** —— 本路由只服务 `claude-cli`;一条以同样方式解析的 Codex CLI 路由,要等那个适配器存在之后成为一个独立的包,而不是这里的一个可配置提供方名称。
- **每次调用一个全新的 `ClaudeCliAdapter`** —— 跨调用之间(包括同一次运行的两次调用之间)什么都不会被池化或复用。这正是让凭据重新打开成为「正确」而非「需要的优化」的原因:一个调用频率很高的部署要为每次调用各付出一次凭据打开的代价,本包尚未把这个代价拿去和 `dsh-credential-vault` 自身的开销做过对比衡量。
- **没有自己的重试分类** —— 本包抛出的一次拒绝(`PROVIDER_MISMATCH`、`CREDENTIAL_UNAVAILABLE`、`BINDING_REFUSED`、`NO_SESSION`)不携带路由自有的重试策略;`dsh-llm-retry` 会以它的默认设置对待这些失败,和 `dsh-llm-claude-cli` 自身的失败一样。
- **R3 编排接合点的深度** —— 本包只解析一次调用的身份与处置;智能体注册表的路由策略、超出调度范围的委派树审计覆盖,以及一个 Codex CLI 对应物,仍是那道接合点里本包没有去建的部分。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景 — 点击展开</summary>

无。

</details>
