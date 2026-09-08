import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JSONWebKeySet } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createOidcUserInfoProvider } from '../src/index.ts'

const ISSUER = 'https://identity.example'
const CLIENT_ID = 'candy-client'
const NOW_SECONDS = Math.floor(Date.now() / 1000)

let privateKey: CryptoKey
let jwks: JSONWebKeySet

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true })
  privateKey = pair.privateKey
  const publicJwk = await exportJWK(pair.publicKey)
  jwks = { keys: [{ ...publicJwk, kid: 'signing-key', alg: 'ES256', use: 'sig' }] }
})

async function idToken(input: {
  readonly nonce?: string
  readonly subject?: string
  readonly audience?: string | string[]
  readonly authorizedParty?: string
  readonly issuedAt?: number
} = {}): Promise<string> {
  const issuedAt = input.issuedAt ?? NOW_SECONDS
  return new SignJWT({
    nonce: input.nonce ?? 'oidc-nonce',
    ...(input.authorizedParty === undefined ? {} : { azp: input.authorizedParty }),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'signing-key' })
    .setIssuer(ISSUER)
    .setAudience(input.audience ?? CLIENT_ID)
    .setSubject(input.subject ?? 'external-alice')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(privateKey)
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function provider(fetch: typeof globalThis.fetch, loadClientSecret?: () => Promise<string>) {
  return createOidcUserInfoProvider({
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize?prompt=select_account`,
    tokenEndpoint: `${ISSUER}/token`,
    userInfoEndpoint: `${ISSUER}/userinfo`,
    clientId: CLIENT_ID,
    jwks,
    fetch,
    ...(loadClientSecret === undefined ? {} : { loadClientSecret }),
  })
}

const exchangeInput = {
  code: 'authorization-code',
  codeVerifier: 'server-retained-verifier',
  nonce: 'oidc-nonce',
  redirectUri: 'https://candy.example/auth/oauth/callback',
} as const

describe('OIDC UserInfo provider', () => {
  it('builds a code + S256 authorization URL without losing provider query', () => {
    const oidc = provider(vi.fn() as never)
    const url = new URL(String(oidc.authorizationUrl({
      state: 'opaque-state',
      codeChallenge: 'pkce-challenge',
      nonce: 'oidc-nonce',
      redirectUri: exchangeInput.redirectUri,
    })))

    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      prompt: 'select_account',
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: 'openid profile',
      redirect_uri: exchangeInput.redirectUri,
      state: 'opaque-state',
      code_challenge: 'pkce-challenge',
      code_challenge_method: 'S256',
      nonce: 'oidc-nonce',
    })
  })

  it('verifies the ID Token and exact UserInfo subject before returning identity', async () => {
    const token = await idToken()
    const fetch = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/token')) return json({ access_token: 'access-token', id_token: token, token_type: 'Bearer' })
      if (url.endsWith('/userinfo')) return json({ sub: 'external-alice' })
      throw new Error(`unexpected URL ${url}`)
    }) as unknown as typeof globalThis.fetch
    const oidc = provider(fetch)

    await expect(oidc.exchangeCode(exchangeInput)).resolves.toEqual({
      issuer: ISSUER,
      subject: 'external-alice',
    })
    const tokenCall = vi.mocked(fetch).mock.calls[0]
    const tokenBody = tokenCall?.[1]?.body as URLSearchParams
    expect(Object.fromEntries(tokenBody)).toEqual({
      grant_type: 'authorization_code',
      code: 'authorization-code',
      redirect_uri: exchangeInput.redirectUri,
      code_verifier: 'server-retained-verifier',
      client_id: CLIENT_ID,
    })
    expect(tokenCall?.[1]).toMatchObject({ method: 'POST', redirect: 'error' })
    const userInfoCall = vi.mocked(fetch).mock.calls[1]
    expect(new Headers(userInfoCall?.[1]?.headers).get('authorization')).toBe('Bearer access-token')
    expect(userInfoCall?.[1]).toMatchObject({ method: 'GET', redirect: 'error' })
  })

  it('loads a confidential-client secret only for exchange and uses HTTP Basic', async () => {
    const token = await idToken()
    const loadClientSecret = vi.fn(async () => 'secret with space')
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith('/token')) {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Basic ${Buffer.from('candy-client:secret+with+space', 'utf8').toString('base64')}`,
        )
        expect((init?.body as URLSearchParams).has('client_id')).toBe(false)
        return json({ access_token: 'access-token', id_token: token, token_type: 'bearer' })
      }
      return json({ sub: 'external-alice', iss: ISSUER })
    }) as unknown as typeof globalThis.fetch

    await expect(provider(fetch, loadClientSecret).exchangeCode(exchangeInput)).resolves.toMatchObject({
      subject: 'external-alice',
    })
    expect(loadClientSecret).toHaveBeenCalledOnce()
  })

  it.each([
    ['wrong nonce', () => idToken({ nonce: 'other-nonce' }), 'external-alice'],
    ['wrong audience', () => idToken({ audience: 'another-client' }), 'external-alice'],
    ['future issued-at', () => idToken({ issuedAt: NOW_SECONDS + 600 }), 'external-alice'],
    ['UserInfo substitution', () => idToken(), 'external-bobby'],
    ['wrong authorized party', () => idToken({ audience: [CLIENT_ID, 'another-client'], authorizedParty: 'another-client' }), 'external-alice'],
  ])('rejects %s', async (_case, tokenFactory, userInfoSubject) => {
    const token = await tokenFactory()
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'access-token', id_token: token, token_type: 'Bearer' }))
      .mockResolvedValueOnce(json({ sub: userInfoSubject })) as unknown as typeof globalThis.fetch

    await expect(provider(fetch).exchangeCode(exchangeInput)).rejects.toThrow()
  })

  it('bounds provider responses and never includes their body in the failure', async () => {
    const providerBody = `provider-secret-${'x'.repeat(1024)}`
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: providerBody }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch
    const oidc = createOidcUserInfoProvider({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      userInfoEndpoint: `${ISSUER}/userinfo`,
      clientId: CLIENT_ID,
      jwks,
      maxResponseBytes: 64,
      fetch,
    })

    const failure = await oidc.exchangeCode(exchangeInput).catch((error: unknown) => error as Error)
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('Expected OIDC exchange to fail')
    expect(failure.message).toBe('OIDC endpoint response exceeded its byte limit')
    expect(failure.message).not.toContain(providerBody)
  })

  it('rejects insecure endpoints, missing openid scope, and symmetric algorithms', () => {
    const base = {
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      userInfoEndpoint: `${ISSUER}/userinfo`,
      clientId: CLIENT_ID,
      jwks,
    }
    expect(() => createOidcUserInfoProvider({ ...base, tokenEndpoint: 'http://identity.example/token' }))
      .toThrow(/HTTPS/u)
    expect(() => createOidcUserInfoProvider({ ...base, scopes: ['profile'] }))
      .toThrow(/openid/u)
    expect(() => createOidcUserInfoProvider({ ...base, algorithms: [] }))
      .toThrow(/algorithms/u)
    expect(() => createOidcUserInfoProvider({
      ...base,
      algorithms: ['HS256'],
    } as never)).toThrow(/algorithms/u)
  })
})
