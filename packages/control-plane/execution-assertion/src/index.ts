/**
 * Short-lived, audience-bound execution assertions: the credential the Candy
 * control plane mints for one run and the Candy runtime admits before it
 * schedules work.
 *
 * {@link admitExecutionAssertion} is the only way to obtain a run's identity.
 * Its {@link ExecutionAssertionExpectation} names deployment facts — issuer,
 * audience, maximum lifetime — and deliberately carries no user, device,
 * account, workspace-grant, conversation, session, or run field, so no caller
 * can supply one. Tenant and account identity leaves this module only after a
 * signature check, which is how "never accept a client-selected tenant"
 * ([Candy Runtime Boundaries](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/candy-runtime-boundaries.md))
 * is enforced in the operation that makes the decision rather than by
 * convention at each call site.
 *
 * The token is `v1.<base64url payload>.<base64url HMAC-SHA256>`, the format
 * `dsh-client-connection`'s browser-session cookie already uses. The MAC
 * covers the received payload text, so admission never re-serializes a decoded
 * object and key order cannot change what was signed.
 *
 * @module @deepseek-ai/dsh-execution-assertion
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
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

/** Token prefix; a future claim-set change mints `v2` rather than reinterpreting `v1`. */
const TOKEN_VERSION = 'v1'

/** Shortest HMAC key this module accepts, matching the 32 random bytes `dsh-client-connection` stores. */
const MINIMUM_SECRET_BYTES = 32

/**
 * The claim set the control plane signs for one run.
 *
 * Every identity field is the control plane's answer, not a request input.
 * `parentRunId` is `undefined` for a root run; a child run names the run that
 * scheduled it, and the orchestration authorization check — not this module —
 * decides whether that child's grants stay within its parent's.
 */
export interface ExecutionAssertionClaims {
  /** Control plane that minted this assertion. */
  readonly issuer: string
  /** Candy runtime this assertion is bound to; any other runtime rejects it. */
  readonly audience: string
  /** Tenant the run executes for. */
  readonly userId: UserId
  /** Paired device the run was requested from. */
  readonly deviceId: DeviceId
  /** Provider account whose credentials the run may use. */
  readonly accountId: ProviderAccountId
  /** Workspace grant bounding the run's filesystem authority. */
  readonly workspaceGrantId: WorkspaceGrantId
  /** Tenant-visible conversation the run belongs to. */
  readonly conversationId: ConversationId
  /** Harness session the run appends its events to. */
  readonly sessionId: SessionId
  /** The run this assertion admits. */
  readonly runId: RunId
  /** The run that scheduled this one, or `undefined` for a root run. */
  readonly parentRunId: RunId | undefined
  /** Single-use value the scheduler's replay store records; see this package's README. */
  readonly nonce: string
  /** Epoch milliseconds the control plane minted this assertion at. */
  readonly issuedAt: number
  /** Epoch milliseconds this assertion stops being admissible at. */
  readonly expiresAt: number
}

/**
 * Deployment facts one Candy runtime checks every assertion against.
 *
 * This type names no tenant, account, device, workspace grant, conversation,
 * session, or run: those are the assertion's answers, and admitting a caller's
 * copy of them would be the confused-deputy path this module exists to close.
 */
export interface ExecutionAssertionExpectation {
  /** Control plane whose assertions this runtime admits. */
  readonly issuer: string
  /** This runtime's own audience identifier. */
  readonly audience: string
  /** Longest issued-to-expiry span this runtime admits, in milliseconds. */
  readonly maxLifetimeMs: number
}

/**
 * Why an assertion was not admitted. Every value denies the run; they are
 * separated for operator diagnostics, never to let a caller retry differently.
 */
export type ExecutionAssertionRejection =
  /** Not three dot-separated parts, or a part that is not canonical base64url or valid claim JSON. */
  | 'malformed'
  /** A token version this build does not implement. */
  | 'unsupported-version'
  /** The HMAC does not match; the payload is forged, tampered with, or signed by another key. */
  | 'signature'
  /** Minted by a control plane this runtime does not admit. */
  | 'issuer'
  /** Bound to a different runtime. */
  | 'audience'
  /** `issuedAt` is in the future. */
  | 'not-yet-valid'
  /** `expiresAt` has passed. */
  | 'expired'
  /** The issued-to-expiry span exceeds this runtime's maximum, or does not advance. */
  | 'lifetime'

/** The outcome of admitting one assertion: verified claims, or the reason the run is denied. */
export type ExecutionAssertionAdmission =
  | { readonly admitted: true; readonly claims: ExecutionAssertionClaims }
  | { readonly admitted: false; readonly rejection: ExecutionAssertionRejection }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode canonical base64url only: text that re-encodes to something else
 * carried padding, alphabet, or trailing bits that a signed token never has.
 */
function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  const decoded = Buffer.from(value, 'base64url')
  return decoded.toString('base64url') === value ? decoded : undefined
}

function admitSecret(secret: Uint8Array): Buffer {
  if (secret.byteLength < MINIMUM_SECRET_BYTES) {
    throw new RangeError(
      `dsh-execution-assertion: the signing secret must be at least ${String(MINIMUM_SECRET_BYTES)} bytes, got ${String(secret.byteLength)}`,
    )
  }
  return Buffer.from(secret)
}

function sign(secret: Buffer, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest()
}

/** Read one required branded id claim, rejecting an absent or non-string value. */
function stringClaim(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeTimestamp(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Rebuild the claim set from verified payload text.
 * @param payload - JSON text whose HMAC this build already matched.
 * @returns the claims, or undefined when a field is absent or the wrong type.
 */
function decodeClaims(payload: string): ExecutionAssertionClaims | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (_nonJsonPayload) {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const issuer = stringClaim(parsed, 'issuer')
  const audience = stringClaim(parsed, 'audience')
  const userId = stringClaim(parsed, 'userId')
  const deviceId = stringClaim(parsed, 'deviceId')
  const accountId = stringClaim(parsed, 'accountId')
  const workspaceGrantId = stringClaim(parsed, 'workspaceGrantId')
  const conversationId = stringClaim(parsed, 'conversationId')
  const sessionId = stringClaim(parsed, 'sessionId')
  const runId = stringClaim(parsed, 'runId')
  const nonce = stringClaim(parsed, 'nonce')
  const issuedAt = safeTimestamp(parsed, 'issuedAt')
  const expiresAt = safeTimestamp(parsed, 'expiresAt')
  if (issuer === undefined || audience === undefined || userId === undefined
    || deviceId === undefined || accountId === undefined || workspaceGrantId === undefined
    || conversationId === undefined || sessionId === undefined || runId === undefined
    || nonce === undefined || issuedAt === undefined || expiresAt === undefined) return undefined

  const rawParent = parsed.parentRunId
  if (rawParent !== undefined && (typeof rawParent !== 'string' || rawParent.length === 0)) return undefined

  return {
    issuer,
    audience,
    userId: UserId(userId),
    deviceId: DeviceId(deviceId),
    accountId: ProviderAccountId(accountId),
    workspaceGrantId: WorkspaceGrantId(workspaceGrantId),
    conversationId: ConversationId(conversationId),
    sessionId: brandString<SessionId>(sessionId),
    runId: RunId(runId),
    parentRunId: rawParent === undefined ? undefined : RunId(rawParent),
    nonce,
    issuedAt,
    expiresAt,
  }
}

/**
 * Mint one signed execution assertion.
 *
 * The caller owns the claim values: this module signs what the control plane
 * decided and never derives identity of its own.
 *
 * @param claims - the control plane's decision for one run.
 * @param secret - HMAC key of at least 32 bytes, shared with the admitting runtime.
 * @returns the `v1.<payload>.<signature>` token.
 * @throws RangeError when the secret is shorter than 32 bytes.
 */
export function mintExecutionAssertion(claims: ExecutionAssertionClaims, secret: Uint8Array): string {
  const key = admitSecret(secret)
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `${TOKEN_VERSION}.${payload}.${sign(key, payload).toString('base64url')}`
}

/**
 * Admit one execution assertion, returning the run identity it carries.
 *
 * Checks run in order: token structure, version, signature, claim shape,
 * issuer, audience, lifetime, then the clock. The signature is checked before
 * any claim is read, so a forged payload never reaches a comparison that could
 * disclose its content through timing or diagnostics.
 *
 * Admission does not consume the nonce. A caller that must block replay within
 * an assertion's lifetime records `claims.nonce` in its own replay store; this
 * module binds the nonce into the signature and returns it, and owns nothing
 * durable.
 *
 * @param token - the minted token, exactly as received.
 * @param secret - HMAC key of at least 32 bytes, shared with the minting control plane.
 * @param expectation - this runtime's issuer, audience, and maximum assertion lifetime.
 * @param now - current epoch milliseconds, supplied by the caller's clock.
 * @returns the verified claims, or the first rejection that denies the run.
 * @throws RangeError when the secret is shorter than 32 bytes.
 */
export function admitExecutionAssertion(
  token: string,
  secret: Uint8Array,
  expectation: ExecutionAssertionExpectation,
  now: number,
): ExecutionAssertionAdmission {
  const key = admitSecret(secret)
  const parts = token.split('.')
  const [version, payload, encodedSignature] = parts
  if (parts.length !== 3 || payload === undefined || encodedSignature === undefined
    || version === undefined) {
    return { admitted: false, rejection: 'malformed' }
  }
  if (version !== TOKEN_VERSION) return { admitted: false, rejection: 'unsupported-version' }

  const actual = decodeCanonicalBase64Url(encodedSignature)
  if (actual === undefined) return { admitted: false, rejection: 'malformed' }
  const expected = sign(key, payload)
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    return { admitted: false, rejection: 'signature' }
  }

  const decodedPayload = decodeCanonicalBase64Url(payload)
  if (decodedPayload === undefined) return { admitted: false, rejection: 'malformed' }
  const claims = decodeClaims(decodedPayload.toString('utf8'))
  if (claims === undefined) return { admitted: false, rejection: 'malformed' }

  if (claims.issuer !== expectation.issuer) return { admitted: false, rejection: 'issuer' }
  if (claims.audience !== expectation.audience) return { admitted: false, rejection: 'audience' }
  if (claims.expiresAt <= claims.issuedAt
    || claims.expiresAt - claims.issuedAt > expectation.maxLifetimeMs) {
    return { admitted: false, rejection: 'lifetime' }
  }
  if (claims.issuedAt > now) return { admitted: false, rejection: 'not-yet-valid' }
  if (claims.expiresAt <= now) return { admitted: false, rejection: 'expired' }
  return { admitted: true, claims }
}
