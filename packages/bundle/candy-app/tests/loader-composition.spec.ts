/**
 * The shipped Candy layer, applied the way a profile applies it.
 *
 * The patch's own text is what boots here: `loadOverlayPatches` reads the file
 * the bundle publishes, and the Loader evaluates its `!!js` expressions
 * against a real process environment. Nothing about the composition is
 * restated in this file, so a row renamed or a variable misspelled in the
 * patch fails here rather than on an operator's first install.
 *
 * The prerequisite rows the layer patches and injects — the storage hub, its
 * default backend, the domain facility and the Host web server — are seeded
 * into the root the way `dsh-base` and `dsh-web-app` supply them.
 */

import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ControlPlaneStore from '@deepseek-ai/dsh-control-plane-store'
import RunScheduler from '@deepseek-ai/dsh-run-scheduler'
import {
  ConversationId,
  DeviceId,
  ProviderAccountId,
  RunId,
  UserId,
  WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import { CredentialKeyVersion, type CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'
import { mintExecutionAssertion } from '@deepseek-ai/dsh-execution-assertion'
import Llm, { type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmReplay from '@deepseek-ai/dsh-llm-replay'
import { createProviderAccount, revokeProviderAccount } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ProviderCredentialChecks from '@deepseek-ai/dsh-provider-credential-checks'
import * as DeepSeekCredentialCheck from '@deepseek-ai/dsh-deepseek-credential-check'
import WorkspaceGrantExecution from '@deepseek-ai/dsh-workspace-grant-execution'
import * as OauthSignInWeb from '@deepseek-ai/dsh-oauth-sign-in-web'
import * as ProviderAccountApi from '@deepseek-ai/dsh-provider-account-api'
import * as AuditApi from '@deepseek-ai/dsh-audit-api'
import * as DeviceApi from '@deepseek-ai/dsh-device-api'
import { ACCOUNT_PATHS } from '@deepseek-ai/dsh-provider-account-api'
import { deviceTokenDigest } from '@deepseek-ai/dsh-device-registry'
import { DEVICE_PATHS } from '@deepseek-ai/dsh-device-api'
import { OAUTH_START_PATH } from '@deepseek-ai/dsh-oauth-sign-in'
import { afterEach, describe, expect, it } from 'vitest'

const PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** Every module the layer's rows and the seeded prerequisites name. */
const MODULES = new Map<string, unknown>([
  ['@deepseek-ai/dsh-storage', Storage],
  ['@deepseek-ai/dsh-storage-json', StorageJson],
  ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
  ['@deepseek-ai/dsh-storage-domain', StorageDomain],
  ['@deepseek-ai/dsh-host-webserver', WebServer],
  ['@deepseek-ai/dsh-control-plane-store', ControlPlaneStore],
  ['@deepseek-ai/dsh-run-scheduler', RunScheduler],
  ['@deepseek-ai/dsh-provider-credential-checks', ProviderCredentialChecks],
  ['@deepseek-ai/dsh-deepseek-credential-check', DeepSeekCredentialCheck],
  ['@deepseek-ai/dsh-workspace-grant-execution', WorkspaceGrantExecution],
  ['@deepseek-ai/dsh-oauth-sign-in-web', OauthSignInWeb],
  ['@deepseek-ai/dsh-provider-account-api', ProviderAccountApi],
  ['@deepseek-ai/dsh-audit-api', AuditApi],
  ['@deepseek-ai/dsh-device-api', DeviceApi],
  // The account page's Node half is an inert Loader entry by construction —
  // its browser half is what the row exists for, and it is proved in its own
  // package. Importing the real module here would put a Client-face source
  // file into this Host-face program, which one program cannot hold.
  ['@deepseek-ai/dsh-client-ui-settings-candy-account', { apply() {} }],
])

let root: string | undefined
let context: Context | undefined
let restore: (() => void) | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  restore?.()
  restore = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A complete, valid deployment environment over one temporary directory. */
async function environment(at: string): Promise<Record<string, string>> {
  const jwks = join(at, 'oidc-jwks.json')
  // One P-256 verification key: the plugin refuses an empty key set, and the
  // OIDC endpoints below are never reached because no test drives a sign-in.
  await writeFile(jwks, `${JSON.stringify({
    keys: [{ kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0', kid: 'candy-test', alg: 'ES256', use: 'sig' }],
  })}\n`)
  return {
    CANDY_DATABASE_PATH: join(at, 'candy.db'),
    CANDY_PUBLIC_ORIGIN: 'https://candy.example',
    CANDY_CONTROL_PLANE_ISSUER: 'candy-control-plane',
    CANDY_RUNTIME_AUDIENCE: 'candy-runtime-debian-1',
    CANDY_CREDENTIAL_KEY_VERSION: '2026-09-a',
    // Both are read as raw bytes of the variable's own text, so the value is
    // 32 characters rather than a 32-byte blob in some encoding.
    CANDY_CREDENTIAL_KEY: randomBytes(24).toString('base64'),
    CANDY_ASSERTION_SECRET: randomBytes(24).toString('base64'),
    CANDY_RUNTIME_POOL_BASE: join(at, 'pools'),
    CANDY_OIDC_ISSUER: 'https://identity.example',
    CANDY_OIDC_AUTHORIZATION_ENDPOINT: 'https://identity.example/authorize',
    CANDY_OIDC_TOKEN_ENDPOINT: 'https://identity.example/token',
    CANDY_OIDC_USERINFO_ENDPOINT: 'https://identity.example/userinfo',
    CANDY_OIDC_CLIENT_ID: 'candy-client',
    CANDY_OIDC_JWKS_PATH: jwks,
  }
}

/** Stage one environment for the boot, and hand back the undo. */
function stage(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name])
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

/**
 * Boot the shipped layer over the rows the base and Web bundles supply.
 * @param at - the temporary directory the deployment lives in.
 * @param overrides - environment values to replace or, with undefined, unset.
 * @returns the settled root context.
 */
async function boot(at: string, overrides: Record<string, string | undefined> = {}): Promise<Context> {
  restore = stage({ ...await environment(at), ...overrides })
  const configPath = join(at, 'cordis.yml')
  await writeFile(configPath, [
    '- id: timer',
    "  name: '@deepseek-ai/cordis-plugin-timer'",
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: storage-json',
    "  name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(at, 'storages'))}`,
    '- id: storage-domain',
    "  name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(at).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await Promise.all([...MODULES.keys(), '@deepseek-ai/cordis-plugin-timer'].map(async (packageName) => {
    const packageDir = join(at, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({
      name: packageName, version: '0.1.0', type: 'module',
    })}\n`)
  }))
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/cordis-plugin-timer') return Timer
      if (!MODULES.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return MODULES.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href, patches: loadOverlayPatches('candy-app spec', PATCH) },
  })
  await ctx.loader.await()
  return ctx
}

/**
 * Request one path with an exact Host header.
 *
 * `fetch` forbids setting `Host`, and the whole point of these routes is that
 * they answer one authority and refuse every other, so the request has to be
 * built where that header can be chosen.
 * @param port - the bound loopback port.
 * @param authority - the Host header value to send.
 * @param path - the request target.
 * @returns the answered status.
 */
async function status(port: number, authority: string, path: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const call = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: authority } },
      (response) => {
        response.resume()
        response.on('end', () => { resolve(response.statusCode ?? 0) })
      },
    )
    call.on('error', reject)
    call.end()
  })
}

describe('the shipped Candy deployment layer', () => {
  it('runs one tenant DeepSeek account through login, replay, metering, and revocation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-app-'))
    await mkdir(join(root, 'pools'), { recursive: true })
    const ctx = await boot(root)
    const now = Date.now()
    const userId = UserId('user-alice')
    const accountId = ProviderAccountId('deepseek-account')
    const sessionId = SessionId('deepseek-session')
    const runId = RunId('deepseek-run')
    const key = process.env.CANDY_CREDENTIAL_KEY
    const version = process.env.CANDY_CREDENTIAL_KEY_VERSION
    if (key === undefined || version === undefined) throw new Error('the Candy test environment did not stage its credential key')
    const keyring: CredentialKeyring = {
      currentVersion: CredentialKeyVersion(version),
      keys: new Map([[CredentialKeyVersion(version), Buffer.from(key, 'utf8')]]),
    }

    const login = await ctx.controlPlaneStore.createUserSession(
      userId, 'member', { issuer: 'https://identity.example', subject: 'alice' }, now, now + 60_000,
    )
    await expect(ctx.controlPlaneStore.authenticateUserSession(login.token, now)).resolves.toMatchObject({ userId })
    await createProviderAccount(ctx.controlPlaneStore, keyring, {
      id: accountId, userId, provider: 'deepseek-api', label: 'DeepSeek', secret: Buffer.from('replay-only-secret'),
    }, now)
    const budget: RunBudget = { tokens: 1_000, wallMs: 60_000, costMicroUsd: 100_000, children: 0 }
    const deviceId = DeviceId('device-1')
    const workspaceGrantId = WorkspaceGrantId('grant-1')
    await ctx.controlPlaneStore.setTenantGrant(userId, budget)
    await ctx.controlPlaneStore.saveDevice({
      id: deviceId, userId, label: 'Studio desktop',
      tokenDigest: deviceTokenDigest('device-token'), pairedAt: Date.now(), revokedAt: undefined,
    })
    await ctx.controlPlaneStore.saveGrant({
      id: workspaceGrantId, userId, deviceId, roots: [root], mode: 'workspace-write', version: 1,
      createdAt: now, updatedAt: now, revokedAt: undefined,
    })

    await ctx.plugin(SessionStore)
    ctx.sessions.create(sessionId, { meta: { cwd: root } })
    await ctx.plugin(Llm)
    const replayFile = join(root, 'deepseek-replay.jsonl')
    const replayChunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'usage', usage: { inputTokens: 30, outputTokens: 12, costMicroUsd: 900 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    await writeFile(replayFile, [
      JSON.stringify({ type: 'session', version: 0, id: 'recorded', createdAt: now }),
      ...replayChunks.map((chunk, index) => JSON.stringify({
        type: 'assistant/chunk', seq: index + 1, time: now, data: { turn: 1, step: 1, chunk },
      })),
      '',
    ].join('\n'))
    await ctx.plugin(LlmReplay, {
      file: replayFile,
      providers: [{ id: 'deepseek-official', models: [{ id: 'deepseek-chat' }] }],
    })
    const token = mintExecutionAssertion({
      issuer: 'candy-control-plane', audience: 'candy-runtime-debian-1', userId, deviceId, accountId,
      provider: 'deepseek-api', workspaceGrantId, conversationId: ConversationId('conversation-1'), sessionId,
      runId, parentRunId: undefined, nonce: 'deepseek-once', issuedAt: now, expiresAt: now + 60_000,
    }, Buffer.from(process.env.CANDY_ASSERTION_SECRET ?? '', 'utf8'))
    expect((await ctx.runScheduler.start(token, undefined, now)).started).toBe(true)

    const call = () => ctx.llm.stream({ provider: 'deepseek-official', model: 'deepseek-chat', sessionId, messages: [] })
    const first: StreamChunk[] = []
    for await (const chunk of call()) first.push(chunk)
    expect(first.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(ctx.runScheduler.ledger.get(runId)?.spent).toMatchObject({ tokens: 42, costMicroUsd: 900 })

    await revokeProviderAccount(ctx.controlPlaneStore, userId, accountId, now + 1)
    const second: StreamChunk[] = []
    for await (const chunk of call()) second.push(chunk)
    expect(second).toMatchObject([{ type: 'finish', reason: { failure: { code: 'CREDENTIAL_REVOKED' } } }])
  })

  it('composes the control plane the browser routes need', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-app-'))

    const ctx = await boot(root)

    // The store and the scheduler are the two the rest is written against.
    expect(ctx.controlPlaneStore).toBeInstanceOf(ControlPlaneStore)
    expect(ctx.runScheduler).toBeInstanceOf(RunScheduler)
    expect(ctx.providerCredentialChecks).toBeInstanceOf(ProviderCredentialChecks)
    // The page's own row mounts on the Host side as an inert Loader entry, so
    // its browser half reaches the roster the modules node half scans.
    expect(ctx.webServer.port).toBeGreaterThan(0)
  })

  it('answers the account routes over the public origin it was configured with', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-app-'))
    const ctx = await boot(root)
    const port = ctx.webServer.port

    // No session cookie: the envelope refuses before any account is reached,
    // which is what proves the route is mounted and authenticated at all.
    expect(await status(port, 'candy.example', ACCOUNT_PATHS.list)).toBe(401)

    // The same route from another authority is refused before authentication,
    // which is what pins the configured origin to this deployment.
    expect(await status(port, 'attacker.example', ACCOUNT_PATHS.list)).toBe(403)

    // Sign-in is mounted on the same authority and redirects rather than 404s.
    expect(await status(port, 'candy.example', OAUTH_START_PATH)).toBe(303)
  })

  it('mounts device pairing, including the one route no session authenticates', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-app-'))
    const ctx = await boot(root)
    const port = ctx.webServer.port

    // The three tenant routes sit behind the same envelope as every other
    // management operation: no cookie, no operation.
    expect(await status(port, 'candy.example', DEVICE_PATHS.list)).toBe(401)
    expect(await status(port, 'attacker.example', DEVICE_PATHS.list)).toBe(403)

    // The exchange is mounted and does not ask for a session — a Harness Host
    // has none — so a GET reaches its method check rather than an auth check.
    expect(await status(port, 'candy.example', DEVICE_PATHS.exchange)).toBe(405)
    expect(await status(port, 'attacker.example', DEVICE_PATHS.exchange)).toBe(403)
  })

  it('names an account page the workspace actually publishes', async () => {
    // The row above is mounted from a stub, so this is what keeps its name
    // honest: the package the deployment would resolve has to exist and to
    // declare the browser entry the modules scan reads.
    const manifest = JSON.parse(await readFile(
      fileURLToPath(new URL('../../../client/ui-settings-candy-account/package.json', import.meta.url)),
      'utf8',
    )) as { name?: string; exports?: Record<string, unknown>; dsh?: { client?: { platform?: string } } }

    expect(manifest.name).toBe('@deepseek-ai/dsh-client-ui-settings-candy-account')
    expect(manifest.exports?.['./client']).toBeDefined()
    expect(manifest.dsh?.client?.platform).toBe('web')
  })

  it('routes the control-plane domain to the medium that can spend a nonce', async () => {
    // The inherited JSON backend answers reads from its open-time snapshot and
    // has no compare/exchange, so a nonce spent on it is not spent once. The
    // layer's whole reason for inserting SQLite is this one domain.
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-app-'))
    const ctx = await boot(root)

    const claims = {
      issuer: 'candy-control-plane',
      audience: 'candy-runtime-debian-1',
      userId: 'user-alice',
      deviceId: 'device-1',
      accountId: 'account-1',
      provider: 'claude-cli' as const,
      workspaceGrantId: 'grant-1',
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      runId: 'run-1',
      parentRunId: undefined,
      nonce: 'nonce-1',
      issuedAt: 1_800_000_000_000,
      expiresAt: 1_800_000_060_000,
    } as unknown as Parameters<typeof ctx.controlPlaneStore.spendNonce>[0]

    expect(await ctx.controlPlaneStore.spendNonce(claims, 1_800_000_000_000)).toBe(true)
    expect(await ctx.controlPlaneStore.spendNonce(claims, 1_800_000_000_000)).toBe(false)
  })

  it.each([
    // Each row is the variable and the entry that must refuse it. Two entries
    // read the public origin and two read the credential key, and the Loader
    // reports concurrent refusals only as a summary, so those cases accept it.
    ['CANDY_DATABASE_PATH', /storage-sqlite/u],
    ['CANDY_PUBLIC_ORIGIN', /oauth-sign-in-web|provider-account-api|loader fibers failed/u],
    ['CANDY_CONTROL_PLANE_ISSUER', /run-scheduler.*invalid config/su],
    ['CANDY_RUNTIME_AUDIENCE', /run-scheduler.*invalid config/su],
    ['CANDY_CREDENTIAL_KEY_VERSION', /run-scheduler|provider-account-api|loader fibers failed/u],
    ['CANDY_RUNTIME_POOL_BASE', /run-scheduler.*invalid config/su],
    ['CANDY_CREDENTIAL_KEY', /run-scheduler|provider-account-api|loader fibers failed/u],
    ['CANDY_ASSERTION_SECRET', /CANDY_ASSERTION_SECRET is not set/u],
    ['CANDY_OIDC_ISSUER', /oauth-sign-in-web/u],
    ['CANDY_OIDC_CLIENT_ID', /oauth-sign-in-web/u],
    ['CANDY_OIDC_JWKS_PATH', /oauth-sign-in-web/u],
  ])('refuses to start without %s', async (name, refusal) => {
    // A deployment missing one of these must not start half-configured: an
    // unset variable resolves to undefined and its plugin's schema refuses it.
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-app-'))

    const failure = await boot(root, { [name]: undefined }).catch((error: unknown) => error as Error)

    expect(failure).toBeInstanceOf(Error)
    // Naming the refusing entry is what keeps this from passing on a boot that
    // crashed for an unrelated reason — which is how a row that stopped
    // validating its config at all would otherwise go unnoticed.
    expect((failure as Error).message).toMatch(refusal)
  })
})
