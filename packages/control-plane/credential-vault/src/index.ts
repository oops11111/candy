/**
 * Tenant-bound credential envelopes: how Candy holds a provider account's
 * secret at rest, rotates the key that protects it, revokes it, and reads it
 * back without ever handing a secret to the wrong tenant.
 *
 * A sealed secret is AES-256-GCM ciphertext, and two independent mechanisms
 * keep it with its tenant
 * ([Candy Runtime Boundaries](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/candy-runtime-boundaries.md)).
 * {@link openCredential} compares the envelope's recorded identity against the
 * {@link CredentialBinding} the caller names, which denies an envelope sitting
 * in the wrong record with its fields intact. The binding also enters the
 * additional authenticated data, which denies an envelope that was moved *and*
 * had its stored fields rewritten to match its new record — a rewrite the
 * comparison cannot see, because by then every stored field agrees with the
 * attacker's own binding.
 *
 * The additional authenticated data is derived from the caller's binding
 * rather than the envelope's fields. Those are equal on every path that
 * reaches decryption, so the choice changes no observable behavior today; it
 * is what keeps the read failing closed if the comparison above is ever
 * reordered or dropped. See the package README before simplifying it away.
 *
 * Every operation returns a {@link CredentialAuditEvent} beside its result, so
 * a caller cannot obtain a secret without also obtaining the record of having
 * done so.
 *
 * @module @deepseek-ai/dsh-credential-vault
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'

/** Envelope layout this build writes; a layout change mints 2 rather than reinterpreting 1. */
const ENVELOPE_VERSION = 1

/** AES-256 key length. A shorter key is a deployment error, not a weaker mode. */
const KEY_BYTES = 32

/** GCM's standard nonce length; a fresh one is drawn for every seal. */
const IV_BYTES = 12

/** Identifies one key-encryption key inside a {@link CredentialKeyring}. */
export type CredentialKeyVersion = Branded<'CredentialKeyVersion'>

/**
 * Brand a string as a {@link CredentialKeyVersion}.
 * @param version - the deployment's own name for one keyring entry.
 * @returns the same string, branded; no validation is performed.
 */
export function CredentialKeyVersion(version: string): CredentialKeyVersion {
  return brandString<CredentialKeyVersion>(version)
}

/**
 * Whose secret this is. The caller states it; the envelope never gets to.
 *
 * Both fields enter the additional authenticated data, so they decide whether
 * the ciphertext opens at all.
 */
export interface CredentialBinding {
  /** Tenant the credential belongs to. */
  readonly userId: UserId
  /** Provider account the credential authenticates. */
  readonly accountId: ProviderAccountId
}

/**
 * The keys a deployment can currently use.
 *
 * `currentVersion` seals every new and rewrapped envelope. `keys` retains
 * every version still needed to open envelopes that have not been rewrapped;
 * dropping a version from it retires that key and makes those envelopes
 * permanently unopenable, which is the intended effect of retiring a key.
 */
export interface CredentialKeyring {
  /** Version new seals and rewraps use. */
  readonly currentVersion: CredentialKeyVersion
  /** Every retained version, including the current one; each key is 32 bytes. */
  readonly keys: ReadonlyMap<CredentialKeyVersion, Uint8Array>
}

/**
 * One sealed credential at rest.
 *
 * Durable and safe to store as JSON. It carries no plaintext, but it is not
 * safe to log or return over the wire: use {@link redactCredential} for that.
 * A revoked envelope carries empty `iv`, `ciphertext`, and `authTag` because
 * revocation destroys them.
 */
export interface CredentialEnvelope {
  /** Layout discriminant. */
  readonly envelopeVersion: number
  /** Tenant recorded at seal time; checked against the caller's binding. */
  readonly userId: UserId
  /** Provider account recorded at seal time. */
  readonly accountId: ProviderAccountId
  /** Keyring version whose key sealed this envelope. */
  readonly keyVersion: CredentialKeyVersion
  /** base64url GCM nonce, empty once revoked. */
  readonly iv: string
  /** base64url ciphertext, empty once revoked. */
  readonly ciphertext: string
  /** base64url GCM authentication tag, empty once revoked. */
  readonly authTag: string
  /** Epoch milliseconds this secret was first sealed. */
  readonly sealedAt: number
  /** Epoch milliseconds of the most recent rewrap, or `undefined` if never rewrapped. */
  readonly rewrappedAt: number | undefined
  /** Epoch milliseconds the secret was destroyed, or `undefined` while it is live. */
  readonly revokedAt: number | undefined
}

/**
 * The metadata view of an envelope: everything except the sealed secret.
 *
 * This is the only shape in this package that is safe to log, return over the
 * wire, or show an operator.
 */
export interface CredentialRedaction {
  /** Tenant the credential belongs to. */
  readonly userId: UserId
  /** Provider account the credential authenticates. */
  readonly accountId: ProviderAccountId
  /** Keyring version currently protecting it. */
  readonly keyVersion: CredentialKeyVersion
  /** Layout discriminant. */
  readonly envelopeVersion: number
  /** Whether the secret is still readable. */
  readonly state: 'active' | 'revoked'
  /** Epoch milliseconds this secret was first sealed. */
  readonly sealedAt: number
  /** Epoch milliseconds of the most recent rewrap, or `undefined`. */
  readonly rewrappedAt: number | undefined
  /** Epoch milliseconds the secret was destroyed, or `undefined`. */
  readonly revokedAt: number | undefined
}

/** Why a sealed secret was not returned. Every value denies the read. */
export type CredentialRejection =
  /** The secret was destroyed by {@link revokeCredential} and cannot be recovered. */
  | 'revoked'
  /** The keyring no longer retains the version that sealed this envelope. */
  | 'unknown-key'
  /** The envelope records a different tenant or account than the caller named. */
  | 'binding-mismatch'
  /** A layout this build does not implement. */
  | 'unsupported-version'
  /** Authentication failed: the envelope was tampered with, moved, or truncated. */
  | 'corrupt'

/** What one vault operation did, recorded whether or not it succeeded. */
export interface CredentialAuditEvent {
  /** The operation attempted. */
  readonly action: 'seal' | 'open' | 'rewrap' | 'revoke'
  /** Tenant named by the caller, or recorded in the envelope for a revoke. */
  readonly userId: UserId
  /** Provider account named by the caller, or recorded in the envelope for a revoke. */
  readonly accountId: ProviderAccountId
  /** Keyring version the operation used or attempted to use. */
  readonly keyVersion: CredentialKeyVersion
  /** Epoch milliseconds supplied by the caller's clock. */
  readonly at: number
  /** `ok`, or the rejection that denied the operation. */
  readonly outcome: 'ok' | CredentialRejection
}

/** A newly sealed envelope and the record of sealing it. */
export interface CredentialSealResult {
  /** The sealed envelope, ready to store. */
  readonly envelope: CredentialEnvelope
  /** The record of this seal. */
  readonly audit: CredentialAuditEvent
}

/** The outcome of opening one envelope. */
export type CredentialOpenResult =
  | { readonly opened: true; readonly secret: Uint8Array; readonly audit: CredentialAuditEvent }
  | { readonly opened: false; readonly rejection: CredentialRejection; readonly audit: CredentialAuditEvent }

/** The outcome of rewrapping one envelope under the keyring's current version. */
export type CredentialRewrapResult =
  | { readonly rewrapped: true; readonly envelope: CredentialEnvelope; readonly audit: CredentialAuditEvent }
  | { readonly rewrapped: false; readonly rejection: CredentialRejection; readonly audit: CredentialAuditEvent }

/** A revoked envelope and the record of destroying its secret. */
export interface CredentialRevokeResult {
  /** The envelope with its secret destroyed. */
  readonly envelope: CredentialEnvelope
  /** The record of this revocation. */
  readonly audit: CredentialAuditEvent
}

/**
 * Build the additional authenticated data for one seal or open.
 *
 * Fields are length-prefixed so no value can forge a field boundary by
 * containing the separator: control-plane ids are opaque strings this package
 * does not constrain.
 *
 * @param binding - the caller's claim about whose secret this is.
 * @param keyVersion - keyring version protecting the envelope.
 * @returns the bytes GCM authenticates alongside the ciphertext.
 */
function additionalData(binding: CredentialBinding, keyVersion: CredentialKeyVersion): Buffer {
  const parts = [String(ENVELOPE_VERSION), binding.userId, binding.accountId, keyVersion]
  return Buffer.from(parts.map(part => `${String(part.length)}:${part}`).join(''), 'utf8')
}

/**
 * Look up and admit one keyring entry.
 * @param keyring - the deployment's retained keys.
 * @param version - the version to resolve.
 * @returns the 32-byte key, or undefined when the version is not retained.
 * @throws RangeError when the retained key is not 32 bytes.
 */
function keyFor(keyring: CredentialKeyring, version: CredentialKeyVersion): Buffer | undefined {
  const key = keyring.keys.get(version)
  if (key === undefined) return undefined
  if (key.byteLength !== KEY_BYTES) {
    throw new RangeError(
      `dsh-credential-vault: keyring version '${version}' must hold a ${String(KEY_BYTES)}-byte key, got ${String(key.byteLength)}`,
    )
  }
  return Buffer.from(key)
}

/**
 * Decode canonical base64url only, so a re-encoded envelope field that differs
 * from what was written is treated as tampering rather than silently accepted.
 */
function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  const decoded = Buffer.from(value, 'base64url')
  return decoded.toString('base64url') === value ? decoded : undefined
}

function audit(
  action: CredentialAuditEvent['action'],
  binding: CredentialBinding,
  keyVersion: CredentialKeyVersion,
  at: number,
  outcome: CredentialAuditEvent['outcome'],
): CredentialAuditEvent {
  return { action, userId: binding.userId, accountId: binding.accountId, keyVersion, at, outcome }
}

/**
 * Seal one secret for a tenant's provider account under the keyring's current key.
 *
 * @param secret - the plaintext credential; the caller owns its lifetime.
 * @param binding - whose secret this is; it authenticates the ciphertext.
 * @param keyring - the deployment's keys; `currentVersion` seals.
 * @param now - epoch milliseconds from the caller's clock.
 * @returns the envelope to store and the record of sealing it.
 * @throws RangeError when the current version is absent from the keyring, or its key is not 32 bytes.
 */
export function sealCredential(
  secret: Uint8Array,
  binding: CredentialBinding,
  keyring: CredentialKeyring,
  now: number,
): CredentialSealResult {
  const version = keyring.currentVersion
  const key = keyFor(keyring, version)
  if (key === undefined) {
    throw new RangeError(`dsh-credential-vault: keyring does not retain its current version '${version}'`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(additionalData(binding, version))
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()])
  return {
    envelope: {
      envelopeVersion: ENVELOPE_VERSION,
      userId: binding.userId,
      accountId: binding.accountId,
      keyVersion: version,
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
      sealedAt: now,
      rewrappedAt: undefined,
      revokedAt: undefined,
    },
    audit: audit('seal', binding, version, now, 'ok'),
  }
}

/**
 * Check everything that must hold before a decryption is even attempted.
 * @returns the rejection that denies the read, or undefined to proceed.
 */
function refuseBeforeDecrypt(
  envelope: CredentialEnvelope,
  binding: CredentialBinding,
): CredentialRejection | undefined {
  if (envelope.envelopeVersion !== ENVELOPE_VERSION) return 'unsupported-version'
  if (envelope.revokedAt !== undefined) return 'revoked'
  const userMatches = sameSecretlessValue(envelope.userId, binding.userId)
  const accountMatches = sameSecretlessValue(envelope.accountId, binding.accountId)
  if (!userMatches || !accountMatches) return 'binding-mismatch'
  return undefined
}

/** Compare two non-secret identifiers without leaking their length difference through early exit. */
function sameSecretlessValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

/**
 * Open one sealed credential for the tenant the caller names.
 *
 * An envelope in the wrong record is denied as `binding-mismatch` while its
 * stored fields still name its real owner, and as `corrupt` once those fields
 * are rewritten to match the caller — the additional authenticated data
 * carries the seal-time tenant, so the rewrite cannot reproduce it.
 *
 * @param envelope - the stored envelope, exactly as read back.
 * @param binding - whose secret the caller is authorized to read.
 * @param keyring - the deployment's retained keys.
 * @param now - epoch milliseconds from the caller's clock.
 * @returns the plaintext and its audit record, or the rejection and its audit record.
 * @throws RangeError when a retained key is not 32 bytes.
 */
export function openCredential(
  envelope: CredentialEnvelope,
  binding: CredentialBinding,
  keyring: CredentialKeyring,
  now: number,
): CredentialOpenResult {
  const version = envelope.keyVersion
  const refusal = refuseBeforeDecrypt(envelope, binding)
  if (refusal !== undefined) {
    return { opened: false, rejection: refusal, audit: audit('open', binding, version, now, refusal) }
  }
  const key = keyFor(keyring, version)
  if (key === undefined) {
    return { opened: false, rejection: 'unknown-key', audit: audit('open', binding, version, now, 'unknown-key') }
  }
  const iv = decodeCanonicalBase64Url(envelope.iv)
  const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext)
  const authTag = decodeCanonicalBase64Url(envelope.authTag)
  if (iv === undefined || ciphertext === undefined || authTag === undefined || iv.byteLength !== IV_BYTES) {
    return { opened: false, rejection: 'corrupt', audit: audit('open', binding, version, now, 'corrupt') }
  }
  let secret: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(additionalData(binding, version))
    decipher.setAuthTag(authTag)
    secret = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (_authenticationFailed) {
    // GCM reports a wrong key, a moved envelope, and a flipped byte the same way.
    return { opened: false, rejection: 'corrupt', audit: audit('open', binding, version, now, 'corrupt') }
  }
  return { opened: true, secret, audit: audit('open', binding, version, now, 'ok') }
}

/**
 * Move one envelope onto the keyring's current key.
 *
 * Rotation is: add a key, make it current, rewrap every envelope, then retire
 * the old version. An envelope that is never rewrapped becomes unopenable when
 * its version is retired.
 *
 * @param envelope - the stored envelope to move.
 * @param binding - whose secret this is; it must open before it can be resealed.
 * @param keyring - the deployment's retained keys.
 * @param now - epoch milliseconds from the caller's clock.
 * @returns the envelope under the current key, or the rejection that denied the read.
 * @throws RangeError when the current version is absent from the keyring, or a retained key is not 32 bytes.
 */
export function rewrapCredential(
  envelope: CredentialEnvelope,
  binding: CredentialBinding,
  keyring: CredentialKeyring,
  now: number,
): CredentialRewrapResult {
  const opened = openCredential(envelope, binding, keyring, now)
  if (!opened.opened) {
    return {
      rewrapped: false,
      rejection: opened.rejection,
      audit: audit('rewrap', binding, envelope.keyVersion, now, opened.rejection),
    }
  }
  const resealed = sealCredential(opened.secret, binding, keyring, now)
  return {
    rewrapped: true,
    envelope: { ...resealed.envelope, sealedAt: envelope.sealedAt, rewrappedAt: now },
    audit: audit('rewrap', binding, keyring.currentVersion, now, 'ok'),
  }
}

/**
 * Destroy one envelope's secret.
 *
 * Revocation removes the ciphertext, nonce, and authentication tag rather than
 * setting a flag an opener has to honor, so a caller that ignores the rejection
 * still has nothing to decrypt and no key can recover the secret. The record
 * itself is kept so its metadata stays auditable.
 *
 * @param envelope - the envelope to revoke; revoking an already-revoked envelope keeps the first `revokedAt`.
 * @param now - epoch milliseconds from the caller's clock.
 * @returns the emptied envelope and the record of destroying its secret.
 */
export function revokeCredential(envelope: CredentialEnvelope, now: number): CredentialRevokeResult {
  const binding: CredentialBinding = { userId: envelope.userId, accountId: envelope.accountId }
  return {
    envelope: {
      ...envelope,
      iv: '',
      ciphertext: '',
      authTag: '',
      revokedAt: envelope.revokedAt ?? now,
    },
    audit: audit('revoke', binding, envelope.keyVersion, now, 'ok'),
  }
}

/**
 * Project one envelope to the metadata that is safe to log or return.
 * @param envelope - the stored envelope.
 * @returns every field except the nonce, ciphertext, and authentication tag.
 */
export function redactCredential(envelope: CredentialEnvelope): CredentialRedaction {
  return {
    userId: envelope.userId,
    accountId: envelope.accountId,
    keyVersion: envelope.keyVersion,
    envelopeVersion: envelope.envelopeVersion,
    state: envelope.revokedAt === undefined ? 'active' : 'revoked',
    sealedAt: envelope.sealedAt,
    rewrappedAt: envelope.rewrappedAt,
    revokedAt: envelope.revokedAt,
  }
}
