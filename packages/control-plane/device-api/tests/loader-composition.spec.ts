/**
 * Real composition: a Loader boots the storage stack, the durable control
 * plane, the Harness Host web server and this plugin, and every case is an
 * HTTP request against the listening port. Two tenants exist throughout, so
 * isolation is asserted rather than assumed, and sessions are established by
 * writing them through the store exactly as browser sign-in does.
 *
 * The exchange is called the way a Harness Host calls it: no cookie, no CSRF
 * header, no `Origin`, and nothing but the code in the body.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { DeviceId, UserId, type ControlPlaneRole } from '@deepseek-ai/dsh-control-plane'
import ControlPlaneStore, { tenantSubject } from '@deepseek-ai/dsh-control-plane-store'
import { authenticateDevice, deviceTokenDigest } from '@deepseek-ai/dsh-device-registry'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as DeviceApi from '../src/index.ts'
import { DEVICE_PATHS } from '../src/types.ts'

const PUBLIC_ORIGIN = 'https://candy.example'
const ALICE = UserId('user-alice')
const BOBBY = UserId('user-bobby')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot storage, the control plane, the real web server and this plugin. */
async function boot(at: string, options: { ttlMs?: number; mounted?: boolean } = {}): Promise<Context> {
  const ttlMs = options.ttlMs
  const configPath = join(at, 'cordis.yml')
  await writeFile(configPath, [
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: storage-sqlite',
    "  name: '@deepseek-ai/dsh-storage-sqlite'",
    '  config:',
    `    path: ${JSON.stringify(join(at, 'candy.db'))}`,
    '- id: storage-domain',
    "  name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: sqlite',
    '- id: control-plane-store',
    "  name: '@deepseek-ai/dsh-control-plane-store'",
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    ...options.mounted === false ? [] : [
      '- id: device-api',
      "  name: '@deepseek-ai/dsh-device-api'",
      '  config:',
      `    publicOrigin: ${JSON.stringify(PUBLIC_ORIGIN)}`,
      ...ttlMs === undefined ? [] : [`    pairingCodeTtlMs: ${ttlMs}`],
    ],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(at).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-control-plane-store', ControlPlaneStore],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-device-api', DeviceApi],
  ])
  await Promise.all([...modules.keys()].map(async (packageName) => {
    const packageDir = join(at, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({
      name: packageName, version: '0.1.0', type: 'module',
    })}\n`)
  }))
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** A temporary deployment directory. */
async function deployment(): Promise<string> {
  const at = await mkdtemp(join(tmpdir(), 'dsh-device-api-'))
  root = at
  return at
}

/** The cookies one signed-in browser holds, established through the store. */
interface Browser {
  readonly cookie: string
  readonly csrf: string
}

/** Sign one tenant in exactly as the OAuth callback does. */
async function signIn(ctx: Context, userId: UserId, role: ControlPlaneRole = 'member'): Promise<Browser> {
  const now = Date.now()
  const result = await ctx.controlPlaneStore.createUserSession(
    userId, role, { issuer: 'https://identity.example', subject: `subject-${userId}` }, now, now + 3_600_000,
  )
  return {
    cookie: `__Host-candy-session=${result.token}; __Host-candy-csrf=${result.csrfToken}`,
    csrf: result.csrfToken,
  }
}

/** What one API call answered. */
interface Reply {
  readonly status: number
  readonly body: string
}

/** One API call, addressed as the public origin is. */
function call(ctx: Context, path: string, options: {
  browser?: Browser
  method?: string
  body?: unknown
  origin?: string | null
  host?: string
  authorization?: string
} = {}): Promise<Reply> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
  const headers: Record<string, string> = { host: options.host ?? new URL(PUBLIC_ORIGIN).host }
  if (method !== 'GET' && options.origin !== null) headers.origin = options.origin ?? PUBLIC_ORIGIN
  if (options.browser !== undefined) {
    headers.cookie = options.browser.cookie
    headers['x-candy-csrf'] = options.browser.csrf
  }
  if (options.authorization !== undefined) headers.authorization = options.authorization
  if (payload !== undefined) headers['content-type'] = 'application/json'
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: ctx.webServer.port, path, method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: text }) })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** Ask whether a device token still identifies its binding. */
function authenticate(ctx: Context, token?: string): Promise<Reply> {
  return call(
    ctx,
    DEVICE_PATHS.authenticate,
    token === undefined ? {} : { authorization: `Bearer ${token}` },
  )
}

/** Issue one pairing code for a signed-in tenant. */
async function issue(ctx: Context, browser: Browser, label = 'Studio desktop'): Promise<string> {
  const reply = await call(ctx, DEVICE_PATHS.pair, { browser, body: { label } })
  expect(reply.status).toBe(201)
  return (JSON.parse(reply.body) as { code: string }).code
}

/** Exchange one code the way a Harness Host does: no cookie, no origin. */
function exchange(ctx: Context, code: string): Promise<Reply> {
  return call(ctx, DEVICE_PATHS.exchange, { body: { code }, origin: null })
}

describe('the device pairing API', () => {
  it('authenticates a live device and refuses its token after revocation', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const credential = JSON.parse((await exchange(ctx, await issue(ctx, alice))).body) as {
      deviceId: string
      userId: string
      token: string
    }

    const live = await authenticate(ctx, credential.token)
    expect(live.status).toBe(200)
    expect(JSON.parse(live.body)).toEqual({ deviceId: credential.deviceId, userId: ALICE })
    expect(live.body).not.toContain(credential.token)

    await call(ctx, DEVICE_PATHS.revoke, { browser: alice, body: { id: credential.deviceId } })
    const revoked = await authenticate(ctx, credential.token)
    expect(revoked).toEqual({ status: 401, body: '' })
    expect(ctx.controlPlaneStore.auditsOf(tenantSubject(ALICE)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'devices.authenticate', outcome: 'revoked' }),
      ]))
  })

  it('answers absent, malformed, and unknown device credentials alike', async () => {
    const ctx = await boot(await deployment())

    const absent = await authenticate(ctx)
    const malformed = await call(ctx, DEVICE_PATHS.authenticate, { authorization: 'Basic not-a-device' })
    const unknown = await authenticate(ctx, 'A'.repeat(43))

    expect(absent).toEqual({ status: 401, body: '' })
    expect(malformed).toEqual(absent)
    expect(unknown).toEqual(absent)
  })

  it('pairs a host to the tenant that issued the code', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)

    const code = await issue(ctx, alice)
    const paired = await exchange(ctx, code)

    expect(paired.status).toBe(201)
    const credential = JSON.parse(paired.body) as {
      deviceId: string
      userId: string
      label: string
      token: string
    }
    expect(credential.userId).toBe(ALICE)
    expect(credential.label).toBe('Studio desktop')
    // The token proves this host is that device, and only that device.
    expect(await authenticateDevice(ctx.controlPlaneStore, credential.token))
      .toMatchObject({ authenticated: true, device: { id: credential.deviceId, userId: ALICE } })

    const listed = await call(ctx, DEVICE_PATHS.list, { browser: alice })
    expect(listed.status).toBe(200)
    const view = JSON.parse(listed.body) as {
      devices: { id: string; label: string; revokedAt: number | null }[]
      pairingCodes: { deviceId: string; consumedAt: number }[]
    }
    expect(view.devices).toHaveLength(1)
    expect(view.devices[0]).toMatchObject({ id: credential.deviceId, label: 'Studio desktop' })
    expect(view.pairingCodes[0]).toMatchObject({ deviceId: credential.deviceId })
  })

  it('returns the code once and the token once, and never stores either', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)

    const code = await issue(ctx, alice)
    const credential = JSON.parse((await exchange(ctx, code)).body) as { token: string; deviceId: string }

    // Every later read of the same records carries neither value.
    const listed = await call(ctx, DEVICE_PATHS.list, { browser: alice })
    expect(listed.body).not.toContain(code)
    expect(listed.body).not.toContain(credential.token)
    expect(listed.body).not.toContain('tokenDigest')
    expect(listed.body).not.toContain('digest')
    // Only the digest reaches the medium, and it is not the token.
    const stored = await ctx.controlPlaneStore.findDevice(DeviceId(credential.deviceId))
    expect(stored?.tokenDigest).toBe(deviceTokenDigest(credential.token))
    expect(stored?.tokenDigest).not.toBe(credential.token)
  })

  it('mints a code of eighty bits that a host may spell as it likes', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)

    const code = await issue(ctx, alice)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/u)
    // Two codes in a row are not the same code.
    expect(await issue(ctx, alice, 'Second')).not.toBe(code)

    // A person types what they can read: spacing and case carry nothing.
    const paired = await exchange(ctx, ` ${code.replace(/-/gu, ' ').toLowerCase()} `)
    expect(paired.status).toBe(201)
  })

  it('exchanges one code exactly once', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const code = await issue(ctx, alice)

    expect((await exchange(ctx, code)).status).toBe(201)
    const second = await exchange(ctx, code)

    expect(second.status).toBe(400)
    expect(second.body).toContain('pairing-code-consumed')
    expect((await ctx.controlPlaneStore.listDevicesOfUser(ALICE))).toHaveLength(1)
  })

  it('refuses a code that was never issued, and one that expired', async () => {
    const ctx = await boot(await deployment(), { ttlMs: 30_000 })
    const alice = await signIn(ctx, ALICE)

    const unknown = await exchange(ctx, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ')
    expect(unknown.status).toBe(400)
    expect(unknown.body).toContain('pairing-code-unknown')
    expect((await exchange(ctx, '')).status).toBe(400)

    // The code's own record is what expires; the store is asked with a clock
    // past its window rather than by waiting for one.
    const code = await issue(ctx, alice)
    const codes = await ctx.controlPlaneStore.listPairingCodesOfUser(ALICE)
    expect(codes[0]?.expiresAt).toBeGreaterThan(Date.now())
    await ctx.controlPlaneStore.savePairingCode({
      ...codes[0], expiresAt: Date.now() - 1,
    } as Parameters<typeof ctx.controlPlaneStore.savePairingCode>[0])

    const expired = await exchange(ctx, code)
    expect(expired.status).toBe(400)
    expect(expired.body).toContain('pairing-code-expired')
  })

  it('never lets a request select the tenant a device binds to', async () => {
    // There is no parameter through which a caller can name a tenant: the
    // session supplies it for the three managed routes, and the code's own
    // record supplies it for the exchange.
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const bobby = await signIn(ctx, BOBBY)

    const planted = await call(ctx, DEVICE_PATHS.pair, {
      browser: alice, body: { label: 'planted', userId: BOBBY },
    })
    expect(planted.status).toBe(201)
    const code = (JSON.parse(planted.body) as { code: string }).code
    const paired = await call(ctx, DEVICE_PATHS.exchange, {
      body: { code, userId: BOBBY, deviceId: 'chosen-by-the-host' }, origin: null,
    })

    expect(paired.status).toBe(201)
    const credential = JSON.parse(paired.body) as { deviceId: string; userId: string }
    expect(credential.userId).toBe(ALICE)
    expect(credential.deviceId).not.toBe('chosen-by-the-host')
    expect(JSON.parse((await call(ctx, DEVICE_PATHS.list, { browser: bobby })).body))
      .toMatchObject({ devices: [], pairingCodes: [] })
  })

  it('withdraws a binding, and refuses another tenant the same id', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const bobby = await signIn(ctx, BOBBY)
    const code = await issue(ctx, alice)
    const credential = JSON.parse((await exchange(ctx, code)).body) as { deviceId: string; token: string }

    // Bobby learning the id changes nothing, and cannot even confirm it.
    expect((await call(ctx, DEVICE_PATHS.revoke, { browser: bobby, body: { id: credential.deviceId } })).status)
      .toBe(404)
    const revoked = await call(ctx, DEVICE_PATHS.revoke, { browser: alice, body: { id: credential.deviceId } })

    expect(revoked.status).toBe(200)
    expect(JSON.parse(revoked.body)).toMatchObject({ id: credential.deviceId })
    // The token the host still holds now authenticates nothing.
    expect(await authenticateDevice(ctx.controlPlaneStore, credential.token))
      .toMatchObject({ authenticated: false, rejection: 'revoked', device: { id: credential.deviceId } })
  })

  it('refuses every managed route to a caller with no session', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const code = await issue(ctx, alice)
    const credential = JSON.parse((await exchange(ctx, code)).body) as { deviceId: string }

    expect((await call(ctx, DEVICE_PATHS.list)).status).toBe(401)
    expect((await call(ctx, DEVICE_PATHS.pair, { body: { label: 'stolen' } })).status).toBe(403)
    expect((await call(ctx, DEVICE_PATHS.revoke, { body: { id: credential.deviceId } })).status).toBe(403)
    // A device token is not a session: it authorizes a run, not management.
    expect((await call(ctx, DEVICE_PATHS.list, { host: 'candy.example' })).status).toBe(401)
    expect((await ctx.controlPlaneStore.listDevicesOfUser(ALICE))).toHaveLength(1)
  })

  it('refuses a request that does not address this deployment', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const code = await issue(ctx, alice)

    // The exchange checks the host it was addressed as, like every other
    // route, and unlike them does not require an Origin a host never sends.
    expect((await call(ctx, DEVICE_PATHS.exchange, {
      body: { code }, origin: null, host: 'attacker.example',
    })).status).toBe(403)
    expect((await call(ctx, DEVICE_PATHS.pair, {
      browser: alice, body: { label: 'x' }, origin: 'https://attacker.example',
    })).status).toBe(403)
    expect((await call(ctx, DEVICE_PATHS.exchange, { method: 'GET', origin: null })).status).toBe(405)
    // Nothing above spent the code.
    expect((await exchange(ctx, code)).status).toBe(201)
  })

  it('refuses a submission that is not a request this route reads', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)

    expect((await call(ctx, DEVICE_PATHS.pair, { browser: alice, body: {} })).status).toBe(400)
    expect((await call(ctx, DEVICE_PATHS.pair, { browser: alice, body: { label: '  ' } })).status).toBe(400)
    expect((await call(ctx, DEVICE_PATHS.pair, { browser: alice, body: { label: 'x'.repeat(200) } })).status)
      .toBe(400)
    expect((await call(ctx, DEVICE_PATHS.revoke, { browser: alice, body: { id: ' ' } })).status).toBe(400)
    expect((await call(ctx, DEVICE_PATHS.revoke, { browser: alice, body: { id: 'x'.repeat(300) } })).status)
      .toBe(400)
    expect((await call(ctx, DEVICE_PATHS.exchange, { body: { code: 42 }, origin: null })).status).toBe(400)
    expect((await call(ctx, DEVICE_PATHS.exchange, {
      body: { code: 'x'.repeat(300) }, origin: null,
    })).status).toBe(400)
    expect((await ctx.controlPlaneStore.listPairingCodesOfUser(ALICE))).toHaveLength(0)
  })

  it('records every operation against the tenant it was about', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const code = await issue(ctx, alice)
    const credential = JSON.parse((await exchange(ctx, code)).body) as { deviceId: string }
    await call(ctx, DEVICE_PATHS.revoke, { browser: alice, body: { id: credential.deviceId } })

    const trail = ctx.controlPlaneStore.auditsOf(tenantSubject(ALICE))
      .map(record => `${record.action}:${record.outcome}`)

    // The exchange is filed against the tenant the code named, which is the
    // only identity a host's request establishes.
    expect(trail).toContain('devices.pair:ok')
    expect(trail).toContain('devices.exchange:ok')
    expect(trail).toContain('devices.revoke:ok')
    expect(ctx.controlPlaneStore.auditsOf(tenantSubject(BOBBY))).toEqual([])
  })

  it('completes the operation when the audit trail cannot take its record', async () => {
    // The trail is a record of what happened, not a precondition for it: a
    // store that cannot append must not turn a completed pairing into a
    // failure the tenant then repeats.
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    vi.spyOn(ctx.controlPlaneStore, 'recordAudit').mockRejectedValue(new Error('medium is gone'))

    const code = await issue(ctx, alice)

    expect((await exchange(ctx, code)).status).toBe(201)
    expect((await ctx.controlPlaneStore.listDevicesOfUser(ALICE))).toHaveLength(1)
  })

  it('answers 500 without a word of it when the medium throws', async () => {
    // A failing store is the deployment's to read; its message carries
    // whatever the failing call was holding.
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const code = await issue(ctx, alice)
    vi.spyOn(ctx.controlPlaneStore, 'findDevice')
      .mockRejectedValue(new Error('the medium named /srv/candy/candy.db'))
    vi.spyOn(ctx.controlPlaneStore, 'findPairingCode')
      .mockRejectedValue(new Error('the medium named /srv/candy/candy.db'))

    const revoked = await call(ctx, DEVICE_PATHS.revoke, { browser: alice, body: { id: 'device-1' } })
    const exchanged = await exchange(ctx, code)

    for (const reply of [revoked, exchanged]) {
      expect(reply.status).toBe(500)
      expect(reply.body).not.toContain('/srv/candy')
    }
  })

  it('removes every route with the plugin fiber', async () => {
    // Mounted here rather than from the config, so the fiber under test is one
    // this case owns and the booted stack outlives it.
    const ctx = await boot(await deployment(), { mounted: false })
    const alice = await signIn(ctx, ALICE)
    const fiber = ctx.plugin(DeviceApi, {
      publicOrigin: PUBLIC_ORIGIN, pairingCodeTtlMs: 900_000, auditRetention: 200,
    })
    await fiber.await()
    expect((await call(ctx, DEVICE_PATHS.list, { browser: alice })).status).toBe(200)

    await fiber.dispose()

    for (const path of Object.values(DEVICE_PATHS)) {
      expect((await call(ctx, path, { browser: alice })).status).toBe(404)
    }
  })
})
