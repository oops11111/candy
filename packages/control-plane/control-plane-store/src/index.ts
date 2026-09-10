/**
 * The durable side of the Candy control plane: provider accounts with their
 * sealed credentials, and each tenant's allowance, over `storage-domain`.
 *
 * `dsh-provider-accounts` defines the account store as a port and
 * `dsh-run-admission` requires a credential lookup and a budget lookup as
 * ports. Every one of them was a parameter no deployment could fill, because
 * nothing in the repository held the data. This service holds it.
 *
 * It holds run records too, but it is not the ledger. `RunLedger` remains the
 * accounting authority and answers what a run may still spend; what lives here
 * is the record that survives a restart, and the settlement marker that lets an
 * interrupted charge be finished exactly once. A child run is still admitted
 * against its *parent's* remainder, which only a live ledger knows.
 *
 * @module @deepseek-ai/dsh-control-plane-store
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { UserId, UserSessionId, type ControlPlaneRole, type DeviceId, type OAuthIdentity, type ProviderAccountId, type RunId, type WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CredentialEnvelope } from '@deepseek-ai/dsh-credential-vault'
import type { ProviderAccountEntry, ProviderAccountRecord, ProviderAccountStore } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import type { ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import { replayKey } from '@deepseek-ai/dsh-run-replay'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { consumeAllowance, openAllowance, type TenantAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import type { DeviceRecord, DeviceRegistryStore, PairingCodeRecord } from '@deepseek-ai/dsh-device-registry'
import type { WorkspaceGrantRecord, WorkspaceGrantStore } from '@deepseek-ai/dsh-workspace-grant'
import {
  controlPlaneDomainSpec,
  fromStoredAllowance,
  fromStoredDevice,
  fromStoredEntry,
  fromStoredGrantRecord,
  fromStoredPairingCode,
  fromStoredRecord,
  fromStoredRun,
  fromStoredUserSession,
  toStoredAllowance,
  toStoredDevice,
  toStoredEntry,
  toStoredGrant,
  toStoredPairingCode,
  toStoredRun,
  type AuditSubject,
  type DurableRunRecord,
  type RunAuditRecord,
  type StoredAuditTrail,
  type StoredDevice,
  type StoredPairingCode,
  type StoredRun,
  type StoredTenantAllowance,
  type StoredTenantRoutePolicy,
  type StoredOAuthAttempt,
  type StoredOAuthEnrollment,
  type StoredWorkspaceGrant,
  type StoredUserSession,
  type TenantModelRoute,
  type UserSessionRecord,
} from './spec.ts'

export { controlPlaneDomainSpec, runtimeSubject, tenantSubject } from './spec.ts'
export type { AuditSubject, DurableRunRecord, RunAuditRecord, StoredAuditTrail, StoredDevice, StoredPairingCode, StoredRun, StoredTenantAllowance, StoredTenantRoutePolicy, StoredWorkspaceGrant, TenantModelRoute, UserSessionRecord } from './spec.ts'

/**
 * Add one record to a trail, folding it into the last when it says the same
 * thing again.
 *
 * A bounded trail is rewritten whole, so an event that repeats pushes the
 * subject's earlier history out of the window one record at a time. That makes
 * the trail erasable by whoever causes the repetition: eight refused calls
 * against a retention of four left nothing but the refusals, and the
 * credential and start records an operator would investigate them with were
 * gone. A record identical to the newest one in every field but its instant
 * adds nothing the trail could distinguish, so it becomes a count on that one
 * and the history behind it stays.
 *
 * @param trail - the subject's records, oldest first.
 * @param record - the record to add.
 * @returns the trail with the record added, or folded into its last entry.
 */
function append(trail: readonly RunAuditRecord[], record: RunAuditRecord): RunAuditRecord[] {
  const last = trail.at(-1)
  if (last === undefined || !sameEvent(last, record)) return [...trail, record]
  return [...trail.slice(0, -1), { ...last, at: record.at, count: (last.count ?? 1) + 1 }]
}

/**
 * Whether two records describe the same thing happening again.
 *
 * The instant differs by definition and the count is what folding produces, so
 * neither takes part. Nor does `parentRunId`, which is a property of `runId`:
 * two records naming one run name one parent, and a record naming no run was
 * refused before any lineage was believed. Everything else identifies what
 * happened and to whom.
 *
 * @param last - the newest record in the trail.
 * @param record - the record being added.
 * @returns true when the two differ only in when they happened.
 */
function sameEvent(last: RunAuditRecord, record: RunAuditRecord): boolean {
  return last.event === record.event
    && last.action === record.action
    && last.outcome === record.outcome
    && last.runId === record.runId
    && last.userId === record.userId
    && last.accountId === record.accountId
    && last.provider === record.provider
    && last.model === record.model
    && sameSpend(last.spent, record.spent)
}

/** Compare optional terminal usage by value rather than object identity. */
function sameSpend(left: RunAuditRecord['spent'], right: RunAuditRecord['spent']): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.tokens === right.tokens
    && left.wallMs === right.wallMs
    && left.costMicroUsd === right.costMicroUsd
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    controlPlaneStore: ControlPlaneStore
  }
}

/**
 * Durable provider accounts, tenant allowances and model-route policies.
 *
 * Reads are synchronous against the domain's in-memory state and are exposed
 * as promises because the ports they satisfy are asynchronous. Writes reach
 * the medium before memory, so a read never sees a record the medium does not
 * hold.
 */
export class ControlPlaneStore extends Service implements DeviceRegistryStore, ProviderAccountStore, WorkspaceGrantStore {
  static inject = ['storageDomain']

  // Assigned by `Service.init`, which Cordis awaits before the service is
  // reachable, so a guard for the unopened state would be untestable rather
  // than defensive.
  /**
   * The one chain every read-modify-write here queues on.
   *
   * The domain serializes each `put` but not the read that decides what to
   * put: two callers that read one record before either writes both compute
   * from the same value, and the second write drops the first. That is a lost
   * charge or a lost audit record, so the read and the write it feeds happen
   * together here.
   */
  private mutations: Promise<unknown> = Promise.resolve()

  private accounts!: KvTable<ProviderAccountId, ReturnType<typeof toStoredEntry>>
  private allowances!: KvTable<UserId, StoredTenantAllowance>
  private runs!: KvTable<RunId, StoredRun>
  private audits!: KvTable<AuditSubject, StoredAuditTrail>
  private grants!: KvTable<WorkspaceGrantId, StoredWorkspaceGrant>
  private devices!: KvTable<DeviceId, StoredDevice>
  private pairingCodes!: KvTable<string, StoredPairingCode>
  private managedSessions!: KvTable<SessionId, { runtime: string }>
  private spentNonces!: KvTable<string, { expiresAt: number }>
  private tenantRoutes!: KvTable<UserId, StoredTenantRoutePolicy>
  private userSessions!: KvTable<UserSessionId, StoredUserSession>
  private oauthAttempts!: KvTable<string, StoredOAuthAttempt>
  private oauthEnrollments!: KvTable<string, StoredOAuthEnrollment>

  constructor(ctx: Context) {
    super(ctx, 'controlPlaneStore')
  }

  /** Open the domain and hold its tables for the life of this service. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(controlPlaneDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'controlPlaneStore.domainClose')
    this.accounts = domain.table('accounts')
    this.allowances = domain.table('allowances')
    this.runs = domain.table('runs')
    this.audits = domain.table('audits')
    this.grants = domain.table('grants')
    this.devices = domain.table('devices')
    this.pairingCodes = domain.table('pairing_codes')
    this.managedSessions = domain.table('managed_sessions')
    this.spentNonces = domain.table('spent_nonces')
    this.tenantRoutes = domain.table('tenant_routes')
    this.userSessions = domain.table('user_sessions')
    this.oauthAttempts = domain.table('oauth_attempts')
    this.oauthEnrollments = domain.table('oauth_enrollments')
  }

  /**
   * Enroll one verified external identity exactly once.
   * @param identity - OAuth issuer and subject verified by the configured provider.
   * @param userId - existing Candy user this identity signs in as.
   * @param role - Candy authorization assigned by provisioning, not provider claims.
   * @param enrolledAt - epoch milliseconds recorded for operator audit.
   * @returns true only when this call created the mapping.
   */
  async enrollOAuthIdentity(
    identity: OAuthIdentity,
    userId: UserId,
    role: ControlPlaneRole,
    enrolledAt: number,
  ): Promise<boolean> {
    if (identity.issuer.trim() === '' || identity.subject.trim() === '') {
      throw new TypeError('dsh-control-plane-store: OAuth issuer and subject must be non-blank')
    }
    if (!Number.isSafeInteger(enrolledAt)) {
      throw new RangeError('dsh-control-plane-store: OAuth enrollment instant must be a safe integer')
    }
    const key = createHash('sha256')
      .update(identity.issuer, 'utf8').update('\0', 'utf8').update(identity.subject, 'utf8').digest('hex')
    const enrollment: StoredOAuthEnrollment = {
      issuer: identity.issuer,
      subject: identity.subject,
      userId,
      role,
      enrolledAt,
    }
    return (await this.oauthEnrollments.compareExchange(key, undefined, enrollment)).exchanged
  }

  /**
   * Resolve Candy authorization for a verified external identity.
   * @param identity - issuer and subject returned by the configured verifier.
   * @returns the provisioned Candy user and role, or undefined when not enrolled.
   */
  resolve(identity: OAuthIdentity): Promise<{
    readonly userId: UserId
    readonly role: ControlPlaneRole
  } | undefined> {
    const key = createHash('sha256')
      .update(identity.issuer, 'utf8').update('\0', 'utf8').update(identity.subject, 'utf8').digest('hex')
    const stored = this.oauthEnrollments.get(key)
    return Promise.resolve(stored === undefined ? undefined : {
      userId: UserId(stored.userId),
      role: stored.role,
    })
  }

  /**
   * Begin one OAuth authorization-code transaction with PKCE S256.
   * @param issuer - exact configured OAuth issuer identifier.
   * @param redirectUri - callback URI the later code exchange must repeat.
   * @param now - transaction creation time in epoch milliseconds.
   * @param expiresAt - epoch milliseconds after which the callback is refused.
   * @returns opaque state and public S256 challenge; the verifier stays server-side.
   */
  async beginOAuthAttempt(
    issuer: string,
    redirectUri: string,
    now: number,
    expiresAt: number,
  ): Promise<{ readonly state: string; readonly codeChallenge: string; readonly nonce: string }> {
    if (issuer.trim() === '' || redirectUri.trim() === '') {
      throw new TypeError('dsh-control-plane-store: OAuth issuer and redirect URI must be non-blank')
    }
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      throw new RangeError('dsh-control-plane-store: OAuth attempt expiry must be a safe integer after creation')
    }
    const state = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const stateDigest = createHash('sha256').update(state, 'utf8').digest('hex')
    await this.oauthAttempts.put(stateDigest, { stateDigest, codeVerifier, nonce, issuer, redirectUri, expiresAt })
    return {
      state,
      codeChallenge: createHash('sha256').update(codeVerifier, 'utf8').digest('base64url'),
      nonce,
    }
  }

  /**
   * Consume a callback state once and recover the PKCE exchange inputs.
   * @param state - exact opaque value returned through the provider callback.
   * @param now - callback receipt time in epoch milliseconds.
   * @returns exchange inputs only for the first matching, unexpired callback.
   */
  async consumeOAuthAttempt(
    state: string,
    now: number,
  ): Promise<{
    readonly codeVerifier: string
    readonly nonce: string
    readonly issuer: string
    readonly redirectUri: string
  } | undefined> {
    const key = createHash('sha256').update(state, 'utf8').digest('hex')
    const stored = this.oauthAttempts.get(key)
    if (stored === undefined) return undefined
    const consumed = await this.oauthAttempts.compareExchange(key, stored, undefined)
    if (!consumed.exchanged || stored.expiresAt <= now || stored.nonce === undefined) return undefined
    return {
      codeVerifier: stored.codeVerifier,
      nonce: stored.nonce,
      issuer: stored.issuer,
      redirectUri: stored.redirectUri,
    }
  }

  /**
   * Create one revocable browser session after an OAuth verifier has proved the external identity.
   * @param userId - Candy user mapped from the verified external identity.
   * @param role - Candy-assigned authorization; never a browser-supplied claim.
   * @param identity - verified OAuth issuer and subject.
   * @param createdAt - current epoch milliseconds.
   * @param expiresAt - expiry after `createdAt`.
   * @returns the bearer and independent CSRF token exactly once, plus the secret-free durable record.
   */
  async createUserSession(
    userId: UserId,
    role: ControlPlaneRole,
    identity: OAuthIdentity,
    createdAt: number,
    expiresAt: number,
  ): Promise<{ readonly token: string; readonly csrfToken: string; readonly record: UserSessionRecord }> {
    if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= createdAt) {
      throw new RangeError('dsh-control-plane-store: user session expiry must be a safe integer after creation')
    }
    if (identity.issuer.trim() === '' || identity.subject.trim() === '') {
      throw new TypeError('dsh-control-plane-store: OAuth issuer and subject must be non-blank')
    }
    const id = UserSessionId(randomUUID())
    const token = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(32).toString('base64url')
    const stored: StoredUserSession = {
      id,
      tokenDigest: createHash('sha256').update(token, 'utf8').digest('hex'),
      csrfDigest: createHash('sha256').update(csrfToken, 'utf8').digest('hex'),
      userId,
      role,
      oauthIssuer: identity.issuer,
      oauthSubject: identity.subject,
      createdAt,
      expiresAt,
    }
    await this.userSessions.put(id, stored)
    return { token, csrfToken, record: fromStoredUserSession(stored) }
  }

  /**
   * Authenticate one bearer without accepting identity or role from the request.
   * @param token - opaque token returned once at session creation.
   * @param now - current epoch milliseconds.
   * @returns the active session, or undefined for unknown, revoked, or expired credentials.
   */
  async authenticateUserSession(token: string, now: number): Promise<UserSessionRecord | undefined> {
    const digest = createHash('sha256').update(token, 'utf8').digest('hex')
    for (const [id, snapshot] of this.userSessions.entries()) {
      if (snapshot.tokenDigest !== digest) continue
      const stored = await this.userSessions.getCurrent(id)
      if (stored === undefined || stored.tokenDigest !== digest) return undefined
      if (stored.revokedAt !== undefined || stored.expiresAt <= now) return undefined
      return fromStoredUserSession(stored)
    }
    return undefined
  }

  /**
   * Verify the independent anti-CSRF token for an authenticated session.
   * @param id - session already authenticated by its HttpOnly bearer.
   * @param csrfToken - value repeated from a readable same-site cookie into a request header.
   * @returns true only when the active session owns that token.
   */
  verifyUserSessionCsrf(id: UserSessionId, csrfToken: string): boolean {
    const stored = this.userSessions.get(id)
    if (stored === undefined || stored.revokedAt !== undefined) return false
    const actual = Buffer.from(createHash('sha256').update(csrfToken, 'utf8').digest('hex'), 'utf8')
    const expected = Buffer.from(stored.csrfDigest, 'utf8')
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
  }

  /**
   * Revoke one browser session; subsequent authentication fails immediately.
   * @param id - session selected by an already-authorized logout or administrative action.
   * @param revokedAt - epoch milliseconds recorded as the revocation instant.
   * @returns true when the session exists, including an already-revoked session.
   */
  async revokeUserSession(id: UserSessionId, revokedAt: number): Promise<boolean> {
    const stored = this.userSessions.get(id)
    if (stored === undefined) return false
    if (stored.revokedAt === undefined) await this.userSessions.put(id, { ...stored, revokedAt })
    return true
  }

  /**
   * Read one tenant's complete model-route allowlist.
   *
   * Missing means no policy was provisioned and therefore no route is
   * allowed. An empty returned list is an explicit deny-all policy; callers
   * enforce both cases identically but operators can still distinguish them.
   * @param userId - the tenant whose model authority is requested.
   * @returns a defensive copy of the routes, or undefined when not provisioned.
   */
  tenantModelRoutes(userId: UserId): readonly TenantModelRoute[] | undefined {
    const stored = this.tenantRoutes.get(userId)
    return stored?.routes.map(route => ({ ...route }))
  }

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
  async setTenantModelRoutes(userId: UserId, routes: readonly TenantModelRoute[]): Promise<readonly TenantModelRoute[]> {
    const stored: TenantModelRoute[] = []
    const seen = new Set<string>()
    for (const route of routes) {
      if (route.provider.trim() === '' || route.model.trim() === '') {
        throw new TypeError('dsh-control-plane-store: tenant model routes require non-blank provider and model ids')
      }
      const key = `${route.provider}\u0000${route.model}`
      if (seen.has(key)) {
        throw new TypeError(`dsh-control-plane-store: duplicate tenant model route ${JSON.stringify(`${route.provider}/${route.model}`)}`)
      }
      seen.add(key)
      stored.push({ provider: route.provider, model: route.model })
    }
    await this.tenantRoutes.put(userId, { routes: stored })
    return stored.map(route => ({ ...route }))
  }

  /**
   * Atomically consume one tenant-scoped assertion nonce on the durable
   * medium. A digest keeps the per-record JSON layout's path-safe key contract
   * without weakening the collision boundary held by `replayKey`.
   *
   * @param claims - The verified tenant, nonce, and assertion expiry.
   * @param now - The admission decision's epoch-millisecond timestamp.
   * @returns true only for the first admissible use.
   */
  async spendNonce(
    claims: ExecutionAssertionClaims,
    now: number,
  ): Promise<boolean> {
    const key = createHash('sha256').update(replayKey(claims)).digest('hex')
    const replacement = { expiresAt: claims.expiresAt }
    let expected = this.spentNonces.get(key)
    // A failed exchange returns the medium's current value, so each retry
    // advances rather than spinning on this process's open-time snapshot.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (expected !== undefined && expected.expiresAt > now) return false
      const result = await this.spentNonces.compareExchange(key, expected, replacement)
      if (result.exchanged) return true
      expected = result.current
    }
    // Reached only if another runtime wins the same key on eight consecutive
    // exchanges; refusing keeps a contended nonce from being spent twice.
    /* v8 ignore next -- sustained cross-process contention cannot be scheduled deterministically. */
    return false
  }

  /**
   * Remove locally known nonce records after their assertions expire. The
   * compare/exchange prevents one process from deleting a newer reservation
   * another process installed under the same key.
   * @param now - Epoch milliseconds used as the expiry boundary.
   * @returns the number of records this process removed.
   */
  async evictNonces(now: number): Promise<number> {
    let dropped = 0
    for (const [key, record] of this.spentNonces.entries()) {
      if (record.expiresAt > now) continue
      const result = await this.spentNonces.compareExchange(key, record, undefined)
      if (result.exchanged) dropped += 1
    }
    return dropped
  }

  /**
   * Every account one tenant owns, deleted ones included.
   *
   * A deleted account is retained rather than removed: `dsh-provider-accounts`
   * keeps its id blocked so a later account cannot inherit its history.
   * @param userId - the tenant to list.
   * @returns that tenant's accounts, in no defined order.
   */
  listByUser(userId: UserId): Promise<readonly ProviderAccountEntry[]> {
    const owned: ProviderAccountEntry[] = []
    for (const [, stored] of this.accounts.entries()) {
      if (stored.record.userId === userId) owned.push(fromStoredEntry(stored))
    }
    return Promise.resolve(owned)
  }

  /**
   * One account by id.
   * @param id - the account to read.
   * @returns the account and its sealed credential, or undefined.
   */
  find(id: ProviderAccountId): Promise<ProviderAccountEntry | undefined> {
    const stored = this.accounts.get(id)
    return Promise.resolve(stored === undefined ? undefined : fromStoredEntry(stored))
  }

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
  accountOf(id: ProviderAccountId): ProviderAccountRecord | undefined {
    const stored = this.accounts.get(id)
    return stored === undefined ? undefined : fromStoredRecord(stored.record)
  }

  /**
   * Write one account, replacing any record under the same id.
   * @param entry - the account and its sealed credential.
   * @returns resolution after the write reaches the medium.
   */
  async save(entry: ProviderAccountEntry): Promise<void> {
    await this.accounts.put(entry.record.id, toStoredEntry(entry))
  }

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
  async findCredential(claims: { userId: UserId; accountId: ProviderAccountId }): Promise<CredentialEnvelope | undefined> {
    const entry = await this.find(claims.accountId)
    if (entry === undefined || entry.record.userId !== claims.userId) return undefined
    return entry.credential
  }

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
  tenantAllowance(userId: UserId): Promise<TenantAllowance | undefined> {
    const stored = this.allowances.get(userId)
    return Promise.resolve(stored === undefined ? undefined : fromStoredAllowance(stored))
  }

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
  // `async` so the argument checks above the chain reject the returned promise
  // rather than throwing synchronously at a caller that only awaits.
  async setTenantGrant(userId: UserId, grant: RunBudget): Promise<TenantAllowance> {
    const opened = openAllowance(grant)
    return this.mutate(async () => {
      const current = this.allowances.get(userId)
      const allowance: TenantAllowance = current === undefined
        ? opened
        : { grant: opened.grant, consumed: fromStoredAllowance(current).consumed }
      await this.allowances.put(userId, toStoredAllowance(allowance))
      return allowance
    })
  }

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
  consumeTenantAllowance(userId: UserId, runId: RunId, spent: RunSpend): Promise<TenantAllowance | undefined> {
    return this.mutate(async () => {
      const stored = this.allowances.get(userId)
      if (stored === undefined) return undefined
      if (stored.lastSettledRunId === runId) return fromStoredAllowance(stored)
      const charged = consumeAllowance(fromStoredAllowance(stored), spent)
      await this.allowances.put(userId, { ...toStoredAllowance(charged), lastSettledRunId: runId })
      return charged
    })
  }

  /**
   * Every run one runtime has open or part-way through settling.
   *
   * Only that runtime's own records: two runtimes sharing this medium would
   * otherwise recover each other's live runs and settle them at boot.
   * @param runtime - the reading runtime's own audience identifier.
   * @returns its records, in no defined order.
   */
  runsOf(runtime: string): Promise<readonly DurableRunRecord[]> {
    const owned: DurableRunRecord[] = []
    for (const [, stored] of this.runs.entries()) {
      if (stored.runtime === runtime) owned.push(fromStoredRun(stored))
    }
    return Promise.resolve(owned)
  }

  /**
   * One run's record by id, whatever runtime opened it.
   *
   * A child run is checked against its parent's identity, and the parent is
   * named by the claims rather than found by scanning.
   * @param runId - the run to read.
   * @returns its record, or undefined when none is held.
   */
  findRun(runId: RunId): DurableRunRecord | undefined {
    const stored = this.runs.get(runId)
    return stored === undefined ? undefined : fromStoredRun(stored)
  }

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
  runsOfSession(runtime: string, sessionId: SessionId): readonly DurableRunRecord[] {
    const found: DurableRunRecord[] = []
    for (const [, stored] of this.runs.entries()) {
      if (stored.runtime === runtime && stored.sessionId === sessionId) found.push(fromStoredRun(stored))
    }
    return found
  }

  /**
   * Write the record of one newly opened run.
   * @param run - the run's accounting, tenant, runtime, and settlement state.
   * @returns resolution after the write reaches the medium.
   */
  async openRun(run: DurableRunRecord): Promise<void> {
    await this.managedSessions.put(run.sessionId, { runtime: run.runtime })
    await this.runs.put(run.record.runId, toStoredRun(run))
  }

  /**
   * Whether a session belongs to Candy, including after its run settles.
   * @param sessionId - the session named by a model request.
   * @param runtime - the runtime whose request is being classified.
   * @returns true when durable ownership exists for that runtime.
   */
  isManagedSession(sessionId: SessionId, runtime: string): boolean {
    return this.managedSessions.get(sessionId)?.runtime === runtime
  }

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
  async recordRunSpend(runId: RunId, spent: RunSpend): Promise<void> {
    if (this.runs.get(runId) === undefined) return
    await this.runs.update(runId, current => ({
      ...current,
      spent: { tokens: spent.tokens, wallMs: spent.wallMs, costMicroUsd: spent.costMicroUsd },
    }))
  }

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
  async renewRun(runId: RunId, leaseExpiresAt: number): Promise<void> {
    if (this.runs.get(runId) === undefined) return
    await this.runs.update(runId, current => ({ ...current, leaseExpiresAt }))
  }

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
  async absorbChild(parentRunId: RunId, childRunId: RunId, spent: RunSpend): Promise<void> {
    const parent = this.runs.get(parentRunId)
    if (parent === undefined || parent.absorbed === childRunId) return
    await this.runs.update(parentRunId, current => ({
      ...current,
      spent: {
        tokens: current.spent.tokens + spent.tokens,
        wallMs: current.spent.wallMs + spent.wallMs,
        costMicroUsd: current.spent.costMicroUsd + spent.costMicroUsd,
      },
      absorbed: childRunId,
    }))
  }

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
  async markRunSettled(runId: RunId, spent: RunSpend): Promise<DurableRunRecord> {
    const stored = await this.runs.update(runId, current => ({
      ...current,
      settledSpent: { tokens: spent.tokens, wallMs: spent.wallMs, costMicroUsd: spent.costMicroUsd },
    }))
    return fromStoredRun(stored)
  }

  /**
   * Remove one run's record.
   * @param runId - the run to forget.
   * @returns true when a record was removed, false when it was already absent.
   */
  deleteRun(runId: RunId): Promise<boolean> {
    return this.runs.delete(runId)
  }

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
  // `async` for the reason `setTenantGrant` is.
  async recordAudit(
    subject: AuditSubject,
    records: readonly RunAuditRecord[],
    retain: number,
  ): Promise<readonly RunAuditRecord[]> {
    if (!Number.isSafeInteger(retain) || retain <= 0) {
      throw new RangeError(`dsh-control-plane-store: audit retention must be a positive safe integer, got ${String(retain)}`)
    }
    return this.mutate(async () => {
      if (records.length === 0) return this.auditsOf(subject)
      let trail = [...this.audits.get(subject)?.records ?? []]
      for (const record of records) trail = append(trail, record)
      const kept = trail.slice(-retain)
      await this.audits.put(subject, { records: kept })
      return kept
    })
  }

  /**
   * Read the grant an execution assertion names.
   *
   * Answering `undefined` denies the run: a grant this store does not hold is
   * never an unlimited one, which is the rule {@link
   * @deepseek-ai/dsh-workspace-grant!refuseWorkspaceGrant} applies.
   * @param id - the grant id the assertion carries.
   * @returns the grant, or `undefined` when none is stored under that id.
   */
  findGrant(id: WorkspaceGrantId): Promise<WorkspaceGrantRecord | undefined> {
    return Promise.resolve(this.grantSnapshot(id))
  }

  /**
   * Read one grant from this process's current store view for a synchronous
   * executor boundary. Callers that can await use {@link findGrant} so a
   * future medium-backed refresh remains transparent.
   * @param id - grant identifier carried by the current run.
   * @returns a defensive record copy, or undefined when absent.
   */
  grantSnapshot(id: WorkspaceGrantId): WorkspaceGrantRecord | undefined {
    const stored = this.grants.get(id)
    return stored === undefined ? undefined : fromStoredGrantRecord(stored)
  }

  /**
   * Write one grant, replacing any record under the same id.
   *
   * A revocation is this same call with `revokedAt` set: the record is the
   * authority an assertion only names, so removing it would leave a run
   * naming a grant that reads as never-issued rather than as withdrawn.
   * @param record - the grant to store.
   * @returns resolution once the medium holds it.
   */
  async saveGrant(record: WorkspaceGrantRecord): Promise<void> {
    await this.grants.put(record.id, toStoredGrant(record))
  }

  /**
   * Read one device by the id an assertion names.
   * @param id - the device id.
   * @returns the device, or `undefined` when nothing resolves the id.
   */
  findDevice(id: DeviceId): Promise<DeviceRecord | undefined> {
    const stored = this.devices.get(id)
    return Promise.resolve(stored === undefined ? undefined : fromStoredDevice(stored))
  }

  /**
   * Read one tenant's devices, revoked ones included.
   * @param userId - the tenant.
   * @returns their devices, in no defined order.
   */
  listDevicesOfUser(userId: UserId): Promise<readonly DeviceRecord[]> {
    const records: DeviceRecord[] = []
    for (const [, stored] of this.devices.entries()) {
      if (stored.userId === userId) records.push(fromStoredDevice(stored))
    }
    return Promise.resolve(records)
  }

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
  async findDeviceByTokenDigest(tokenDigest: string): Promise<DeviceRecord | undefined> {
    for (const [id, snapshot] of this.devices.entries()) {
      if (snapshot.tokenDigest !== tokenDigest) continue
      const stored = await this.devices.getCurrent(id)
      if (stored === undefined || stored.tokenDigest !== tokenDigest) return undefined
      return fromStoredDevice(stored)
    }
    return undefined
  }

  /**
   * Write one device, replacing any record under the same id.
   * @param record - the device to store.
   * @returns resolution once the medium holds it.
   */
  async saveDevice(record: DeviceRecord): Promise<void> {
    await this.devices.put(record.id, toStoredDevice(record))
  }

  /**
   * Read one pairing code by digest, consumed and expired ones included.
   * @param digest - the normalized code's digest.
   * @returns the code, or `undefined` when nothing resolves the digest.
   */
  findPairingCode(digest: string): Promise<PairingCodeRecord | undefined> {
    const stored = this.pairingCodes.get(digest)
    return Promise.resolve(stored === undefined ? undefined : fromStoredPairingCode(stored))
  }

  /**
   * Read one tenant's pairing codes, consumed and expired ones included.
   * @param userId - the tenant.
   * @returns their codes, in no defined order.
   */
  listPairingCodesOfUser(userId: UserId): Promise<readonly PairingCodeRecord[]> {
    const records: PairingCodeRecord[] = []
    for (const [, stored] of this.pairingCodes.entries()) {
      if (stored.userId === userId) records.push(fromStoredPairingCode(stored))
    }
    return Promise.resolve(records)
  }

  /**
   * Write one pairing code, replacing any record under the same digest.
   * @param record - the code to store.
   * @returns resolution once the medium holds it.
   */
  async savePairingCode(record: PairingCodeRecord): Promise<void> {
    await this.pairingCodes.put(record.digest, toStoredPairingCode(record))
  }

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
  async claimPairingCode(
    digest: string,
    deviceId: DeviceId,
    at: number,
  ): Promise<PairingCodeRecord | undefined> {
    let expected = this.pairingCodes.get(digest)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (expected === undefined || expected.consumedAt !== undefined || expected.expiresAt <= at) {
        return undefined
      }
      const replacement: StoredPairingCode = { ...expected, consumedAt: at, deviceId }
      const result = await this.pairingCodes.compareExchange(digest, expected, replacement)
      if (result.exchanged) return fromStoredPairingCode(expected)
      expected = result.current
    }
    // Reached only if another runtime wins the same code on eight consecutive
    // exchanges; refusing keeps a contended code from pairing two hosts.
    /* v8 ignore next -- sustained cross-process contention cannot be scheduled deterministically. */
    return undefined
  }

  /** Queue one read-modify-write, so no other reads the record it is about to replace. */
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(work, work)
    this.mutations = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * One subject's recorded activity, oldest first.
   * @param subject - the tenant or runtime to read.
   * @returns its retained records; empty when nothing is recorded for it.
   */
  auditsOf(subject: AuditSubject): readonly RunAuditRecord[] {
    return this.audits.get(subject)?.records ?? []
  }

}

export default ControlPlaneStore
