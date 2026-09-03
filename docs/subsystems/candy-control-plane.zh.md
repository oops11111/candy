# Candy 控制平面

[English](candy-control-plane.md) | 中文

[control-plane 组](../../packages/control-plane)负责把一个来自不受信任客户端的请求，变成一个只能花某一个租户的钱、只能待在某一个租户目录里的提供方进程。它由九个包组成，没有正在运行的 Cordis 服务：每个包都被直接导入，而那些会让它成为服务的 OAuth、设备配对与账户存储属于[提议的多租户运行时计划](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)，尚不属于本仓库。

正是这项缺席让本页面有存在的必要。这些包只能按一种顺序组合，每一步的输出都是下一步唯一与租户相关的输入，而仓库里除了它的测试之外没有任何东西执行这套序列。本页面就是那套序列。[Candy 运行时边界](../candy-runtime-boundaries.zh.md)拥有本设计所要应对的信任边界与滥用场景。

## 操作顺序

| 步骤 | 包 | 它决定什么 |
|---|---|---|
| 签发 | [`dsh-execution-assertion`](../../packages/control-plane/execution-assertion) | 控制平面授权了这次运行，为这个租户，授权这么久 |
| 准入 | [`dsh-run-admission`](../../packages/control-plane/run-admission) | 断言是真的、额度没花光、nonce 是新的、凭据能打开 |
| 开启 | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | 这次运行持有一份别处无法再发一次的额度 |
| 绑定 | [`dsh-claude-cli-binding`](../../packages/control-plane/claude-cli-binding) | 一次提供方调用所处的主目录、工作目录、密钥与上限 |
| 计费 | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | 这次调用消耗了什么，以及这次运行还能不能再来一次 |
| 关闭 | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | 这次运行花了多少，以及有多少归还给委派它的那一方 |

[`dsh-control-plane`](../../packages/control-plane/control-plane) 提供每一步用来指称租户的品牌化 id，[`dsh-credential-vault`](../../packages/control-plane/credential-vault) 密封并打开准入所交付的东西，[`dsh-runtime-pool`](../../packages/control-plane/runtime-pool) 推导出一个池所拥有的目录，而 [`dsh-run-budget`](../../packages/control-plane/run-budget) 是账本据以记账的预留算术。[`dsh-provider-accounts`](../../packages/control-plane/provider-accounts) 拥有租户在这一切开始之前所配置的、用户可见的账户元数据。

## 部署方必须提供什么

有三种存储在本仓库中并不存在，而 `admitRun` 把三者都作为端口接收，这样在部署方回答它们之前，运行无法开始：

- **`findBudget`** —— 这次运行据以启动的那份额度。对根运行来说是租户的剩余额度；对 claims 携带 `parentRunId` 的运行来说，则是那个**父运行**的剩余额度，从账本里读出。给子运行回答租户预算会让这项检查失效：子运行会在这里通过，直到它的份额被预留时才被拒绝，而那已经在它的一次性 nonce 被消费之后。
- **`spendNonce`** —— 这份断言的 nonce 是否曾被见过。在真实部署中它是持久且按租户分区的；这里不会重试一个已被消费的 nonce。
- **`findCredential`** —— 断言所指名的租户与账户对应的密封信封。

还有两样东西完全归部署方所有：池目录（本组只为它命名，没有任何东西创建它，而启动到一个没人创建过的目录会在 spawn 处失败），以及调用 `RunLedger.expire` 的那个时钟 —— 它是一次调用，不是一个定时器。

## 为什么这个顺序就是契约

每一步都被放在「弄错的代价最小」的位置上。

**断言最先被校验**，因此下游永远看不到未经认证的 claim。**额度第二个被读取**：它是这里唯一一种调用方能够修复并重试的拒绝 —— 充值，再出示同一份仍然有效的断言 —— 因此把它放在 nonce 之后，会在一次可恢复的拒绝上烧掉一次性令牌。它也不触碰任何密钥。**nonce 第三个被消费**，它在那里的职责是把并发的重复请求串行化，使同一个令牌的两份副本不可能都抵达凭据。**凭据第四个被打开**，在 claims 所携带的绑定之下。**池最后被解析**，因为它不需要任何密钥。

在这条链路上的任何一处，身份都无法被替换。`RunRequest` 只携带一个令牌；凭据绑定与池身份都从被准入的 claims 里读出，因此调度器无法为一次以另一个身份认证的运行打开某个租户的凭据。这种配对不是被拒绝 —— 它根本无法被表达。

## 每一步保证什么，不保证什么

**准入回答的是授权，不是尺寸。** 它的预算检查问的是这次运行还有没有东西可花，而此时任何请求的大小都尚未可知。只剩一个 token 的父运行仍会让子运行通过准入，而 `RunLedger.openChild` 随后会拒绝它；这点残余无法避免，因为子运行请求的份额并不在断言里。

**账本只记录，不停止任何东西。** 计费绝不会被拒绝 —— 提供方计了多少就是多少，而一笔因「装不下」被拒绝记录的计费，会让账本继续报告那次运行早已用掉的额度。它转而报告哪些维度已经耗尽，而把运行停下来是调用方的事。租约是一份占用而不是一个截止期限：到期释放的是一次丢失的运行所占用的东西，并不取消那份工作 —— 那属于启动它的一方。

**绑定约束的是一次调用。** CLI 按调用强制它的上限，因此额度是一个参数而不是运行的一个字段：持有账本记录的调用方传入该记录的剩余额度，而每次都传入被准入的预算，会把按运行的限额变成按调用的限额。凭据隔离始终被要求，从不可配置 —— 每一次抵达绑定的运行都恰好是为一个租户准入的。

## 哪些是被检验的，而不是被声称的

隔离这项主张是对着操作系统检验的，而不是对着对象。[`tests/tenant-isolation.spec.ts`](../../packages/control-plane/claude-cli-binding/tests/tenant-isolation.spec.ts) 会签发、准入、绑定并启动一个真实进程，其替身可执行文件报告它实际拿到的 `HOME`、工作目录、密钥与上限：两个租户拿到两个主目录，两个进程都看不到对方的密钥；而环境里已有的 `CLAUDE_CODE_USE_BEDROCK` 不会抵达子进程，一个普通的环境变量却会。同一份文件还检验取消或放弃一次运行会把 CLI 以及它启动的那个进程一并回收。

[`tests/run-accounting.spec.ts`](../../packages/control-plane/claude-cli-binding/tests/run-accounting.spec.ts) 从另一个方向闭合这条回路 —— 开启、启动、用进程报告的用量与成本计费、结算 —— 而 [`tests/delegation.spec.ts`](../../packages/control-plane/claude-cli-binding/tests/delegation.spec.ts) 会让一个子运行同时走过准入与预留。

## 相关文档

- [Candy 运行时边界](../candy-runtime-boundaries.zh.md) —— 本组所要应对的、已接受的信任边界与滥用场景。
- [多租户 CLI agent 运行时](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划，以及尚未构建的部分。
- [LLM 流式传输](llm-streaming.zh.md) —— 计费所依据的 `TokenUsage`，包括提供方报告的成本。
