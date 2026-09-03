# Agent Note: 一份记录稿钉不住一个没有任何东西为它定序的事件

Status: implemented

[English](2026-09-03-acp-snapshots-exclude-the-late-twin.md) | 中文

## Problem

八个 ACP 快照场景中有六到七个失败，而且失败的是哪几个每次运行还不一样：完整跑 `test:snapshot` 时是六个，单独跑 ACP 语料时是七个。每一次失败都是多出的一行 —— 一条携带 `config_option_update` 的 `session/update` —— 而没有任何一份已提交的 `stdout.expected.jsonl` 含有它。

给 `LlmRuntime.emitAdaptersUpdated` 与 `AcpSession.topologyChanged` 加上探针，把原因点得很准。`llm-deepseek` 在 apply 期间就注册好它的适配器，早于任何客户端请求。而被基础 profile 以休眠姿态挂载的 `llm-pi-ai` 要晚大约九百毫秒才完成 apply，它的 `registerConfigurableProviders` 就在那时发布 `llm/adapters-updated`。到那一刻客户端的 `session/new` 已经创建了会话，于是 ACP 的 `llm/adapters-updated` 监听器通知了它。

有两个事实让它不只是「没被记录」，而是根本钉不住。这条通知的负载正是同一个会话的 `session/new` 响应已经返回过的那份选项集合，因此它没有携带客户端尚未拥有的任何东西。而它的到达时机与这段交互中的任何东西都没有定序关系：它出现在 `session/new` 响应之前、之后，还是根本不出现，取决于启动是否在场景结束之前完成。

## Decision

ACP 快照的基础补丁把 `llm-pi-ai` 关掉。该条目旁边的注释写明了原因，而每个 ACP 场景都会继承它，因为 `snapshots/acp/escalation-approved/cordis.yml` 正是本套件对所有场景应用的那个基础补丁。

这让这些场景断言的是「一个适配器的路由之上的 ACP 协议表面」，而这本就是它们在断言的东西：语料中每一份预期的 `configOptions` 负载列出的都只有 `deepseek-official` 路由，因此那个休眠的孪生适配器在被关掉之前也没有贡献任何覆盖。

### 这条通知是正确的，而这正是关键

ACP 的拓扑随时可能变化，`config_option_update` 就是协议用来陈述这件事的机制；客户端本就必须处理它。这里没有任何缺陷被掩盖。一份已提交的记录稿做不到的，是固定一个没有任何请求引发的事件的行位置，而没有任何测试侧的等待能把它与一个和它赛跑的响应定序。

### 有意没有改动的部分

让 `AcpSession.topologyChanged` 在选项集合与它上次发布的相同时跳过通知，可以从源头消除这场竞争，而这正是 `llm-pi-ai` 已经用在自己的注册与目录替换上的那道守卫。但它是一次产品行为变更 —— 今天客户端会收到的一条通知将不再到达 —— 因此把它记在这里，而不是作为一次测试修复的一部分做掉。

让 ACP 服务器在插件图完成 apply 之前拒绝请求也能消除它，而这才是更大的发现：一个立刻连上来的客户端可能读到一份仍在填充中的 `listConfigurableProviders()`。那是每一个 ACP 客户端都会遇到的启动语义，不是快照层面的事。

## Consequences

ACP 语料是确定的了：连续三次运行以及完整套件中，十五个测试都通过。`test:snapshot` 中仅剩的那一处失败与此无关，且属于环境问题 —— 一台既没有 bubblewrap 也没有启用 Landlock 的内核的主机会拒绝运行被沙箱约束的 `bash` 工具，因此 SDK 的 `bash-tool` 场景记录到的是 `SANDBOX_UNAVAILABLE` 结果而不是命令输出。

本套件不再原样启动已发布的 ACP profile。它本来也没有 —— 同一份基础补丁早就钉住了 `llm-deepseek` 的模型清单、沙箱模式与审批策略 —— 但被测组合与实际发布的组合之间的差距又宽了一个条目，而一个需要两个适配器家族都注册的场景必须撤销这个条目，并接受它无法比较一份有序的记录稿。

## Alternatives considered

**带着这条通知重新录制预期记录稿。** 如果这只是一份过期的录制，那就该这么做；而诊断结果恰恰排除了它：这个事件是竞争性的，而不只是新增的，因此重新录制只是把录制那一次所走的那一侧竞争结果祝福下来。完整运行与单独运行之间的差异就是证据。

**增加一个 `waitForConfigOptions` 输入步骤。** 该 harness 的等待词汇是基于条件而不是基于计时的，所以这与它的风格相符，也确实能让通知可靠地出现。但它修不好行位置：这条通知与 `session/new` 响应赛跑，而一个在该响应之后才运行的步骤无法为两者定序。

**在快照归一化器里过滤掉这条通知。** 予以否决：一个丢弃某类通知的归一化器，会掩盖该类通知未来的每一次回归，而这份语料存在的目的正是抓住它们。
