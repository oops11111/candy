import { UserId, UserSessionId } from '@deepseek-ai/dsh-control-plane'
import { describe, expect, it, vi } from 'vitest'
import { completeOAuthSignIn, type OAuthSignInStore } from '../src/index.ts'

const NOW = 1_800_000_000_000

function store(): OAuthSignInStore {
  return {
    consumeOAuthAttempt: vi.fn(async state => state === 'state-ok' ? {
      codeVerifier: 'verifier', issuer: 'https://issuer.example', redirectUri: 'https://candy.example/callback',
    } : undefined),
    createUserSession: vi.fn(async (userId, role, identity, createdAt, expiresAt) => ({
      token: 'bearer', csrfToken: 'csrf',
      record: { id: UserSessionId('session-1'), userId, role, identity, createdAt, expiresAt, revokedAt: undefined },
    })),
  }
}

describe('completeOAuthSignIn', () => {
  it('maps only a provider-verified identity into a Candy session', async () => {
    const storage = store()
    const exchangeCode = vi.fn(async () => ({ issuer: 'https://issuer.example', subject: 'subject-1' }))
    const resolve = vi.fn(async () => ({ userId: UserId('alice'), role: 'administrator' as const }))

    const result = await completeOAuthSignIn(
      storage,
      { issuer: 'https://issuer.example', exchangeCode },
      { resolve },
      { state: 'state-ok', code: 'code', now: NOW, sessionExpiresAt: NOW + 60_000 },
    )

    expect(exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ code: 'code', codeVerifier: 'verifier' }))
    expect(resolve).toHaveBeenCalledWith({ issuer: 'https://issuer.example', subject: 'subject-1' })
    expect(result?.record).toMatchObject({ userId: 'alice', role: 'administrator' })
  })

  it.each(['wrong-state', ''])('creates no session for invalid state or code (%s)', async (value) => {
    const storage = store()
    const exchangeCode = vi.fn()
    const result = await completeOAuthSignIn(
      storage,
      { issuer: 'https://issuer.example', exchangeCode },
      { resolve: vi.fn() },
      { state: value, code: value, now: NOW, sessionExpiresAt: NOW + 1 },
    )
    expect(result).toBeUndefined()
    expect(exchangeCode).not.toHaveBeenCalled()
  })

  it('denies provider mismatch, verified issuer mismatch, and unenrolled identity', async () => {
    const mismatchStore = store()
    expect(await completeOAuthSignIn(
      mismatchStore,
      { issuer: 'https://other.example', exchangeCode: vi.fn() },
      { resolve: vi.fn() },
      { state: 'state-ok', code: 'code', now: NOW, sessionExpiresAt: NOW + 1 },
    )).toBeUndefined()

    const wrongIssuer = store()
    expect(await completeOAuthSignIn(
      wrongIssuer,
      { issuer: 'https://issuer.example', exchangeCode: vi.fn(async () => ({ issuer: 'https://forged.example', subject: 's' })) },
      { resolve: vi.fn() },
      { state: 'state-ok', code: 'code', now: NOW, sessionExpiresAt: NOW + 1 },
    )).toBeUndefined()

    const unenrolled = store()
    expect(await completeOAuthSignIn(
      unenrolled,
      { issuer: 'https://issuer.example', exchangeCode: vi.fn(async () => ({ issuer: 'https://issuer.example', subject: 's' })) },
      { resolve: vi.fn(async () => undefined) },
      { state: 'state-ok', code: 'code', now: NOW, sessionExpiresAt: NOW + 1 },
    )).toBeUndefined()
    expect(unenrolled.createUserSession).not.toHaveBeenCalled()
  })
})
