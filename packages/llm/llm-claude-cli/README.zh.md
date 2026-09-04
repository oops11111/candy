---
description: "通过把 Claude CLI 当作模型端点来运行，为 LLM 缝隙提供一条提供方路由：每次模型调用一个进程，且只使用单一租户的凭据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-cli

[English](README.md) | 中文

## 概述

`dsh-llm-claude-cli` 注册一条 `dsh-llm` 提供方路由，通过运行 Claude CLI 来回答模型调用。一次 `stream()` 调用就是一个 CLI 进程。本包拥有该进程的生命周期，而不拥有协议：[`dsh-claude-cli-protocol`](../claude-cli-protocol/README.zh.md) 决定这次调用说什么、它的输出意味着什么，因此留在这里的是启动进程、读取 stdout、判定退出，以及保证无论进程如何结束都恰好产出一个终止 chunk。

这条路由有意做得很窄。CLI 是一个一次性的提示词接口，而不是无状态的对话端点，因此本包对它无法表达的东西选择拒绝而不是丢弃 —— 见[这条路由接受什么](#use-this-package)。

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

### 组装这条路由

```yml
- id: llm-claude-cli
  name: '@deepseek-ai/dsh-llm-claude-cli'
  config:
    cwd: /srv/candy/work
    home: /srv/candy/pools/9f2c…
    apiKeyEnv: CANDY_TENANT_KEY
```

`home` 是该运行的[运行时池根目录](../../control-plane/runtime-pool/README.zh.md)，`apiKeyEnv` 指明在加载时从哪个变量读取凭据。没有可注入凭据的路由会让整个组装失败，而不是先注册、之后再失败。

### 这条路由接受什么

一个用户回合的文本、一段系统提示词、一个模型 id，以及一个推理力度。其余一律以 `UNSUPPORTED_REQUEST` 拒绝，并指明是哪一项让运行停下：

| 请求携带 | 结果 |
|---|---|
| 单条用户消息，且只有文本块 | 运行 |
| `system`、`model`、`reasoningEffort`（`low`…`max`） | 运行；各自映射到一个 CLI 开关 |
| 多于一条消息 | 拒绝 —— CLI 不回放助手历史 |
| 非文本块 | 拒绝 —— 位置参数提示词只承载文本 |
| `tools` | 拒绝 —— CLI 不接受调用方提供的工具模式 |
| `maxTokens`、`temperature`、`stop` | 拒绝 —— CLI 没有对应开关 |

拒绝正是要点。这些项在 CLI 上都没有表达方式，而悄悄丢弃其中任何一项，都会在调用方毫不知情的情况下改变对模型的提问。拒绝发生在 `stream()` 调用处，在启动任何进程之前。

### 每租户一个实例，而不是按请求携带身份

`ClaudeCliAdapter` 把某一个租户的 home 与凭据放在实例上。多租户运行时为每个运行时池构造一个适配器；它不会只加载一次本插件、再按请求改变身份。`stream()` 上没有任何参数能让一个租户的请求触及另一个租户的凭据。

```ts
import { ClaudeCliAdapter } from '@deepseek-ai/dsh-llm-claude-cli'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

declare const run: AdmittedRun
declare const subprocess: SubprocessRuntime

export const adapter = new ClaudeCliAdapter({
  executable: 'claude',
  cwd: run.poolRoot,
  isolation: { home: run.poolRoot, apiKey: Buffer.from(run.secret).toString('utf8') },
  graceMs: 5_000,
  maxOutputBytes: 16 * 1024 * 1024,
  spawn: spec => subprocess.spawn(spec),
  requireCredentialIsolation: true,
})
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/request.ts`](src/request.ts) | `projectRequest`：把一次 harness 请求投影为一次调用，或给出具名的拒绝 |
| [`src/adapter.ts`](src/adapter.ts) | `ClaudeCliAdapter`：进程生命周期、stdout 读取、退出判定 |
| [`src/index.ts`](src/index.ts) | 插件本体、它的 `Config` 与 `resolveAdapterOptions` |
| — | 不发布运行时不变量伴生模块；缝隙自身的 `dsh-llm/invariant` 已经在每条提供方流周围检查 chunk 文法，而本包不拥有其他可独立观察的关系。 |

### 为什么拒绝历史而不是把它摊平

CLI 的 `--input-format stream-json` 只接受用户消息，而它接受的每一条都会开启自己的回合、带自己的终止帧 —— 一次录制的两条消息输入产出了两个 `result` 帧。因此它不回放任何助手历史，也无法服务一次模型调用。另一条路是把对话渲染成提示词文本，那意味着发明一种本仓库没有依据的转录格式；一旦弄错就会悄悄降低模型输出质量，而 harness 中没有任何地方会显示出来。这个决定要等到出现真正需要它的消费者。

### 恰好一个终止 chunk，三条抵达路径

CLI 的终止帧结束一次正常的运行。当 stdout 在没有终止帧的情况下关闭时，说明运行被取消了或进程死了，而这两者的判定方式不同。取消只从调用方的信号读取，绝不从进程读取：subprocess 缝隙只是*启动*了终止阶梯，因此一个忽略 `SIGTERM` 的子进程会在调用方早已放弃之后，仍把这次运行占住整个宽限期。只有没人取消的运行才会等待退出事实，再由它指出退出码或信号。

被中断的运行仍然报告它已经发送过的计数 —— 翻译器保留最后一次 `message_delta` 的用量，正是为了让被杀死的进程有账可算，而不是悄悄免费。

### 隔离检查在这里被强制执行，而不只是被报告

### 为什么失败会被脱敏

`result` 帧的文本会原样成为失败消息，因此一个把自己的凭据引述回来的 CLI —— 在一次认证错误里，或者在任何回显自身环境的诊断里 —— 会把租户的密钥放进会话日志，并摆到模型面前。持有那个被注入密钥的是本包，而 [`dsh-claude-cli-protocol`](../claude-cli-protocol/README.zh.md) 在不知道这个秘密的情况下翻译帧，因此这次替换要么发生在这里，要么哪里都不会发生。

只有诊断文本会被改写。模型输出是租户自己的内容，悄悄编辑它会毁掉一个合法的回答 —— 比如一个关于密钥长什么样的回答。

### 为什么这次运行带着一个 stdout 上限

子进程缝隙为自行解码协议的调用方提供 `'pipe'`，并把原始流交出来 —— 因此界定它是本包的事，而这条路由上没有任何别的东西界定任何东西。读进来的每一个字节都会被累积：在一行尚未结束时累积进那半行，在它的帧解析成功后累积进一个内容块。这条路由还会拒绝 `maxTokens`，因为 CLI 没有输出 token 的开关，于是响应长度也没有别的上限。

`maxOutputBytes` 就是那个上限，按字节而不是按码元计数，因此它界定的是运行时真正持有的东西。超过它会终止进程并让这次运行失败，而不是截断：截断适合模型要读的工具结果，而一个写了一半的帧根本解析不了，因此一个被截短的响应看上去反倒像是完整的。默认值是 16 MiB —— 录制到的运行把一次简短的对话装在 8 KB 里，而一个最大的响应仍在约一兆字节以内，因为文本在 `result` 帧里被带一次，在各个增量里又被带一次。

`dsh-claude-cli-protocol` 能说出 CLI 是否用注入的密钥完成了认证；但只有本包拥有一次可供失败的运行。在 `requireCredentialIsolation`（默认开启）下，一个指向其他凭据来源的 init 帧会在流中途抛出，于是一次触及了宿主自身登录态的运行会停下，而不是完成并记账给一个从未提出请求的人。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-claude-cli-protocol`](../claude-cli-protocol/README.zh.md) —— 这次调用说什么、它的输出意味着什么，以及本适配器所依赖的三项实测 CLI 行为。
- [`dsh-llm`](../llm/README.zh.md) —— `LlmAdapter` 契约与 `StreamChunk` 协议。
- [Claude CLI 的流式协议：实测](../../../.agents/notes/implemented/architecture/2026-09-03-claude-cli-stream-protocol.zh.md) —— 为什么直接解析协议而不走 Agent SDK。
- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md) —— 按实例隔离所强制执行的「代理人混淆」规则。

-----

<a id="model-experience"></a>
## 模型体验

### 调用方的文本，透传给 CLI

#### 模型看到什么

请求中那唯一一个用户回合成为 CLI 的位置参数提示词，`options.system` 成为它的 `--system-prompt` 值；两者都按文本块顺序拼接后原样传递。省略系统提示词会让 CLI 自带的智能体提示词继续生效，于是模型收到的是 Claude Code 的指令而不是 harness 的 —— 想要替换它们的路由必须发送一个。本包不写入自己的任何提示词文本，也不在调用方的文本外添加包装、前缀或分隔符。

#### Token 影响

无直接影响：请求的 token 恰好是调用方那两段文本。本包拥有的影响都是削减。拒绝对话意味着这条路由根本不发送历史，因此它的请求不会随回合增长。而协议包构造的调用又阻止 CLI 从工作目录加载环境中现成的项目上下文 —— 不受约束的运行是会读取它的。

#### KV 缓存影响

每次调用相互独立。每次 `stream()` 都是一个全新进程与一个全新 CLI 会话，因此请求之间不携带任何前缀，本包的任何选择也无法使一个可复用的前缀失效。提供方仍可能在服务端对相同前缀做缓存；那不在本路由的契约之内。

### 本路由记录的助手内容

#### 模型看到什么

本轮什么也看不到；它是后续轮次会回放的东西 —— 如果后续轮次能回放的话，而对这条路由来说它不能，因为对话会被拒绝。在一次调用之内，这些 chunk 就是模型自己的输出，因为协议包只读取 CLI 的流式事件，并丢弃那些把失败文本当作助手内容承载的合成帧。

#### Token 影响

对本轮无直接影响，跨轮次也没有保留影响：既然对话被拒绝，这里记录的内容就绝不会被本路由送回给模型。

#### KV 缓存影响

相互独立。块按流序追加到调用方的会话日志中，而被本路由判定为 error 或 aborted 结束的运行完全不贡献内容块，因此一次失败绝不会落进另一个请求会携带的对话记录里。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是本包当前的约束，不是任务清单。

- **智能体循环无法使用这条路由** —— 循环在每个请求上都发送对话历史与工具模式，而两者都会被拒绝。这条路由服务一次性调用，也就是缝隙自身那些辅助用途（`compaction`、`session-title`）的形状。要服务循环，需要先后解决下面的历史与工具决定。
- **没有工具往返** —— CLI 没有接受调用方工具模式的开关；要触及它们意味着通过 MCP 服务器暴露 harness 的工具，而本包不构建它。CLI 输出中的工具调用块仍会被翻译，因此这道缺口只在入站方向。
- **成本只在最后到达，而且只是一个数** —— usage chunk 携带 CLI 的 `total_cost_usd` 作为 `costMicroUsd`，因此一次在终止帧之前就死掉的运行，无论花了多少都不报告成本，而按模型的构成也被丢弃。`maxBudgetUsd` 仍然独立于所报告的内容给一次运行封顶。
- **没有重试分类** —— 每种失败都映射到 `CLI_EXIT` 或协议包的 `terminal_reason`，也没有声明本路由拥有的重试策略，因此 `dsh-llm-retry` 会用默认策略对待这些失败。CLI 还会在报告之前内部重试，那对该策略是不可见的。
- **`resolveModel` 不做任何校验** —— CLI 不发布目录，且同时接受别名与精确 id，因此任何模型 id 都会被报告为可解析，写错的那个会表现为 CLI 失败而不是路由错误。
- **按构造每个实例只服务一个租户** —— 这正是隔离性质本身，但也意味着服务多个租户的部署要自行为每个池构造并释放一个适配器；这里不管理那套生命周期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 组装测试所用的夹具是在不加 `--bare` 的情况下录制的，因此它报告的是环境中现成的凭据，于是该测试关掉了 `requireCredentialIsolation` 以便走通输出。要录制一次隔离的*成功*运行需要真实 API 密钥，而产出这些夹具的机器没有 —— 它只有一个 OAuth 会话，而 `--bare` 有意忽略它。若能录到两者兼备的夹具，该测试就可以保留出厂默认值。
- 被拒绝的请求究竟应当是抛出的 `LlmError` 还是一个终止的 error finish，值得在出现「宁愿绕开这个提供方也不愿失败」的调用方时重新考虑；今天抛出是对的，因为悄悄降级的请求比响亮失败更糟。

</details>
