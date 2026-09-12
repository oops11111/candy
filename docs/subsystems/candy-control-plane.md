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

Durable provider accounts, tenant allowances and model-route policies.

Reads are synchronous against the domain's in-memory state and are exposed as promises because the ports they satisfy are asynchronous. Writes reach the medium before memory, so a read never sees a record the medium does not hold.

```ts cordis-catalog
/**
 * Enroll one verified external identity exactly once.
 * @param identity - OAuth issuer and subject verified by the configured provider.
 * @param userId - existing Candy user this identity signs in as.
 * @param role - Candy authorization assigned by provisioning, not provider claims.
 * @param enrolledAt - epoch milliseconds recorded for operator audit.
 * @returns true only when this call created the mapping.
 */
async enrollOAuthIdentity( identity: OAuthIdentity, userId: UserId, role: ControlPlaneRole, enrolledAt: number, ): Promise<boolean>

/**
 * Resolve Candy authorization for a verified external identity.
 * @param identity - issuer and subject returned by the configured verifier.
 * @returns the provisioned Candy user and role, or undefined when not enrolled.
 */
resolve(identity: OAuthIdentity): Promise<{ readonly userId: UserId readonly role: ControlPlaneRole } | undefined>

/**
 * Begin one OAuth authorization-code transaction with PKCE S256.
 * @param issuer - exact configured OAuth issuer identifier.
 * @param redirectUri - callback URI the later code exchange must repeat.
 * @param now - transaction creation time in epoch milliseconds.
 * @param expiresAt - epoch milliseconds after which the callback is refused.
 * @returns opaque state and public S256 challenge; the verifier stays server-side.
 */
async beginOAuthAttempt( issuer: string, redirectUri: string, now: number, expiresAt: number, ): Promise<{ readonly state: string; readonly codeChallenge: string; readonly nonce: string }>

/**
 * Consume a callback state once and recover the PKCE exchange inputs.
 * @param state - exact opaque value returned through the provider callback.
 * @param now - callback receipt time in epoch milliseconds.
 * @returns exchange inputs only for the first matching, unexpired callback.
 */
async consumeOAuthAttempt( state: string, now: number, ): Promise<{ readonly codeVerifier: string readonly nonce: string readonly issuer: string readonly redirectUri: string } | undefined>

/**
 * Create one revocable browser session after an OAuth verifier has proved the external identity.
 * @param userId - Candy user mapped from the verified external identity.
 * @param role - Candy-assigned authorization; never a browser-supplied claim.
 * @param identity - verified OAuth issuer and subject.
 * @param createdAt - current epoch milliseconds.
 * @param expiresAt - expiry after `createdAt`.
 * @returns the bearer and independent CSRF token exactly once, plus the secret-free durable record.
 */
async createUserSession( userId: UserId, role: ControlPlaneRole, identity: OAuthIdentity, createdAt: number, expiresAt: number, ): Promise<{ readonly token: string; readonly csrfToken: string; readonly record: UserSessionRecord }>

/**
 * Authenticate one bearer without accepting identity or role from the request.
 * @param token - opaque token returned once at session creation.
 * @param now - current epoch milliseconds.
 * @returns the active session, or undefined for unknown, revoked, or expired credentials.
 */
async authenticateUserSession(token: string, now: number): Promise<UserSessionRecord | undefined>

/**
 * Verify the independent anti-CSRF token for an authenticated session.
 * @param id - session already authenticated by its HttpOnly bearer.
 * @param csrfToken - value repeated from a readable same-site cookie into a request header.
 * @returns true only when the active session owns that token.
 */
verifyUserSessionCsrf(id: UserSessionId, csrfToken: string): boolean

/**
 * Revoke one browser session; subsequent authentication fails immediately.
 * @param id - session selected by an already-authorized logout or administrative action.
 * @param revokedAt - epoch milliseconds recorded as the revocation instant.
 * @returns true when the session exists, including an already-revoked session.
 */
async revokeUserSession(id: UserSessionId, revokedAt: number): Promise<boolean>

/**
 * Read one tenant's complete model-route allowlist.
 *
 * Missing means no policy was provisioned and therefore no route is
 * allowed. An empty returned list is an explicit deny-all policy; callers
 * enforce both cases identically but operators can still distinguish them.
 * @param userId - the tenant whose model authority is requested.
 * @returns a defensive copy of the routes, or undefined when not provisioned.
 */
tenantModelRoutes(userId: UserId): readonly TenantModelRoute[] | undefined

/**
 * Replace one tenant's complete model-route allowlist.
 *
 * Exact duplicate routes and blank fields are rejected instead of silently
 * normalized, because either usually means an operator supplied a malformed
 * security policy. An empty list is valid and persists a deny-all policy.
 * @param userId - the tenant whose model authority is replaced.
 * @param routes - exact provider/model pairs that tenant may call.
 * @returns a defensive copy after the write reaches the medium.
 * @throws TypeError for blank fields or duplicate exact routes.
 */
async setTenantModelRoutes(userId: UserId, routes: readonly TenantModelRoute[]): Promise<readonly TenantModelRoute[]>

/**
 * Atomically consume one tenant-scoped assertion nonce on the durable
 * medium. A digest keeps the per-record JSON layout's path-safe key contract
 * without weakening the collision boundary held by `replayKey`.
 *
 * @param claims - The verified tenant, nonce, and assertion expiry.
 * @param now - The admission decision's epoch-millisecond timestamp.
 * @returns true only for the first admissible use.
 */
async spendNonce( claims: ExecutionAssertionClaims, now: number, ): Promise<boolean>

/**
 * Remove locally known nonce records after their assertions expire. The
 * compare/exchange prevents one process from deleting a newer reservation
 * another process installed under the same key.
 * @param now - Epoch milliseconds used as the expiry boundary.
 * @returns the number of records this process removed.
 */
async evictNonces(now: number): Promise<number>

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
 * One account's record, read without awaiting.
 *
 * {@link find} is the port `dsh-provider-accounts` consumes and stays async
 * because another backend need not answer from memory. This runtime decides
 * whether an in-flight call may still spend, on the synchronous path a
 * waterfall listener runs on, and it needs the record rather than the sealed
 * credential beside it.
 * @param id - the account to read.
 * @returns its secret-free record, or undefined when none is held.
 */
accountOf(id: ProviderAccountId): ProviderAccountRecord | undefined

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
 * Whether a session belongs to Candy, including after its run settles.
 * @param sessionId - the session named by a model request.
 * @param runtime - the runtime whose request is being classified.
 * @returns true when durable ownership exists for that runtime.
 */
isManagedSession(sessionId: SessionId, runtime: string): boolean

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
 * Push one run's lease out, leaving every other field as it is.
 *
 * The stored lease is what a later reader — this runtime after a restart,
 * an operator, another runtime sharing this audience — uses to tell a run
 * still being driven from one whose runtime went away. A renewal held only
 * in a live ledger would leave that reader a record that looks abandoned
 * while the run is working.
 * @param runId - the run whose hold should be held longer.
 * @param leaseExpiresAt - the new release time, in epoch milliseconds.
 * @returns resolution after the write reaches the medium; a run with no
 *   record is a no-op, because only a live ledger can say it exists.
 */
async renewRun(runId: RunId, leaseExpiresAt: number): Promise<void>

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
 * Read the grant an execution assertion names.
 *
 * Answering `undefined` denies the run: a grant this store does not hold is
 * never an unlimited one, which is the rule {@link
 * @deepseek-ai/dsh-workspace-grant!refuseWorkspaceGrant} applies.
 * @param id - the grant id the assertion carries.
 * @returns the grant, or `undefined` when none is stored under that id.
 */
findGrant(id: WorkspaceGrantId): Promise<WorkspaceGrantRecord | undefined>

/**
 * Read one grant from this process's current store view for a synchronous
 * executor boundary. Callers that can await use {@link findGrant} so a
 * future medium-backed refresh remains transparent.
 * @param id - grant identifier carried by the current run.
 * @returns a defensive record copy, or undefined when absent.
 */
grantSnapshot(id: WorkspaceGrantId): WorkspaceGrantRecord | undefined

/**
 * Write one grant, replacing any record under the same id.
 *
 * A revocation is this same call with `revokedAt` set: the record is the
 * authority an assertion only names, so removing it would leave a run
 * naming a grant that reads as never-issued rather than as withdrawn.
 * @param record - the grant to store.
 * @returns resolution once the medium holds it.
 */
async saveGrant(record: WorkspaceGrantRecord): Promise<void>

/**
 * Read one device by the id an assertion names.
 * @param id - the device id.
 * @returns the device, or `undefined` when nothing resolves the id.
 */
async findDevice(id: DeviceId): Promise<DeviceRecord | undefined>

/**
 * Read one tenant's devices, revoked ones included.
 * @param userId - the tenant.
 * @returns their devices, in no defined order.
 */
async listDevicesOfUser(userId: UserId): Promise<readonly DeviceRecord[]>

/**
 * Read the device presenting one token digest.
 *
 * The snapshot narrows the scan to one candidate and the medium is then
 * re-read, for the reason {@link authenticateUserSession} re-reads: a device
 * another process revoked is still in this one's snapshot, and answering
 * from it would authenticate a binding that no longer exists.
 * @param tokenDigest - the digest of the presented token.
 * @returns the device, or `undefined` when none holds that digest.
 */
async findDeviceByTokenDigest(tokenDigest: string): Promise<DeviceRecord | undefined>

/**
 * Write one device, replacing any record under the same id.
 * @param record - the device to store.
 * @returns resolution once the medium holds it.
 */
async saveDevice(record: DeviceRecord): Promise<void>

/**
 * Read one pairing code by digest, consumed and expired ones included.
 * @param digest - the normalized code's digest.
 * @returns the code, or `undefined` when nothing resolves the digest.
 */
async findPairingCode(digest: string): Promise<PairingCodeRecord | undefined>

/**
 * Read one tenant's pairing codes, consumed and expired ones included.
 * @param userId - the tenant.
 * @returns their codes, in no defined order.
 */
async listPairingCodesOfUser(userId: UserId): Promise<readonly PairingCodeRecord[]>

/**
 * Write one pairing code, replacing any record under the same digest.
 * @param record - the code to store.
 * @returns resolution once the medium holds it.
 */
async savePairingCode(record: PairingCodeRecord): Promise<void>

/**
 * Mark one outstanding, unexpired code consumed by one device, indivisibly.
 *
 * The compare/exchange is what makes a code single-use across processes and
 * restarts, the same mechanism {@link spendNonce} uses: two hosts exchanging
 * one code both read it outstanding, and only the exchange can tell them
 * apart. A failed exchange returns the medium's current value, so each retry
 * decides against what is there rather than this process's snapshot.
 * @param digest - the normalized code's digest.
 * @param deviceId - the device the claiming host becomes.
 * @param at - epoch milliseconds of the exchange, also the expiry boundary.
 * @returns the record as it stood before the claim, or `undefined` when the
 * code was already consumed, expired or absent.
 */
async claimPairingCode( digest: string, deviceId: DeviceId, at: number, ): Promise<PairingCodeRecord | undefined>

/**
 * One subject's recorded activity, oldest first.
 * @param subject - the tenant or runtime to read.
 * @returns its retained records; empty when nothing is recorded for it.
 */
auditsOf(subject: AuditSubject): readonly RunAuditRecord[]
```

Types: [SessionId](core.md)

Source: [`packages/control-plane/control-plane-store/src/index.ts`](../../packages/control-plane/control-plane-store/src/index.ts)

<a id="ctxdevicebinding--devicebinding"></a>

### `ctx.deviceBinding` — `DeviceBinding`

The host's own record of which deployment it serves and as which device.

Every write goes through the credential seam's serialized read-modify-write, which holds across processes where the store supports it. That is what makes "one binding" a fact rather than an intention: two `dsh` processes starting on one machine and pairing at the same moment cannot both install one.

```ts cordis-catalog
/**
 * The binding this host holds.
 * @returns the binding, or `undefined` while this host is unpaired.
 */
async read(): Promise<HostDeviceBinding | undefined>

/**
 * The binding this host holds, without its token.
 * @returns the binding's server, tenant, device and instant, or `undefined`
 * while this host is unpaired.
 */
async describe(): Promise<HostDeviceBindingView | undefined>

/**
 * Exchange one operator-supplied code and durably bind this host.
 *
 * An existing binding is refused before the one-shot code reaches the
 * deployment. The exchange follows no redirects, and only a complete device
 * credential from the deployment is allowed into the credential store.
 *
 * @param serverOrigin - deployment where the tenant issued the code.
 * @param code - one-time pairing code copied by the operator.
 * @param now - epoch milliseconds recorded as the binding's instant.
 * @returns the binding installed from the exchange response.
 * @throws DeviceBindingError when a binding already stands or the origin is
 * invalid; DevicePairingError when the deployment refuses or malforms the
 * exchange.
 */
async pair(serverOrigin: string, code: string, now: number): Promise<HostDeviceBinding>

/**
 * Ask the bound deployment whether this host's token still identifies it.
 *
 * This is one request, not a connection monitor. Network failure keeps
 * throwing for the inherited connection owner to classify; only the
 * deployment's uniform `401` means the binding no longer authenticates.
 *
 * @returns `true` only when the deployment authenticates the exact tenant
 * and device stored locally; `false` while unpaired or after a `401`.
 * @throws DeviceBindingVerificationError when a successful reply names a
 * different identity or the deployment answers an undocumented status.
 */
async verify(): Promise<boolean>

/**
 * Take one binding, if this host holds none.
 *
 * Re-binding to the exact deployment, tenant and device already stored is
 * accepted and replaces the token, because that is what a host does when a
 * tenant re-pairs it after rotating its credential. Anything else is
 * refused: changing which tenant a machine serves without releasing it first
 * would leave one tenant's work reachable from the next tenant's session.
 *
 * @param request - the deployment, identity and token the pairing produced.
 * @param now - epoch milliseconds recorded as the binding's instant.
 * @returns the binding now stored.
 * @throws DeviceBindingError `invalid-origin` for a server that is not an
 * absolute `http` or `https` URL, `invalid-identity` for a blank tenant,
 * device or token, and `already-bound` when a different binding stands.
 */
async bind( request: { readonly serverOrigin: string readonly userId: UserId readonly deviceId: DeviceId readonly token: string }, now: number, ): Promise<HostDeviceBinding>

/**
 * Give up this host's binding.
 *
 * It is the operator action that follows a revocation, and the one that has
 * to happen before a machine can serve someone else. Releasing an unpaired
 * host changes nothing, so an operator repeating it is not told they were
 * too late.
 * @returns resolution once no binding is stored.
 */
async release(): Promise<void>
```

Source: [`packages/control-plane/device-binding/src/index.ts`](../../packages/control-plane/device-binding/src/index.ts)

<a id="ctxprovidercredentialchecks--providercredentialchecks"></a>

### `ctx.providerCredentialChecks` — `ProviderCredentialChecks`

The registry one deployment's provider integrations contribute to.

```ts cordis-catalog
/**
 * Register how one provider's credential is checked.
 * @param provider - the provider this check speaks for.
 * @param check - answers whether one secret authenticates, and nothing else.
 * @returns the disposer removing the registration.
 */
register(provider: ProviderKind, check: ProviderCredentialCheck): () => void

/**
 * Ask whether one credential authenticates with its provider.
 *
 * The first registration for a provider answers. A deployment composes one
 * integration per provider, and a second would be two opinions about one
 * fact with no rule for choosing between them.
 * @param provider - the account's provider.
 * @param secret - the opened credential, held only for this call.
 * @returns the verdict, or `unsupported-provider` when nothing is registered.
 */
async check(provider: ProviderKind, secret: Uint8Array): Promise<ProviderAccountValidation>
```

Source: [`packages/control-plane/provider-credential-checks/src/index.ts`](../../packages/control-plane/provider-credential-checks/src/index.ts)

<a id="ctxrunscheduler--runscheduler"></a>

### `ctx.runScheduler` — `RunScheduler`

Live run state for one Candy runtime, and the composition that starts a run.

One instance owns one ledger, so every run this runtime admits is accounted against the same delegation trees. Spent nonces instead belong to the durable control-plane store and are shared across runtime processes.

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
start( token: string, share: (run: { budget: RunBudget }) => RunBudget = run => run.budget, now: number = Date.now(), ): Promise<RunStartOutcome>

/**
 * Record what one run consumed since its last charge.
 * @param runId - the open run.
 * @param spend - what the invocation consumed.
 * @returns the updated record and the dimensions now used up, or why the
 *   charge was refused.
 */
charge(runId: RunId, spend: RunSpend): Promise<RunLedgerResult<RunChargeResult>>

/**
 * The tenant of a session's one open, usable run.
 *
 * Synchronous, unlike {@link runIdentityFor}: resolving a tenant reads the
 * same in-memory run index {@link findSessionRun} already reads for
 * metering and requires no credential open, so a caller wiring a
 * synchronous policy hook elsewhere in the harness — an `AgentPresets`
 * guard, for instance — can consult it directly instead of threading a
 * `Promise` through a call path that has no other reason to be async.
 * @param sessionId - the session naming the run to resolve.
 * @returns the run's tenant, or `undefined` when this runtime has no
 *   single open, usable run for that session.
 */
tenantOf(sessionId: SessionId): UserId | undefined

/**
 * Persist one final route-policy refusal for a managed session.
 *
 * The write settles before this promise does and never rejects, matching
 * metering refusal ordering: callers may report the denial only after the
 * trail has it, while an unavailable trail cannot turn a refusal into an
 * authorization success or a different failure.
 * @param sessionId - session whose route was refused.
 * @param code - stable policy failure code.
 * @param message - refusal text used if the audit write must be logged.
 */
recordRouteRefusal(sessionId: SessionId, code: string, message: string): Promise<void>

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
 * Resolve what a provider binding needs to launch one call for the run
 * driving a session: an opened credential, the pool it may use, and this
 * call's own spend ceiling.
 *
 * This is the reach `dsh-run-admission` gives a run once, at start, made
 * available again for every later call the same run makes. Nothing here is
 * cached from that first admission: the account is read fresh, and the
 * credential is opened fresh, so a binding built on this method inherits the
 * same property `meterRequest` already does — a revocation that happens
 * between two calls of one run stops the second rather than only the next
 * metered chunk.
 *
 * The opened secret is not retained here, and this method does not itself
 * launch anything: a caller that never calls it, and the ledger's own
 * per-call metering, are both unaffected by whether anything ever does.
 * @param sessionId - the session a provider binding's call was assembled for.
 * @returns the launch identity, or the reason none could be resolved.
 */
async runIdentityFor(sessionId: SessionId): Promise<RunIdentityResult>

/**
 * Resolve the one open durable run that owns a session in this runtime.
 * @param sessionId - session whose workspace authority is about to be used.
 * @returns the run record, or undefined when this runtime owns no unique open run.
 */
runOfSession(sessionId: SessionId): DurableRunRecord | undefined

/**
 * Mint and admit a child run for a session delegated from an already-open
 * run, inheriting the delegating run's tenant, account, provider, device,
 * workspace grant and conversation.
 *
 * This is the one place this runtime mints an execution assertion rather
 * than only verifying one it was handed. It needs no external issuing
 * authority because it authenticates nothing new: a delegated child's
 * identity is exactly its parent's, already verified when the parent's own
 * run was admitted, so re-deriving it here — sessionId, runId and nonce
 * freshly generated, everything else copied — is not a new grant of
 * authority, only a restatement of one already held. The minted token is
 * never transmitted or persisted; it exists only to drive the same
 * `start()` admission path a caller-supplied token would, so a child run is
 * funded, ledgered and audited exactly as a root run is, including the
 * parent-subset budget and concurrency accounting `dsh-run-budget` already
 * enforces for any assertion naming a `parentRunId`.
 * @param parentSessionId - the session whose open run the child delegates from.
 * @param childSessionId - the session the new child run drives.
 * @param share - the allowance to open the child with, computed from the
 *   parent's own remaining budget. Required rather than defaulted: how much
 *   of a parent's budget a delegated child should receive is a policy
 *   choice this runtime has no basis to guess.
 * @param now - epoch milliseconds; defaults to this runtime's clock.
 * @returns the child's start outcome, or the reason the parent session
 *   itself could not be resolved to one open, usable run.
 */
async startChildRun( parentSessionId: SessionId, childSessionId: SessionId, share: (run: { budget: RunBudget }) => RunBudget, now: number = Date.now(), ): Promise<StartChildRunResult>

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
 * Close the one open run driving a session, for a caller that knows the
 * session rather than the run.
 *
 * A delegated child is the case this exists for: whatever opened its run
 * named it by session, and the settlement it is reacting to names the same
 * session. Waiting for the lease instead would hold the parent's allowance
 * and one of its concurrency slots for minutes after the child finished, so
 * a parent that delegates in sequence would run out of slots it is no longer
 * using.
 *
 * A session this runtime has no single open run for is not an error: there
 * is nothing here to close, exactly as {@link tenantOf} answers nothing for
 * the same session.
 * @param sessionId - the session whose run should be settled.
 * @returns the settlement, or `undefined` when nothing was closed — this
 *   runtime has no single open run for that session, or a concurrent close
 *   settled it between resolving the run and reaching the queue.
 */
async closeSessionRun(sessionId: SessionId): Promise<RunSettlement | undefined>

/**
 * Register a disposer to run once, when `runId` is settled.
 *
 * The producer is whatever holds a live resource this run started and the
 * ledger cannot reach: a spawned process, bound to the run at the moment it
 * is created. Settlement ends the run's accounting whichever way it comes
 * about — a normal finish, an expired lease, an account no longer able to
 * authorize it, or an ancestor's tree closing around it — and this is what
 * lets that same event reach the resource.
 *
 * At most one disposer is held per run: a later registration replaces an
 * earlier one rather than accumulating, which is correct for a run that
 * makes several sequential calls, since only the live one still needs
 * releasing. A caller whose resource already ended on its own unregisters
 * with the returned function, so a stale disposer is never invoked for a
 * process that already exited.
 * @param runId - the run whose settlement should trigger disposal.
 * @param dispose - releases the resource; a rejection is logged and never
 *   allowed to fail the settlement that triggered it.
 * @returns unregisters this disposer without invoking it.
 */
registerDisposer(runId: RunId, dispose: () => void | Promise<void>): () => void

/**
 * Wrap a process-spawning function so every handle it returns is registered
 * against `runId`'s lifetime and unregistered once that process exits on
 * its own.
 *
 * This is the whole of the disposal wiring a provider binding needs: compose
 * it around the `spawn` function an adapter is given, and settlement reaches
 * every process that function ever starts for this run, without the binding
 * knowing anything about settlement itself.
 * @param runId - the run each spawned handle's disposer is registered against.
 * @param spawn - the underlying spawn function, called unchanged.
 * @returns a spawn function with the same signature.
 */
disposableSpawn<Spec, Handle extends { readonly done: Promise<unknown>; terminate(): void }>( runId: RunId, spawn: (spec: Spec) => Handle, ): (spec: Spec) => Handle

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

Types: [SessionId](core.md) · [StreamChunk](llm-streaming.md)

Source: [`packages/control-plane/run-scheduler/src/index.ts`](../../packages/control-plane/run-scheduler/src/index.ts)
<!-- END GENERATED cordis-surface -->
