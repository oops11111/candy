/**
 * Real composition: a Loader boots the storage stack, the durable control
 * plane, the Harness Host web server and this plugin, and every case is an
 * HTTP request against the listening port. Two tenants exist throughout, so
 * isolation is asserted rather than assumed, and sessions are established by
 * writing them through the store exactly as browser sign-in does.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ProviderAccountId, UserId, type ControlPlaneRole } from '@deepseek-ai/dsh-control-plane'
import { assembleKeyring, openCredential, type CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'
import ControlPlaneStore, { tenantSubject } from '@deepseek-ai/dsh-control-plane-store'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProviderCredentialChecks from '@deepseek-ai/dsh-provider-credential-checks'
import * as ProviderAccountApi from '../src/index.ts'
import { ACCOUNT_PATHS } from '../src/types.ts'

const PUBLIC_ORIGIN = 'https://candy.example'
const KEY = 'candy-credential-key-32-bytes!!!'
const KEY_VERSION = '2026-09-a'
const ALICE = UserId('user-alice')
const BOBBY = UserId('user-bobby')
const SECRET = 'sk-alice-provider-secret'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot storage, the control plane, the real web server and this plugin. */
async function boot(at: string): Promise<Context> {
  process.env.CANDY_CREDENTIAL_KEY = KEY
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
    '- id: provider-credential-checks',
    "  name: '@deepseek-ai/dsh-provider-credential-checks'",
    '- id: provider-account-api',
    "  name: '@deepseek-ai/dsh-provider-account-api'",
    '  config:',
    `    publicOrigin: ${JSON.stringify(PUBLIC_ORIGIN)}`,
    `    credentialKeyVersion: ${JSON.stringify(KEY_VERSION)}`,
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
    ['@deepseek-ai/dsh-provider-credential-checks', ProviderCredentialChecks],
    ['@deepseek-ai/dsh-provider-account-api', ProviderAccountApi],
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

/** The same keyring the booted plugin assembles, for opening what it sealed. */
function keyring(): CredentialKeyring {
  return assembleKeyring({
    component: 'test',
    environment: process.env,
    currentVersion: KEY_VERSION,
    currentEnv: 'CANDY_CREDENTIAL_KEY',
  })
}

/** A temporary deployment directory. */
async function deployment(): Promise<string> {
  const at = await mkdtemp(join(tmpdir(), 'dsh-account-api-'))
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

/** One API call from a signed-in browser, addressed as the public origin is. */
function call(ctx: Context, path: string, options: {
  browser?: Browser
  method?: string
  body?: unknown
  origin?: string
} = {}): Promise<Reply> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
  const headers: Record<string, string> = { host: new URL(PUBLIC_ORIGIN).host }
  if (method !== 'GET') headers.origin = options.origin ?? PUBLIC_ORIGIN
  if (options.browser !== undefined) {
    headers.cookie = options.browser.cookie
    headers['x-candy-csrf'] = options.browser.csrf
  }
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

/** Create one account for a signed-in tenant and return its id. */
async function createAccount(ctx: Context, browser: Browser, label = 'work'): Promise<string> {
  const reply = await call(ctx, ACCOUNT_PATHS.create, {
    browser,
    body: { provider: 'claude-cli', label, secret: SECRET },
  })
  expect(reply.status).toBe(201)
  return (JSON.parse(reply.body) as { id: string }).id
}

describe('the provider-account management API', () => {
  it('creates, lists and defaults an account for the tenant the session names', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)

    const id = await createAccount(ctx, alice)
    const listed = await call(ctx, ACCOUNT_PATHS.list, { browser: alice })

    expect(listed.status).toBe(200)
    const accounts = JSON.parse(listed.body) as { id: string; isDefault: boolean; provider: string }[]
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ id, provider: 'claude-cli', isDefault: true })
  })

  it('never returns the credential, in any operation or any listing', async () => {
    // The store holds a sealed envelope and `ProviderAccountView` has no field
    // for a secret; this is the assertion that keeps it that way.
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const id = await createAccount(ctx, alice)

    const replies = [
      await call(ctx, ACCOUNT_PATHS.list, { browser: alice }),
      await call(ctx, ACCOUNT_PATHS.default, { browser: alice, body: { id } }),
      await call(ctx, ACCOUNT_PATHS.validate, { browser: alice, body: { id } }),
      await call(ctx, ACCOUNT_PATHS.revoke, { browser: alice, body: { id } }),
    ]

    for (const reply of replies) {
      expect(reply.body).not.toContain(SECRET)
      expect(reply.body).not.toContain(KEY)
      expect(reply.body).not.toContain('ciphertext')
    }
  })

  it('ignores a userId a caller puts in the body', async () => {
    // There is no parameter through which a request can select a tenant. The
    // envelope hands the handler an actor and the handler has no other source.
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const bobby = await signIn(ctx, BOBBY)

    const created = await call(ctx, ACCOUNT_PATHS.create, {
      browser: alice,
      body: { provider: 'claude-cli', label: 'planted', secret: SECRET, userId: BOBBY },
    })

    expect(created.status).toBe(201)
    expect(JSON.parse((await call(ctx, ACCOUNT_PATHS.list, { browser: bobby })).body)).toEqual([])
    expect(JSON.parse((await call(ctx, ACCOUNT_PATHS.list, { browser: alice })).body)).toHaveLength(1)
  })

  it('keeps two tenants on the same provider completely apart', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const bobby = await signIn(ctx, BOBBY)
    const aliceAccount = await createAccount(ctx, alice, 'alice work')
    const bobbyAccount = await createAccount(ctx, bobby, 'bobby work')

    const aliceList = JSON.parse((await call(ctx, ACCOUNT_PATHS.list, { browser: alice })).body) as { id: string }[]
    const bobbyList = JSON.parse((await call(ctx, ACCOUNT_PATHS.list, { browser: bobby })).body) as { id: string }[]

    expect(aliceList.map(account => account.id)).toEqual([aliceAccount])
    expect(bobbyList.map(account => account.id)).toEqual([bobbyAccount])
    expect(aliceAccount).not.toBe(bobbyAccount)
  })

  it.each([
    ['default', ACCOUNT_PATHS.default],
    ['validate', ACCOUNT_PATHS.validate],
    ['revoke', ACCOUNT_PATHS.revoke],
    ['delete', ACCOUNT_PATHS.delete],
  ])('reports another tenant\'s account as not found: %s', async (_name, path) => {
    // The id is real and Bobby holds it; naming it changes nothing about
    // whose session is acting, and the answer is what a made-up id gets.
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const bobby = await signIn(ctx, BOBBY)
    const bobbyAccount = await createAccount(ctx, bobby)

    const stolen = await call(ctx, path, { browser: alice, body: { id: bobbyAccount } })
    const invented = await call(ctx, path, { browser: alice, body: { id: randomUUID() } })

    expect(stolen.status).toBe(404)
    expect(stolen.body).toBe(invented.body)
    expect(stolen.status).toBe(invented.status)
  })

  it('leaves the other tenant\'s account untouched when one is refused', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const bobby = await signIn(ctx, BOBBY)
    const bobbyAccount = await createAccount(ctx, bobby)

    await call(ctx, ACCOUNT_PATHS.revoke, { browser: alice, body: { id: bobbyAccount } })

    const bobbyList = JSON.parse((await call(ctx, ACCOUNT_PATHS.list, { browser: bobby })).body) as { revokedAt?: number }[]
    expect(bobbyList[0]?.revokedAt).toBeUndefined()
  })

  it('refuses every operation to a browser with no session', async () => {
    const ctx = await boot(await deployment())

    expect((await call(ctx, ACCOUNT_PATHS.list)).status).toBe(401)
    expect((await call(ctx, ACCOUNT_PATHS.create, { body: { provider: 'claude-cli', label: 'x', secret: 'y' } })).status).toBe(403)
  })

  it('refuses a write that does not declare this deployment as its origin', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)

    const reply = await call(ctx, ACCOUNT_PATHS.create, {
      browser: alice, origin: 'https://attacker.example',
      body: { provider: 'claude-cli', label: 'x', secret: 'y' },
    })

    expect(reply.status).toBe(403)
    expect(JSON.parse((await call(ctx, ACCOUNT_PATHS.list, { browser: alice })).body)).toEqual([])
  })

  it('refuses a revoked account to new work, immediately', async () => {
    // Revocation is the operation an operator reaches for under pressure, so
    // the next thing that asks for the credential must already be refused.
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const id = await createAccount(ctx, alice)

    expect((await call(ctx, ACCOUNT_PATHS.revoke, { browser: alice, body: { id } })).status).toBe(200)

    // The record is retained with an emptied envelope, and the gate every
    // consumer passes through — opening the credential — refuses it.
    const envelope = await ctx.controlPlaneStore.findCredential({ userId: ALICE, accountId: ProviderAccountId(id) })
    if (envelope === undefined) throw new Error('the revoked account kept no record at all')
    expect(openCredential(envelope, { userId: ALICE, accountId: ProviderAccountId(id) }, keyring(), Date.now()))
      .toMatchObject({ opened: false })
    // And every later operation on it refuses rather than acting.
    expect((await call(ctx, ACCOUNT_PATHS.validate, { browser: alice, body: { id } })).status).toBe(400)
    expect((await call(ctx, ACCOUNT_PATHS.default, { browser: alice, body: { id } })).status).toBe(400)
  })

  it('deletes an account and keeps its id blocked', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const id = await createAccount(ctx, alice)

    expect((await call(ctx, ACCOUNT_PATHS.delete, { browser: alice, body: { id } })).status).toBe(200)

    const listed = JSON.parse((await call(ctx, ACCOUNT_PATHS.list, { browser: alice })).body) as unknown[]
    expect(listed).toEqual([])
  })

  it('validates through the registered check, and reports an unregistered provider', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const id = await createAccount(ctx, alice)

    const unsupported = await call(ctx, ACCOUNT_PATHS.validate, { browser: alice, body: { id } })
    expect(JSON.parse(unsupported.body)).toMatchObject({
      validation: { valid: false, reason: 'unsupported-provider' },
    })

    const seen: string[] = []
    const stop = ctx.providerCredentialChecks.register('claude-cli', (secret) => {
      seen.push(Buffer.from(secret).toString('utf8'))
      return Promise.resolve({ valid: true })
    })
    const checked = await call(ctx, ACCOUNT_PATHS.validate, { browser: alice, body: { id } })

    expect(JSON.parse(checked.body)).toMatchObject({ validation: { valid: true } })
    expect(seen).toEqual([SECRET])
    stop()
  })

  it.each([
    ['an unknown provider', { provider: 'nope', label: 'x', secret: 'y' }],
    ['a blank label', { provider: 'claude-cli', label: '   ', secret: 'y' }],
    ['an over-long label', { provider: 'claude-cli', label: 'l'.repeat(121), secret: 'y' }],
    ['no secret', { provider: 'claude-cli', label: 'x' }],
    ['an over-long secret', { provider: 'claude-cli', label: 'x', secret: 's'.repeat(4097) }],
    ['a non-boolean default', { provider: 'claude-cli', label: 'x', secret: 'y', isDefault: 'yes' }],
    ['a non-string label', { provider: 'claude-cli', label: 7, secret: 'y' }],
  ])('refuses a create request with %s', async (_name, body) => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)

    expect((await call(ctx, ACCOUNT_PATHS.create, { browser: alice, body })).status).toBe(400)
  })

  it.each([
    ['no id', {}],
    ['a blank id', { id: '  ' }],
    ['an over-long id', { id: 'i'.repeat(201) }],
    ['a non-string id', { id: 7 }],
  ])('refuses an operation naming %s', async (_name, body) => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)

    for (const path of [ACCOUNT_PATHS.revoke, ACCOUNT_PATHS.delete, ACCOUNT_PATHS.default, ACCOUNT_PATHS.validate]) {
      expect((await call(ctx, path, { browser: alice, body })).status).toBe(400)
    }
  })

  it('creates a second account as the provider default when asked', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const first = await createAccount(ctx, alice, 'first')

    const second = await call(ctx, ACCOUNT_PATHS.create, {
      browser: alice, body: { provider: 'claude-cli', label: 'second', secret: SECRET, isDefault: true },
    })

    expect(second.status).toBe(201)
    const listed = JSON.parse((await call(ctx, ACCOUNT_PATHS.list, { browser: alice })).body) as
      { id: string; isDefault: boolean }[]
    expect(listed.find(account => account.id === first)?.isDefault).toBe(false)
    expect(listed.find(account => account.isDefault)?.id).toBe((JSON.parse(second.body) as { id: string }).id)
  })

  it('completes the operation when the audit trail cannot take its record', async () => {
    // The trail is a record of what happened, not a precondition for it: a
    // store that cannot append must not turn a completed revocation into a
    // failure the operator then retries.
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const id = await createAccount(ctx, alice)
    vi.spyOn(ctx.controlPlaneStore, 'recordAudit').mockRejectedValue(new Error('medium is gone'))

    expect((await call(ctx, ACCOUNT_PATHS.revoke, { browser: alice, body: { id } })).status).toBe(200)
  })

  it('refuses an operation on an account this tenant already deleted', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const id = await createAccount(ctx, alice)
    expect((await call(ctx, ACCOUNT_PATHS.delete, { browser: alice, body: { id } })).status).toBe(200)

    const again = await call(ctx, ACCOUNT_PATHS.revoke, { browser: alice, body: { id } })

    expect(again.status).toBe(400)
    expect(again.body).toContain('deleted')
  })

  it('forwards the label rule its owner enforces, rather than repeating it', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)

    const blank = await call(ctx, ACCOUNT_PATHS.create, {
      browser: alice, body: { provider: 'claude-cli', label: '   ', secret: SECRET },
    })

    expect(blank.status).toBe(400)
    expect(blank.body).toContain('invalid-label')
  })

  it('answers 500 without a word of it when a provider check throws', async () => {
    // A failing integration is the deployment's to read; its message carries
    // whatever the failing call was holding.
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    const id = await createAccount(ctx, alice)
    const stop = ctx.providerCredentialChecks.register('claude-cli', () => {
      throw new Error(`the provider rejected key ${SECRET}`)
    })

    const reply = await call(ctx, ACCOUNT_PATHS.validate, { browser: alice, body: { id } })

    expect(reply.status).toBe(500)
    expect(reply.body).not.toContain(SECRET)
    stop()
  })

  it('records every operation against the acting tenant, refusals included', async () => {
    const ctx = await boot(await deployment())
    const alice = await signIn(ctx, ALICE)
    await createAccount(ctx, alice)
    await call(ctx, ACCOUNT_PATHS.revoke, { browser: alice, body: { id: randomUUID() } })

    const trail = ctx.controlPlaneStore.auditsOf(tenantSubject(ALICE))

    expect(trail).toContainEqual(expect.objectContaining({ action: 'accounts.create', outcome: 'ok' }))
    expect(trail).toContainEqual(expect.objectContaining({ action: 'accounts.revoke', outcome: 'notFound' }))
    // The vault's own record of sealing the credential reaches the same trail.
    expect(trail).toContainEqual(expect.objectContaining({ event: 'credential' }))
    expect(JSON.stringify(trail)).not.toContain(SECRET)
  })

  it('survives a restart with every account and its ownership intact', async () => {
    const at = await deployment()
    const first = await boot(at)
    const alice = await signIn(first, ALICE)
    const id = await createAccount(first, alice)
    await first.fiber.dispose()
    context = undefined

    const second = await boot(at)
    const restored = await signIn(second, ALICE)

    const listed = JSON.parse((await call(second, ACCOUNT_PATHS.list, { browser: restored })).body) as { id: string }[]
    expect(listed.map(account => account.id)).toEqual([id])
  })
})
