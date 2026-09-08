import { UserId, UserSessionId } from '@deepseek-ai/dsh-control-plane'
import { describe, expect, it, vi } from 'vitest'
import {
  authenticateOAuthHttpRequest,
  clearOAuthSessionCookies,
  completeOAuthSignIn,
  OAUTH_CALLBACK_PATH,
  OAUTH_CSRF_HEADER,
  OAUTH_LOGOUT_PATH,
  OAUTH_SESSION_PATH,
  OAUTH_START_PATH,
  oauthSessionCookies,
  registerOAuthHttpRoutes,
  type OAuthSignInResult,
  type OAuthSignInStore,
  type OAuthWebProvider,
  type OAuthWebServer,
  type OAuthWebStore,
} from '../src/index.ts'

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

describe('OAuth HTTP session transport', () => {
  const result: OAuthSignInResult = {
    token: 'bearer', csrfToken: 'csrf',
    record: {
      id: UserSessionId('session-1'), userId: UserId('alice'), role: 'member',
      identity: { issuer: 'issuer', subject: 'alice' },
      createdAt: NOW, expiresAt: NOW + 60_000, revokedAt: undefined,
    },
  }

  it('writes host-only secure cookies and clears them with matching attributes', () => {
    const [session, csrf] = oauthSessionCookies(result, NOW)
    expect(session).toContain('__Host-candy-session=bearer; Max-Age=60; Path=/;')
    expect(session).toContain('Secure; HttpOnly; SameSite=Lax')
    expect(csrf).toContain('__Host-candy-csrf=csrf; Max-Age=60; Path=/;')
    expect(csrf).toContain('Secure; SameSite=Strict')
    expect(clearOAuthSessionCookies()).toEqual([
      '__Host-candy-session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax',
      '__Host-candy-csrf=; Max-Age=0; Path=/; Secure; SameSite=Strict',
    ])
  })

  it('derives identity from the bearer and requires matching CSRF for mutations', () => {
    const store = {
      authenticateUserSession: vi.fn((token: string) => token === 'bearer' ? result.record : undefined),
      verifyUserSessionCsrf: vi.fn((_id: UserSessionId, token: string) => token === 'csrf'),
    }
    const cookie = '__Host-candy-session=bearer; __Host-candy-csrf=csrf'
    expect(authenticateOAuthHttpRequest(store, { method: 'GET', cookie, csrfHeader: undefined }, NOW))
      .toBe(result.record)
    expect(authenticateOAuthHttpRequest(store, { method: 'POST', cookie, csrfHeader: 'csrf' }, NOW))
      .toBe(result.record)
    expect(authenticateOAuthHttpRequest(store, { method: 'POST', cookie, csrfHeader: 'wrong' }, NOW))
      .toBeUndefined()
    expect(authenticateOAuthHttpRequest(store, {
      method: 'DELETE', cookie: '__Host-candy-session=forged; __Host-candy-csrf=csrf', csrfHeader: 'csrf',
    }, NOW)).toBeUndefined()
  })
})

type WebRoute = Parameters<OAuthWebServer['register']>[0]

function routeHarness(): {
  readonly server: OAuthWebServer
  readonly routes: Map<string, WebRoute>
  readonly removed: string[]
} {
  const routes = new Map<string, WebRoute>()
  const removed: string[] = []
  return {
    routes,
    removed,
    server: {
      register(route) {
        if (routes.has(route.path)) throw new Error('duplicate route')
        routes.set(route.path, route)
        return () => { routes.delete(route.path); removed.push(route.path) }
      },
    },
  }
}

async function invoke(
  route: WebRoute,
  input: { readonly method?: string; readonly url?: string; readonly headers?: Record<string, string> } = {},
): Promise<{ readonly status: number; readonly headers: Record<string, string | readonly string[]>; readonly body: string | undefined }> {
  let status = 0
  let responseHeaders: Record<string, string | readonly string[]> = {}
  let body: string | undefined
  const request = {
    method: input.method ?? 'GET',
    url: input.url ?? route.path,
    headers: { host: 'candy.example', ...input.headers },
  }
  const response = {
    writeHead(nextStatus: number, headers: Record<string, string | readonly string[]>) {
      status = nextStatus
      responseHeaders = headers
      return this
    },
    end(value?: string) { body = value; return this },
  }
  await route.handler(request as never, response as never)
  return { status, headers: responseHeaders, body }
}

function webStore(): OAuthWebStore {
  const record = {
    id: UserSessionId('session-web'),
    userId: UserId('alice'),
    role: 'member' as const,
    identity: { issuer: 'https://issuer.example', subject: 'external-alice' },
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    revokedAt: undefined,
  }
  return {
    beginOAuthAttempt: vi.fn(async () => ({ state: 'opaque-state', codeChallenge: 'pkce-challenge' })),
    consumeOAuthAttempt: vi.fn(async state => state === 'opaque-state' ? {
      codeVerifier: 'pkce-verifier',
      issuer: 'https://issuer.example',
      redirectUri: 'https://candy.example/auth/oauth/callback',
    } : undefined),
    resolve: vi.fn(async () => ({ userId: UserId('alice'), role: 'member' as const })),
    createUserSession: vi.fn(async (_userId, _role, _identity, createdAt, expiresAt) => ({
      token: 'web-bearer',
      csrfToken: 'web-csrf',
      record: { ...record, createdAt, expiresAt },
    })),
    authenticateUserSession: vi.fn(token => token === 'web-bearer' ? record : undefined),
    verifyUserSessionCsrf: vi.fn((_id, csrf) => csrf === 'web-csrf'),
    revokeUserSession: vi.fn(async () => true),
  }
}

function webProvider(
  authorizationUrl?: OAuthWebProvider['authorizationUrl'],
): OAuthWebProvider {
  return {
    issuer: 'https://issuer.example',
    authorizationUrl: authorizationUrl ?? ((input) => {
      const url = new URL('https://issuer.example/authorize')
      url.searchParams.set('state', input.state)
      url.searchParams.set('code_challenge', input.codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('redirect_uri', input.redirectUri)
      return url
    }),
    exchangeCode: vi.fn(async () => ({ issuer: 'https://issuer.example', subject: 'external-alice' })),
  }
}

describe('OAuth Host Web routes', () => {
  it('starts a server-owned PKCE flow and removes all routes together', async () => {
    const harness = routeHarness()
    const storage = webStore()
    const dispose = registerOAuthHttpRoutes(harness.server, storage, webProvider(), {
      publicOrigin: 'https://candy.example',
      attemptTtlMs: 60_000,
    })

    expect([...harness.routes.keys()]).toEqual([
      OAUTH_START_PATH, OAUTH_CALLBACK_PATH, OAUTH_SESSION_PATH, OAUTH_LOGOUT_PATH,
    ])
    const result = await invoke(harness.routes.get(OAUTH_START_PATH) as WebRoute)
    expect(result.status).toBe(303)
    const location = new URL(result.headers['location'] as string)
    expect(location.searchParams.get('state')).toBe('opaque-state')
    expect(location.searchParams.get('code_challenge')).toBe('pkce-challenge')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('redirect_uri')).toBe('https://candy.example/auth/oauth/callback')
    expect(storage.beginOAuthAttempt).toHaveBeenCalledWith(
      'https://issuer.example',
      'https://candy.example/auth/oauth/callback',
      expect.any(Number),
      expect.any(Number),
    )

    dispose()
    expect(harness.routes.size).toBe(0)
    expect(harness.removed).toEqual([
      OAUTH_LOGOUT_PATH, OAUTH_SESSION_PATH, OAUTH_CALLBACK_PATH, OAUTH_START_PATH,
    ])
  })

  it('completes login, reads the server-derived session, and revokes it on logout', async () => {
    const harness = routeHarness()
    const storage = webStore()
    registerOAuthHttpRoutes(harness.server, storage, webProvider(), {
      publicOrigin: 'https://candy.example',
      successPath: '/app',
      sessionTtlMs: 60_000,
    })

    const callback = await invoke(harness.routes.get(OAUTH_CALLBACK_PATH) as WebRoute, {
      url: `${OAUTH_CALLBACK_PATH}?state=opaque-state&code=authorization-code`,
    })
    expect(callback).toMatchObject({ status: 303, body: undefined })
    expect(callback.headers['location']).toBe('/app')
    expect(callback.headers['set-cookie']).toEqual([
      expect.stringContaining('__Host-candy-session=web-bearer'),
      expect.stringContaining('__Host-candy-csrf=web-csrf'),
    ])

    const cookie = '__Host-candy-session=web-bearer; __Host-candy-csrf=web-csrf'
    const session = await invoke(harness.routes.get(OAUTH_SESSION_PATH) as WebRoute, {
      headers: { cookie },
    })
    expect(session.status).toBe(200)
    expect(JSON.parse(session.body as string)).toMatchObject({ userId: 'alice', role: 'member' })

    const crossOrigin = await invoke(harness.routes.get(OAUTH_LOGOUT_PATH) as WebRoute, {
      method: 'POST',
      headers: { cookie, origin: 'https://attacker.example', [OAUTH_CSRF_HEADER]: 'web-csrf' },
    })
    expect(crossOrigin.status).toBe(403)
    expect(storage.revokeUserSession).not.toHaveBeenCalled()

    const nonOriginValue = await invoke(harness.routes.get(OAUTH_LOGOUT_PATH) as WebRoute, {
      method: 'POST',
      headers: { cookie, origin: 'https://candy.example/path', [OAUTH_CSRF_HEADER]: 'web-csrf' },
    })
    expect(nonOriginValue.status).toBe(403)

    const logout = await invoke(harness.routes.get(OAUTH_LOGOUT_PATH) as WebRoute, {
      method: 'POST',
      headers: { cookie, origin: 'https://candy.example', [OAUTH_CSRF_HEADER]: 'web-csrf' },
    })
    expect(logout.status).toBe(204)
    expect(storage.revokeUserSession).toHaveBeenCalledWith(UserSessionId('session-web'), expect.any(Number))
    expect(logout.headers['set-cookie']).toEqual(clearOAuthSessionCookies())
  })

  it('keeps cookies when durable logout fails', async () => {
    const harness = routeHarness()
    const storage = webStore()
    Object.assign(storage, {
      revokeUserSession: vi.fn(async () => { throw new Error('storage unavailable') }),
    })
    registerOAuthHttpRoutes(harness.server, storage, webProvider(), {
      publicOrigin: 'https://candy.example',
    })
    const logout = await invoke(harness.routes.get(OAUTH_LOGOUT_PATH) as WebRoute, {
      method: 'POST',
      headers: {
        cookie: '__Host-candy-session=web-bearer; __Host-candy-csrf=web-csrf',
        origin: 'https://candy.example',
        [OAUTH_CSRF_HEADER]: 'web-csrf',
      },
    })
    expect(logout.status).toBe(503)
    expect(logout.headers['set-cookie']).toBeUndefined()
  })

  it('closes authority, method, callback, and provider-URL failure paths', async () => {
    const harness = routeHarness()
    const storage = webStore()
    registerOAuthHttpRoutes(harness.server, storage, webProvider(() => 'https://issuer.example/authorize'), {
      publicOrigin: 'https://candy.example',
    })

    expect((await invoke(harness.routes.get(OAUTH_START_PATH) as WebRoute, {
      headers: { host: 'attacker.example' },
    })).status).toBe(403)
    expect((await invoke(harness.routes.get(OAUTH_START_PATH) as WebRoute, { method: 'POST' }))).toMatchObject({
      status: 405,
      headers: expect.objectContaining({ allow: 'GET' }),
    })
    expect((await invoke(harness.routes.get(OAUTH_CALLBACK_PATH) as WebRoute, {
      url: `${OAUTH_CALLBACK_PATH}?state=opaque-state`,
    })).status).toBe(400)
    expect((await invoke(harness.routes.get(OAUTH_START_PATH) as WebRoute)).status).toBe(502)
    expect(storage.consumeOAuthAttempt).not.toHaveBeenCalled()
  })

  it('rejects unsafe deployment origins and redirect destinations', () => {
    const harness = routeHarness()
    const storage = webStore()
    expect(() => registerOAuthHttpRoutes(harness.server, storage, webProvider(), {
      publicOrigin: 'http://candy.example',
    })).toThrow(/publicOrigin/u)
    expect(() => registerOAuthHttpRoutes(harness.server, storage, webProvider(), {
      publicOrigin: 'https://candy.example', successPath: '//attacker.example',
    })).toThrow(/successPath/u)
    expect(() => registerOAuthHttpRoutes(harness.server, storage, webProvider(), {
      publicOrigin: 'http://127.0.0.1:3000',
    })).not.toThrow()
  })
})
