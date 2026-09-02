import { brandString } from '@deepseek-ai/dsh-brand'
import { ConversationId, DeviceId, ProviderAccountId, RunId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'
import {
  CredentialKeyVersion,
  revokeCredential,
  sealCredential,
  type CredentialEnvelope,
  type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion, type ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import { runtimePoolKey, runtimePoolRoot } from '@deepseek-ai/dsh-runtime-pool'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { admitRun, type RunAdmissionPolicy } from '../src/index.ts'

const ASSERTION_SECRET = Buffer.alloc(32, 3)
const KEY_VERSION = CredentialKeyVersion('2026-09-a')
const NOW = 1_800_000_000_000
const LIFETIME = 60_000
const POOL_BASE = '/srv/candy/pools'
const API_KEY = Buffer.from('sk-alice-deepseek', 'utf8')

const EXPECTATION = {
  issuer: 'candy-control-plane',
  audience: 'candy-runtime-debian-1',
  maxLifetimeMs: LIFETIME,
} as const

const KEYRING: CredentialKeyring = {
  currentVersion: KEY_VERSION,
  keys: new Map([[KEY_VERSION, Buffer.alloc(32, 5)]]),
}

function claims(overrides: Partial<ExecutionAssertionClaims> = {}): ExecutionAssertionClaims {
  return {
    issuer: EXPECTATION.issuer,
    audience: EXPECTATION.audience,
    userId: UserId('user-alice'),
    deviceId: DeviceId('device-1'),
    accountId: ProviderAccountId('account-1'),
    provider: 'deepseek-api',
    workspaceGrantId: WorkspaceGrantId('grant-1'),
    conversationId: ConversationId('conversation-1'),
    sessionId: brandString<SessionId>('session-1'),
    runId: RunId('run-1'),
    parentRunId: undefined,
    nonce: 'nonce-1',
    issuedAt: NOW,
    expiresAt: NOW + LIFETIME,
    ...overrides,
  }
}

function sealedFor(subject: ExecutionAssertionClaims): CredentialEnvelope {
  return sealCredential(
    API_KEY, { userId: subject.userId, accountId: subject.accountId }, KEYRING, NOW,
  ).envelope
}

/** A policy whose stores answer for exactly one tenant, with a one-shot nonce set. */
function policy(overrides: Partial<RunAdmissionPolicy> = {}): RunAdmissionPolicy {
  const spent = new Set<string>()
  return {
    expectation: EXPECTATION,
    assertionSecret: ASSERTION_SECRET,
    keyring: KEYRING,
    poolBase: POOL_BASE,
    spendNonce: (subject) => {
      if (spent.has(subject.nonce)) return Promise.resolve(false)
      spent.add(subject.nonce)
      return Promise.resolve(true)
    },
    findCredential: subject => Promise.resolve(
      subject.userId === UserId('user-alice') ? sealedFor(subject) : undefined,
    ),
    ...overrides,
  }
}

describe('admitRun', () => {
  it('turns a token into a credential and the pool that may use it', async () => {
    const subject = claims()
    const token = mintExecutionAssertion(subject, ASSERTION_SECRET)

    const admission = await admitRun({ token }, policy(), NOW)

    expect(admission.admitted).toBe(true)
    if (!admission.admitted) return
    expect(admission.run.claims).toEqual(subject)
    expect(Buffer.from(admission.run.secret).toString('utf8')).toBe('sk-alice-deepseek')
    expect(admission.run.poolRoot.startsWith(`${POOL_BASE}/`)).toBe(true)
    expect(admission.run.credentialAudit).toMatchObject({ action: 'open', outcome: 'ok' })
  })

  it('places the run in the pool the signed provider names', async () => {
    const subject = claims({ provider: 'claude-cli' })
    const token = mintExecutionAssertion(subject, ASSERTION_SECRET)

    const admission = await admitRun({ token }, policy(), NOW)

    expect(admission.admitted).toBe(true)
    if (!admission.admitted) return
    const expected = runtimePoolKey({
      userId: subject.userId, provider: 'claude-cli', accountId: subject.accountId,
    })
    expect(admission.run.poolKey).toBe(expected)
    expect(admission.run.poolRoot).toBe(runtimePoolRoot(POOL_BASE, expected))
  })

  it('separates two providers for one tenant and account', async () => {
    const first = await admitRun(
      { token: mintExecutionAssertion(claims(), ASSERTION_SECRET) }, policy(), NOW,
    )
    const second = await admitRun(
      { token: mintExecutionAssertion(claims({ provider: 'codex-cli' }), ASSERTION_SECRET) }, policy(), NOW,
    )

    expect(first.admitted && second.admitted).toBe(true)
    if (!first.admitted || !second.admitted) return
    expect(first.run.poolRoot).not.toBe(second.run.poolRoot)
  })

  it('denies a token this runtime does not admit before touching any store', async () => {
    let looked = false
    const token = mintExecutionAssertion(claims({ audience: 'another-runtime' }), ASSERTION_SECRET)

    const admission = await admitRun({ token }, policy({
      findCredential: () => { looked = true; return Promise.resolve(undefined) },
    }), NOW)

    expect(admission).toEqual({ admitted: false, rejection: { stage: 'assertion', reason: 'audience' } })
    expect(looked).toBe(false)
  })

  it('denies a replayed token on its second use', async () => {
    const token = mintExecutionAssertion(claims(), ASSERTION_SECRET)
    const shared = policy()

    const first = await admitRun({ token }, shared, NOW)
    const second = await admitRun({ token }, shared, NOW)

    expect(first.admitted).toBe(true)
    expect(second).toEqual({
      admitted: false, rejection: { stage: 'replay', reason: 'nonce-already-spent' },
    })
  })

  it('spends the nonce before reading a credential', async () => {
    const order: string[] = []
    const token = mintExecutionAssertion(claims(), ASSERTION_SECRET)

    await admitRun({ token }, policy({
      spendNonce: () => { order.push('nonce'); return Promise.resolve(true) },
      findCredential: (subject) => { order.push('credential'); return Promise.resolve(sealedFor(subject)) },
    }), NOW)

    expect(order).toEqual(['nonce', 'credential'])
  })

  it('denies a tenant whose account has no stored credential', async () => {
    const token = mintExecutionAssertion(claims({ userId: UserId('user-bobby') }), ASSERTION_SECRET)

    const admission = await admitRun({ token }, policy(), NOW)

    expect(admission).toEqual({
      admitted: false, rejection: { stage: 'credential', reason: 'not-found' },
    })
  })

  it('denies a run whose credential was revoked', async () => {
    const token = mintExecutionAssertion(claims(), ASSERTION_SECRET)

    const admission = await admitRun({ token }, policy({
      findCredential: subject => Promise.resolve(revokeCredential(sealedFor(subject), NOW).envelope),
    }), NOW)

    expect(admission).toEqual({
      admitted: false, rejection: { stage: 'credential', reason: 'revoked' },
    })
  })

  it('denies a run whose store returns another tenant envelope', async () => {
    const token = mintExecutionAssertion(claims(), ASSERTION_SECRET)
    const foreign = sealedFor(claims({ userId: UserId('user-bobby') }))

    const admission = await admitRun({ token }, policy({
      findCredential: () => Promise.resolve(foreign),
    }), NOW)

    expect(admission).toEqual({
      admitted: false, rejection: { stage: 'credential', reason: 'binding-mismatch' },
    })
  })

  it('opens the credential under the signed tenant, not the stored envelope', async () => {
    const token = mintExecutionAssertion(claims(), ASSERTION_SECRET)
    // The store hands back an envelope relabelled for the caller's tenant; the
    // vault's authenticated data still carries the tenant it was sealed for.
    const relabelled: CredentialEnvelope = {
      ...sealedFor(claims({ userId: UserId('user-bobby') })),
      userId: UserId('user-alice'),
    }

    const admission = await admitRun({ token }, policy({
      findCredential: () => Promise.resolve(relabelled),
    }), NOW)

    expect(admission).toEqual({
      admitted: false, rejection: { stage: 'credential', reason: 'corrupt' },
    })
  })

  it('denies an expired token', async () => {
    const token = mintExecutionAssertion(claims(), ASSERTION_SECRET)

    const admission = await admitRun({ token }, policy(), NOW + LIFETIME)

    expect(admission).toEqual({ admitted: false, rejection: { stage: 'assertion', reason: 'expired' } })
  })
})
