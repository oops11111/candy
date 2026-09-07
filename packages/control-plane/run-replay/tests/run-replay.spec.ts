import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ConversationId,
  DeviceId,
  ProviderAccountId,
  RunId,
  UserId,
  WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import type { ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { RunReplayStore } from '../src/index.ts'

const NOW = 1_800_000_000_000
const LIFETIME = 60_000

function claims(overrides: Partial<ExecutionAssertionClaims> = {}): ExecutionAssertionClaims {
  return {
    issuer: 'candy-control-plane',
    audience: 'candy-runtime-debian-1',
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

describe('spending a nonce', () => {
  it('admits a nonce it has not seen', () => {
    expect(new RunReplayStore().spend(claims(), NOW)).toBe(true)
  })

  it('denies the same nonce on its second use', () => {
    const store = new RunReplayStore()

    expect(store.spend(claims(), NOW)).toBe(true)
    expect(store.spend(claims(), NOW)).toBe(false)
  })

  it('denies a replay for the rest of the assertion lifetime', () => {
    const store = new RunReplayStore()
    store.spend(claims(), NOW)

    expect(store.spend(claims(), NOW + LIFETIME - 1)).toBe(false)
  })

  it('records a run whose admission is later denied', () => {
    // The nonce is spent before the credential is read, so a run refused at
    // that step has still burned its token; the store must not un-spend it.
    const store = new RunReplayStore()
    store.spend(claims(), NOW)

    expect(store.spend(claims(), NOW)).toBe(false)
  })
})

describe('partitioning by tenant', () => {
  it('leaves another tenant the same nonce value', () => {
    // Otherwise one tenant denies another's run by spending a value first.
    const store = new RunReplayStore()
    store.spend(claims(), NOW)

    expect(store.spend(claims({ userId: UserId('user-bobby') }), NOW)).toBe(true)
  })

  it('cannot have a tenant and nonce pair forge the boundary between them', () => {
    // ('ab', 'c') and ('a', 'bc') are different records, not one.
    const store = new RunReplayStore()
    store.spend(claims({ userId: UserId('ab'), nonce: 'c' }), NOW)

    expect(store.spend(claims({ userId: UserId('a'), nonce: 'bc' }), NOW)).toBe(true)
  })

  it('separates two nonces of one tenant', () => {
    const store = new RunReplayStore()
    store.spend(claims(), NOW)

    expect(store.spend(claims({ nonce: 'nonce-2' }), NOW)).toBe(true)
  })
})

describe('retention bounded by the assertion', () => {
  it('treats a record whose assertion expired as absent', () => {
    const store = new RunReplayStore()
    store.spend(claims(), NOW)

    expect(store.spend(claims(), NOW + LIFETIME)).toBe(true)
  })

  it('holds a record for exactly as long as the assertion is admissible', () => {
    // `admitExecutionAssertion` denies at the expiry instant, so the record
    // stops mattering at the same millisecond it stops being needed.
    const store = new RunReplayStore()
    store.spend(claims(), NOW)

    expect(store.spend(claims(), NOW + LIFETIME - 1)).toBe(false)
    expect(store.spend(claims(), NOW + LIFETIME)).toBe(true)
  })
})

describe('evicting expired records', () => {
  it('drops only what can no longer deny anything', () => {
    const store = new RunReplayStore()
    store.spend(claims(), NOW)
    store.spend(claims({ nonce: 'nonce-2', expiresAt: NOW + LIFETIME * 2 }), NOW)

    expect(store.evict(NOW + LIFETIME)).toBe(1)
    expect(store.size).toBe(1)
  })

  it('changes no decision, only how much is held', () => {
    const evicting = new RunReplayStore()
    const hoarding = new RunReplayStore()
    for (const store of [evicting, hoarding]) store.spend(claims(), NOW)
    evicting.evict(NOW + LIFETIME)

    expect(evicting.spend(claims(), NOW + LIFETIME)).toBe(true)
    expect(hoarding.spend(claims(), NOW + LIFETIME)).toBe(true)
    expect(hoarding.size).toBe(1)
  })

  it('drops nothing while every assertion is still admissible', () => {
    const store = new RunReplayStore()
    store.spend(claims(), NOW)

    expect(store.evict(NOW)).toBe(0)
    expect(store.size).toBe(1)
  })
})

describe('as the spendNonce port', () => {
  it('admits exactly one of two concurrent copies of one token', async () => {
    // The port returns a promise, so the risk is an implementation that awaits
    // between asking and recording: both copies would then see a fresh nonce
    // and both would reach the credential.
    const store = new RunReplayStore()
    const spendNonce = (subject: ExecutionAssertionClaims): Promise<boolean> =>
      Promise.resolve(store.spend(subject, NOW))

    const outcomes = await Promise.all([spendNonce(claims()), spendNonce(claims())])

    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })

  it('admits exactly one of many concurrent copies', async () => {
    const store = new RunReplayStore()
    const spendNonce = (subject: ExecutionAssertionClaims): Promise<boolean> =>
      Promise.resolve(store.spend(subject, NOW))

    const outcomes = await Promise.all(Array.from({ length: 32 }, () => spendNonce(claims())))

    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })
})
