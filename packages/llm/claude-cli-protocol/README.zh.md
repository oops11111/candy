---
description: "Claude CLI stream-json 帧解码、StreamChunk 翻译,以及把一次运行限定在单一租户凭据上的参数向量与环境。"
kind: "package-library"
---

# @deepseek-ai/dsh-claude-cli-protocol

[English](README.md) | 中文

## 概述

`dsh-claude-cli-protocol` 回答两件事:Claude CLI 的 `--output-format stream-json` 输出意味着什么,以及一次调用必须说什么。它解码 CLI 以行分隔的 stdout,把这些帧翻译成 harness 的 [`StreamChunk`](../llm/README.zh.md) 词汇表,并组装出参数向量与环境覆盖层,使一次运行成为一个纯粹的流式模型端点,且只花费某一个租户的密钥。本包不启动任何进程:运行 CLI 的适配器提供进程,因此这里的一切都可以针对已录制的输出来测试,不需要凭据、网络或子进程。

这些行为是从 `claude` 2.1.259 及随其分发的 `@anthropic-ai/claude-agent-sdk` 声明中实测得出的,而非来自文档;两份测试夹具都是真实录制的运行。其中三项发现是关键且无法靠猜测得到的,记录在[理解实现](#understand-the-implementation)一节。

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

### 读取一次运行的输出

```ts
import { ClaudeCliFrameTranslator, ClaudeCliLineDecoder } from '@deepseek-ai/dsh-claude-cli-protocol'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

declare const stdout: AsyncIterable<string>

export async function* run(): AsyncIterable<StreamChunk> {
  const decoder = new ClaudeCliLineDecoder()
  const translator = new ClaudeCliFrameTranslator()
  for await (const chunk of stdout) {
    for (const frame of decoder.push(chunk)) yield* translator.translate(frame)
  }
  for (const frame of decoder.flush()) yield* translator.translate(frame)
}
```

两个对象都持有单次运行的状态,因此各自只服务一个进程。若 CLI 未发出终止帧就退出,则由 `translator.end(reason)` 收尾:它先报告该运行已发送的计数,再给出调用方根据退出本身判定的结束原因。

### 组装一次隔离的调用

```ts
import { claudeCliArguments, claudeCliEnvironment } from '@deepseek-ai/dsh-claude-cli-protocol'

export const spec = {
  argv: ['claude', ...claudeCliArguments({ prompt: 'summarize this', model: 'claude-opus-5' })],
  env: claudeCliEnvironment({ home: '/srv/candy/pools/abc', apiKey: 'sk-ant-tenant' }),
}
```

`home` 是该运行的[运行时池根目录](../../control-plane/runtime-pool/README.zh.md);CLI 由它推导自己的按用户状态目录,因此它正是把一个租户的提供方状态与另一个租户分开的东西。环境是一个 [`dsh-subprocess`](../../subprocess/subprocess/README.zh.md) 覆盖层:两个显式字符串会越过该缝隙的父环境清洗保留下来,其余条目都是墓碑。

### 确认这次运行花的是正确的凭据

```ts
import { isCredentialIsolated } from '@deepseek-ai/dsh-claude-cli-protocol'
import type { WireFrame } from '@deepseek-ai/dsh-claude-cli-protocol'

declare const frame: WireFrame

export const verdict = isCredentialIsolated(frame)
```

CLI 会在其 `system`/`init` 帧中声明自己用哪一个凭据完成了认证。`true` 表示用的是注入的租户密钥;`false` 表示它找到了别的凭据;`undefined` 表示这一帧不是该声明。把 `false` 视为致命的调用方,会在计费发生之前而不是之后让一次配置错误的运行失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/lines.ts`](src/lines.ts) | `ClaudeCliLineDecoder` 与 `ClaudeCliProtocolError`:从 stdout 文本到帧 |
| [`src/frames.ts`](src/frames.ts) | `ClaudeCliFrameTranslator`、`mapUsage`、`mapFinish`:从帧到 `StreamChunk` |
| [`src/launch.ts`](src/launch.ts) | `claudeCliArguments`、`claudeCliEnvironment`、`isCredentialIsolated`、`SCRUBBED_ROUTING_VARIABLES`、`SCRUBBED_STATE_VARIABLES` |
| [`src/types.ts`](src/types.ts) | CLI 帧联合体中本包实际处理的那个子集 |
| — | 不发布运行时不变量伴生模块;本纯模块不拥有事件流或可变运行时数据,其翻译由针对已录制运行的单元测试保障。 |

### 终止帧在整体失败的运行上仍报告成功

一次每个请求都认证失败的运行,结束时依然是 `subtype: "success"`。因此 `mapFinish` 从不读取 `subtype`;区分正常完成与失败的是 `is_error`,而 `api_error_status` 与 `terminal_reason` 描述失败本身。`auth-failure.jsonl` 夹具正是这次运行,并有测试同时断言该帧写着 `success`、而翻译结果是 error,使两者不会悄悄错位。

### 有意忽略 CLI 的 `assistant` 帧

它们与已经送达同样内容的 `stream_event` 增量同时到达,两者都读会让每个块发出两次。在失败的运行上,CLI 还会合成一帧,其内容就是失败信息,`model` 为 `"<synthetic>"` —— 读它会把一次传输失败当作模型说过的话写进对话记录。因此只从携带原样 Messages API 流式事件的 `stream_event` 帧中读取内容。

### 只有 `--bare` 能把运行限定在注入的凭据上

没有它,CLI 会回退到宿主机上任何现成的登录态。一次在开发机上录制的运行正是如此:它通过宿主的 OAuth 会话完成认证,并报告 `apiKeySource: "none"` —— 在多租户运行时里,这就是一个租户的请求记在了宿主账上。`--bare` 把 Anthropic 认证限制为 `ANTHROPIC_API_KEY`,这就是它在这里并非可选项的原因。

`--bare` 并不管 CLI 与*哪个提供方*通信,因此单靠它并不够。环境中现成的 `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX` 或 `ANTHROPIC_BASE_URL` 会把运行重定向到一个用宿主自己的云凭据认证的端点,完全绕开租户密钥。`SCRUBBED_ROUTING_VARIABLES` 为每一项设置墓碑;与 `--bare` 合在一起,注入的密钥才成为该运行唯一能触及的凭据。

### 固定的 `HOME` 只有在没有任何变量指向其外部目录时才是隔离

`claudeCliEnvironment` 靠给每个子进程各自的 `HOME` 来区分两个租户,调用方把它设为该租户的运行时池根目录。这种区分是间接的:它成立,是因为子进程的配置、缓存和账户状态都是*相对于* `HOME` 定位的。一个直接指名其中某个目录的变量会在不碰 `HOME` 的情况下破坏这种推导,于是环境看上去仍然是隔离的。`CLAUDE_CONFIG_DIR` 会把 CLI 自己的配置和账户状态迁走,而 XDG 基础目录则指名缓存、配置、数据和状态的根目录。从运维人员的 shell 启动的服务器——或从另一个导出了这类变量的智能体启动的服务器——会把同一个目录交给每个租户读写。

`SCRUBBED_STATE_VARIABLES` 为它们设置墓碑。这份清单覆盖标准的状态目录变量,而不只是已知某个 CLI 版本会读取的那些,因为两种错误并不对称:被设置墓碑而 CLI 又忽略的名字不会改变任何事,因为回退位置正是本就想要的、固定 `HOME` 之下的位置;而漏掉的名字则是两个租户共享的一个目录。

### 帧处理默认是开放的

CLI 把会话簿记、限流报告、hook 与任务活动以及状态复用到同一条流上,其自身声明也把这个联合体描述为开放集合。因此未知的帧标签、未建模的内容块类型与无法识别的增量类型都产出零个 chunk,而不是让运行失败。唯一会失败的是一整行却不是 JSON 对象的 stdout 行,因为那意味着解码器读到的并不是它以为的东西;而结尾未换行的那一行 —— 也就是杀死 CLI 会产生的东西 —— 则被丢弃。

### token 计数是直接映射而非调整

CLI 报告的计数本身就是互不重叠的 —— `input_tokens` 不含两个缓存计数 —— 这正是 harness `TokenUsage` 的约定,因此 `mapUsage` 原样映射。这与 [`dsh-llm-deepseek`](../llm-deepseek/README.zh.md) 相反:它的提供方把缓存命中折进 prompt 计数,必须再减回去。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-llm`](../llm/README.zh.md) —— 本包翻译到的 `StreamChunk` 协议,以及其消费者需实现的适配器契约。
- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md) —— 启动组装在进程边界上强制执行的「代理人混淆」规则。
- [`dsh-runtime-pool`](../../control-plane/runtime-pool/README.zh.md) —— 一次运行的 `home` 从哪里来。
- [`dsh-credential-vault`](../../control-plane/credential-vault/README.zh.md) —— 它的 `apiKey` 从哪里来。
- [多租户 CLI 智能体运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划;本包是 R2 中 Claude CLI 适配器的协议一半。

-----

<a id="model-experience"></a>
## 模型体验

### 调用方的提示词文本，透传给 CLI

#### 模型看到什么

`claudeCliArguments` 把调用方的 `systemPrompt` 原样作为 CLI 的 `--system-prompt` 值传入,它会在该次运行中取代 CLI 自带的智能体提示词。省略它则保留那个内置提示词,于是模型收到的是 Claude Code 的智能体指令,而不是 harness 的。本包不写入自己的任何提示词文本,也不对收到的内容做包装、加前缀或截断;组装请求的调用方拥有其中每一个词。

#### Token 影响

无直接影响。请求的 prompt token 恰好是调用方的 `systemPrompt` 加上位置参数提示词,两者都原样传递。本包唯一拥有的影响是一处削减:`--bare` 与 `--setting-sources ""` 阻止 CLI 预置环境中现成的项目上下文 —— 而不受约束的运行确实会加载它:一次在开发机上录制的、只有两个输入 token 的请求,仍然为被发现的 `CLAUDE.md` 上下文计入了 8273 个缓存写入 token。

#### KV 缓存影响

在传入相同 `systemPrompt` 的多次运行之间保持前缀稳定,因为参数向量是由调用方的值确定性组装的,不含本包自己的任何时间戳、路径或标识符。有两处本包拥有的选择会使复用失效:在两次运行之间改变 `systemPrompt` 会替换掉已缓存的前缀;而省略它会让该次运行使用 CLI 的内置提示词 —— 本包既不固定也不为其版本化,CLI 升级可能在调用方毫无改动的情况下改变它。

### 从 CLI 翻译回来的助手内容

#### 模型看到什么

这条路径上的内容不会在本轮到达模型;它是*后续*轮次所回放的东西。翻译器只发出 CLI 以 Messages API `stream_event` 帧送达的内容,因此记入会话日志的助手文本、推理与工具调用都是模型自己的输出。CLI 合成的 `assistant` 帧被丢弃,这正是把一次传输失败 —— 例如认证错误的 `"Authentication error · This may be a temporary network issue, please try again"` —— 挡在对话记录之外、从而也挡在之后每一个请求的历史之外的原因。

#### Token 影响

对本轮无直接影响。保留:每个发出的块都会进入会话日志,并在后续轮次作为历史回放。被丢弃的合成帧是本包在那些后续轮次上唯一的 token 节省,而丢弃它们出于正确性而非节省。

#### KV 缓存影响

仅追加。翻译出的块按流序追加到对话中,从不改写,因此后续轮次的前缀保持可复用。被本包判定为 error 结束的运行完全不贡献内容块,于是先前的前缀原封不动,而不是被一段模型随后还要读到的失败信息延长。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是本包当前的约束,不是任务清单。

- **没有进程** —— 这里不启动、不取消、不回收 CLI。本包提供适配器读取与表达所需的东西;运行 CLI、把 harness 请求投影到它那个唯一的位置参数提示词上、以及遵守 `options.signal`,都属于消费它的 [`dsh-llm-claude-cli`](../llm-claude-cli/README.zh.md)。
- **只有单条提示词,而非一段对话** —— `claudeCliArguments` 组装的是一条位置参数提示词。回放多轮 harness 历史需要 CLI 的 `--input-format stream-json`,本包没有为其输入消息格式建模。
- **没有工具往返** —— 工具调用块会被翻译,但调用是以 `--tools ""` 组装的,因为工具由 harness 自己执行。把工具结果送回 CLI 属于上面那条对话缺口。
- **只携带调用总额，不携带它的构成** —— `total_cost_usd` 会抵达 `TokenUsage.costMicroUsd`,但终止帧中按模型统计的 `modelUsage` 总量被丢弃。租户的账单是可以还原的;哪个模型挣走了其中哪一部分则不能。
- **隔离结论只报告,不强制** —— `isCredentialIsolated` 读取 CLI 的声明;这里不会让结论为 `false` 的运行失败,因为本包从不拥有可供失败的进程。
- **锁定在一个 CLI 版本上** —— 夹具与帧词汇表来自 `claude` 2.1.259。帧联合体是开放的,所以更新的 CLI 新增帧不成问题;但若它重命名了本包处理的某个字段则不然,那会表现为翻译悄悄不再看到内容。
- **重新录制夹具需要可用的 CLI 与密钥** —— 两份夹具都是真实录制的运行，因此刷新它们是一个手工步骤：用 `claudeCliArguments` 构造的那组参数运行，然后规范化会话 id、uuid、宿主路径与账户遥测数据，并清空被忽略帧的载荷。`text-turn.jsonl` 是有意在*不加* `--bare` 的情况下录制的，因此它固定了本包正是为检测而存在的那个未隔离的 `apiKeySource`；用 `--bare` 重新录制会悄悄让这项覆盖失效。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 隔离结论应当是适配器强制执行的硬前置条件，还是它记录下来的一个事实，尚未决定；这取决于是否存在合法的部署会用非 `ANTHROPIC_API_KEY` 的凭据运行这个 CLI。
- CLI 的 `system`/`api_retry` 帧会暴露其内部重试的次数与状态。今天它们被忽略，但那是调用方唯一能看到一次运行正在 `dsh-llm-retry` 视野之外被重试的地方。

</details>
