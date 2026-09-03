/**
 * Tenant-owned provider-account management for Candy.
 *
 * Secrets enter only as write-only input, are sealed by
 * `dsh-credential-vault`, and never appear in views or diagnostics.
 *
 * @module @deepseek-ai/dsh-provider-accounts
 */

import {
  type ProviderAccountId,
  type ProviderKind,
  type UserId,
} from '@deepseek-ai/dsh-control-plane'
import {
  openCredential,
  revokeCredential,
  sealCredential,
  type CredentialAuditEvent,
  type CredentialEnvelope,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'

/** Stored metadata for one provider account, excluding the encrypted secret. */
export interface ProviderAccountRecord {
  readonly id: ProviderAccountId
  readonly userId: UserId
  readonly provider: ProviderKind
  readonly label: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly validatedAt: number | undefined
  readonly revokedAt: number | undefined
  readonly deletedAt: number | undefined
  readonly isDefault: boolean
}

/** Stored provider account plus its sealed credential. */
export interface ProviderAccountEntry {
  readonly record: ProviderAccountRecord
  readonly credential: CredentialEnvelope
}

/** Secret-free account view returned to clients. */
export interface ProviderAccountView {
  readonly id: ProviderAccountId
  readonly provider: ProviderKind
  readonly label: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly validatedAt: number | undefined
  readonly revokedAt: number | undefined
  readonly isDefault: boolean
}

/** Storage port supplied by the deployment. */
export interface ProviderAccountStore {
  readonly listByUser: (userId: UserId) => Promise<readonly ProviderAccountEntry[]>
  readonly find: (id: ProviderAccountId) => Promise<ProviderAccountEntry | undefined>
  readonly save: (entry: ProviderAccountEntry) => Promise<void>
}

/** Account validation port supplied by a provider-specific integration. */
export type ProviderAccountValidator = (
  provider: ProviderKind,
  secret: Uint8Array,
) => Promise<ProviderAccountValidation>

/** Safe validation result: no token, endpoint, raw provider body, or credential path. */
export type ProviderAccountValidation =
  | { readonly valid: true; readonly diagnostic?: string }
  | { readonly valid: false; readonly reason: 'invalid-credential' | 'provider-unavailable' | 'unsupported-provider'; readonly diagnostic?: string }

/** Result with audit records produced by vault operations. */
export interface ProviderAccountMutation<T> {
  readonly value: T
  readonly audits: readonly CredentialAuditEvent[]
}

/** Error code safe to return from an authenticated API. */
export class ProviderAccountError extends Error {
  constructor(readonly code: 'account-already-exists' | 'not-found' | 'revoked' | 'deleted' | 'invalid-label') {
    super(`provider account ${code}`)
  }
}

/**
 * Create one account and seal its credential.
 *
 * The account becomes this provider's default when the caller asks for it, and
 * also when the tenant has no other active account for that provider, so a
 * tenant's first account is never left unselectable.
 * @param store - the deployment's account store.
 * @param keyring - keys the credential vault seals with.
 * @param input - the account's identity, provider, display label, plaintext
 *   secret, and whether it should become the provider's default.
 * @param now - epoch milliseconds stamped on the record and its audit entry.
 * @returns the secret-free view and the vault's sealing audit record.
 * @throws ProviderAccountError `account-already-exists` when any account —
 * including a deleted one — already holds this id, so a deleted account's id
 * can never be reused for a different one, or `invalid-label` when the label
 * is empty once trimmed or longer than 120 characters.
 */
export async function createProviderAccount(
  store: ProviderAccountStore,
  keyring: CredentialKeyring,
  input: {
    readonly id: ProviderAccountId
    readonly userId: UserId
    readonly provider: ProviderKind
    readonly label: string
    readonly secret: Uint8Array
    readonly makeDefault?: boolean
  },
  now: number,
): Promise<ProviderAccountMutation<ProviderAccountView>> {
  // A deleted row keeps its id blocked rather than releasing it: reusing the
  // id would let a fresh account silently overwrite the very record deletion
  // promises to retain, misattributing that account's history to a stranger.
  if (await store.find(input.id) !== undefined) {
    throw new ProviderAccountError('account-already-exists')
  }
  const label = cleanLabel(input.label)
  const shouldDefault = input.makeDefault === true || !hasActiveAccount(await store.listByUser(input.userId), input.provider)
  if (shouldDefault) await clearDefaultForProvider(store, input.userId, input.provider, now)
  const sealed = sealCredential(input.secret, { userId: input.userId, accountId: input.id }, keyring, now)
  const record: ProviderAccountRecord = {
    id: input.id,
    userId: input.userId,
    provider: input.provider,
    label,
    createdAt: now,
    updatedAt: now,
    validatedAt: undefined,
    revokedAt: undefined,
    deletedAt: undefined,
    isDefault: shouldDefault,
  }
  await store.save({ record, credential: sealed.envelope })
  return { value: view(record), audits: [sealed.audit] }
}

/**
 * List the caller's non-deleted accounts, optionally narrowed to one provider.
 *
 * Revoked accounts remain listed so a caller can see why a provider stopped
 * working; only deleted ones are hidden.
 * @param store - the deployment's account store.
 * @param userId - the tenant whose accounts are listed; no other tenant's are reachable.
 * @param provider - narrows the result to one provider kind when given.
 * @returns secret-free views, in store order.
 */
export async function listProviderAccounts(
  store: ProviderAccountStore,
  userId: UserId,
  provider?: ProviderKind,
): Promise<readonly ProviderAccountView[]> {
  return (await store.listByUser(userId))
    .filter(entry => entry.record.deletedAt === undefined)
    .filter(entry => provider === undefined || entry.record.provider === provider)
    .map(entry => view(entry.record))
}

/**
 * Mark one account as the caller's default for its provider.
 *
 * The previous default for that provider is cleared first, so a tenant holds
 * at most one default per provider.
 * @param store - the deployment's account store.
 * @param userId - the tenant that must own the account.
 * @param id - the account to make default.
 * @param now - epoch milliseconds stamped on the updated records.
 * @returns the secret-free view of the newly default account.
 * @throws ProviderAccountError `not-found` when the account is absent or owned
 * by another tenant, or `revoked`/`deleted` when it is no longer usable.
 */
export async function selectDefaultProviderAccount(
  store: ProviderAccountStore,
  userId: UserId,
  id: ProviderAccountId,
  now: number,
): Promise<ProviderAccountView> {
  const entry = await ownedActiveEntry(store, userId, id)
  await clearDefaultForProvider(store, userId, entry.record.provider, now)
  const selected = updateRecord(entry.record, now, { isDefault: true })
  await store.save({ ...entry, record: selected })
  return view(selected)
}

/**
 * Revoke one account and its sealed credential.
 *
 * The record stays listed and the credential's ciphertext is destroyed, so the
 * account is visible but can never be opened again. A revoked default is
 * replaced by another active account for the same provider when one exists.
 * @param store - the deployment's account store.
 * @param userId - the tenant that must own the account.
 * @param id - the account to revoke.
 * @param now - epoch milliseconds stamped on the record and its audit entry.
 * @returns the secret-free view and the vault's revocation audit record.
 * @throws ProviderAccountError `not-found` when the account is absent or owned
 * by another tenant, or `revoked`/`deleted` when it is no longer usable.
 */
export async function revokeProviderAccount(
  store: ProviderAccountStore,
  userId: UserId,
  id: ProviderAccountId,
  now: number,
): Promise<ProviderAccountMutation<ProviderAccountView>> {
  const entry = await ownedActiveEntry(store, userId, id)
  const revoked = revokeCredential(entry.credential, now)
  const record = updateRecord(entry.record, now, { revokedAt: entry.record.revokedAt ?? now, isDefault: false })
  await store.save({ record, credential: revoked.envelope })
  await promoteReplacementDefault(store, userId, record.provider, now)
  return { value: view(record), audits: [revoked.audit] }
}

/**
 * Soft-delete one account after revoking the credential envelope.
 *
 * The record is retained so audit history keeps a subject, but it stops being
 * listed and its credential is destroyed first — a delete never leaves an
 * openable envelope behind. {@link createProviderAccount} refuses to reuse a
 * deleted account's id, so the retained record can never be overwritten by an
 * unrelated one. A deleted default is replaced as in {@link revokeProviderAccount}.
 * @param store - the deployment's account store.
 * @param userId - the tenant that must own the account.
 * @param id - the account to delete.
 * @param now - epoch milliseconds stamped on the record and its audit entry.
 * @returns the secret-free view and the vault's revocation audit record.
 * @throws ProviderAccountError `not-found` when the account is absent or owned
 * by another tenant, or `revoked`/`deleted` when it is no longer usable.
 */
export async function deleteProviderAccount(
  store: ProviderAccountStore,
  userId: UserId,
  id: ProviderAccountId,
  now: number,
): Promise<ProviderAccountMutation<ProviderAccountView>> {
  const entry = await ownedActiveEntry(store, userId, id)
  const revoked = revokeCredential(entry.credential, now)
  const record = updateRecord(entry.record, now, {
    revokedAt: entry.record.revokedAt ?? now,
    deletedAt: now,
    isDefault: false,
  })
  await store.save({ record, credential: revoked.envelope })
  await promoteReplacementDefault(store, userId, record.provider, now)
  return { value: view(record), audits: [revoked.audit] }
}

/**
 * Validate one account without returning or storing the plaintext credential.
 *
 * The secret is opened, handed to the caller's probe, and never leaves this
 * call: the result is scrubbed to a bounded diagnostic before it is returned,
 * so a provider that echoes the request cannot leak it onward. A credential
 * the vault refuses to open reports `invalid-credential` rather than throwing,
 * because an unopenable credential is a validation outcome, not a caller error.
 * @param store - the deployment's account store.
 * @param keyring - keys the credential vault opens with.
 * @param userId - the tenant that must own the account.
 * @param id - the account to validate.
 * @param validator - the provider-specific probe, given the provider kind and
 *   the plaintext secret for the duration of the call.
 * @param now - epoch milliseconds recorded as `validatedAt` on success.
 * @returns the secret-free view, the scrubbed validation, and the vault's
 *   opening audit record.
 * @throws ProviderAccountError `not-found` when the account is absent or owned
 * by another tenant, or `revoked`/`deleted` when it is no longer usable.
 */
export async function validateProviderAccount(
  store: ProviderAccountStore,
  keyring: CredentialKeyring,
  userId: UserId,
  id: ProviderAccountId,
  validator: ProviderAccountValidator,
  now: number,
): Promise<ProviderAccountMutation<{ readonly account: ProviderAccountView; readonly validation: ProviderAccountValidation }>> {
  const entry = await ownedActiveEntry(store, userId, id)
  const opened = openCredential(entry.credential, { userId, accountId: id }, keyring, now)
  if (!opened.opened) {
    return {
      value: { account: view(entry.record), validation: { valid: false, reason: 'invalid-credential' } },
      audits: [opened.audit],
    }
  }
  const validation = scrubValidation(await validator(entry.record.provider, opened.secret))
  const record = validation.valid
    ? updateRecord(entry.record, now, { validatedAt: now })
    : entry.record
  if (record !== entry.record) await store.save({ ...entry, record })
  return { value: { account: view(record), validation }, audits: [opened.audit] }
}

function view(record: ProviderAccountRecord): ProviderAccountView {
  return {
    id: record.id,
    provider: record.provider,
    label: record.label,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    validatedAt: record.validatedAt,
    revokedAt: record.revokedAt,
    isDefault: record.isDefault,
  }
}

function cleanLabel(label: string): string {
  const cleaned = label.trim()
  if (cleaned.length === 0 || cleaned.length > 120) throw new ProviderAccountError('invalid-label')
  return cleaned
}

function hasActiveAccount(entries: readonly ProviderAccountEntry[], provider: ProviderKind): boolean {
  return entries.some(entry =>
    entry.record.provider === provider
    && entry.record.deletedAt === undefined
    && entry.record.revokedAt === undefined)
}

async function ownedActiveEntry(
  store: ProviderAccountStore,
  userId: UserId,
  id: ProviderAccountId,
): Promise<ProviderAccountEntry> {
  const entry = await store.find(id)
  if (entry === undefined || entry.record.userId !== userId) throw new ProviderAccountError('not-found')
  if (entry.record.deletedAt !== undefined) throw new ProviderAccountError('deleted')
  if (entry.record.revokedAt !== undefined) throw new ProviderAccountError('revoked')
  return entry
}

async function clearDefaultForProvider(
  store: ProviderAccountStore,
  userId: UserId,
  provider: ProviderKind,
  now: number,
): Promise<void> {
  await Promise.all((await store.listByUser(userId))
    .filter(entry => entry.record.provider === provider)
    .filter(entry => entry.record.deletedAt === undefined)
    .filter(entry => entry.record.isDefault)
    .map(entry => store.save({ ...entry, record: updateRecord(entry.record, now, { isDefault: false }) })))
}

async function promoteReplacementDefault(
  store: ProviderAccountStore,
  userId: UserId,
  provider: ProviderKind,
  now: number,
): Promise<void> {
  const replacement = (await store.listByUser(userId))
    .find(entry =>
      entry.record.provider === provider
      && entry.record.deletedAt === undefined
      && entry.record.revokedAt === undefined
      && !entry.record.isDefault)
  if (replacement !== undefined) {
    await store.save({ ...replacement, record: updateRecord(replacement.record, now, { isDefault: true }) })
  }
}

function updateRecord(
  record: ProviderAccountRecord,
  now: number,
  patch: Partial<ProviderAccountRecord>,
): ProviderAccountRecord {
  return { ...record, ...patch, updatedAt: now }
}

function scrubValidation(validation: ProviderAccountValidation): ProviderAccountValidation {
  if (validation.diagnostic === undefined) return validation
  return { ...validation, diagnostic: validation.diagnostic.slice(0, 240) }
}
