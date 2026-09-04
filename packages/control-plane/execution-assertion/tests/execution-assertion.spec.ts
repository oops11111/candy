import { createHmac } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ConversationId,
  DeviceId,
  ProviderAccountId,
  RunId,
  UserId,
  WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  admitExecutionAssertion,
  mintExecutionAssertion,
  type ExecutionAssertionClaims,
  type ExecutionAssertionExpectation,
} from '../src/index.ts'

const SECRET = Buffer.alloc(32, 7)
const OTHER_SECRET = Buffer.alloc(32, 9)
const ISSUED_AT = 1_800_000_000_000
const LIFETIME = 60_000

const EXPECTATION: ExecutionAssertionExpectation = {
  issuer: 'candy-control-plane',
  audience: 'candy-runtime-debian-1',
  maxLifetimeMs: LIFETIME,
}

function claims(overrides: Partial<ExecutionAssertionClaims> = {}): ExecutionAssertionClaims {
  return {
    issuer: EXPECTATION.issuer,
    audience: EXPECTATION.audience,
    userId: UserId('user-1'),
    deviceId: DeviceId('device-1'),
    accountId: ProviderAccountId('account-1'),
    provider: 'deepseek-api',
    workspaceGrantId: WorkspaceGrantId('grant-1'),
    conversationId: ConversationId('conversation-1'),
    sessionId: brandString<SessionId>('session-1'),
    runId: RunId('run-1'),
    parentRunId: undefined,
    nonce: 'nonce-1',
    issuedAt: ISSUED_AT,
    expiresAt: ISSUED_AT + LIFETIME,
    ...overrides,
  }
}

/** Sign payload text the way a control plane holding `secret` would. */
function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest().toString('base64url')
}

/** Build a correctly signed token carrying an arbitrary payload object. */
function tokenWithPayload(payload: object, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `v1.${encoded}.${sign(encoded, secret)}`
}

describe('mintExecutionAssertion', () => {
  it('round-trips every claim through admission', () => {
    const minted = claims()

    const admission = admitExecutionAssertion(
      mintExecutionAssertion(minted, SECRET), SECRET, EXPECTATION, ISSUED_AT,
    )

    expect(admission).toEqual({ admitted: true, claims: minted })
  })

  it('carries child-run ancestry through admission', () => {
    const minted = claims({ runId: RunId('run-2'), parentRunId: RunId('run-1') })

    const admission = admitExecutionAssertion(
      mintExecutionAssertion(minted, SECRET), SECRET, EXPECTATION, ISSUED_AT,
    )

    expect(admission).toEqual({ admitted: true, claims: minted })
  })

  it('mints the documented three-part token', () => {
    const token = mintExecutionAssertion(claims(), SECRET)

    expect(token.split('.')).toHaveLength(3)
    expect(token.startsWith('v1.')).toBe(true)
  })

  it('rejects a secret shorter than 32 bytes', () => {
    expect(() => mintExecutionAssertion(claims(), Buffer.alloc(31, 7)))
      .toThrow(/at least 32 bytes, got 31/)
  })
})

describe('admitExecutionAssertion', () => {
  it('rejects a secret shorter than 32 bytes', () => {
    expect(() => admitExecutionAssertion('v1.a.b', Buffer.alloc(1), EXPECTATION, ISSUED_AT))
      .toThrow(RangeError)
  })

  it.each([
    ['not a number', Number.NaN],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses a lifetime ceiling that is %s', (_case, maxLifetimeMs) => {
    const token = mintExecutionAssertion(claims(), SECRET)

    expect(() => admitExecutionAssertion(token, SECRET, { ...EXPECTATION, maxLifetimeMs }, ISSUED_AT))
      .toThrow(/maxLifetimeMs must be a positive safe integer/)
  })

  it('never admits an unbounded lifetime under a NaN ceiling', () => {
    const forever = mintExecutionAssertion(
      claims({ expiresAt: ISSUED_AT + LIFETIME * 1_000_000 }), SECRET,
    )

    expect(() => admitExecutionAssertion(
      forever, SECRET, { ...EXPECTATION, maxLifetimeMs: Number.NaN }, ISSUED_AT,
    )).toThrow(RangeError)
  })

  it.each([
    ['no separators', 'not-a-token'],
    ['two parts', 'v1.payload'],
    ['four parts', 'v1.a.b.c'],
  ])('rejects a token with %s as malformed', (_case, token) => {
    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT))
      .toEqual({ admitted: false, rejection: 'malformed' })
  })

  it('rejects an unimplemented token version', () => {
    const token = mintExecutionAssertion(claims(), SECRET)

    expect(admitExecutionAssertion(`v2${token.slice(2)}`, SECRET, EXPECTATION, ISSUED_AT))
      .toEqual({ admitted: false, rejection: 'unsupported-version' })
  })

  it('rejects a non-canonical base64url signature as malformed', () => {
    const [version, payload] = mintExecutionAssertion(claims(), SECRET).split('.')

    expect(admitExecutionAssertion(
      `${String(version)}.${String(payload)}.not+canonical/`, SECRET, EXPECTATION, ISSUED_AT,
    )).toEqual({ admitted: false, rejection: 'malformed' })
  })

  it('rejects a signature of the wrong length', () => {
    const [version, payload] = mintExecutionAssertion(claims(), SECRET).split('.')

    expect(admitExecutionAssertion(
      `${String(version)}.${String(payload)}.AAAA`, SECRET, EXPECTATION, ISSUED_AT,
    )).toEqual({ admitted: false, rejection: 'signature' })
  })

  it('rejects a token signed with another key', () => {
    const token = mintExecutionAssertion(claims(), OTHER_SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT))
      .toEqual({ admitted: false, rejection: 'signature' })
  })

  it.each([
    ['tenant', { userId: UserId('user-2') }],
    ['device', { deviceId: DeviceId('device-2') }],
    ['account', { accountId: ProviderAccountId('account-2') }],
    ['provider', { provider: 'claude-cli' } as const],
    ['workspace grant', { workspaceGrantId: WorkspaceGrantId('grant-2') }],
    ['conversation', { conversationId: ConversationId('conversation-2') }],
    ['session', { sessionId: brandString<SessionId>('session-2') }],
    ['run', { runId: RunId('run-2') }],
    ['parent run', { parentRunId: RunId('run-0') }],
    ['nonce', { nonce: 'nonce-2' }],
    ['issuer', { issuer: 'another-control-plane' }],
    ['audience', { audience: 'another-runtime' }],
    ['issued instant', { issuedAt: ISSUED_AT - 1 }],
    ['expiry', { expiresAt: ISSUED_AT + LIFETIME + 1 }],
  ])('rejects a forged %s while every other claim is untouched', (_claim, overrides) => {
    // Every claim is inside the MAC, so none of them can be swapped under a
    // signature the control plane produced. A claim moved out of the signed
    // payload would keep the tenant case passing while becoming forgeable, so
    // the whole set is pinned rather than one member of it.
    const [version, , signature] = mintExecutionAssertion(claims(), SECRET).split('.')
    const forged = Buffer.from(JSON.stringify(claims(overrides)), 'utf8').toString('base64url')

    expect(admitExecutionAssertion(
      `${String(version)}.${forged}.${String(signature)}`, SECRET, EXPECTATION, ISSUED_AT,
    )).toEqual({ admitted: false, rejection: 'signature' })
  })

  it('rejects a payload that is not canonical base64url', () => {
    const signature = sign('not+canonical/', SECRET)

    expect(admitExecutionAssertion(
      `v1.not+canonical/.${signature}`, SECRET, EXPECTATION, ISSUED_AT,
    )).toEqual({ admitted: false, rejection: 'malformed' })
  })

  it('rejects a correctly signed payload that is not JSON', () => {
    const payload = Buffer.from('not json', 'utf8').toString('base64url')

    expect(admitExecutionAssertion(
      `v1.${payload}.${sign(payload, SECRET)}`, SECRET, EXPECTATION, ISSUED_AT,
    )).toEqual({ admitted: false, rejection: 'malformed' })
  })

  it.each([
    ['a JSON array', []],
    ['a JSON scalar', 7],
    ['an absent claim', { ...claims(), runId: undefined }],
    ['an empty id', { ...claims(), userId: '' }],
    ['a non-string id', { ...claims(), accountId: 42 }],
    ['a fractional timestamp', { ...claims(), issuedAt: 1.5 }],
    ['a negative timestamp', { ...claims(), expiresAt: -1 }],
    ['a non-numeric timestamp', { ...claims(), issuedAt: 'soon' }],
    ['a non-string parent run', { ...claims(), parentRunId: 42 }],
    ['an empty parent run', { ...claims(), parentRunId: '' }],
    ['an absent provider', { ...claims(), provider: undefined }],
    ['a provider outside the closed set', { ...claims(), provider: 'gemini-cli' }],
  ])('rejects %s as malformed', (_case, payload) => {
    const token = tokenWithPayload(payload as object, SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT))
      .toEqual({ admitted: false, rejection: 'malformed' })
  })

  it('rejects another control plane', () => {
    const token = mintExecutionAssertion(claims({ issuer: 'other-control-plane' }), SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT))
      .toEqual({ admitted: false, rejection: 'issuer' })
  })

  it('rejects an assertion bound to another runtime', () => {
    const token = mintExecutionAssertion(claims({ audience: 'candy-runtime-debian-2' }), SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT))
      .toEqual({ admitted: false, rejection: 'audience' })
  })

  it('rejects a lifetime longer than this runtime admits', () => {
    const token = mintExecutionAssertion(claims({ expiresAt: ISSUED_AT + LIFETIME + 1 }), SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT))
      .toEqual({ admitted: false, rejection: 'lifetime' })
  })

  it('rejects a lifetime that does not advance', () => {
    const token = mintExecutionAssertion(claims({ expiresAt: ISSUED_AT }), SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT))
      .toEqual({ admitted: false, rejection: 'lifetime' })
  })

  it('admits an assertion whose lifetime is exactly the maximum', () => {
    const token = mintExecutionAssertion(claims(), SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT).admitted).toBe(true)
  })

  it('rejects an assertion minted in the future', () => {
    const token = mintExecutionAssertion(claims(), SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT - 1))
      .toEqual({ admitted: false, rejection: 'not-yet-valid' })
  })

  it('rejects an assertion at its expiry instant', () => {
    const token = mintExecutionAssertion(claims(), SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT + LIFETIME))
      .toEqual({ admitted: false, rejection: 'expired' })
  })

  it('admits an assertion in its last admissible millisecond', () => {
    const token = mintExecutionAssertion(claims(), SECRET)

    expect(admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT + LIFETIME - 1).admitted)
      .toBe(true)
  })

  it('takes tenant identity only from the signed token', () => {
    const token = mintExecutionAssertion(claims({ userId: UserId('user-signed') }), SECRET)

    const admission = admitExecutionAssertion(token, SECRET, EXPECTATION, ISSUED_AT)

    expect(admission.admitted && admission.claims.userId).toBe('user-signed')
  })
})
