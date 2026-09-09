---
description: "把一次已准入运行的持久工作区授权绑定到既有文件系统与 Shell 执行的 Candy Provider。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-grant-execution

[English](README.md) | 中文

## 概述

本包提供 `ctx.workspaceAuthority`，即 `dsh-sandbox` 所声明通用授权点的 Candy Provider。它为每次工具分发解析开启中的 Candy 运行、重新读取工作区授权，并让继承来的文件系统与 Shell 沙箱 Provider 在自己的操作位置执行结果。它不定义工具、文件操作、Shell 语法、远程传输或第二套沙箱。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

把它与 `dsh-control-plane-store`、`dsh-run-scheduler` 以及既有的沙箱文件系统和 Shell Provider 一起装载。没有开启中 Candy 运行的工具分发会在工具主体开始前被拒绝。无 Agent 调用没有可供本 Provider 推断的租户身份，因此继续由部署沙箱管理。

对于文件系统操作，执行器会在每次读取或变更前重新验证授权，并按宿主文件系统解析包含关系。未知、已撤销、跨租户、跨设备、符号链接、junction 和根目录之外的路径均默认拒绝。`read-only` 授权拒绝变更。

对于 Shell 操作，执行器重新验证授权并收紧既有的逐调用沙箱策略。进程工作目录必须解析到授权根目录之下，请求的模式不能超过授权模式。继承来的平台沙箱继续负责执行最终的进程策略。

<a id="understand-the-implementation"></a>
## 理解实现

`WorkspaceGrantExecution.enter` 通过 `RunScheduler.runOfSession` 取得唯一开启中的运行，只把租户、设备和授权标识放入异步执行上下文，不保留根目录或撤销状态。`authorizePath` 与 `authorizePolicy` 会再次读取当前授权，因此撤销或收窄会在下一次执行器操作生效，而非只在下一次运行生效。

文件系统后端检查规范目标路径。现有祖先目录先按原生 realpath 语义解析再判断包含关系，因此通往授权外部的符号链接或 Windows junction 会作为越界路径被拒绝。缺失的路径后缀仍附着在解析后的最深现有祖先之上。

<a id="further-exploration"></a>
## 延伸阅读

不发布运行时 invariant companion；此包只保留异步调用身份，每次持久授权决策都会重新读取，并由执行器边界的集成测试覆盖。

- [`dsh-workspace-grant`](../workspace-grant/README.zh.md) — 持久授权记录和准入时身份检查。
- [`dsh-fs-sandbox`](../../fs/fs-sandbox/README.zh.md) — 文件系统执行器强制检查。
- [`dsh-sandbox`](../../sandbox/sandbox/README.zh.md) — 共享进程策略术语和授权服务定义。
- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md) — 两阶段工作区授权要求。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## 模型体验

### 执行器授权

#### 模型看到什么

`ctx.workspaceAuthority` 不直接提供内容。执行器应用授权后，既有工具报告自己的正常结果或结构化拒绝。

#### Token 影响

没有常驻提示词成本；只有继承工具的普通结果或拒绝进入对话。

#### KV Cache 影响

除继承工具结果外没有影响；该结果通过既有工具协议追加。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 无 Agent 操作没有 Candy 运行身份，因此只使用普通部署沙箱。
- 工作区授权会约束 Shell 沙箱的模式和工作目录。平台进程内的读取可见性仍属于平台沙箱契约；本包不解析命令，也不建立第二套 Shell 协议。
- 授权变更能否跨进程可见，取决于控制平面存储从介质刷新的行为。
