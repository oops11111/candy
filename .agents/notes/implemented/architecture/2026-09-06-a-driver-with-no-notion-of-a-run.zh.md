# Agent Note：一个不知道运行为何物的委派器

状态：已实现

[English](2026-09-06-a-driver-with-no-notion-of-a-run.md) | 中文

## 问题

[没有人铸造断言](2026-09-06-no-one-mints-an-assertion.zh.md) 给了 `RunScheduler.startChildRun` 一种为受委派子会话铸造并准入一次运行的方式，其范围被限定在唯一不需要新身份验证的场景——一个子会话只是重申其父会话已经验证过的身份。但没有任何代码调用它。`dsh-subagent` 的进程内一次性委派器通过 `ctx.agents.create()` 创建子 agent，完全不携带 Candy 运行的概念，而它仅有的生命周期事件——`subagent/start`、`subagent/end`——都在子 agent 已经发布之后才触发，这为时已晚：铸造一次运行是异步的，一个在其运行完成开启之前就开始发起模型调用的子会话,可能在任何东西限定它之前就已经产生花费，若铸造之后失败，情况会更糟——它会完全不受约束地运行，因为没有任何东西挡住过它的第一次请求。

塑造了 `dsh-tenant-preset-policy` 与 `dsh-agent-presets` 之间关系的那条包边界规则再次适用：`dsh-subagent` 是一个通用的 Harness 包，其他组装也会加载它，且完全不携带 Candy 的概念，因此这次修复不能直接教会这个委派器租户、预算或断言。

## 决策

`dsh-subagent` 的 `SubagentRuntime` 得到了一个通用扩展点：`onBeforeDelegate(hook: ChildDelegationHook): () => void`，其中 `ChildDelegationHook = (parent: Agent, childId: SessionId) => Promise<void> | void`。钩子保存在一个 `AnonymousEntries` 登记表中（与 `AgentPresets.guard()`、`ToolRuntime.guard()` 早已使用的同一个幂等处置器原语），并按注册顺序通过 `prepareDelegatedChild(parent, childId)` 依次运行——这是一个公开方法，委派器在调用 `ctx.agents.create()` 之前会等待它完成。此时 `childId` 已经存在：`startInProcessRun` 在创建之前就通过 `brandString<SessionId>(randomUUID())` 计算出它，正是为了让一个创建前的钩子有一个可以用来指称这个子会话的名字。一个抛出异常或拒绝的钩子会让整个委派彻底中止——因为此时还什么都没创建，所以没有什么需要回滚，这与守卫（guard）那种 `string | undefined` 的拒绝形状不同,后者适合一个没有异步准备工作要先运行的判断。

这与 `AgentPresets.guard()` 不仅是名字不同,而是种类不同：一个守卫回答一个没有副作用的同步是否判断，而一个委派前钩子执行的是异步工作（铸造并开启一次运行），调用方必须先等待它完成才能继续。`subagent/start`/`subagent/end` 曾被考虑作为钩子点，但因为上面描述的那个竞态而被否决：两者都在发布之后触发，若把一次异步铸造挂在其中任何一个上,子会话的第一次请求就会与运行自身的准入过程产生竞态。

`dsh-run-delegation` 是把两者组合起来的、新的 Candy 自有的包：一个函数插件（`name`/`inject`/`Config`/`apply`，没有服务，也没有默认导出），其 `Config.childBudget` 是为每一个受委派子会话请求的一份固定 `RunBudget`。它的钩子调用 `RunScheduler.startChildRun(parent.id, childId, () => config.childBudget)`，并在父会话解析不出唯一一个可用的运行时（被多个开启中的运行认领，或其账户已被吊销）,或铸造成功但准入或账本拒绝按精确的请求提供资金时（父租户的额度已耗尽，或其自身剩余的额度在某一维度上不够 `childBudget`）,抛出一条描述性的 `Error`。一个完全没有开启中 Candy 运行的父会话——即 `startChildRun` 自己的 `findSessionRun` 根本解析不出运行——则被放行不管，这与 `RunScheduler.tenantOf` 和 `dsh-tenant-preset-policy` 已有的「不是这个运行时该资助的」默认行为一致。

拒绝原因的格式化函数对准入阶段那个深层联合类型采取的是窄化处理而非穷举：一个被铸造的子会话的声明是从其父会话已经通过准入的记录中复制而来，并携带一个新生成的运行 id 与 nonce，因此除了委派租户自身额度耗尽之外,`RunRejection`/`RunLedgerRejection` 命名的每一个阶段都是在防范一个伪造的、被重放的、不匹配的或过期的令牌——而这个调用点从不产生这样的令牌。这些分支被标记为 `v8 ignore if`，而不是靠人为构造调度器内部状态去执行到它们，因为那样做测试的是 `dsh-run-admission` 与 `dsh-run-ledger` 自己已经覆盖过的逻辑，而非这个包自己的逻辑。

## 后果

一个组合了 `dsh-subagent` + `dsh-run-scheduler` + `dsh-run-delegation` 的 Candy 部署，现在会在子 agent 存在之前，为每一次进程内一次性委派开启一次真实的、有资金的、有父子关系的运行。子会话自己的模型调用会像一次根运行一样对照这次运行计量，其未花费的余量也会在子会话结算时归还给父会话——促成这项工作的那个症状，即 `dsh-claude-cli-route` 以 `RUN_NOT_OPEN` 直接拒绝一个受委派子会话的会话，对于加载了这个插件的部署不再发生。任何其他 `dsh-subagent` 的部署——完全没有 Candy 运行概念的那些——都不受影响：钩子登记表在有东西向它注册之前一直是空的，委派器自身的行为与测试都没有改变。

两个包各自的真实组合测试证明了这条链路：`dsh-subagent-spawn-in-process` 的测试套件证明了一个已注册的钩子会在子会话创建之前运行、能看到父会话与子会话未来的 id、多个钩子按注册顺序运行、一个抛出异常的钩子会在不留下孤儿子会话的情况下拒绝委派，并且一旦被处置就不再被咨询；`dsh-run-delegation` 的测试套件启动一个真实的调度器（真实的已准入运行、一个真实的、以 SQLite 为后盾的控制平面存储）与真实的 `SubagentRuntime` 及其内置的 spawn 提供方一起运行，并证明了一次委派会按配置的预算资助子会话并把它挂到委派运行下、在父会话无力承担精确请求或已耗尽时拒绝委派、在父会话被多个开启中的运行认领或其账户被吊销时拒绝委派，以及在父会话没有开启中的 Candy 运行时不受限制。

可续接的子会话（`dsh-subagent` 的续接管理器）与进程外的产品提供方（例如 `dsh-subagent-claude-code`）并未接到这个钩子上，它们的委派没有一次 Candy 运行为其提供资金——参见该包自己的「已知限制」一节。一个可续接子会话的运行,或许需要在每次恢复时重新开启,而非只在创建时开启一次，因为一次运行的租约会在子会话处于休眠状态期间过期；这个生命周期问题被刻意排除在这一批次之外。

## 考虑过的替代方案

**把铸造挂在 `subagent/start` 上，而不是一个新的创建前钩子。** 已拒绝：`subagent/start` 在子 agent 已经发布、其生命周期已经交给调用方之后才触发。一次挂在那里的异步铸造会与子会话自己的第一轮对话产生竞态，`drivePublishedRun` 会在 `ctx.agents.create()` 解析之后立刻安排它——一个子会话可能在有运行限定它之前就已发起第一次模型调用，而一次之后失败的铸造也没有已创建但未发布的状态可供回滚，这与创建前钩子那种干净利落的拒绝不同。

**给委派钩子也套上守卫那种 `string | undefined` 的形状，保持它同步。** 已拒绝：铸造并开启一次运行需要一次异步的 `ControlPlaneStore` 写入，在账本路径上还需要一次排队的链式操作——没有同步的答案可给。强行同步要么意味着让钩子依赖一份预先取得的缓存（这份状态可能在取得与使用之间过期），要么意味着把实际的铸造挪到另一个仍未解决的钩子点上，这只是把同一个问题换了个说法。

**把子会话开启运行的逻辑直接叠加进 `dsh-subagent-in-process-driver`。** 已拒绝：这个委派器是一个通用的 Harness 包，不携带 Candy 运行、租户或预算的概念；教会它这些概念，会重复 `AgentPresets.guard()` 当初为 preset 名册特意避免的那个错误，也会让这个委派器的每一个非 Candy 消费方都背上它从未走到过的代码路径。

**用一个按调用计算出的份额取代一份固定的 `config.childBudget`。** 曾经考虑过，因为一次真实的部署或许想给一个后台调研任务比一次快速查询更宽裕的资金。这一批次里拒绝了：目前没有消费方需要它，而 `startChildRun` 自己的 `share` 参数早已接受任意一个函数——一个想要按调用计算份额的部署，可以直接针对 `onBeforeDelegate()` 组合自己的钩子，而不必让这个包生长出一套用来表达它的策略语言。一份固定的额度是更小的、有证据支撑的默认值；按任务给出不同份额被推迟到有消费方真正需要它的那一刻。
