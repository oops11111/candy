# Agent Note: Claude CLI 的流式协议：实测而非假设

Status: implemented

[English](2026-09-03-claude-cli-stream-protocol.md) | 中文

## Problem

[多租户 CLI 智能体运行时计划](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)的 R2 需要让 Claude CLI 服务一次 harness 模型请求。计划选定的是直接解析而非走 Agent SDK：以 `--output-format stream-json` 启动 CLI，并把它的输出翻译成 `StreamChunk`。本笔记记录 CLI 实际的行为，因为其中三项与合理假设恰好相反，而按合理假设写出的解析器会以能通过自身测试的方式出错。

当时可用的 CLI 版本是 2.1.259，因此这里的每一条结论都来自实际运行它，或来自随其分发的 `@anthropic-ai/claude-agent-sdk` 0.3.241 声明。`dsh-claude-cli-protocol` 中的两份夹具都是真实录制的运行。

## Decision

`@deepseek-ai/dsh-claude-cli-protocol` 只拥有协议本身：帧解码、翻译成 harness 的 `StreamChunk` 词汇表，以及组装一次隔离的调用。它不启动任何进程，因此整套协议都可以针对已录制的输出来测试，不需要凭据、网络或子进程。运行 CLI 的 `LlmAdapter` 是另一个包，属于后续变更。

### 终止帧在整体失败的运行上仍报告成功

一次每个请求都以 HTTP 401 失败的运行，结束时是 `subtype: "success"`，同时带着 `is_error: true`、`api_error_status: 401` 与 `terminal_reason: "api_error"`。读取 `subtype` —— 那个显而易见的字段，也正是 SDK 自身类型命名为成功/失败判别式的字段 —— 会把一次认证失败报告为一次成功的空回合。因此 `mapFinish` 从不读它。`auth-failure.jsonl` 夹具就是那次运行，并有测试同时断言该帧写着 `success`、而翻译结果是 error，使两者不会在无人察觉的情况下错位。

### CLI 的 `assistant` 帧必须忽略，而不是读取

内容会到达两次：一次是携带原样 Messages API 流式事件的 `stream_event` 帧，另一次是完整的 `assistant` 消息。两者都读会让每个块发出两次。更糟的是，在失败的运行上，CLI 还会以 `model: "<synthetic>"` 合成一帧，其内容就是失败文本 —— 在那次录制的运行里是 `"Authentication error · This may be a temporary network issue, please try again"`。读取 `assistant` 帧的解析器会把传输失败当作模型回合写进对话记录，而之后每一个请求都会把它们作为历史回放。因此只从 `stream_event` 帧中读取内容。

### 只有 `--bare` 能把一次运行限定在注入的凭据上

没有它，CLI 会使用宿主机上任何现成的登录态完成认证。第一次录制的运行正是如此：`ANTHROPIC_API_KEY` 未设置，CLI 使用了宿主的 OAuth 会话，其 init 帧报告 `apiKeySource: "none"`。在多租户运行时里，这就是[边界文档](../../../../docs/candy-runtime-boundaries.zh.md)所禁止的「代理人混淆」失效 —— 一个租户的请求记在了宿主账上。加上 `--bare` 并注入密钥后，同一帧报告 `apiKeySource: "ANTHROPIC_API_KEY"`，这正是 `isCredentialIsolated` 读取该字段的原因：CLI 会声明自己用了哪个凭据，因此运行时可以验证而不是假设。

`--bare` 管认证，但不管路由。环境中现成的 `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX`、`CLAUDE_CODE_USE_FOUNDRY` 或 `ANTHROPIC_BASE_URL` 会把运行送到一个用宿主自己的云凭据认证的端点，完全绕开租户密钥。`SCRUBBED_ROUTING_VARIABLES` 为所分发 CLI 会读取的每一个此类名字设置墓碑；这个开关与这些墓碑合在一起，才使注入的密钥成为唯一可触及的凭据，两者单独都不充分。

### 帧是开放集合，而解码器只在一件事上严格

这条流把 `active_goal`、`autocompact_state`、`rate_limit_event`、若干 `system` 子类型以及其他许多东西复用到同样的行上；SDK 声明了 38 个消息成员，并把该集合记为开放。因此未知的帧标签、未建模的内容块类型与无法识别的增量类型都产出零个 chunk，而不是让运行失败。唯一严格的规则是：一个*完整*的 stdout 行必须是 JSON 对象，因为不是的话就意味着解码器读到的并非它以为的东西。而结尾未换行的那一行 —— 杀死 CLI 会产生的东西 —— 则被丢弃，因为一个被截断的对象不是可以如实报告的帧。

### token 计数直接映射

CLI 的计数本身就互不重叠：`input_tokens` 不含 `cache_read_input_tokens` 与 `cache_creation_input_tokens`。这正是 harness `TokenUsage` 的约定，因此 `mapUsage` 原样映射而不做减法 —— 与 `dsh-llm-deepseek` 相反，后者的提供方把缓存命中折进了 prompt 计数。

## Consequences

R2 适配器可以基于一个已被测试的协议来编写，因此它自己的测试可以只关注进程生命周期、取消与清理，而不是解析。有两项被接受的代价。本包锁定在一个 CLI 版本上：开放的帧联合体能吸收新增内容，但若它重命名了本包处理的某个字段，则会表现为翻译悄悄看不到内容，而只有重新录制夹具才能发现。以及成本被丢弃 —— 终止帧携带 `total_cost_usd` 与按模型统计的总量（其中包含 CLI 自身的辅助调用：一次只有两个 token 的录制请求还计入了一次 `claude-haiku-4-5` 调用），而 `TokenUsage` 没有对应字段，因此仅凭翻译出的 chunk 无法还原一个租户的账单。

有一项测量值得带进 R3：一次不受约束的运行在开发机上为回答一条两 token 的提示词，计入了 8273 个由被发现的 `CLAUDE.md` 项目上下文产生的缓存写入 token。`--bare` 与 `--setting-sources ""` 正是让租户不必为运行时工作目录里恰好存在的东西买单的原因。

## Alternatives considered

**像 `dsh-subagent-claude-code` 那样使用 Agent SDK。** 那个包已经通过 `@anthropic-ai/claude-agent-sdk` 驱动真实的 CLI，复用它本可以省下写解析器。在这条缝隙上它被否决，是因为 SDK 提供的是一个智能体循环，而 `dsh-llm` 缝隙需要的是一次模型调用：工具执行、历史与重试都由 harness 拥有，因此一个委托出循环的适配器会同时拥有两个循环。SDK 的声明被当作文档使用，这里的帧词汇表正来自它。

**把 SDK 的类型当作规范来信任。** 它们准确描述了联合体，但没有描述其行为；其中没有任何地方说明 `subtype` 在失败的运行上是 `"success"`、`assistant` 帧会与流式内容重复，或者不加 `--bare` 时 `apiKeySource` 会报告 `"none"`。这几条都来自实际运行 CLI，这也正是夹具是录制而非手写样本的原因。
