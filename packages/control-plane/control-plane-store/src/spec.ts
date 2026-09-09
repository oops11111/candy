/**
 * The Candy control plane's durable declaration: what a provider account and a
 * tenant allowance look like on the medium, and the domain the store opens.
 *
 * The stored shapes are deliberately not the in-memory ones. JSON drops an
 * `undefined` property, so a field the runtime types as `number | undefined`
 * comes back as an absent key; the schemas below say `optional` and the
 * converters beside them put the field back. Reading the runtime type straight
 * from `z.infer` would compile and then disagree with itself the first time a
 * never-validated account round-tripped.
 * @module @deepseek-ai/dsh-control-plane-store/src/spec
 */

import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ConversationId, DeviceId, ProviderAccountId, RunId, UserId, UserSessionId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import type { ControlPlaneRole, OAuthIdentity, UserId as TenantId } from '@deepseek-ai/dsh-control-plane'
import { CredentialKeyVersion, type CredentialEnvelope } from '@deepseek-ai/dsh-credential-vault'
import type { ProviderAccountEntry, ProviderAccountRecord } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import type { RunRecord } from '@deepseek-ai/dsh-run-ledger'
import type { TenantAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import type { WorkspaceGrantRecord } from '@deepseek-ai/dsh-workspace-grant'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** The closed provider set, spelled once for the durable boundary. */
const provider = z.enum(['deepseek-api', 'claude-cli', 'codex-cli'])

/** Stored account metadata; absent timestamps mean the event never happened. */
const storedRecord = z.object({
  id: z.string(),
  userId: z.string(),
  provider,
  label: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  validatedAt: z.number().optional(),
  revokedAt: z.number().optional(),
  deletedAt: z.number().optional(),
  isDefault: z.boolean(),
})

/** Stored credential envelope; a revoked one carries empty ciphertext fields. */
const storedCredential = z.object({
  envelopeVersion: z.number(),
  userId: z.string(),
  accountId: z.string(),
  keyVersion: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
  authTag: z.string(),
  sealedAt: z.number(),
  rewrappedAt: z.number().optional(),
  revokedAt: z.number().optional(),
})

/** One stored account: its metadata and the sealed credential it authenticates with. */
const storedEntry = z.object({ record: storedRecord, credential: storedCredential })

/** One tenant's grant, in the four dimensions `dsh-run-budget` bounds. */
const storedGrant = z.object({
  tokens: z.number(),
  wallMs: z.number(),
  costMicroUsd: z.number(),
  children: z.number(),
})

/**
 * What one tenant's settled runs consumed. It carries no `children` for the
 * reason `RunSpend` does not: a concurrency slot is held and returned, never
 * spent.
 */
const storedConsumed = z.object({
  tokens: z.number(),
  wallMs: z.number(),
  costMicroUsd: z.number(),
})

/**
 * One tenant's allowance: the grant an operator set, and what has been drawn
 * from it. The grant is stored beside the consumption rather than decremented
 * in place, so a restart can still report what the tenant was given.
 */
const storedAllowance = z.object({
  grant: storedGrant,
  consumed: storedConsumed,
  /**
   * The last settled run folded into `consumed`, absent before the first one.
   *
   * It is what makes a settlement exactly-once across a crash. Charging the
   * tenant and deleting the settled run record are two writes this medium
   * cannot make one, so a crash between them leaves a settled record that a
   * recovering runtime would charge a second time. Recording which run this
   * value already absorbed answers that question from the same record the
   * charge lands in, and therefore from the same atomic write.
   */
  lastSettledRunId: z.string().optional(),
})

/**
 * One run's durable record: the ledger's own accounting, plus the tenant it is
 * charged to, the runtime that opened it, and the settlement it is part-way
 * through.
 */
const storedRun = z.object({
  runId: z.string(),
  parentRunId: z.string().optional(),
  userId: z.string(),
  /** The harness session this run drives; how its model calls find it. */
  sessionId: z.string(),
  /** The provider account this run was admitted for; a child may not name another. */
  accountId: z.string(),
  /** Paired device the run was requested from; a minted child assertion copies its parent's. */
  deviceId: z.string(),
  /** Workspace grant bounding the run's filesystem authority; a minted child assertion copies its parent's. */
  workspaceGrantId: z.string(),
  /** Tenant-visible conversation the run belongs to; a minted child assertion copies its parent's. */
  conversationId: z.string(),
  runtime: z.string(),
  reserved: storedGrant,
  spent: storedConsumed,
  leaseExpiresAt: z.number(),
  /**
   * What settling this run charges, written before the charge is applied.
   *
   * Its presence is the state: a record carrying it is finished and awaiting a
   * tenant charge that may already have happened, and a recovering runtime
   * finishes exactly that. A separate state field could disagree with the
   * figure it describes.
   */
  settledSpent: storedConsumed.optional(),
  /**
   * The last settled child whose spend was folded into `spent`.
   *
   * The same exactly-once marker `lastSettledRunId` is on an allowance, one
   * level lower: crediting a parent and deleting the settled child are two
   * writes, and this one makes the first of them repeatable.
   */
  absorbed: z.string().optional(),
})

/**
 * One device's standing grant of filesystem authority to one tenant.
 *
 * The roots are stored as the issuing device spells them and are never
 * compared here: this medium holds the record, and the device it names is what
 * resolves a path against it.
 */
const storedGrantRecord = z.object({
  id: z.string(),
  userId: z.string(),
  deviceId: z.string(),
  roots: z.array(z.string()),
  mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  version: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revokedAt: z.number().optional(),
})

/**
 * One thing that happened to a run, as an operator reads it back.
 *
 * The `subject` a record is filed under is the tenant when the attempt named
 * one, and the runtime when it did not: an assertion that fails to verify
 * carries no tenant this runtime may believe, and it is also the record an
 * operator most wants, so it is filed against the runtime rather than dropped.
 */
const storedAuditRecord = z.object({
  at: z.number(),
  runId: z.string().optional(),
  /**
   * The run `runId` was delegated from, absent for a root run.
   *
   * Two runs of one tenant are otherwise indistinguishable in the trail: the
   * durable run record that holds the lineage is deleted at settlement, so
   * without this the trail cannot say which run a child was spawned by, and
   * a delegating agent's tree reads as unrelated runs that happened to
   * overlap.
   */
  parentRunId: z.string().optional(),
  userId: z.string().optional(),
  accountId: z.string().optional(),
  /** Final provider chosen for a routed model call. */
  provider: z.string().optional(),
  /** Final model chosen for a routed model call. */
  model: z.string().optional(),
  /** What the record is about: a scheduling attempt, a settlement, a vault operation, or a launched process. */
  event: z.enum(['started', 'settled', 'refused', 'credential', 'launched', 'routed']),
  /** The step that ran: the one that refused, the vault action, or `settle`. */
  action: z.string(),
  /** `ok`, the reason the step refused, or how a settled run ended. */
  outcome: z.string(),
  /** Final billable usage, present on a settled run's terminal record. */
  spent: storedConsumed.optional(),
  /**
   * How many times this record happened, when the same thing happened more
   * than once in a row. Absent means once; `at` is the most recent.
   */
  count: z.number().optional(),
})

/** One subject's most recent records, oldest first. */
const storedAuditTrail = z.object({ records: z.array(storedAuditRecord) })

/** Persistent ownership remains after the session's run is settled. */
const storedManagedSession = z.object({ runtime: z.string() })

/** One tenant-scoped assertion nonce and the end of its admissible lifetime. */
const storedReplayNonce = z.object({ expiresAt: z.number() })

/** One exact provider/model route a tenant is allowed to call. */
const storedTenantRoute = z.object({
  provider: z.string(),
  model: z.string(),
})

/** One tenant's complete model-route allowlist; an empty list explicitly denies all routes. */
const storedTenantRoutePolicy = z.object({ routes: z.array(storedTenantRoute) })

/** One revocable browser session; only the digest of its bearer token is durable. */
const storedUserSession = z.object({
  id: z.string(),
  tokenDigest: z.string(),
  csrfDigest: z.string(),
  userId: z.string(),
  role: z.enum(['member', 'administrator']),
  oauthIssuer: z.string(),
  oauthSubject: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  revokedAt: z.number().optional(),
})

/** One short-lived OAuth authorization-code transaction awaiting its callback. */
const storedOAuthAttempt = z.object({
  stateDigest: z.string(),
  codeVerifier: z.string(),
  // Optional only for the short migration window: an attempt written before
  // nonce support is consumed fail-closed and never reaches a provider.
  nonce: z.string().optional(),
  issuer: z.string(),
  redirectUri: z.string(),
  expiresAt: z.number(),
})

/** Candy authorization assigned to one verified OAuth issuer/subject pair. */
const storedOAuthEnrollment = z.object({
  issuer: z.string(),
  subject: z.string(),
  userId: z.string(),
  role: z.enum(['member', 'administrator']),
  enrolledAt: z.number(),
})

/** Durable external-identity enrollment; no provider token is retained. */
export type StoredOAuthEnrollment = z.infer<typeof storedOAuthEnrollment>

/** Stored OAuth transaction used exactly once to exchange an authorization code. */
export type StoredOAuthAttempt = z.infer<typeof storedOAuthAttempt>

/** Authenticated Candy browser-session state returned after bearer verification. */
export interface UserSessionRecord {
  readonly id: UserSessionId
  readonly userId: UserId
  readonly role: ControlPlaneRole
  readonly identity: OAuthIdentity
  readonly createdAt: number
  readonly expiresAt: number
  readonly revokedAt: number | undefined
}

/** Stored form of {@link UserSessionRecord}, including its one-way bearer digest. */
export type StoredUserSession = z.infer<typeof storedUserSession>

/** The durable declaration the control-plane store opens. */
export const controlPlaneDomainSpec = defineDomain({
  name: 'candy_control_plane',
  // 1 replaced a bare per-tenant budget with a grant and its consumption.
  // Records stamped 0 are discarded on read: a bare budget cannot say how much
  // of itself was already spent, so admitting one would restore a tenant's
  // whole allowance rather than migrate it.
  //
  // 2 added run records and the settled-run marker on an allowance. A version 1
  // allowance is discarded for the same reason: it cannot say which settlement
  // it already absorbed, so a run record recovered beside it could be charged
  // twice.
  //
  // 3 added audit trails. Nothing else changed, and a stale trail is discarded
  // rather than read, which loses history a version 2 store never kept.
  //
  // 4 added a run's session and account. A version 3 run record cannot say
  // which session its model calls belong to or which account a child of it may
  // name, so it is discarded rather than recovered as either.
  //
  // 5 added a run's parent and its settlement to the audit trail. A version 4
  // trail is not read as one: nothing in it says which run a child was
  // delegated from, and every run that finished simply stops appearing, so a
  // trail admitted as this version would answer both questions wrongly rather
  // than not at all.
  //
  // 6 added workspace grants. A version 5 store holds none, and every run in
  // it names a grant that would now resolve to nothing — so it is discarded
  // rather than recovered into runs admission would immediately refuse.
  // 7 adds persistent session ownership; older records cannot distinguish
  // a settled Candy session from an unmanaged session after a restart.
  // 8 adds durable spent nonces. A version 7 store has no replay history, so
  // accepting it would reopen every assertion admitted before the restart.
  // Tenant model-route policies add a new table without changing any existing
  // record shape, so they remain on version 8. This is deliberate: SQLite
  // rejects a unit-version mismatch and can materialize the new table while
  // preserving every account, grant, run, audit and nonce already stored.
  // An older store has no route records, which is the correct fail-closed state.
  // 9 adds final spend to terminal audit records. Reading a version 8 trail as
  // this version would silently answer a run-cost query with no figure.
  // 10 records the final provider/model route selected for managed calls.
  version: 10,
  layout: 'per-record',
  tables: {
    accounts: domainTable<ProviderAccountId, z.infer<typeof storedEntry>>(storedEntry),
    allowances: domainTable<UserId, z.infer<typeof storedAllowance>>(storedAllowance),
    runs: domainTable<RunId, z.infer<typeof storedRun>>(storedRun),
    audits: domainTable<AuditSubject, z.infer<typeof storedAuditTrail>>(storedAuditTrail),
    grants: domainTable<WorkspaceGrantId, z.infer<typeof storedGrantRecord>>(storedGrantRecord),
    managed_sessions: domainTable<SessionId, z.infer<typeof storedManagedSession>>(storedManagedSession),
    spent_nonces: domainTable<string, z.infer<typeof storedReplayNonce>>(storedReplayNonce),
    tenant_routes: domainTable<UserId, z.infer<typeof storedTenantRoutePolicy>>(storedTenantRoutePolicy),
    user_sessions: domainTable<UserSessionId, StoredUserSession>(storedUserSession),
    oauth_attempts: domainTable<string, StoredOAuthAttempt>(storedOAuthAttempt),
    oauth_enrollments: domainTable<string, StoredOAuthEnrollment>(storedOAuthEnrollment),
  },
})

/**
 * Project a stored user session without exposing its bearer digest.
 * @param stored - validated durable session record.
 * @returns authenticated session state safe for management consumers.
 */
export function fromStoredUserSession(stored: StoredUserSession): UserSessionRecord {
  return {
    id: UserSessionId(stored.id),
    userId: UserId(stored.userId),
    role: stored.role,
    identity: { issuer: stored.oauthIssuer, subject: stored.oauthSubject },
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    revokedAt: stored.revokedAt,
  }
}

/** Drop a property whose value is absent, so an optional key round-trips as absent. */
function present<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value }
}

/**
 * Project one account entry onto the medium.
 * @param entry - the runtime account and its sealed credential.
 * @returns the stored form, with never-happened timestamps omitted.
 */
export function toStoredEntry(entry: ProviderAccountEntry): z.infer<typeof storedEntry> {
  const { record, credential } = entry
  return {
    record: {
      id: record.id,
      userId: record.userId,
      provider: record.provider,
      label: record.label,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      isDefault: record.isDefault,
      ...present('validatedAt', record.validatedAt),
      ...present('revokedAt', record.revokedAt),
      ...present('deletedAt', record.deletedAt),
    },
    credential: {
      envelopeVersion: credential.envelopeVersion,
      userId: credential.userId,
      accountId: credential.accountId,
      keyVersion: credential.keyVersion,
      iv: credential.iv,
      ciphertext: credential.ciphertext,
      authTag: credential.authTag,
      sealedAt: credential.sealedAt,
      ...present('rewrappedAt', credential.rewrappedAt),
      ...present('revokedAt', credential.revokedAt),
    },
  }
}

/**
 * Rebuild one account's record from the medium.
 * @param stored - the validated stored record.
 * @returns the runtime account record, with its ids branded.
 */
export function fromStoredRecord(stored: z.infer<typeof storedEntry>['record']): ProviderAccountRecord {
  return {
    id: ProviderAccountId(stored.id),
    userId: UserId(stored.userId),
    provider: stored.provider,
    label: stored.label,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    validatedAt: stored.validatedAt,
    revokedAt: stored.revokedAt,
    deletedAt: stored.deletedAt,
    isDefault: stored.isDefault,
  }
}

/**
 * Rebuild one account entry from the medium.
 * @param stored - the validated stored form.
 * @returns the runtime account and its sealed credential.
 */
export function fromStoredEntry(stored: z.infer<typeof storedEntry>): ProviderAccountEntry {
  const record = fromStoredRecord(stored.record)
  const credential: CredentialEnvelope = {
    envelopeVersion: stored.credential.envelopeVersion,
    userId: UserId(stored.credential.userId),
    accountId: ProviderAccountId(stored.credential.accountId),
    keyVersion: CredentialKeyVersion(stored.credential.keyVersion),
    iv: stored.credential.iv,
    ciphertext: stored.credential.ciphertext,
    authTag: stored.credential.authTag,
    sealedAt: stored.credential.sealedAt,
    rewrappedAt: stored.credential.rewrappedAt,
    revokedAt: stored.credential.revokedAt,
  }
  return { record, credential }
}

/** The stored allowance form, for a caller writing one. */
export type StoredTenantAllowance = z.infer<typeof storedAllowance>

/** One exact provider/model route in a tenant's durable allowlist. */
export type TenantModelRoute = z.infer<typeof storedTenantRoute>

/** The stored form of one tenant's complete model-route policy. */
export type StoredTenantRoutePolicy = z.infer<typeof storedTenantRoutePolicy>

/** Rebuild one grant from the medium. */
function fromStoredGrant(stored: StoredTenantAllowance['grant']): RunBudget {
  return {
    tokens: stored.tokens,
    wallMs: stored.wallMs,
    costMicroUsd: stored.costMicroUsd,
    children: stored.children,
  }
}

/**
 * Project one tenant allowance onto the medium.
 * @param allowance - the grant and what has been consumed of it.
 * @returns the stored form.
 */
export function toStoredAllowance(allowance: TenantAllowance): StoredTenantAllowance {
  return {
    grant: {
      tokens: allowance.grant.tokens,
      wallMs: allowance.grant.wallMs,
      costMicroUsd: allowance.grant.costMicroUsd,
      children: allowance.grant.children,
    },
    consumed: {
      tokens: allowance.consumed.tokens,
      wallMs: allowance.consumed.wallMs,
      costMicroUsd: allowance.consumed.costMicroUsd,
    },
  }
}

/**
 * Rebuild one tenant allowance from the medium.
 * @param stored - the validated stored allowance.
 * @returns the allowance in the runtime's shape.
 */
export function fromStoredAllowance(stored: StoredTenantAllowance): TenantAllowance {
  return {
    grant: fromStoredGrant(stored.grant),
    consumed: {
      tokens: stored.consumed.tokens,
      wallMs: stored.consumed.wallMs,
      costMicroUsd: stored.consumed.costMicroUsd,
    },
  }
}


/** The stored run form, for a caller writing one. */
export type StoredRun = z.infer<typeof storedRun>

/**
 * One run as the medium holds it: the ledger's record, who it is charged to,
 * which runtime opened it, and whether its settlement is part-way through.
 */
export interface DurableRunRecord {
  /** The accounting `dsh-run-ledger` owns; restored into a ledger verbatim. */
  readonly record: RunRecord
  /** The tenant whose allowance this run's tree is charged to. */
  readonly userId: TenantId
  /**
   * The harness session this run drives.
   *
   * A model request carries the session it was assembled for, so this is what
   * lets a stream find the run it should be charged to without the request
   * carrying a Candy concept of its own.
   */
  readonly sessionId: SessionId
  /**
   * The provider account this run was admitted for.
   *
   * A child run inherits a subset of its parent's grants and may not widen
   * them, so this is what a child's own claimed account is checked against.
   */
  readonly accountId: ProviderAccountId
  /**
   * Paired device the run was requested from.
   *
   * A minted child assertion copies its parent's, since a delegated child acts
   * from the same device its parent does.
   */
  readonly deviceId: DeviceId
  /**
   * Workspace grant bounding the run's filesystem authority.
   *
   * A minted child assertion copies its parent's, since a delegated child's
   * grant may not widen what its parent was given.
   */
  readonly workspaceGrantId: WorkspaceGrantId
  /**
   * Tenant-visible conversation the run belongs to.
   *
   * A minted child assertion copies its parent's, since a delegated child
   * belongs to the same conversation its parent does.
   */
  readonly conversationId: ConversationId
  /**
   * The runtime that opened this run, as its own audience identifier.
   *
   * Recovery reads only its own runtime's records. Two runtimes sharing one
   * medium would otherwise settle each other's live runs at boot, and an
   * assertion is audience-bound already, so two runtimes never share the value.
   */
  readonly runtime: string
  /** What settling this run charges, once that charge has been written down. */
  readonly settledSpent: RunSpend | undefined
  /** The last settled child already folded into `record.spent`. */
  readonly absorbed: RunId | undefined
}

/**
 * Project one run onto the medium.
 * @param run - the durable record.
 * @returns the stored form, with absent optional fields omitted.
 */
export function toStoredRun(run: DurableRunRecord): StoredRun {
  return {
    runId: run.record.runId,
    userId: run.userId,
    sessionId: run.sessionId,
    accountId: run.accountId,
    deviceId: run.deviceId,
    workspaceGrantId: run.workspaceGrantId,
    conversationId: run.conversationId,
    runtime: run.runtime,
    reserved: {
      tokens: run.record.reserved.tokens,
      wallMs: run.record.reserved.wallMs,
      costMicroUsd: run.record.reserved.costMicroUsd,
      children: run.record.reserved.children,
    },
    spent: {
      tokens: run.record.spent.tokens,
      wallMs: run.record.spent.wallMs,
      costMicroUsd: run.record.spent.costMicroUsd,
    },
    leaseExpiresAt: run.record.leaseExpiresAt,
    ...present('parentRunId', run.record.parentRunId),
    ...present('absorbed', run.absorbed),
    ...present('settledSpent', run.settledSpent === undefined ? undefined : {
      tokens: run.settledSpent.tokens,
      wallMs: run.settledSpent.wallMs,
      costMicroUsd: run.settledSpent.costMicroUsd,
    }),
  }
}

/**
 * Rebuild one run from the medium.
 * @param stored - the validated stored run.
 * @returns the durable record, whose `record` restores into a `RunLedger`.
 */
export function fromStoredRun(stored: StoredRun): DurableRunRecord {
  return {
    record: {
      runId: RunId(stored.runId),
      parentRunId: stored.parentRunId === undefined ? undefined : RunId(stored.parentRunId),
      reserved: fromStoredGrant(stored.reserved),
      spent: {
        tokens: stored.spent.tokens,
        wallMs: stored.spent.wallMs,
        costMicroUsd: stored.spent.costMicroUsd,
      },
      leaseExpiresAt: stored.leaseExpiresAt,
    },
    userId: UserId(stored.userId),
    sessionId: brandString<SessionId>(stored.sessionId),
    accountId: ProviderAccountId(stored.accountId),
    deviceId: DeviceId(stored.deviceId),
    workspaceGrantId: WorkspaceGrantId(stored.workspaceGrantId),
    conversationId: ConversationId(stored.conversationId),
    runtime: stored.runtime,
    absorbed: stored.absorbed === undefined ? undefined : RunId(stored.absorbed),
    settledSpent: stored.settledSpent === undefined ? undefined : {
      tokens: stored.settledSpent.tokens,
      wallMs: stored.settledSpent.wallMs,
      costMicroUsd: stored.settledSpent.costMicroUsd,
    },
  }
}


/**
 * Whom a trail of audit records belongs to.
 *
 * `t_` prefixes a tenant and `r_` a runtime, so the two spaces cannot collide
 * on one key. The record itself carries the real identity; this is only how the
 * medium partitions them.
 */
export type AuditSubject = Branded<'AuditSubject'>

/**
 * The subject a tenant's records are filed under.
 * @param userId - the tenant a verified assertion named.
 * @returns that tenant's subject key.
 */
export function tenantSubject(userId: TenantId): AuditSubject {
  return brandString<AuditSubject>(`t_${userId}`)
}

/**
 * The subject records with no tenant are filed under.
 *
 * An assertion that fails to verify names no tenant this runtime may believe,
 * so the runtime that refused it owns the record.
 * @param runtime - the runtime's own audience identifier.
 * @returns that runtime's subject key.
 */
export function runtimeSubject(runtime: string): AuditSubject {
  return brandString<AuditSubject>(`r_${runtime}`)
}

/** One recorded thing that happened to a run. */
export type RunAuditRecord = z.infer<typeof storedAuditRecord>

/** One subject's trail, oldest first. */
export type StoredAuditTrail = z.infer<typeof storedAuditTrail>


/** The stored grant form, for a caller writing one. */
export type StoredWorkspaceGrant = z.infer<typeof storedGrantRecord>

/**
 * Project one workspace grant onto the medium.
 * @param record - the runtime grant.
 * @returns the stored form, with an absent revocation omitted.
 */
export function toStoredGrant(record: WorkspaceGrantRecord): StoredWorkspaceGrant {
  return {
    id: record.id,
    userId: record.userId,
    deviceId: record.deviceId,
    roots: [...record.roots],
    mode: record.mode,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...present('revokedAt', record.revokedAt),
  }
}

/**
 * Rebuild one workspace grant from the medium.
 * @param stored - the validated stored grant.
 * @returns the runtime grant, with its ids branded.
 */
export function fromStoredGrantRecord(stored: StoredWorkspaceGrant): WorkspaceGrantRecord {
  return {
    id: WorkspaceGrantId(stored.id),
    userId: UserId(stored.userId),
    deviceId: DeviceId(stored.deviceId),
    roots: stored.roots,
    mode: stored.mode,
    version: stored.version,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    revokedAt: stored.revokedAt,
  }
}
