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
