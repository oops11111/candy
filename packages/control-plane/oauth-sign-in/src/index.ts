/** OAuth authorization-code completion into a Candy user session. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ControlPlaneRole, OAuthIdentity, UserId } from '@deepseek-ai/dsh-control-plane'
import type { UserSessionRecord } from '@deepseek-ai/dsh-control-plane-store'

/** Durable operations required by sign-in orchestration. */
export interface OAuthSignInStore {
  consumeOAuthAttempt(state: string, now: number): Promise<{
    readonly codeVerifier: string
    readonly nonce: string
    readonly issuer: string
    readonly redirectUri: string
  } | undefined>
  createUserSession(
    userId: UserId,
    role: ControlPlaneRole,
    identity: OAuthIdentity,
    createdAt: number,
    expiresAt: number,
  ): Promise<OAuthSignInResult>
}

/** Provider implementation selected by a deployment, never by callback input. */
export interface OAuthCodeProvider {
  readonly issuer: string
  /** Exchange and verify one code with the server-retained PKCE transaction. */
  exchangeCode(request: {
    readonly code: string
    readonly codeVerifier: string
    readonly nonce: string
    readonly redirectUri: string
    readonly signal?: AbortSignal
  }): Promise<OAuthIdentity>
}

/** Candy-owned mapping from a verified external identity to authorization. */
export interface OAuthIdentityDirectory {
  /** Resolve an identity without accepting a browser-selected user or role. */
  resolve(identity: OAuthIdentity): Promise<{
    readonly userId: UserId
    readonly role: ControlPlaneRole
  } | undefined>
}

/** Successful callback output whose secrets must be placed into secure cookies. */
export interface OAuthSignInResult {
  readonly token: string
  readonly csrfToken: string
  readonly record: UserSessionRecord
}

/** Minimal session reader required by an HTTP transport. */
export interface OAuthHttpSessionStore {
  authenticateUserSession(token: string, now: number): UserSessionRecord | undefined
  verifyUserSessionCsrf(id: UserSessionRecord['id'], csrfToken: string): boolean
}

/** Headers relevant to Candy session authentication. */
export interface OAuthHttpRequest {
  readonly method: string
  readonly cookie: string | undefined
  readonly csrfHeader: string | undefined
}

/** Provider capabilities required by the browser authorization routes. */
export interface OAuthWebProvider extends OAuthCodeProvider {
  /** Build the authorization endpoint URL from server-created PKCE inputs. */
  authorizationUrl(input: {
    readonly state: string
    readonly codeChallenge: string
    readonly nonce: string
    readonly redirectUri: string
  }): string | URL | Promise<string | URL>
}

/** Durable authority required by the browser authorization routes. */
export interface OAuthWebStore extends OAuthSignInStore, OAuthHttpSessionStore, OAuthIdentityDirectory {
  beginOAuthAttempt(
    issuer: string,
    redirectUri: string,
    now: number,
    expiresAt: number,
  ): Promise<{ readonly state: string; readonly codeChallenge: string; readonly nonce: string }>
  revokeUserSession(id: UserSessionRecord['id'], revokedAt: number): Promise<boolean>
}

/** Small structural surface implemented by `dsh-host-webserver`. */
export interface OAuthWebServer {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Deployment-owned browser authorization policy. */
export interface OAuthWebConfig {
  /** Exact externally visible origin. HTTPS is required except for loopback development. */
  readonly publicOrigin: string
  /** Relative destination after a successful callback. @default '/' */
  readonly successPath?: string
  /** PKCE transaction lifetime. @default 300000 */
  readonly attemptTtlMs?: number
  /** Browser user-session lifetime. @default 2592000000 */
  readonly sessionTtlMs?: number
}

export const OAUTH_START_PATH = '/auth/oauth/start'
export const OAUTH_CALLBACK_PATH = '/auth/oauth/callback'
export const OAUTH_SESSION_PATH = '/auth/session'
export const OAUTH_LOGOUT_PATH = '/auth/logout'
export const OAUTH_CSRF_HEADER = 'x-candy-csrf'

const DEFAULT_ATTEMPT_TTL_MS = 5 * 60 * 1000
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const SESSION_COOKIE = '__Host-candy-session'
const CSRF_COOKIE = '__Host-candy-csrf'

interface ResolvedOAuthWebConfig {
  readonly publicOrigin: string
  readonly authority: string
  readonly callbackUri: string
  readonly successPath: string
  readonly attemptTtlMs: number
  readonly sessionTtlMs: number
}

function resolveWebConfig(config: OAuthWebConfig): ResolvedOAuthWebConfig {
  const origin = new URL(config.publicOrigin)
  const loopback = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]'
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))
    || origin.username !== '' || origin.password !== '' || origin.pathname !== '/'
    || origin.search !== '' || origin.hash !== '') {
    throw new Error('dsh-oauth-sign-in publicOrigin must be an HTTPS origin (or HTTP loopback) without credentials, path, query, or fragment')
  }
  const successPath = config.successPath ?? '/'
  if (!successPath.startsWith('/') || successPath.startsWith('//') || successPath.includes('\\')
    || successPath.includes('?') || successPath.includes('#')) {
    throw new Error('dsh-oauth-sign-in successPath must be a same-origin absolute path without query or fragment')
  }
  const attemptTtlMs = config.attemptTtlMs ?? DEFAULT_ATTEMPT_TTL_MS
  const sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  for (const [name, value] of [['attemptTtlMs', attemptTtlMs], ['sessionTtlMs', sessionTtlMs]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`dsh-oauth-sign-in ${name} must be a positive safe integer`)
    }
  }
  return {
    publicOrigin: origin.origin,
    authority: origin.host,
    callbackUri: `${origin.origin}${OAUTH_CALLBACK_PATH}`,
    successPath,
    attemptTtlMs,
    sessionTtlMs,
  }
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? undefined : value
}

function baseHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }
}

function reply(
  response: ServerResponse,
  status: number,
  body?: string,
  headers: Record<string, string | readonly string[]> = {},
): void {
  response.writeHead(status, {
    ...baseHeaders(),
    ...(body === undefined ? {} : { 'content-type': 'text/plain; charset=utf-8' }),
    ...headers,
  })
  response.end(body)
}

function trustedAuthority(request: IncomingMessage, config: ResolvedOAuthWebConfig): boolean {
  const host = requestHeader(request, 'host')
  if (host === undefined) return false
  try {
    return new URL(`http://${host}`).host.toLowerCase() === config.authority.toLowerCase()
  } catch {
    return false
  }
}

function callbackInput(request: IncomingMessage, config: ResolvedOAuthWebConfig): {
  readonly state: string
  readonly code: string
} | undefined {
  const url = new URL(request.url ?? OAUTH_CALLBACK_PATH, config.publicOrigin)
  const states = url.searchParams.getAll('state')
  const codes = url.searchParams.getAll('code')
  if (states.length !== 1 || codes.length !== 1 || states[0]?.trim() === '' || codes[0]?.trim() === '') {
    return undefined
  }
  return { state: states[0] as string, code: codes[0] as string }
}

function verifiedAuthorizationLocation(
  value: string | URL,
  expected: {
    readonly state: string
    readonly codeChallenge: string
    readonly nonce: string
    readonly redirectUri: string
  },
): string {
  const url = new URL(String(value))
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('OAuth authorization endpoint must be an HTTPS URL without credentials or fragment')
  }
  const exact = (name: string, expectedValue: string): boolean => {
    const values = url.searchParams.getAll(name)
    return values.length === 1 && values[0] === expectedValue
  }
  if (!exact('state', expected.state)
    || !exact('code_challenge', expected.codeChallenge)
    || !exact('code_challenge_method', 'S256')
    || !exact('redirect_uri', expected.redirectUri)
    || !exact('nonce', expected.nonce)) {
    throw new Error('OAuth authorization URL did not retain the server-created PKCE inputs')
  }
  return url.href
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at !== -1 && segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Serialize the two cookies created by a successful OAuth callback.
 * @param result - session bearer and independent CSRF token.
 * @param now - response time used to derive a non-negative Max-Age.
 * @returns authentication and CSRF Set-Cookie values, in that order.
 */
export function oauthSessionCookies(result: OAuthSignInResult, now: number): readonly [string, string] {
  const maxAge = Math.max(0, Math.floor((result.record.expiresAt - now) / 1000))
  const expires = new Date(result.record.expiresAt).toUTCString()
  return [
    `${SESSION_COOKIE}=${result.token}; Max-Age=${String(maxAge)}; Path=/; Expires=${expires}; Secure; HttpOnly; SameSite=Lax`,
    `${CSRF_COOKIE}=${result.csrfToken}; Max-Age=${String(maxAge)}; Path=/; Expires=${expires}; Secure; SameSite=Strict`,
  ]
}

/** Cookies that remove both browser credentials during logout. */
export function clearOAuthSessionCookies(): readonly [string, string] {
  return [
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
    `${CSRF_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Strict`,
  ]
}

/**
 * Authenticate one HTTP request and enforce CSRF on unsafe methods.
 * @param store - durable session and CSRF verifier.
 * @param request - method and exact Cookie/header values from the HTTP owner.
 * @param now - request receipt time.
 * @returns server-derived user session, or undefined when authentication or CSRF fails.
 */
export function authenticateOAuthHttpRequest(
  store: OAuthHttpSessionStore,
  request: OAuthHttpRequest,
  now: number,
): UserSessionRecord | undefined {
  const bearer = cookieValue(request.cookie, SESSION_COOKIE)
  if (bearer === undefined) return undefined
  const session = store.authenticateUserSession(bearer, now)
  if (session === undefined) return undefined
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return session
  const csrfCookie = cookieValue(request.cookie, CSRF_COOKIE)
  if (csrfCookie === undefined || request.csrfHeader === undefined || csrfCookie !== request.csrfHeader) return undefined
  return store.verifyUserSessionCsrf(session.id, csrfCookie) ? session : undefined
}

/**
 * Register the public OAuth entry points on the Host WebServer.
 *
 * These routes deliberately do not use the inherited `/api` carrier: that
 * carrier requires a process launch token, while OAuth is what establishes a
 * Candy user identity for a remote browser. Every request is instead pinned
 * to the configured public authority. The callback accepts only the
 * server-created PKCE state, and logout requires both exact Origin and CSRF.
 *
 * @param server - Harness Host route registry.
 * @param store - durable PKCE, identity, session, and revocation authority.
 * @param provider - deployment-selected authorization and code verifier.
 * @param config - fixed external origin and lifetimes.
 * @returns one disposer that removes all four routes.
 */
export function registerOAuthHttpRoutes(
  server: OAuthWebServer,
  store: OAuthWebStore,
  provider: OAuthWebProvider,
  config: OAuthWebConfig,
): () => void {
  const resolved = resolveWebConfig(config)
  const disposers: (() => void)[] = []
  const register = (
    path: string,
    methods: readonly string[],
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
  ): void => {
    disposers.push(server.register({
      kind: 'exact',
      path,
      handler: async (request, response) => {
        if (!trustedAuthority(request, resolved)) {
          reply(response, 403, 'forbidden')
          return
        }
        if (!methods.includes(request.method ?? 'GET')) {
          reply(response, 405, 'method not allowed', { allow: methods.join(', ') })
          return
        }
        await handler(request, response)
      },
    }))
  }

  try {
    register(OAUTH_START_PATH, ['GET'], async (_request, response) => {
      const now = Date.now()
      let attempt: Awaited<ReturnType<OAuthWebStore['beginOAuthAttempt']>>
      try {
        attempt = await store.beginOAuthAttempt(
          provider.issuer,
          resolved.callbackUri,
          now,
          now + resolved.attemptTtlMs,
        )
      } catch {
        reply(response, 503, 'sign-in temporarily unavailable')
        return
      }
      try {
        const input = {
          state: attempt.state,
          codeChallenge: attempt.codeChallenge,
          nonce: attempt.nonce,
          redirectUri: resolved.callbackUri,
        }
        const location = verifiedAuthorizationLocation(await provider.authorizationUrl(input), input)
        reply(response, 303, undefined, { location })
      } catch {
        // The attempt remains harmless until its short expiry. There is no
        // portable delete primitive, and the callback still needs its secret state.
        reply(response, 502, 'OAuth provider configuration is invalid')
      }
    })

    register(OAUTH_CALLBACK_PATH, ['GET'], async (request, response) => {
      const input = callbackInput(request, resolved)
      if (input === undefined) {
        reply(response, 400, 'invalid OAuth callback')
        return
      }
      const now = Date.now()
      let result: OAuthSignInResult | undefined
      try {
        result = await completeOAuthSignIn(store, provider, store, {
          ...input,
          now,
          sessionExpiresAt: now + resolved.sessionTtlMs,
        })
      } catch {
        reply(response, 502, 'OAuth provider exchange failed')
        return
      }
      if (result === undefined) {
        reply(response, 401, 'sign-in denied')
        return
      }
      reply(response, 303, undefined, {
        location: resolved.successPath,
        'set-cookie': oauthSessionCookies(result, now),
      })
    })

    register(OAUTH_SESSION_PATH, ['GET'], (request, response) => {
      const session = authenticateOAuthHttpRequest(store, {
        method: 'GET',
        cookie: requestHeader(request, 'cookie'),
        csrfHeader: undefined,
      }, Date.now())
      if (session === undefined) {
        reply(response, 401, 'unauthorized')
        return
      }
      const body = JSON.stringify({
        userId: session.userId,
        role: session.role,
        expiresAt: session.expiresAt,
      })
      reply(response, 200, body, { 'content-type': 'application/json; charset=utf-8' })
    })

    register(OAUTH_LOGOUT_PATH, ['POST'], async (request, response) => {
      const origin = requestHeader(request, 'origin')
      if (origin !== resolved.publicOrigin) {
        reply(response, 403, 'forbidden')
        return
      }
      const session = authenticateOAuthHttpRequest(store, {
        method: 'POST',
        cookie: requestHeader(request, 'cookie'),
        csrfHeader: requestHeader(request, OAUTH_CSRF_HEADER),
      }, Date.now())
      if (session === undefined) {
        reply(response, 401, 'unauthorized')
        return
      }
      try {
        await store.revokeUserSession(session.id, Date.now())
      } catch {
        reply(response, 503, 'logout temporarily unavailable')
        return
      }
      reply(response, 204, undefined, { 'set-cookie': clearOAuthSessionCookies() })
    })
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Complete one OAuth callback and create a revocable Candy user session.
 *
 * The PKCE attempt is consumed before external exchange, so failures cannot be
 * retried with the same state. The configured provider must match both the
 * stored issuer and the verified identity issuer. Candy authorization comes
 * only from the directory.
 *
 * @param store - durable PKCE and user-session owner.
 * @param provider - deployment-selected code exchanger and identity verifier.
 * @param directory - Candy identity-to-user authorization mapping.
 * @param input - untrusted callback code/state plus server timing and lifetime.
 * @returns a session, or undefined for invalid state, issuer mismatch, or an unenrolled identity.
 */
export async function completeOAuthSignIn(
  store: OAuthSignInStore,
  provider: OAuthCodeProvider,
  directory: OAuthIdentityDirectory,
  input: {
    readonly state: string
    readonly code: string
    readonly now: number
    readonly sessionExpiresAt: number
    readonly signal?: AbortSignal
  },
): Promise<OAuthSignInResult | undefined> {
  if (input.code.trim() === '') return undefined
  const attempt = await store.consumeOAuthAttempt(input.state, input.now)
  if (attempt === undefined || attempt.issuer !== provider.issuer) return undefined
  const identity = await provider.exchangeCode({
    code: input.code,
    codeVerifier: attempt.codeVerifier,
    nonce: attempt.nonce,
    redirectUri: attempt.redirectUri,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (identity.issuer !== attempt.issuer || identity.subject.trim() === '') return undefined
  const authorization = await directory.resolve(identity)
  if (authorization === undefined) return undefined
  return store.createUserSession(
    authorization.userId,
    authorization.role,
    identity,
    input.now,
    input.sessionExpiresAt,
  )
}
