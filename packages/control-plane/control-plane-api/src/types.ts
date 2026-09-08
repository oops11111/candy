/**
 * The vocabulary of one authenticated Candy management request.
 * @module @deepseek-ai/dsh-control-plane-api/src/types
 */

import type { ControlPlaneRole, UserId } from '@deepseek-ai/dsh-control-plane'
import type { UserSessionRecord } from '@deepseek-ai/dsh-control-plane-store'

/**
 * Who is making one management request, derived entirely on the server.
 *
 * There is no constructor for this that takes a tenant: the only way to hold
 * one is to have presented a session cookie the store authenticated. A
 * handler that wants to know whose data it is reads {@link Actor.userId} and
 * has no other option, which is what keeps a request parameter from ever
 * selecting a tenant.
 */
export interface Actor {
  /** The tenant every record this request touches belongs to. */
  readonly userId: UserId
  /** What this person may do, as Candy provisioned it and not as a claim said. */
  readonly role: ControlPlaneRole
  /** The authenticated session, for revocation and audit. */
  readonly session: UserSessionRecord
}

/** Why a management request was refused, before any handler ran. */
export type ApiRejection =
  /** No usable session cookie, or the session is expired or revoked. */
  | 'unauthenticated'
  /** Authenticated, but this role may not perform the operation. */
  | 'forbidden'
  /** The request did not address the configured public origin. */
  | 'untrusted-origin'
  /** A write arrived without a matching CSRF cookie and header. */
  | 'csrf'
  /** The body exceeded this route's cap, and the rest of it was not read. */
  | 'body-too-large'
  /** The method is not one this route serves. */
  | 'method-not-allowed'
  /** The body is not the JSON this route reads. */
  | 'malformed-body'

/**
 * What a handler answers with.
 *
 * `notFound` is the only way to report a record a caller may not have, and it
 * is deliberately indistinguishable from a record that does not exist: an
 * error that separated "another tenant's account" from "no such account"
 * would confirm the id to whoever guessed it.
 */
export type ApiResult =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'empty'; readonly status: number }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'invalid'; readonly reason: string }

/** One recorded management operation, for the tenant-scoped audit trail. */
export interface ApiAuditEvent {
  /** The tenant the record is filed against. */
  readonly userId: UserId
  /** The operation attempted, in this API's own vocabulary. */
  readonly action: string
  /** `ok`, or why it was refused. Never a provider message or a secret. */
  readonly outcome: string
}
