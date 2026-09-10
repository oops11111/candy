# Agent Note: 没人见过的 Codex 帧

Status: implemented

[English](2026-09-10-the-codex-frames-nobody-had-seen.md) | 中文

## 问题

R2 剩下的提供方是 Codex CLI 的 `LlmAdapter`,而它被「不知道协议长什么样」卡住了。所陈述的阻塞点是一台能访问 OpenAI API、已登录 Codex CLI 的机器,并附带一条规则:解析器要等真实录制,因为从几个帧名猜出来的协议,是一个只在那几个例子上成立的解析器。

在接受这个说法之前,有两件事值得核实。Codex CLI 0.149.1 的二进制早已是 `dsh-subagent-codex` 的依赖,并且在本环境中可以运行;而该包已经在用一个本地脚本化的 Responses 服务器驱动它,真实产品测试全部通过。因此 CLI *自身*的帧结构无需任何 OpenAI 账号即可触及;真正触及不到的,只有上游账号才会产生的那部分。

`dsh-subagent-codex/src/wire.ts` 所知道的东西也比适配器所需要的更窄。它处理线程与回合的生命周期、`item/completed`、审批与中断,因为子代理只需要一个最终答案。而适配器需要流式文本、token 用量、失败与取消,而这四样在任何地方都没有被录制过。

## 决定

用真实二进制录下这四种情形,逐字固定帧词汇表,并且不写解析器。

`packages/subagent/subagent-codex/tests/recorded-protocol.spec.ts` 通过该包自己固定的包装器 argv 和该包自己的 Responses 夹具启动真实的 `codex app-server --stdio`,捕获它写出的每一行 JSON-RPC,并钉住未来适配器将要读取的内容。录制得出四项发现,其中三项与读者会去找的位置相矛盾:

**流式文本是 `item/agentMessage/delta`。**`item/completed` 随后会把整个答案再重复一遍,因此只针对完成帧写出的解析器根本产生不出任何流。

**token 用量是独立的一条通知。**`thread/tokenUsage/updated` 携带 `totalTokens`、`inputTokens`、`cachedInputTokens`、`cacheWriteInputTokens`、`outputTokens`、`reasoningOutputTokens`、`modelContextWindow`,以及 `total` 与 `last` 的区分。这些都不在 `turn/completed` 上,而 Claude CLI 的对应物正是放在那里。`cacheWriteInputTokens` 与 total/last 的区分,无法从 harness 的词汇表推导出来。

**没有任何帧携带成本。**Claude CLI 会报告 `total_cost_usd`;Codex 没有任何等价物,因此想要成本的适配器要从 token 与价目表算出来,或者报告它缺失。该录制断言没有任何帧匹配 cost 或 USD,因此日后新增了该字段的 CLI 会让这个用例失败,而不是被默默忽略。

**被取消的回合是一种状态,而不是一个错误。**`turn/interrupt` 除线程 id 之外还要求回合 id,而它产生的是 `status: 'interrupted'`、`error: null` 的 `turn/completed`。失败的回合则被报告两次:一条携带 `codexErrorInfo.responseTooManyFailedAttempts.httpStatusCode` 的 `error` 通知,以及回合自身上的同一个错误。

录制过程中有两处拼写是由二进制纠正的,而不是读出来的:`thread/start` 请求中的 sandbox 取值是 kebab-case(`read-only`、`workspace-write`、`danger-full-access`),而线程回显时又变成 camelCase;另外,解析到环境代理的 app-server 会去访问 `chatgpt.com` 而不是 loopback 夹具,这正是该 harness 清空每一个代理变量的原因。

## 考虑过的替代方案

**现在就按 `wire.ts` 里的帧名写适配器。**否决,而录制说明了原因:适配器最需要的那两个帧——文本增量与用量通知——根本不在 `wire.ts` 里,而且用量也不在 Claude CLI 的位置所暗示的地方。

**等到有 OpenAI 访问权限的机器再开始录制。**在发现二进制可以在这里运行之后否决。协议的大部分是 CLI 自身的帧结构,真实二进制面对任何 Responses 端点都会发出它们;现在录下来,就把阻塞缩小到真正需要账号的那一部分。

**自己手写一个 Responses 服务器来录制。**在尝试之后否决:该包的夹具已经能流式输出文本、函数调用、错误和一个挂住的响应,而它对环境的处理正是真实测试能抵达 loopback 的原因。手写的那次尝试访问了 `chatgpt.com` 并被拒绝。

**新建一个空的 `dsh-codex-cli-protocol` 包来存放夹具。**否决。一个只有夹具、没有解析器的包没有当前归属者,而录制内容属于真实二进制已经被运行的地方;适配器的包在适配器出现时再建。

## 结果

阻塞变小了,而且被点了名。现在可以针对已录制的流式文本、用量、失败与取消帧来写 Codex 适配器,而日后 CLI 的协议变化会先让这个 spec 失败,而不是先到达适配器。

仍然需要已登录账号的只有三件事,不多不少。没有账号时 `account/rateLimits/updated` 的每个字段都是 null,因此真实的限额窗口、套餐类型与消费控制状态都未被录制。真实的上游拒绝——无效密钥、配额耗尽——可能携带与夹具产生的 429 不同的 `codexErrorInfo` 变体。而真实用量数字与夹具的差异是种类上的还是数值上的,尚未验证。

成本这项发现改变的是设计,而不只是证据。`AdmittedRun` 记账与 `dsh-run-metering` 按 micro-USD 计费,而一次 Codex 运行无法报告它花了多少钱。在价目表、只认提供方报告的策略,以及改为按 token 计费之间做出抉择,是这次录制让其变得可见、而非由它完成的 R2 工作。

这为测试套件增加了一个真实二进制测试。它启动 app-server 四次,耗时约四十秒,与该包已有的真实产品 spec 所付的代价相同。

## 验证

`packages/subagent/subagent-codex/tests/recorded-protocol.spec.ts` 在本环境中针对 `@openai/codex` 0.149.1 通过:流式增量及其与 `item/completed` 的顺序、用量通知的确切字段名连同 `turn/completed` 上没有用量以及没有任何成本字段、带 HTTP 状态的双重报告失败,以及被中断回合的状态。

两项变异对照证明这些断言绑定在录制上而不只是复述它:把 `cacheWriteInputTokens` 改成一个看似合理的替代名,以及把增量方法名改成 `item/agentMessage/chunk`,各自都会让对应用例失败,随后 spec 被还原。
