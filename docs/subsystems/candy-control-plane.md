# Candy control plane

English | [中文](candy-control-plane.zh.md)

The [control-plane group](../../packages/control-plane) is what turns a request from an untrusted client into one provider process that can only spend one tenant's money in one tenant's directory. It is eleven packages and no running Cordis service: every package is imported directly, and the OAuth, device pairing, and account store that would make it a service belong to the [proposed multi-tenant runtime plan](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md), not to this repository yet.

That absence is the reason this page exists. The packages compose in exactly one order, and each step's output is the next step's only tenant-specific input. This page is that sequence; [`dsh-run-start`](../../packages/control-plane/run-start) performs the first half of it — Admit, Open and Place — and owns the rollback between them, because opening a run's funding before placing it means a refused placement would otherwise leave a parent short until the lease expires. [Candy Runtime Boundaries](../candy-runtime-boundaries.md) owns the trust boundaries and abuse cases the design answers to.

## The order of operations

| Step | Package | What it decides |
|---|---|---|
| Mint | [`dsh-execution-assertion`](../../packages/control-plane/execution-assertion) | that the control plane authorized this run, for this tenant, for this long |
| Admit | [`dsh-run-admission`](../../packages/control-plane/run-admission) | that the assertion is genuine, the allowance is not spent, the nonce is fresh, and the credential opens |
| Open | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | that the run holds an allowance nothing else can hand out twice |
| Place | [`dsh-runtime-pool`](../../packages/control-plane/runtime-pool) | that the directory the invocation runs in exists and is private to the account this runtime runs as |
| Bind | [`dsh-claude-cli-binding`](../../packages/control-plane/claude-cli-binding) | the home, working directory, key, and ceiling one provider invocation runs under |
| Charge | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | what the invocation consumed, and whether the run may make another |
| Close | [`dsh-run-ledger`](../../packages/control-plane/run-ledger) | what the run cost, and what returns to whoever delegated it |

[`dsh-control-plane`](../../packages/control-plane/control-plane) supplies the branded ids every step names a tenant with, [`dsh-credential-vault`](../../packages/control-plane/credential-vault) seals and opens what admission hands over, [`dsh-runtime-pool`](../../packages/control-plane/runtime-pool) also derives the key and root that admission resolves before Place creates them, [`dsh-run-budget`](../../packages/control-plane/run-budget) is the reservation arithmetic the ledger records against, and [`dsh-run-replay`](../../packages/control-plane/run-replay) is the single-use record behind the nonce admission spends. [`dsh-provider-accounts`](../../packages/control-plane/provider-accounts) owns the user-visible account metadata a tenant configures before any of this runs.

## What a deployment must supply

Two of the three stores `admitRun` takes as ports do not exist in this repository, and all three stay ports so that a run cannot start until a deployment has answered them:

- **`findBudget`** — the allowance this run is started against. For a root run that is the tenant's remaining allowance; for a run whose claims carry a `parentRunId` it is that **parent's** remaining allowance, read from the ledger. Answering the tenant's budget for a child defeats the check: the child would pass here and be refused only when its share is reserved, after its single-use nonce was spent.
- **`spendNonce`** — whether this assertion's nonce had been seen; nothing here retries a spent one. [`dsh-run-replay`](../../packages/control-plane/run-replay) answers it for one process: the decision is one synchronous step, so two concurrent copies of a token cannot both pass, and a record is held exactly while its assertion stays admissible. A deployment running more than one runtime process needs a durable store satisfying the same three obligations.
- **`findCredential`** — the sealed envelope for the tenant and account the assertion names.

The pool directory is opened rather than derived: `openRuntimePool` creates one pool root and makes it private to the account this runtime runs as, applying the mode with an explicit change so it is true of a root that already existed. It never creates the pool base — a base that is absent means the deployment never provisioned its storage — and it refuses anything but a real directory in the pool's place, because `chmod` follows a symlink and a link to another tenant's pool root is owned by the same account. What it cannot do is tell a directory a stranger created from one an earlier run left, so provisioning the base privately stays with the deployment.

Two things a deployment still owns outright: the pool base's own permissions, and the clock that calls `RunLedger.expire`, which is a call rather than a timer.

## Why the order is the contract

Each step is placed where the cost of being wrong is lowest.

The **assertion is verified first**, so nothing downstream ever sees an unauthenticated claim. The **allowance is read second**: it is the one denial a caller can fix and retry — top up, present the same still-valid assertion — so checking it after the nonce would burn a single-use token on a recoverable refusal. It also touches no secret. The **nonce is spent third**, where its job is to serialize concurrent duplicates so two copies of one token cannot both reach a credential. The **credential opens fourth**, under the binding the claims carry. The **pool resolves last**, because it needs no secret.

Identity cannot be substituted anywhere along it. `RunRequest` carries only a token; the credential binding and the pool identity are both read from the admitted claims, so a scheduler cannot open one tenant's credential for a run that authenticated as another. That pairing is not refused — it cannot be expressed.

## What each step guarantees, and what it does not

**Admission answers authority, not sizing.** Its budget check asks whether the run has anything at all to spend, before the size of any request is known. A parent with one token left admits a child that `RunLedger.openChild` then refuses; that residue is unavoidable, because the child's requested share is not part of the assertion.

**The ledger records, and does not stop anything.** A charge is never refused — a provider bills what it billed, and a charge declined for not fitting would leave the ledger reporting an allowance the run has already used. It reports which dimensions are exhausted instead, and stopping the run is the caller's. A lease is a hold rather than a deadline: expiry releases what a lost run held and does not cancel the work, which belongs to whoever started it.

**The binding confines one invocation.** The CLI enforces its ceiling per invocation, so the allowance is a parameter rather than a field of the run: a caller holding a ledger record passes that record's remaining allowance, and passing the admitted budget every time would give a run a per-call limit instead of a per-run one. Credential isolation is always required, never configurable — every run reaching the binding was admitted for exactly one tenant.

## What is checked rather than asserted

The isolation claim is exercised against an operating system rather than against objects. [`tests/tenant-isolation.spec.ts`](../../packages/control-plane/claude-cli-binding/tests/tenant-isolation.spec.ts) mints, admits, binds, and spawns a real process whose stand-in executable reports the `HOME`, working directory, key, and ceiling it was actually handed: two tenants get two homes, neither process can see the other's secret, and an ambient `CLAUDE_CODE_USE_BEDROCK` does not reach the child while an ordinary ambient variable does. The same file checks that cancelling or abandoning a run reaps both the CLI and a process it started.

[`tests/run-accounting.spec.ts`](../../packages/control-plane/claude-cli-binding/tests/run-accounting.spec.ts) closes the loop the other way — open, launch, charge with the usage and cost the process reported, settle — and [`tests/delegation.spec.ts`](../../packages/control-plane/claude-cli-binding/tests/delegation.spec.ts) runs a child through admission and reservation together.

## Related documentation

- [Candy Runtime Boundaries](../candy-runtime-boundaries.md) — the accepted trust boundaries and abuse cases this group answers to.
- [Multi-tenant CLI agent runtime](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan, and what remains unbuilt.
- [LLM streaming](llm-streaming.md) — the `TokenUsage` a charge is derived from, including the provider-reported cost.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
async consumeTenantAllowance(userId: UserId, runId: RunId, spent: RunSpend): Promise<TenantAllowance | undefined>

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

Types: [StreamChunk](llm-streaming.md)

Source: [`packages/control-plane/run-scheduler/src/index.ts`](../../packages/control-plane/run-scheduler/src/index.ts)
<!-- END GENERATED cordis-surface -->
