# Candy 控制平面

[English](candy-control-plane.md) | 中文

[control-plane 组](../../packages/control-plane)负责把一个来自不受信任客户端的请求，变成一个只能花某一个租户的钱、只能待在某一个租户目录里的提供方进程。它由十一个包组成，没有正在运行的 Cordis 服务：每个包都被直接导入，而那些会让它成为服务的 OAuth、设备配对与账户存储属于[提议的多租户运行时计划](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)，尚不属于本仓库。

正是这项缺席让本页面有存在的必要。这些包只能按一种顺序组合，每一步的输出都是下一步唯一与租户相关的输入。本页面就是那套序列；[`dsh-run-start`](../../packages/control-plane/run-start) 执行它的前半段 —— 准入、开启与放置 —— 并拥有它们之间的回滚，因为在放置之前就为一次运行拨款，意味着一次被拒的放置否则会让父运行一直少掉一份，直到租约到期。[Candy 运行时边界](../candy-runtime-boundaries.zh.md)拥有本设计所要应对的信任边界与滥用场景。

## 操作顺序

| 步骤 | 包 | 它决定什么 |
|---|---|---|
| 签发 | [`dsh-execution-assertion`](../../packages/control-plane/execution-assertion) | 控制平面授权了这次运行，为这个租户，授权这么久 |
| 准入 | [`dsh-run-admission`](../../packages/control-plane/run-admission) | 断言是真的、额度没花光、nonce 是新的、凭据能打开 |
| 开启 | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | 这次运行持有一份别处无法再发一次的额度 |
| 放置 | [`dsh-runtime-pool`](../../packages/control-plane/runtime-pool) | 这次调用所运行的目录已经存在，并且只对本运行时所属的账户私有 |
| 绑定 | [`dsh-claude-cli-binding`](../../packages/control-plane/claude-cli-binding) | 一次提供方调用所处的主目录、工作目录、密钥与上限 |
| 计费 | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | 这次调用消耗了什么，以及这次运行还能不能再来一次 |
| 关闭 | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | 这次运行花了多少，以及有多少归还给委派它的那一方 |

[`dsh-control-plane`](../../packages/control-plane/control-plane) 提供每一步用来指称租户的品牌化 id，[`dsh-credential-vault`](../../packages/control-plane/credential-vault) 密封并打开准入所交付的东西，[`dsh-runtime-pool`](../../packages/control-plane/runtime-pool) 同时还推导出准入所解析的那个键与根目录 —— 放置这一步随后才创建它们 —— [`dsh-run-budget`](../../packages/control-plane/run-budget) 是账本据以记账的预留算术，而 [`dsh-run-replay`](../../packages/control-plane/run-replay) 是准入所消费的那个 nonce 背后的一次性记录。[`dsh-provider-accounts`](../../packages/control-plane/provider-accounts) 拥有租户在这一切开始之前所配置的、用户可见的账户元数据。

## 部署方必须提供什么

`admitRun` 作为端口接收的三种存储中，有两种在本仓库中并不存在，而三者都仍是端口，这样在部署方回答它们之前，运行无法开始：

- **`findBudget`** —— 这次运行据以启动的那份额度。对根运行来说是租户的剩余额度；对 claims 携带 `parentRunId` 的运行来说，则是那个**父运行**的剩余额度，从账本里读出。给子运行回答租户预算会让这项检查失效：子运行会在这里通过，直到它的份额被预留时才被拒绝，而那已经在它的一次性 nonce 被消费之后。
- **`spendNonce`** —— 这份断言的 nonce 是否曾被见过；这里不会重试一个已被消费的 nonce。[`dsh-run-replay`](../../packages/control-plane/run-replay) 为单个进程回答它：决定是一个同步步骤，因此一个令牌的两份并发副本不可能都通过，而一条记录恰好在其断言仍可被准入期间被持有。运行多于一个运行时进程的部署，需要一个满足同样三项义务的持久化存储。
- **`findCredential`** —— 断言所指名的租户与账户对应的密封信封。

池目录是被打开的，而不只是被推导出来的：`openRuntimePool` 创建一个池根目录，并把它设为只对本运行时所属的账户私有，用一次显式的修改来施加模式，因此该模式对一个原本就已存在的根目录同样成立。它从不创建池基目录 —— 基目录缺失意味着部署从未准备好它的存储 —— 而且它会拒绝池所在位置上任何不是真正目录的东西，因为 `chmod` 会跟随符号链接，而一个指向另一个租户池根目录的链接属主与本进程相同。它做不到的，是把陌生人创建的目录与先前某次运行留下的目录区分开，因此把基目录准备成私有的仍归部署所有。

还有两样东西仍完全归部署方所有：池基目录自身的权限，以及调用 `RunLedger.expire` 的那个时钟 —— 它是一次调用，不是一个定时器。

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

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcontrolplanestore--controlplanestore"></a>

### `ctx.controlPlaneStore` — `ControlPlaneStore`

Durable provider accounts and tenant allowances.

Reads are synchronous against the domain's in-memory state and are exposed as promises because the ports they satisfy are asynchronous. Writes reach the medium before memory, so a read never sees a record the medium does not hold.

```ts cordis-catalog
/**
 * Every account one tenant owns, deleted ones included.
 *
 * A deleted account is retained rather than removed: `dsh-provider-accounts`
 * keeps its id blocked so a later account cannot inherit its history.
 * @param userId - the tenant to list.
 * @returns that tenant's accounts, in no defined order.
 */
listByUser(userId: UserId): Promise<readonly ProviderAccountEntry[]>

/**
 * One account by id.
 * @param id - the account to read.
 * @returns the account and its sealed credential, or undefined.
 */
find(id: ProviderAccountId): Promise<ProviderAccountEntry | undefined>

/**
 * Write one account, replacing any record under the same id.
 * @param entry - the account and its sealed credential.
 * @returns resolution after the write reaches the medium.
 */
async save(entry: ProviderAccountEntry): Promise<void>

/**
 * Look up the sealed credential a run's claims name.
 *
 * The account is read by id and its recorded tenant must be the one the
 * claims carry. An account that names another tenant is not returned: the
 * vault would refuse to open it, and refusing here keeps a mismatch out of
 * the one call that could otherwise be handed the wrong envelope.
 * @param claims - the tenant and account a verified assertion names.
 * @returns the sealed envelope, or undefined when there is no such account
 *   for that tenant.
 */
async findCredential(claims: { userId: UserId; accountId: ProviderAccountId }): Promise<CredentialEnvelope | undefined>

/**
 * One tenant's grant and what its settled runs have consumed of it.
 *
 * This is the durable half of the root-run answer to `dsh-run-admission`'s
 * `findBudget`. It is deliberately not that answer: what a new run may start
 * against is this record less the reservation of every run of that tenant
 * still open, and which runs are open lives in a `RunLedger` rather than
 * here. `dsh-tenant-allowance`'s `remainingAllowance` composes the two, and
 * `dsh-run-scheduler` is where they meet.
 * @param userId - the tenant to read.
 * @returns the tenant's allowance, or undefined when none is recorded — which
 *   denies the run, because a tenant the store does not know is not a tenant
 *   with unlimited budget.
 */
tenantAllowance(userId: UserId): Promise<TenantAllowance | undefined>

/**
 * Set what one tenant is granted, keeping what it has already consumed.
 *
 * Raising or lowering a grant does not return spent tokens: an operator who
 * doubles a quota mid-period means the tenant may now spend twice as much in
 * total, not that its history was erased. A tenant with no record is opened
 * with nothing consumed.
 * @param userId - the tenant.
 * @param grant - the allowance that tenant's runs draw on.
 * @returns the stored allowance, after the write reaches the medium.
 * @throws RangeError when the grant is not made of non-negative safe integers.
 */
async setTenantGrant(userId: UserId, grant: RunBudget): Promise<TenantAllowance>

/**
 * Add one settled run's spending to what its tenant has consumed, at most once.
 *
 * The settlement `dsh-run-ledger` reports for a root run already covers its
 * whole subtree, so one call per tree is the whole of a tenant's charge.
 *
 * Charging the tenant and deleting the settled run record are two writes this
 * medium cannot make one, so a crash between them leaves a settled record a
 * recovering runtime finds and charges again. The run's id is written into
 * the same record as the charge, by the same atomic update, and a repeat of
 * the same id is a no-op — so recovery may re-drive an interrupted settlement
 * without knowing how far it got.
 *
 * That guarantee needs one settlement at a time per tenant: two interleaved
 * settlements leave the id of the later one, and a crash would then charge
 * the earlier one twice. `dsh-run-scheduler` serializes them.
 * @param userId - the tenant that ran it.
 * @param runId - the settled root run, which this charge is recorded under.
 * @param spent - what that run and its descendants consumed.
 * @returns the tenant's allowance after the charge — unchanged when this run
 *   was already charged — or undefined when no allowance is recorded for that
 *   tenant and the charge therefore landed nowhere.
 * @throws RangeError when the spend is not made of non-negative safe integers.
 */
consumeTenantAllowance(userId: UserId, runId: RunId, spent: RunSpend): Promise<TenantAllowance | undefined>

/**
 * Every run one runtime has open or part-way through settling.
 *
 * Only that runtime's own records: two runtimes sharing this medium would
 * otherwise recover each other's live runs and settle them at boot.
 * @param runtime - the reading runtime's own audience identifier.
 * @returns its records, in no defined order.
 */
runsOf(runtime: string): Promise<readonly DurableRunRecord[]>

/**
 * One run's record by id, whatever runtime opened it.
 *
 * A child run is checked against its parent's identity, and the parent is
 * named by the claims rather than found by scanning.
 * @param runId - the run to read.
 * @returns its record, or undefined when none is held.
 */
findRun(runId: RunId): DurableRunRecord | undefined

/**
 * Every run of this runtime that drives one harness session.
 *
 * A model request carries the session it was assembled for, so this is the
 * lookup that turns a stream into the run it is charged to. More than one
 * result means the control plane minted two runs for one session, which is
 * a bookkeeping error rather than a choice a caller may resolve.
 * @param runtime - the reading runtime's own audience identifier.
 * @param sessionId - the session a request names.
 * @returns the matching records, in no defined order.
 */
runsOfSession(runtime: string, sessionId: SessionId): readonly DurableRunRecord[]

/**
 * Write the record of one newly opened run.
 * @param run - the run's accounting, tenant, runtime, and settlement state.
 * @returns resolution after the write reaches the medium.
 */
async openRun(run: DurableRunRecord): Promise<void>

/**
 * Update what one run has spent, leaving every other field as it is.
 *
 * A whole-record write would erase {@link DurableRunRecord.absorbed}, whose
 * whole purpose is to survive until the settled child it names is deleted.
 * @param runId - the run being charged.
 * @param spent - everything charged to it so far.
 * @returns resolution after the write reaches the medium; a run with no
 *   record is a no-op, because only a live ledger can say it exists.
 */
async recordRunSpend(runId: RunId, spent: RunSpend): Promise<void>

/**
 * Fold one settled child's charge into its parent, at most once.
 *
 * The parent's allowance is what a child's spend is charged to, exactly as a
 * tenant's is for a root, so this is {@link consumeTenantAllowance} one level
 * lower and carries the same marker for the same reason: crediting the parent
 * and deleting the child are two writes, and a crash between them must not
 * credit the parent twice.
 * @param parentRunId - the delegating run.
 * @param childRunId - the settled child, recorded as absorbed.
 * @param spent - the child's charge, already capped at what it reserved.
 * @returns resolution after the write reaches the medium; a parent with no
 *   record is a no-op.
 */
async absorbChild(parentRunId: RunId, childRunId: RunId, spent: RunSpend): Promise<void>

/**
 * Write down what settling one run charges, before that charge is applied.
 *
 * This is the durable decision point of a settlement: after it, a recovering
 * runtime knows the run is finished and how much it owes, whatever else was
 * interrupted.
 * @param runId - the run being settled.
 * @param spent - what it and its descendants consumed.
 * @returns the marked record, which carries the tenant the charge belongs to.
 * @throws DomainError when no record is held for that run — a run open in a
 *   ledger always has one, so an absent record is a lost write rather than a
 *   run to settle silently.
 */
async markRunSettled(runId: RunId, spent: RunSpend): Promise<DurableRunRecord>

/**
 * Remove one run's record.
 * @param runId - the run to forget.
 * @returns true when a record was removed, false when it was already absent.
 */
deleteRun(runId: RunId): Promise<boolean>

/**
 * Append records to one subject's trail, keeping the most recent `retain`.
 *
 * The cap is the caller's because it is a deployment's retention choice, not
 * a property of the medium. It is also the whole of the retention policy:
 * a trail is a window on recent activity, and the record that falls out of it
 * is gone.
 * @param subject - the tenant or runtime the records belong to.
 * @param records - what happened, oldest first.
 * @param retain - most records to keep for this subject; at least one.
 * @returns the trail as stored, after the write reaches the medium.
 * @throws RangeError when `retain` is not a positive safe integer, which is a
 *   deployment error rather than a record to drop.
 */
async recordAudit( subject: AuditSubject, records: readonly RunAuditRecord[], retain: number, ): Promise<readonly RunAuditRecord[]>

/**
 * One subject's recorded activity, oldest first.
 * @param subject - the tenant or runtime to read.
 * @returns its retained records; empty when nothing is recorded for it.
 */
auditsOf(subject: AuditSubject): readonly RunAuditRecord[]
```

Types: [SessionId](core.zh.md)

Source: [`packages/control-plane/control-plane-store/src/index.ts`](../../packages/control-plane/control-plane-store/src/index.ts)

<a id="ctxrunscheduler--runscheduler"></a>

### `ctx.runScheduler` — `RunScheduler`

Live run state for one Candy runtime, and the composition that starts a run.

One instance owns one ledger and one replay store, so every run this runtime admits is accounted against the same delegation trees and the same spent nonces. Two instances would each believe they held the whole allowance.

```ts cordis-catalog
/**
 * Admit one request, fund the run it names, and place it in its pool.
 *
 * @param token - the execution assertion exactly as received.
 * @param share - the allowance to open the run with; a root run is normally
 *   opened with what admission answered, and a child with the share its
 *   parent delegates.
 * @param now - epoch milliseconds; defaults to this runtime's clock.
 * @returns the started run, or the step that refused it, with every audit
 *   record the attempt produced.
 */
async start( token: string, share: (run: { budget: RunBudget }) => RunBudget = run => run.budget, now: number = Date.now(), ): Promise<RunStartOutcome>

/**
 * Record what one run consumed since its last charge.
 * @param runId - the open run.
 * @param spend - what the invocation consumed.
 * @returns the updated record and the dimensions now used up, or why the
 *   charge was refused.
 */
async charge(runId: RunId, spend: RunSpend): Promise<RunLedgerResult<RunChargeResult>>

/**
 * Meter one provider stream against an open run.
 *
 * This is where an allowance stops being an accounting figure. The call is
 * refused before the provider is reached when the run has nothing left, cut
 * when it outruns the wall time the run still had, and charged — durably —
 * before its terminal chunk reaches the consumer, so the next call is
 * admitted against a ledger that already knows about this one.
 *
 * A cut ends the call, not the run: the record stays open with what the call
 * consumed, and whoever started the run decides what happens next.
 * @param runId - the open run this call belongs to.
 * @param source - the provider's stream for one call.
 * @returns the same chunks, ending early when the run cannot afford the rest.
 */
meter(runId: RunId, source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>

/**
 * Close one run and its descendants, and charge its tenant for what the tree
 * consumed.
 *
 * Closing a root is the one point a tenant's durable allowance moves. A child
 * settles into its parent's record instead, and reaches the tenant when that
 * parent's root closes, so a tree is charged once rather than once per run.
 * @param runId - the run to settle.
 * @returns the settlement, or why it could not be closed.
 */
close(runId: RunId): Promise<RunLedgerResult<RunSettlement>>

/**
 * Release every hold whose lease has passed and drop nonce records that can
 * no longer deny anything.
 *
 * The clock calls this; a caller with its own decision timestamp may call it
 * directly. Eviction changes no decision — `spend` already treats an expired
 * record as absent — so this only bounds what the runtime holds.
 * @param now - epoch milliseconds.
 * @returns the runs whose holds were released.
 */
async sweep(now: number): Promise<readonly RunSettlement[]>

/**
 * Read back what one tenant's scheduling attempts did here, oldest first.
 * @param userId - the tenant to read.
 * @returns its retained records.
 */
auditsOfTenant(userId: UserId): readonly RunAuditRecord[]

/**
 * Read back the attempts this runtime refused before it knew whose they were.
 *
 * An assertion that fails to verify names no tenant this runtime may believe,
 * so its record is filed here rather than dropped — it is the clearest attack
 * signal admission can observe.
 * @returns this runtime's retained unattributed records, oldest first.
 */
auditsOfRuntime(): readonly RunAuditRecord[]
```

Types: [StreamChunk](llm-streaming.zh.md)

Source: [`packages/control-plane/run-scheduler/src/index.ts`](../../packages/control-plane/run-scheduler/src/index.ts)
<!-- END GENERATED cordis-surface -->
