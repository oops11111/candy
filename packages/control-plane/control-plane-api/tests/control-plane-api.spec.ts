/**
 * The envelope's whole job is what it refuses, so every case here drives a
 * real `node:http` server through `registerApiRoute` and asserts the status,
 * the body, and whether the handler ran at all. The session store is the one
 * fake: it is `dsh-control-plane-store`'s two-method reader, and standing a
 * SQLite domain up would test that store rather than this envelope.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { UserId, UserSessionId, type ControlPlaneRole } from '@deepseek-ai/dsh-control-plane'
import type { UserSessionRecord } from '@deepseek-ai/dsh-control-plane-store'
import { OAUTH_CSRF_HEADER } from '@deepseek-ai/dsh-oauth-sign-in'
import { afterEach, describe, expect, it } from 'vitest'
import { registerApiRoute, type Actor, type ApiAuditEvent, type ApiHost, type ApiResult, type ApiRoute } from '../src/index.ts'

const ORIGIN = 'https://candy.example'
const ALICE = UserId('user-alice')
const BOBBY = UserId('user-bobby')
const SESSION_COOKIE = '__Host-candy-session'
const CSRF_COOKIE = '__Host-candy-csrf'
const NOW = 1_800_000_000_000

let server: Server | undefined

afterEach(async () => {
  const listening = server
  server = undefined
  if (listening !== undefined) await new Promise<void>(resolve => listening.close(() => { resolve() }))
})

function session(userId = ALICE, role: ControlPlaneRole = 'member'): UserSessionRecord {
  return {
    id: UserSessionId('session-1'),
    userId,
    role,
    identity: { issuer: 'https://identity.example', subject: 'subject-1' },
    createdAt: NOW,
    expiresAt: NOW + 3_600_000,
    revokedAt: undefined,
  }
}

/** What one run of the harness observed. */
interface Harness {
  readonly port: number
  readonly audits: ApiAuditEvent[]
  readonly handled: { count: number; actor: Actor | undefined; body: unknown }
}

/**
 * Mount one route on a real listening server.
 *
 * @param route - the route's own policy, minus the handler's defaults.
 * @param sessions - the token the store accepts, and the record it answers.
 * @returns the port, the audit records written, and what the handler saw.
 */
async function mount(
  route: Partial<ApiRoute> = {},
  sessions: { token?: string; csrf?: string; record?: UserSessionRecord } = {},
): Promise<Harness> {
  const audits: ApiAuditEvent[] = []
  const handled: Harness['handled'] = { count: 0, actor: undefined, body: undefined }
  const accepted = sessions.token ?? 'bearer-alice'
  const csrf = sessions.csrf ?? 'csrf-alice'
  const record = sessions.record ?? session()
  const registrations: { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] = []

  const host: ApiHost = {
    publicOrigin: ORIGIN,
    sessions: {
      authenticateUserSession: async token => token === accepted ? record : undefined,
      verifyUserSessionCsrf: (id, token) => id === record.id && token === csrf,
    },
    audit: (event) => { audits.push(event); return Promise.resolve() },
  }
  registerApiRoute({ register: (r) => { registrations.push(r); return () => {} } }, host, {
    path: '/api/candy/probe',
    methods: ['GET', 'POST'],
    role: 'member',
    action: 'probe',
    handle: (actor, body) => {
      handled.count += 1
      handled.actor = actor
      handled.body = body
      return { kind: 'json', status: 200, body: { userId: actor.userId } } satisfies ApiResult
    },
    ...route,
  })

  const listening = createServer((req, res) => { void registrations[0]?.handler(req, res) })
  server = listening
  await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve))
  return { port: (listening.address() as AddressInfo).port, audits, handled }
}

/** What one request against the mounted route answered. */
interface Reply {
  readonly status: number
  readonly body: string
  readonly cacheControl: string | undefined
}

/**
 * One request, addressed as the public origin by default.
 *
 * `node:http` because the route is pinned to the exact authority through the
 * `Host` header, which `fetch` forbids setting.
 * @param port - the listening port.
 * @param options - method, headers and body this case varies.
 * @returns the status, body text and cache directive.
 */
function call(port: number, options: {
  method?: string
  host?: string
  origin?: string | null
  cookie?: string | null
  csrf?: string | null
  body?: string
} = {}): Promise<Reply> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { host: options.host ?? 'candy.example' }
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN
  if (options.cookie !== null) headers.cookie = options.cookie ?? `${SESSION_COOKIE}=bearer-alice; ${CSRF_COOKIE}=csrf-alice`
  if (options.csrf !== null) headers[OAUTH_CSRF_HEADER] = options.csrf ?? 'csrf-alice'
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/candy/probe', method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: text, cacheControl: res.headers['cache-control'] })
      })
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** A route mounted without a socket, for requests an HTTP client cannot send. */
function direct(): {
  handler: (request: IncomingMessage) => Promise<{ status: number }>
  seen: { count: number }
} {
  const seen = { count: 0 }
  const registrations: { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] = []
  registerApiRoute({ register: (r) => { registrations.push(r); return () => {} } }, {
    publicOrigin: ORIGIN,
    sessions: {
      authenticateUserSession: async () => session(),
      verifyUserSessionCsrf: () => true,
    },
    audit: () => Promise.resolve(),
  }, {
    path: '/api/candy/probe', methods: ['GET'], role: 'member', action: 'probe',
    handle: () => { seen.count += 1; return { kind: 'empty', status: 204 } },
  })
  return {
    handler: async (request) => {
      let status = 0
      const response = {
        writeHead: (code: number) => { status = code; return response },
        end: () => response,
      } as unknown as ServerResponse
      await registrations[0]?.handler(request, response)
      return { status }
    },
    seen,
  }
}

describe('the authenticated management envelope', () => {
  it('derives the tenant from the session and hands the handler nothing else', async () => {
    const harness = await mount()

    const reply = await call(harness.port)

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({ userId: ALICE })
    expect(harness.handled.actor?.userId).toBe(ALICE)
    expect(harness.audits).toEqual([{ userId: ALICE, action: 'probe', outcome: 'ok' }])
  })

  it('answers 401 for a request with no session, without running the handler', async () => {
    const harness = await mount()

    const reply = await call(harness.port, { cookie: null })

    expect(reply.status).toBe(401)
    expect(harness.handled.count).toBe(0)
    // No tenant is established, so nothing is filed against one.
    expect(harness.audits).toEqual([])
  })

  it('answers 401 for a session token the store does not accept', async () => {
    const harness = await mount()

    const reply = await call(harness.port, { cookie: `${SESSION_COOKIE}=someone-elses-guess` })

    expect(reply.status).toBe(401)
    expect(harness.handled.count).toBe(0)
  })

  it('answers 403 for an authenticated member on an administrator route', async () => {
    // 403 and not 404: the person is known, and the route exists.
    const harness = await mount({ role: 'administrator' })

    const reply = await call(harness.port)

    expect(reply.status).toBe(403)
    expect(harness.handled.count).toBe(0)
    expect(harness.audits).toEqual([{ userId: ALICE, action: 'probe', outcome: 'forbidden' }])
  })

  it('admits an administrator to a member route and to an administrator route', async () => {
    const admin = { record: session(ALICE, 'administrator') }
    expect((await call((await mount({}, admin)).port)).status).toBe(200)
    expect((await call((await mount({ role: 'administrator' }, admin)).port)).status).toBe(200)
  })

  it('refuses a request that does not address the configured origin', async () => {
    const harness = await mount()

    expect((await call(harness.port, { host: 'attacker.example' })).status).toBe(403)
    expect(harness.handled.count).toBe(0)
  })

  it('refuses a write from another site, and one that declares no origin at all', async () => {
    // A browser sends Origin on a cross-site write; absence is refused rather
    // than assumed same-site.
    const harness = await mount()

    expect((await call(harness.port, { method: 'POST', origin: 'https://attacker.example', body: '{}' })).status).toBe(403)
    expect((await call(harness.port, { method: 'POST', origin: null, body: '{}' })).status).toBe(403)
    expect(harness.handled.count).toBe(0)
  })

  it('refuses a write whose CSRF header does not repeat the cookie', async () => {
    const harness = await mount()

    expect((await call(harness.port, { method: 'POST', csrf: 'not-the-cookie', body: '{}' })).status).toBe(403)
    expect((await call(harness.port, { method: 'POST', csrf: null, body: '{}' })).status).toBe(403)
    expect(harness.handled.count).toBe(0)
  })

  it('accepts a write that proves origin and CSRF, and parses its body', async () => {
    const harness = await mount()

    const reply = await call(harness.port, { method: 'POST', body: '{"label":"work"}' })

    expect(reply.status).toBe(200)
    expect(harness.handled.body).toEqual({ label: 'work' })
  })

  it('refuses a body over the route cap without buffering it whole', async () => {
    const harness = await mount({ maxBodyBytes: 64 })

    const reply = await call(harness.port, { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(4096) }) })

    expect(reply.status).toBe(413)
    expect(harness.handled.count).toBe(0)
    expect(harness.audits).toEqual([{ userId: ALICE, action: 'probe', outcome: 'body-too-large' }])
  })

  it('refuses a body that is not the JSON the route reads', async () => {
    const harness = await mount()

    expect((await call(harness.port, { method: 'POST', body: 'not json' })).status).toBe(400)
    expect(harness.handled.count).toBe(0)
  })

  it('treats an empty write body as no body rather than malformed JSON', async () => {
    const harness = await mount()

    const reply = await call(harness.port, { method: 'POST' })

    expect(reply.status).toBe(200)
    expect(harness.handled.body).toBeUndefined()
  })

  it('answers 405 for a method the route does not serve, before authenticating', async () => {
    const harness = await mount({ methods: ['GET'] })

    const reply = await call(harness.port, { method: 'POST', body: '{}' })

    expect(reply.status).toBe(405)
    expect(harness.handled.count).toBe(0)
  })

  it('reports another tenant\'s record exactly as a record that does not exist', async () => {
    // The whole point: a caller must not be able to confirm an id by the
    // difference between "not yours" and "no such thing".
    const harness = await mount({
      handle: actor => actor.userId === BOBBY
        ? { kind: 'json', status: 200, body: { secret: true } }
        : { kind: 'notFound' },
    })

    const reply = await call(harness.port)

    expect(reply.status).toBe(404)
    expect(reply.body).toBe('not found')
    expect(harness.audits).toEqual([{ userId: ALICE, action: 'probe', outcome: 'notFound' }])
  })

  it('answers a handler refusal and an invalid request without inventing a body', async () => {
    expect((await call((await mount({ handle: () => ({ kind: 'forbidden' }) })).port)).status).toBe(403)
    const invalid = await call((await mount({ handle: () => ({ kind: 'invalid', reason: 'label is required' }) })).port)
    expect(invalid.status).toBe(400)
    expect(invalid.body).toBe('label is required')
    expect((await call((await mount({ handle: () => ({ kind: 'empty', status: 204 }) })).port)).status).toBe(204)
  })

  it('marks every reply no-store, whichever way it ended', async () => {
    const harness = await mount()

    expect((await call(harness.port)).cacheControl).toBe('no-store')
    expect((await call(harness.port, { cookie: null })).cacheControl).toBe('no-store')
    expect((await call(harness.port, { host: 'attacker.example' })).cacheControl).toBe('no-store')
  })

  it('reports each refusal to the deployment log with the route it was for', async () => {
    const seen: string[] = []
    const audits: ApiAuditEvent[] = []
    const registrations: { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] = []
    registerApiRoute({ register: (r) => { registrations.push(r); return () => {} } }, {
      publicOrigin: ORIGIN,
      sessions: {
        authenticateUserSession: async () => undefined,
        verifyUserSessionCsrf: () => false,
      },
      audit: (event) => { audits.push(event); return Promise.resolve() },
      log: (rejection, path) => { seen.push(`${rejection} ${path}`) },
    }, {
      path: '/api/candy/probe', methods: ['GET'], role: 'member', action: 'probe',
      handle: () => ({ kind: 'empty', status: 204 }),
    })
    const listening = createServer((req, res) => { void registrations[0]?.handler(req, res) })
    server = listening
    await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve))

    await call((listening.address() as AddressInfo).port)

    expect(seen).toEqual(['unauthenticated /api/candy/probe'])
  })

  it.each([
    ['no Host header at all', { headers: {} }],
    ['a Host header that is not a host', { headers: { host: 'not a host at all' } }],
    ['a Host header sent twice', { headers: { host: ['candy.example', 'attacker.example'] } }],
    ['no method', { method: undefined, headers: { host: 'candy.example' } }],
  ])('refuses a request with %s', async (_name, overrides) => {
    // Reached by calling the handler directly: an HTTP client cannot send a
    // request with no Host, an invalid one, a repeated one, or no method.
    const { handler, seen } = direct()

    const response = await handler({ method: 'GET', ...overrides } as unknown as IncomingMessage)

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(seen.count).toBe(0)
  })

  it('removes the route when its registration is disposed', async () => {
    let disposed = false
    const dispose = registerApiRoute({ register: () => () => { disposed = true } }, {
      publicOrigin: ORIGIN,
      sessions: { authenticateUserSession: async () => undefined, verifyUserSessionCsrf: () => false },
      audit: () => Promise.resolve(),
    }, {
      path: '/api/candy/probe', methods: ['GET'], role: 'member', action: 'probe',
      handle: () => ({ kind: 'empty', status: 204 }),
    })

    dispose()

    expect(disposed).toBe(true)
  })
})
