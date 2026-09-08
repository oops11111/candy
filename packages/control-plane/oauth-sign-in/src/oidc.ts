/** Standards-based OIDC provider backed by a verified ID Token and UserInfo. */

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose'
import type { OAuthIdentity } from '@deepseek-ai/dsh-control-plane'
import type { OAuthWebProvider } from './index.ts'

const DEFAULT_SCOPES = ['openid', 'profile'] as const
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const ALLOWED_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'] as const
const ALLOWED_ALGORITHM_SET = new Set<string>(ALLOWED_ALGORITHMS)

/** Fixed OIDC client and verified-key configuration supplied by a deployment. */
export interface OidcUserInfoProviderConfig {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly userInfoEndpoint: string
  readonly clientId: string
  readonly jwks: JSONWebKeySet
  /** Must return the deployment client secret without exposing it in public plugin config. */
  readonly loadClientSecret?: () => Promise<string>
  /** Scope tokens; `openid` is mandatory and added by default. */
  readonly scopes?: readonly string[]
  /** Maximum bytes accepted from token or UserInfo endpoints. @default 65536 */
  readonly maxResponseBytes?: number
  /** Independent network deadline for token and UserInfo requests. @default 15000 */
  readonly timeoutMs?: number
  /** JWT clock tolerance in seconds, also bounding future issued-at. @default 60 */
  readonly clockToleranceSeconds?: number
  /** Asymmetric ID Token algorithms accepted by this deployment. */
  readonly algorithms?: readonly ('RS256' | 'PS256' | 'ES256' | 'EdDSA')[]
  /** Injectable Fetch implementation for deployment policy and deterministic tests. */
  readonly fetch?: typeof globalThis.fetch
}

interface ResolvedConfig {
  readonly issuer: string
  readonly authorizationEndpoint: URL
  readonly tokenEndpoint: URL
  readonly userInfoEndpoint: URL
  readonly clientId: string
  readonly jwks: JSONWebKeySet
  readonly loadClientSecret: (() => Promise<string>) | undefined
  readonly scopes: readonly string[]
  readonly maxResponseBytes: number
  readonly timeoutMs: number
  readonly clockToleranceSeconds: number
  readonly algorithms: readonly string[]
  readonly fetch: typeof globalThis.fetch
}

function httpsUrl(name: string, value: string, allowQuery: boolean): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== ''
    || (!allowQuery && url.search !== '')) {
    throw new Error(`dsh-oauth-sign-in ${name} must be an HTTPS URL without credentials or fragment`)
  }
  return url
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`dsh-oauth-sign-in ${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`dsh-oauth-sign-in ${name} must be a non-negative safe integer`)
  }
  return value
}

function resolveConfig(config: OidcUserInfoProviderConfig): ResolvedConfig {
  httpsUrl('OIDC issuer', config.issuer, false)
  if (config.issuer.trim() !== config.issuer) {
    throw new Error('dsh-oauth-sign-in OIDC issuer must not contain surrounding whitespace')
  }
  if (config.clientId.trim() === '') throw new Error('dsh-oauth-sign-in OIDC clientId must be non-blank')
  const scopes = config.scopes ?? DEFAULT_SCOPES
  if (!scopes.includes('openid') || scopes.length === 0
    || scopes.some(scope => scope === '' || /\s/u.test(scope))
    || new Set(scopes).size !== scopes.length) {
    throw new Error('dsh-oauth-sign-in OIDC scopes must be unique non-blank tokens including openid')
  }
  if (!Array.isArray(config.jwks.keys) || config.jwks.keys.length === 0) {
    throw new Error('dsh-oauth-sign-in OIDC jwks must contain at least one verification key')
  }
  const algorithms = config.algorithms ?? ALLOWED_ALGORITHMS
  if (algorithms.length === 0 || new Set(algorithms).size !== algorithms.length
    || algorithms.some(algorithm => !ALLOWED_ALGORITHM_SET.has(algorithm))) {
    throw new Error('dsh-oauth-sign-in OIDC algorithms must contain unique asymmetric algorithms')
  }
  return {
    issuer: config.issuer,
    authorizationEndpoint: httpsUrl('OIDC authorizationEndpoint', config.authorizationEndpoint, true),
    tokenEndpoint: httpsUrl('OIDC tokenEndpoint', config.tokenEndpoint, true),
    userInfoEndpoint: httpsUrl('OIDC userInfoEndpoint', config.userInfoEndpoint, true),
    clientId: config.clientId,
    jwks: config.jwks,
    loadClientSecret: config.loadClientSecret,
    scopes: [...scopes],
    maxResponseBytes: positiveSafeInteger(
      'OIDC maxResponseBytes', config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    ),
    timeoutMs: positiveSafeInteger('OIDC timeoutMs', config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    clockToleranceSeconds: nonNegativeSafeInteger(
      'OIDC clockToleranceSeconds', config.clockToleranceSeconds ?? 60,
    ),
    algorithms: [...algorithms],
    fetch: config.fetch ?? globalThis.fetch,
  }
}

function combinedSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout])
}

async function boundedJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') throw new Error('OIDC endpoint response was not JSON')
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('OIDC endpoint response had no body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error('OIDC endpoint response exceeded its byte limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = Buffer.concat(chunks, size).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('OIDC endpoint response was invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('OIDC endpoint response was not an object')
  }
  return parsed as Record<string, unknown>
}

function basicCredential(value: string): string {
  return new URLSearchParams({ value }).toString().slice('value='.length)
}

function validRequiredClaims(
  payload: JWTPayload,
  clientId: string,
  nonce: string,
  clockToleranceSeconds: number,
): payload is JWTPayload & {
  readonly sub: string
  readonly exp: number
  readonly iat: number
} {
  if (typeof payload.sub !== 'string' || payload.sub.trim() === ''
    || typeof payload.exp !== 'number' || typeof payload.iat !== 'number'
    || payload.exp <= payload.iat
    || payload.iat > Math.floor(Date.now() / 1000) + clockToleranceSeconds
    || payload.nonce !== nonce) return false
  if ((payload.azp !== undefined && payload.azp !== clientId)
    || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) return false
  return true
}

/**
 * Build one OIDC Authorization Code + PKCE provider.
 *
 * ID Token verification is local against deployment-supplied JWKs. UserInfo
 * is then fetched with the access token and its subject must match the ID
 * Token, closing the token-substitution boundary before Candy sees identity.
 */
export function createOidcUserInfoProvider(config: OidcUserInfoProviderConfig): OAuthWebProvider {
  const resolved = resolveConfig(config)
  const verifyKey = createLocalJWKSet(resolved.jwks)
  return {
    issuer: resolved.issuer,
    authorizationUrl(input) {
      const url = new URL(resolved.authorizationEndpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', resolved.clientId)
      url.searchParams.set('scope', resolved.scopes.join(' '))
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('state', input.state)
      url.searchParams.set('code_challenge', input.codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('nonce', input.nonce)
      return url
    },
    async exchangeCode(request): Promise<OAuthIdentity> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: request.code,
        redirect_uri: request.redirectUri,
        code_verifier: request.codeVerifier,
      })
      const headers = new Headers({
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      })
      if (resolved.loadClientSecret === undefined) {
        body.set('client_id', resolved.clientId)
      } else {
        const secret = await resolved.loadClientSecret()
        if (secret === '') throw new Error('OIDC client secret was empty')
        headers.set(
          'authorization',
          `Basic ${Buffer.from(`${basicCredential(resolved.clientId)}:${basicCredential(secret)}`, 'utf8').toString('base64')}`,
        )
      }
      const tokenResponse = await resolved.fetch(resolved.tokenEndpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: combinedSignal(request.signal, resolved.timeoutMs),
      })
      if (!tokenResponse.ok) throw new Error('OIDC token endpoint refused the code')
      const token = await boundedJson(tokenResponse, resolved.maxResponseBytes)
      const accessToken = token['access_token']
      const idToken = token['id_token']
      const tokenType = token['token_type']
      if (typeof accessToken !== 'string' || accessToken.trim() === ''
        || typeof idToken !== 'string' || idToken.trim() === ''
        || typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
        throw new Error('OIDC token response omitted required credentials')
      }
      const verified = await jwtVerify(idToken, verifyKey, {
        issuer: resolved.issuer,
        audience: resolved.clientId,
        algorithms: [...resolved.algorithms],
        clockTolerance: resolved.clockToleranceSeconds,
      })
      if (!validRequiredClaims(
        verified.payload,
        resolved.clientId,
        request.nonce,
        resolved.clockToleranceSeconds,
      )) {
        throw new Error('OIDC ID Token omitted or mismatched required claims')
      }
      const userInfoResponse = await resolved.fetch(resolved.userInfoEndpoint, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
        redirect: 'error',
        signal: combinedSignal(request.signal, resolved.timeoutMs),
      })
      if (!userInfoResponse.ok) throw new Error('OIDC UserInfo endpoint refused the token')
      const userInfo = await boundedJson(userInfoResponse, resolved.maxResponseBytes)
      if ((userInfo['iss'] !== undefined && userInfo['iss'] !== resolved.issuer)
        || userInfo['sub'] !== verified.payload.sub) {
        throw new Error('OIDC UserInfo subject did not match the verified ID Token')
      }
      return { issuer: resolved.issuer, subject: verified.payload.sub }
    },
  }
}
