/** OAuth authorization-code completion into a Candy user session. */

import type { ControlPlaneRole, OAuthIdentity, UserId } from '@deepseek-ai/dsh-control-plane'
import type { UserSessionRecord } from '@deepseek-ai/dsh-control-plane-store'

/** Durable operations required by sign-in orchestration. */
export interface OAuthSignInStore {
  consumeOAuthAttempt(state: string, now: number): Promise<{
    readonly codeVerifier: string
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

const SESSION_COOKIE = '__Host-candy-session'
const CSRF_COOKIE = '__Host-candy-csrf'

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
