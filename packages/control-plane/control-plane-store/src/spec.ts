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
import { ProviderAccountId, RunId, UserId } from '@deepseek-ai/dsh-control-plane'
import type { UserId as TenantId } from '@deepseek-ai/dsh-control-plane'
import { CredentialKeyVersion, type CredentialEnvelope } from '@deepseek-ai/dsh-credential-vault'
import type { ProviderAccountEntry, ProviderAccountRecord } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import type { RunRecord } from '@deepseek-ai/dsh-run-ledger'
import type { TenantAllowance } from '@deepseek-ai/dsh-tenant-allowance'
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
  userId: z.string().optional(),
  accountId: z.string().optional(),
  /** What the record is about: a scheduling attempt, or one vault operation. */
  event: z.enum(['started', 'refused', 'credential']),
  /** The step that refused, or the vault action that ran. */
  action: z.string(),
  /** `ok`, or the reason the step refused. */
  outcome: z.string(),
})

/** One subject's most recent records, oldest first. */
const storedAuditTrail = z.object({ records: z.array(storedAuditRecord) })

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
  version: 4,
  layout: 'per-record',
  tables: {
    accounts: domainTable<ProviderAccountId, z.infer<typeof storedEntry>>(storedEntry),
    allowances: domainTable<UserId, z.infer<typeof storedAllowance>>(storedAllowance),
    runs: domainTable<RunId, z.infer<typeof storedRun>>(storedRun),
    audits: domainTable<AuditSubject, z.infer<typeof storedAuditTrail>>(storedAuditTrail),
  },
})

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
 * Rebuild one account entry from the medium.
 * @param stored - the validated stored form.
 * @returns the runtime account and its sealed credential.
 */
export function fromStoredEntry(stored: z.infer<typeof storedEntry>): ProviderAccountEntry {
  const record: ProviderAccountRecord = {
    id: ProviderAccountId(stored.record.id),
    userId: UserId(stored.record.userId),
    provider: stored.record.provider,
    label: stored.record.label,
    createdAt: stored.record.createdAt,
    updatedAt: stored.record.updatedAt,
    validatedAt: stored.record.validatedAt,
    revokedAt: stored.record.revokedAt,
    deletedAt: stored.record.deletedAt,
    isDefault: stored.record.isDefault,
  }
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
