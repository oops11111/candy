import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import { describe, expect, it } from 'vitest'
import {
  CredentialKeyVersion,
  openCredential,
  redactCredential,
  revokeCredential,
  rewrapCredential,
  sealCredential,
  type CredentialBinding,
  type CredentialEnvelope,
  type CredentialKeyring,
} from '../src/index.ts'

const V1 = CredentialKeyVersion('2026-09-a')
const V2 = CredentialKeyVersion('2026-09-b')
const SEALED_AT = 1_800_000_000_000
const SECRET = Buffer.from('sk-deepseek-example', 'utf8')

const ALICE: CredentialBinding = { userId: UserId('user-alice'), accountId: ProviderAccountId('account-1') }
const BOB: CredentialBinding = { userId: UserId('user-bobby'), accountId: ProviderAccountId('account-1') }

/** Same length as ALICE.userId, so a length check alone cannot separate them. */
const ALIAS: CredentialBinding = { userId: UserId('user-alicf'), accountId: ProviderAccountId('account-1') }

function keyring(current = V1, versions: readonly CredentialKeyVersion[] = [V1]): CredentialKeyring {
  const keys = new Map(versions.map((version, index) => [version, Buffer.alloc(32, index + 1)]))
  return { currentVersion: current, keys }
}

function sealed(binding: CredentialBinding = ALICE, ring: CredentialKeyring = keyring()): CredentialEnvelope {
  return sealCredential(SECRET, binding, ring, SEALED_AT).envelope
}

describe('sealCredential', () => {
  it('round-trips a secret for its own tenant', () => {
    const ring = keyring()
    const envelope = sealed(ALICE, ring)

    const opened = openCredential(envelope, ALICE, ring, SEALED_AT)

    expect(opened.opened && Buffer.from(opened.secret).toString('utf8')).toBe('sk-deepseek-example')
    expect(opened.audit).toEqual({
      action: 'open', userId: ALICE.userId, accountId: ALICE.accountId,
      keyVersion: V1, at: SEALED_AT, outcome: 'ok',
    })
  })

  it('records the seal without exposing the secret', () => {
    const result = sealCredential(SECRET, ALICE, keyring(), SEALED_AT)

    expect(result.audit.action).toBe('seal')
    expect(result.audit.outcome).toBe('ok')
    expect(result.envelope.ciphertext).not.toContain('sk-deepseek')
    expect(result.envelope.sealedAt).toBe(SEALED_AT)
    expect(result.envelope.rewrappedAt).toBeUndefined()
    expect(result.envelope.revokedAt).toBeUndefined()
  })

  it('draws a fresh nonce for every seal', () => {
    const ring = keyring()

    const first = sealCredential(SECRET, ALICE, ring, SEALED_AT).envelope
    const second = sealCredential(SECRET, ALICE, ring, SEALED_AT).envelope

    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it('refuses a keyring that does not retain its current version', () => {
    const ring: CredentialKeyring = { currentVersion: V2, keys: keyring().keys }

    expect(() => sealCredential(SECRET, ALICE, ring, SEALED_AT))
      .toThrow(/does not retain its current version '2026-09-b'/)
  })

  it('refuses a key that is not 32 bytes', () => {
    const ring: CredentialKeyring = { currentVersion: V1, keys: new Map([[V1, Buffer.alloc(16, 1)]]) }

    expect(() => sealCredential(SECRET, ALICE, ring, SEALED_AT)).toThrow(/must hold a 32-byte key, got 16/)
  })
})

describe('openCredential', () => {
  // Every stored field names Bob, so the binding comparison agrees; only the
  // additional authenticated data still carries Alice and denies the read.
  it('denies another tenant naming their own binding for a moved envelope', () => {
    const ring = keyring()
    const moved: CredentialEnvelope = { ...sealed(ALICE, ring), userId: BOB.userId, accountId: BOB.accountId }

    const opened = openCredential(moved, BOB, ring, SEALED_AT)

    expect(opened).toMatchObject({ opened: false, rejection: 'corrupt' })
  })

  // The stored fields still name Alice, so the comparison denies this one.
  it('denies a caller whose tenant differs from the envelope', () => {
    const ring = keyring()

    const opened = openCredential(sealed(ALICE, ring), BOB, ring, SEALED_AT)

    expect(opened).toMatchObject({ opened: false, rejection: 'binding-mismatch' })
  })

  it('denies a tenant whose id differs only in one character', () => {
    const ring = keyring()

    const opened = openCredential(sealed(ALICE, ring), ALIAS, ring, SEALED_AT)

    expect(opened).toMatchObject({ opened: false, rejection: 'binding-mismatch' })
  })

  it('denies a caller whose account differs from the envelope', () => {
    const ring = keyring()
    const other: CredentialBinding = { userId: ALICE.userId, accountId: ProviderAccountId('account-2') }

    const opened = openCredential(sealed(ALICE, ring), other, ring, SEALED_AT)

    expect(opened).toMatchObject({ opened: false, rejection: 'binding-mismatch' })
  })

  it('denies an envelope layout this build does not implement', () => {
    const ring = keyring()
    const future: CredentialEnvelope = { ...sealed(ALICE, ring), envelopeVersion: 2 }

    expect(openCredential(future, ALICE, ring, SEALED_AT))
      .toMatchObject({ opened: false, rejection: 'unsupported-version' })
  })

  it('denies an envelope whose key version was retired', () => {
    const sealedUnderV1 = sealed(ALICE, keyring())
    const rotated = keyring(V2, [V2])

    expect(openCredential(sealedUnderV1, ALICE, rotated, SEALED_AT))
      .toMatchObject({ opened: false, rejection: 'unknown-key' })
  })

  it('denies an envelope sealed under a different key of the same version', () => {
    const envelope = sealed(ALICE, keyring())
    const rekeyed: CredentialKeyring = { currentVersion: V1, keys: new Map([[V1, Buffer.alloc(32, 9)]]) }

    expect(openCredential(envelope, ALICE, rekeyed, SEALED_AT))
      .toMatchObject({ opened: false, rejection: 'corrupt' })
  })

  it.each([
    ['ciphertext', (e: CredentialEnvelope) => ({ ...e, ciphertext: 'not+canonical/' })],
    ['nonce', (e: CredentialEnvelope) => ({ ...e, iv: 'not+canonical/' })],
    ['authentication tag', (e: CredentialEnvelope) => ({ ...e, authTag: 'not+canonical/' })],
  ])('denies a non-canonical %s', (_field, damage) => {
    const ring = keyring()

    expect(openCredential(damage(sealed(ALICE, ring)), ALICE, ring, SEALED_AT))
      .toMatchObject({ opened: false, rejection: 'corrupt' })
  })

  it('denies a nonce of the wrong length', () => {
    const ring = keyring()
    const shortNonce: CredentialEnvelope = { ...sealed(ALICE, ring), iv: Buffer.alloc(8, 1).toString('base64url') }

    expect(openCredential(shortNonce, ALICE, ring, SEALED_AT))
      .toMatchObject({ opened: false, rejection: 'corrupt' })
  })

  it('denies a flipped ciphertext byte', () => {
    const ring = keyring()
    const envelope = sealed(ALICE, ring)
    const bytes = Buffer.from(envelope.ciphertext, 'base64url')
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0)

    expect(openCredential({ ...envelope, ciphertext: bytes.toString('base64url') }, ALICE, ring, SEALED_AT))
      .toMatchObject({ opened: false, rejection: 'corrupt' })
  })

  it('records the rejection in the audit event', () => {
    const ring = keyring()

    const opened = openCredential(sealed(ALICE, ring), BOB, ring, SEALED_AT + 5)

    expect(opened.audit).toEqual({
      action: 'open', userId: BOB.userId, accountId: BOB.accountId,
      keyVersion: V1, at: SEALED_AT + 5, outcome: 'binding-mismatch',
    })
  })
})

describe('rewrapCredential', () => {
  it('moves an envelope onto the current key and keeps its seal time', () => {
    const rotating = keyring(V2, [V1, V2])
    const envelope = sealed(ALICE, keyring())

    const rewrapped = rewrapCredential(envelope, ALICE, rotating, SEALED_AT + 100)

    expect(rewrapped.rewrapped).toBe(true)
    if (!rewrapped.rewrapped) return
    expect(rewrapped.envelope.keyVersion).toBe(V2)
    expect(rewrapped.envelope.sealedAt).toBe(SEALED_AT)
    expect(rewrapped.envelope.rewrappedAt).toBe(SEALED_AT + 100)
    expect(rewrapped.audit).toMatchObject({ action: 'rewrap', keyVersion: V2, outcome: 'ok' })
  })

  it('survives retiring the old key once every envelope is rewrapped', () => {
    const rotating = keyring(V2, [V1, V2])
    const rewrapped = rewrapCredential(sealed(ALICE, keyring()), ALICE, rotating, SEALED_AT + 100)
    const retired = keyring(V2, [V2])
    // The retired ring must hold the same V2 bytes the rotating ring sealed with.
    const sameV2: CredentialKeyring = { currentVersion: V2, keys: new Map([[V2, rotating.keys.get(V2) as Uint8Array]]) }

    expect(rewrapped.rewrapped).toBe(true)
    if (!rewrapped.rewrapped) return
    const opened = openCredential(rewrapped.envelope, ALICE, sameV2, SEALED_AT + 200)
    expect(opened.opened && Buffer.from(opened.secret).toString('utf8')).toBe('sk-deepseek-example')
    expect(retired.keys.has(V1)).toBe(false)
  })

  it('passes a denied read through instead of resealing', () => {
    const ring = keyring()

    const rewrapped = rewrapCredential(sealed(ALICE, ring), BOB, ring, SEALED_AT)

    expect(rewrapped).toMatchObject({ rewrapped: false, rejection: 'binding-mismatch' })
    expect(rewrapped.audit).toMatchObject({ action: 'rewrap', outcome: 'binding-mismatch' })
  })
})

describe('revokeCredential', () => {
  it('destroys the secret rather than flagging it', () => {
    const ring = keyring()

    const revoked = revokeCredential(sealed(ALICE, ring), SEALED_AT + 10)

    expect(revoked.envelope.ciphertext).toBe('')
    expect(revoked.envelope.iv).toBe('')
    expect(revoked.envelope.authTag).toBe('')
    expect(revoked.envelope.revokedAt).toBe(SEALED_AT + 10)
    expect(revoked.audit).toMatchObject({ action: 'revoke', userId: ALICE.userId, outcome: 'ok' })
  })

  it('denies every later read', () => {
    const ring = keyring()
    const revoked = revokeCredential(sealed(ALICE, ring), SEALED_AT + 10).envelope

    expect(openCredential(revoked, ALICE, ring, SEALED_AT + 20))
      .toMatchObject({ opened: false, rejection: 'revoked' })
  })

  it('keeps the first revocation time when revoked again', () => {
    const revoked = revokeCredential(sealed(), SEALED_AT + 10).envelope

    expect(revokeCredential(revoked, SEALED_AT + 999).envelope.revokedAt).toBe(SEALED_AT + 10)
  })
})

describe('redactCredential', () => {
  it('carries metadata and no sealed material', () => {
    const envelope = sealed()

    const redaction = redactCredential(envelope)

    expect(redaction).toEqual({
      userId: ALICE.userId,
      accountId: ALICE.accountId,
      keyVersion: V1,
      envelopeVersion: 1,
      state: 'active',
      sealedAt: SEALED_AT,
      rewrappedAt: undefined,
      revokedAt: undefined,
    })
    expect(JSON.stringify(redaction)).not.toContain(envelope.ciphertext)
  })

  it('reports a revoked envelope as revoked', () => {
    const revoked = revokeCredential(sealed(), SEALED_AT + 10).envelope

    expect(redactCredential(revoked).state).toBe('revoked')
  })
})
