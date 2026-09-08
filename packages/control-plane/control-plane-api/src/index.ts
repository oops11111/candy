/**
 * The authenticated envelope every Candy management route is registered
 * through.
 *
 * Candy's management operations decide who owns a provider account, which
 * routes a tenant may call, and which workspace a device granted. None of
 * those may be driven by anything a caller supplies. The Harness Host access
 * token authorizes a process, not a person; a `userId` in a path or a body is
 * the caller's own claim. This module is the one place a request becomes an
 * {@link Actor}, and the only way to obtain one is to have presented a session
 * cookie the store authenticated.
 *
 * It also owns the failure vocabulary, because the failures are where a
 * management API leaks. A record belonging to another tenant answers exactly
 * as a record that does not exist; a refusal names the step and never the
 * token, code, key or provider response that produced it.
 *
 * @module @deepseek-ai/dsh-control-plane-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ControlPlaneRole } from '@deepseek-ai/dsh-control-plane'
import {
  authenticateOAuthHttpRequest,
  OAUTH_CSRF_HEADER,
  type OAuthHttpSessionStore,
} from '@deepseek-ai/dsh-oauth-sign-in'
import type { Actor, ApiAuditEvent, ApiRejection, ApiResult } from './types.ts'

export type { Actor, ApiAuditEvent, ApiRejection, ApiResult } from './types.ts'

/** Largest request body any management route accepts unless it lowers the cap. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024

/** The route registry `dsh-host-webserver` implements. */
export interface ApiWebServer {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** What every management route shares, supplied once by the mounting plugin. */
export interface ApiHost {
  /** Exact externally visible origin; a request addressing any other is refused. */
  readonly publicOrigin: string
  /** Session and CSRF authority; the same one browser sign-in wrote. */
  readonly sessions: OAuthHttpSessionStore
  /**
   * Record one management operation against its tenant.
   *
   * The envelope calls it for refusals it decides itself, so an operator sees
   * a rejected write even when no handler ran. It never rejects the request:
   * a trail that cannot take a record must not turn a completed operation
   * into a failure.
   */
  readonly audit: (event: ApiAuditEvent) => Promise<void>
  /** Reports a refusal the envelope decided, for the deployment's own log. */
  readonly log?: (rejection: ApiRejection, path: string) => void
}

/** One management route's own policy and handler. */
export interface ApiRoute {
  /** Absolute pathname, no trailing slash. */
  readonly path: string
  /** Methods this route serves; anything else is refused before authentication. */
  readonly methods: readonly string[]
  /** Least role that may reach the handler. */
  readonly role: ControlPlaneRole
  /** This route's own body cap. @default DEFAULT_MAX_BODY_BYTES */
  readonly maxBodyBytes?: number
  /** The operation name recorded in the audit trail. */
  readonly action: string
  /**
   * The operation, run only for an authenticated actor of sufficient role.
   * @param actor - who is making the request, derived on the server.
   * @param body - the parsed JSON body, or `undefined` for a bodyless method.
   * @param request - the raw request, for a route that reads its own query.
   */
  readonly handle: (
    actor: Actor,
    body: unknown,
    request: IncomingMessage,
  ) => ApiResult | Promise<ApiResult>
}

/** Status and text for each refusal the envelope decides. */
const REJECTIONS: Readonly<Record<ApiRejection, { readonly status: number; readonly text: string }>> = {
  'unauthenticated': { status: 401, text: 'sign in required' },
  'forbidden': { status: 403, text: 'forbidden' },
  'untrusted-origin': { status: 403, text: 'forbidden' },
  'csrf': { status: 403, text: 'forbidden' },
  'body-too-large': { status: 413, text: 'request body too large' },
  'method-not-allowed': { status: 405, text: 'method not allowed' },
  'malformed-body': { status: 400, text: 'malformed request' },
  'handler-failed': { status: 500, text: 'the operation could not be completed' },
}

/** Methods that carry no body and need no CSRF proof. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Response headers every management reply carries.
 *
 * `no-store` because each of these is one tenant's data answered on one
 * session: a shared cache or a restored back-forward page would hand it to
 * whoever holds the browser next. The rest deny this JSON any ability to be
 * framed, sniffed into another type, or to leak its path as a referrer.
 */
function baseHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }
}

/** Read one header, treating a repeated header as absent rather than guessing. */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? undefined : value
}

/**
 * Whether the request addresses the one origin this deployment is reached at.
 *
 * The `Host` header is checked on every method and `Origin` additionally on
 * writes. A browser sends `Origin` on cross-site writes, so an exact match is
 * what separates this tenant's own page from a page that merely knows the URL;
 * a write with no `Origin` at all is refused rather than assumed same-site.
 */
function addressesThisDeployment(request: IncomingMessage, origin: URL, write: boolean): boolean {
  const host = header(request, 'host')
  if (host === undefined) return false
  try {
    if (new URL(`http://${host}`).host.toLowerCase() !== origin.host.toLowerCase()) return false
  } catch {
    return false
  }
  if (!write) return true
  const declared = header(request, 'origin')
  return declared !== undefined && declared === origin.origin
}

/**
 * Read a bounded request body.
 *
 * The cap is enforced as bytes arrive rather than after the body is whole: a
 * management endpoint is authenticated, so an oversized body is a mistake or
 * an attempt to exhaust this process, and neither is worth buffering. Reading
 * stops at the cap and the socket is left for the caller to answer on —
 * destroying it here would replace the refusal with a hang-up the client
 * cannot tell from a crash.
 * @param request - the incoming request.
 * @param limit - most bytes to accept.
 * @returns the body text, or `undefined` once it exceeds the limit.
 */
async function readBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Send one reply, with the shared headers and nothing about why internally. */
function reply(response: ServerResponse, status: number, body?: string, json = false): void {
  response.writeHead(status, {
    ...baseHeaders(),
    ...body === undefined ? {} : { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' },
  })
  response.end(body)
}

/**
 * Answer one refusal, record it, and tell the deployment's log.
 *
 * The audit record is filed only when a session established whose tenant it
 * is. An unauthenticated refusal names no tenant this runtime may believe, so
 * it reaches the log and not a tenant's trail.
 */
async function refuse(
  host: ApiHost,
  route: ApiRoute,
  response: ServerResponse,
  rejection: ApiRejection,
  actor: Actor | undefined,
): Promise<void> {
  const { status, text } = REJECTIONS[rejection]
  reply(response, status, text)
  host.log?.(rejection, route.path)
  if (actor === undefined) return
  await host.audit({ userId: actor.userId, action: route.action, outcome: rejection })
}

/** Whether this role satisfies the route's least role. */
function permits(role: ControlPlaneRole, least: ControlPlaneRole): boolean {
  return least === 'member' || role === 'administrator'
}

/**
 * Turn one handler result into a reply.
 *
 * `notFound` and `forbidden` are answered here rather than by the handler so
 * every route reports them identically: a handler that discovered a record
 * belongs to another tenant returns `notFound`, and the caller cannot tell
 * that from an id that was never issued.
 */
function send(response: ServerResponse, result: ApiResult): void {
  switch (result.kind) {
    case 'json':
      reply(response, result.status, JSON.stringify(result.body), true)
      return
    case 'empty':
      reply(response, result.status)
      return
    case 'notFound':
      reply(response, 404, 'not found')
      return
    case 'forbidden':
      reply(response, 403, 'forbidden')
      return
    case 'invalid':
      reply(response, 400, result.reason)
  }
}

/**
 * Register one management route behind the authenticated envelope.
 *
 * The order is the contract. The origin is checked first, so a request that
 * does not address this deployment never reaches a session lookup. The method
 * is checked next, because a route that does not serve it has nothing to
 * authenticate for. The session is derived third — and it is the only source
 * of identity — with CSRF proved in the same step for a write. The role is
 * checked fourth, so an authenticated person of insufficient role is told
 * `403` rather than `404`. The body is read last, bounded, and only for a
 * caller already established as allowed to send one.
 *
 * @param server - the Harness Host route registry.
 * @param host - the origin, session authority, and audit sink shared by every route.
 * @param route - this route's path, methods, least role and handler.
 * @returns the disposer removing the route.
 */
export function registerApiRoute(server: ApiWebServer, host: ApiHost, route: ApiRoute): () => void {
  const origin = new URL(host.publicOrigin)
  const limit = route.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  return server.register({
    kind: 'exact',
    path: route.path,
    handler: async (request, response) => {
      const method = (request.method ?? 'GET').toUpperCase()
      const write = !SAFE_METHODS.has(method)
      if (!addressesThisDeployment(request, origin, write)) {
        await refuse(host, route, response, 'untrusted-origin', undefined)
        return
      }
      if (!route.methods.includes(method)) {
        await refuse(host, route, response, 'method-not-allowed', undefined)
        return
      }
      const session = authenticateOAuthHttpRequest(host.sessions, {
        method,
        cookie: header(request, 'cookie'),
        csrfHeader: header(request, OAUTH_CSRF_HEADER),
      }, Date.now())
      if (session === undefined) {
        // One answer for an absent session and a failed CSRF proof: telling a
        // caller which of the two it was reports whether the cookie it holds
        // is a live session.
        await refuse(host, route, response, write ? 'csrf' : 'unauthenticated', undefined)
        return
      }
      const actor: Actor = { userId: session.userId, role: session.role, session }
      if (!permits(actor.role, route.role)) {
        await refuse(host, route, response, 'forbidden', actor)
        return
      }
      let body: unknown
      if (write) {
        const text = await readBody(request, limit)
        if (text === undefined) {
          await refuse(host, route, response, 'body-too-large', actor)
          // Answered first, then the unread remainder is dropped: a client
          // that keeps sending has nowhere to send it.
          request.destroy()
          return
        }
        if (text !== '') {
          try {
            body = JSON.parse(text)
          } catch {
            await refuse(host, route, response, 'malformed-body', actor)
            return
          }
        }
      }
      let result: ApiResult
      try {
        result = await route.handle(actor, body, request)
      } catch (error) {
        // A handler that throws is a defect or a dependency that failed, and
        // either way its message is the deployment's to read and never the
        // caller's: it carries whatever the failing operation was holding.
        host.log?.('handler-failed', route.path)
        await host.audit({ userId: actor.userId, action: route.action, outcome: 'handler-failed' })
        reply(response, REJECTIONS['handler-failed'].status, REJECTIONS['handler-failed'].text)
        throw error
      }
      send(response, result)
      await host.audit({
        userId: actor.userId,
        action: route.action,
        outcome: result.kind === 'json' || result.kind === 'empty' ? 'ok' : result.kind,
      })
    },
  })
}
