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
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import type { ProviderKind } from '@deepseek-ai/dsh-control-plane'
import { CredentialKeyVersion, type CredentialEnvelope } from '@deepseek-ai/dsh-credential-vault'
import type { ProviderAccountEntry, ProviderAccountRecord } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
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

/** One tenant's allowance, in the four dimensions `dsh-run-budget` bounds. */
const storedBudget = z.object({
  tokens: z.number(),
  wallMs: z.number(),
  costMicroUsd: z.number(),
  children: z.number(),
})

/** The durable declaration the control-plane store opens. */
export const controlPlaneDomainSpec = defineDomain({
  name: 'candy_control_plane',
  version: 0,
  layout: 'per-record',
  tables: {
    accounts: domainTable<ProviderAccountId, z.infer<typeof storedEntry>>(storedEntry),
    budgets: domainTable<UserId, z.infer<typeof storedBudget>>(storedBudget),
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
    provider: stored.record.provider as ProviderKind,
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
export type StoredRunBudget = z.infer<typeof storedBudget>

/**
 * Rebuild one tenant allowance from the medium.
 * @param stored - the validated stored allowance.
 * @returns the allowance in the runtime's shape.
 */
export function fromStoredBudget(stored: StoredRunBudget): RunBudget {
  return {
    tokens: stored.tokens,
    wallMs: stored.wallMs,
    costMicroUsd: stored.costMicroUsd,
    children: stored.children,
  }
}
