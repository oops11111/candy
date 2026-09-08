/**
 * Two Candy deployments over one control-plane database, both alive.
 *
 * This is the shape the deployment page describes for a canary and for a
 * second runtime, and it is not the restart case the store already covers: a
 * restart reloads from disk, while a live second process has been holding its
 * own view since it opened. What propagates between them, and what does not,
 * is a property of the medium rather than of any one plugin — so it is checked
 * here, where the medium is chosen.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { UserId } from '@deepseek-ai/dsh-control-plane'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ControlPlaneStore from '@deepseek-ai/dsh-control-plane-store'
import RunScheduler from '@deepseek-ai/dsh-run-scheduler'
import ProviderCredentialChecks from '@deepseek-ai/dsh-provider-credential-checks'
import WorkspaceGrantExecution from '@deepseek-ai/dsh-workspace-grant-execution'
import * as OauthSignInWeb from '@deepseek-ai/dsh-oauth-sign-in-web'
import * as ProviderAccountApi from '@deepseek-ai/dsh-provider-account-api'
import { afterEach, describe, expect, it } from 'vitest'

const PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const NOW = 1_800_000_000_000
const ALICE = UserId('user-alice')

const MODULES = new Map<string, unknown>([
  ['@deepseek-ai/dsh-storage', Storage],
  ['@deepseek-ai/dsh-storage-json', StorageJson],
  ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
  ['@deepseek-ai/dsh-storage-domain', StorageDomain],
  ['@deepseek-ai/dsh-host-webserver', WebServer],
  ['@deepseek-ai/dsh-control-plane-store', ControlPlaneStore],
  ['@deepseek-ai/dsh-run-scheduler', RunScheduler],
  ['@deepseek-ai/dsh-provider-credential-checks', ProviderCredentialChecks],
  ['@deepseek-ai/dsh-workspace-grant-execution', WorkspaceGrantExecution],
  ['@deepseek-ai/dsh-oauth-sign-in-web', OauthSignInWeb],
  ['@deepseek-ai/dsh-provider-account-api', ProviderAccountApi],
  ['@deepseek-ai/dsh-client-ui-settings-candy-account', { apply() {} }],
])

let root: string | undefined
const running: Context[] = []
let restore: (() => void) | undefined

afterEach(async () => {
  for (const ctx of running.splice(0)) await ctx.fiber.dispose()
  restore?.()
  restore = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Stage the deployment environment shared by both processes.
 *
 * Each process gets its own runtime audience, exactly as the deployment page
 * requires: sharing one is what lets a runtime admit assertions minted for
 * another.
 * @param at - the directory the shared deployment lives in.
 * @returns the undo for the staged environment.
 */
async function stage(at: string): Promise<() => void> {
  const jwks = join(at, 'oidc-jwks.json')
  await writeFile(jwks, `${JSON.stringify({
    keys: [{ kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0', kid: 'candy-test', alg: 'ES256', use: 'sig' }],
  })}\n`)
  const values: Record<string, string> = {
    CANDY_DATABASE_PATH: join(at, 'candy.db'),
    CANDY_PUBLIC_ORIGIN: 'https://candy.example',
    CANDY_CONTROL_PLANE_ISSUER: 'candy-control-plane',
    CANDY_RUNTIME_AUDIENCE: 'candy-runtime-1',
    CANDY_CREDENTIAL_KEY_VERSION: '2026-09-a',
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
  const previous = new Map(Object.keys(values).map(name => [name, process.env[name]]))
  Object.assign(process.env, values)
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

/**
 * Boot one more deployment over the shared directory.
 * @param at - the shared deployment directory.
 * @param instance - a name distinguishing this process's own files.
 * @returns the settled root context.
 */
async function boot(at: string, instance: string): Promise<Context> {
  const configPath = join(at, `cordis-${instance}.yml`)
  await writeFile(configPath, [
    '- id: timer',
    "  name: '@deepseek-ai/cordis-plugin-timer'",
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: storage-json',
    "  name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(at, `storages-${instance}`))}`,
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
  running.push(ctx)
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
    config: { path: pathToFileURL(configPath).href, patches: loadOverlayPatches('candy-app two-process spec', PATCH) },
  })
  await ctx.loader.await()
  return ctx
}

describe('two Candy deployments over one control plane', () => {
  it('spends one tenant\'s nonce exactly once across both', async () => {
    // The reason the layer routes this domain to SQLite: a nonce that both
    // processes accept is a replayed execution assertion that both admit.
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-two-'))
    restore = await stage(root)
    const first = await boot(root, 'a')
    const second = await boot(root, 'b')
    const claims = {
      issuer: 'candy-control-plane',
      audience: 'candy-runtime-1',
      userId: ALICE,
      deviceId: 'device-1',
      accountId: 'account-1',
      provider: 'claude-cli' as const,
      workspaceGrantId: 'grant-1',
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      runId: 'run-1',
      parentRunId: undefined,
      nonce: 'nonce-1',
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    } as unknown as Parameters<ControlPlaneStore['spendNonce']>[0]

    expect(await first.controlPlaneStore.spendNonce(claims, NOW)).toBe(true)
    expect(await second.controlPlaneStore.spendNonce(claims, NOW)).toBe(false)
  })

  it('does not show one process a browser session the other revoked', async () => {
    // A live process authenticates from the view it has held since it opened,
    // so a revocation elsewhere does not reach it. The deployment page's
    // canary shape is safe because each process owns its own database; two
    // processes over ONE database do not share a logout, and that is what this
    // pins rather than what it wishes were true.
    root = await mkdtemp(join(tmpdir(), 'dsh-candy-two-'))
    restore = await stage(root)
    const issuer = await boot(root, 'a')
    const created = await issuer.controlPlaneStore.createUserSession(
      ALICE, 'member', { issuer: 'https://identity.example', subject: 'external-alice' }, NOW, NOW + 3_600_000,
    )

    const other = await boot(root, 'b')
    expect(other.controlPlaneStore.authenticateUserSession(created.token, NOW)).toMatchObject({ userId: ALICE })

    expect(await issuer.controlPlaneStore.revokeUserSession(created.record.id, NOW + 1)).toBe(true)
    expect(issuer.controlPlaneStore.authenticateUserSession(created.token, NOW + 2)).toBeUndefined()

    // The second process still admits it. A deployment that logs a user out
    // must therefore not run two processes over one database, or must accept
    // that a revocation takes effect there only after a restart.
    expect(other.controlPlaneStore.authenticateUserSession(created.token, NOW + 2)).toMatchObject({ userId: ALICE })

    const restarted = await boot(root, 'c')
    expect(restarted.controlPlaneStore.authenticateUserSession(created.token, NOW + 2)).toBeUndefined()
  })
})
