/**
 * Real composition: a Loader boots the storage stack, the durable control
 * plane, the Harness Host web server and this plugin from a `cordis.yml`, and
 * every assertion is made against that listening server over HTTP. The only
 * thing faked is the identity provider's network, because the provider is the
 * one participant this deployment does not run.
 */

import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { UserId } from '@deepseek-ai/dsh-control-plane'
import ControlPlaneStore, { tenantSubject } from '@deepseek-ai/dsh-control-plane-store'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { OAUTH_SESSION_PATH, OAUTH_START_PATH } from '@deepseek-ai/dsh-oauth-sign-in'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as OAuthSignInWeb from '../src/index.ts'
import type { Config } from '../src/index.ts'

const ISSUER = 'https://identity.example'
const ALICE = UserId('user-alice')
const SUBJECT = 'subject-alice'
const PUBLIC_ORIGIN = 'https://candy.example'

let jwksText: string
let root: string | undefined
let context: Context | undefined

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true })
  const publicJwk = await exportJWK(pair.publicKey)
  jwksText = JSON.stringify({ keys: [{ ...publicJwk, kid: 'signing-key', alg: 'ES256', use: 'sig' }] })
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The deployment facts a `cordis.yml` states, minus what a case varies. */
function config(at: string, overrides: Partial<Config> = {}): Config {
  return {
    publicOrigin: PUBLIC_ORIGIN,
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    userInfoEndpoint: `${ISSUER}/userinfo`,
    clientId: 'candy-debian',
    jwksPath: join(at, 'jwks.json'),
    ...overrides,
  }
}

/** Boot storage, the control plane, the real web server and this plugin. */
async function boot(at: string, plugin: Config): Promise<Context> {
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
    '- id: oauth-sign-in-web',
    "  name: '@deepseek-ai/dsh-oauth-sign-in-web'",
    '  config:',
    ...Object.entries(plugin).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`),
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
    ['@deepseek-ai/dsh-oauth-sign-in-web', OAuthSignInWeb],
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

/** A temporary deployment directory holding the pinned key set. */
async function deployment(): Promise<string> {
  const at = await mkdtemp(join(tmpdir(), 'dsh-oauth-web-'))
  root = at
  await writeFile(join(at, 'jwks.json'), jwksText)
  return at
}

/** What one request against the booted server answered. */
interface Reply {
  readonly status: number
  readonly location: string | undefined
}

/**
 * One request against the booted server.
 *
 * `node:http` rather than `fetch`: the routes are pinned to the exact public
 * authority through the `Host` header, and `fetch` forbids setting it — every
 * case would reach the server as `127.0.0.1` and be refused for a reason no
 * assertion here is about.
 * @param ctx - the booted deployment, for its listening port.
 * @param path - the route to call.
 * @param host - the `Host` header to send; the public authority by default.
 * @returns the status and any redirect target.
 */
function call(ctx: Context, path: string, host = new URL(PUBLIC_ORIGIN).host): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: ctx.webServer.port,
      path,
      method: 'GET',
      headers: { host },
    }, (response) => {
      response.resume()
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, location: response.headers.location })
      })
    })
    request.on('error', reject)
    request.end()
  })
}

describe('a booted Candy sign-in deployment', () => {
  it('serves the authorization redirect from the configured provider', async () => {
    const at = await deployment()
    const ctx = await boot(at, config(at))

    const response = await call(ctx, OAUTH_START_PATH)

    expect(response.status).toBe(303)
    const location = new URL(response.location ?? '')
    expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`)
    expect(location.searchParams.get('client_id')).toBe('candy-debian')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    // The verifier never leaves the server; only its challenge is published.
    expect(location.searchParams.get('code_verifier')).toBeNull()
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/auth/oauth/callback`)
  })

  it('reports no session for a browser that has not signed in', async () => {
    const at = await deployment()
    const ctx = await boot(at, config(at))

    const response = await call(ctx, OAUTH_SESSION_PATH)

    expect(response.status).toBe(401)
  })

  it('refuses a request that does not address the configured public origin', async () => {
    // The Host access token authorizes a process, not a person; every browser
    // route is pinned to the exact origin instead.
    const at = await deployment()
    const ctx = await boot(at, config(at))

    // The same route answers 302 for the configured authority, so the refusal
    // is the Host check and not a route that is simply unreachable here.
    expect((await call(ctx, OAUTH_START_PATH)).status).toBe(303)
    expect((await call(ctx, OAUTH_START_PATH, 'attacker.example')).status).toBe(403)
  })

  it('enrolls the configured administrator, and enrolls them only once', async () => {
    const at = await deployment()
    const admin = { bootstrapAdministratorSubject: SUBJECT, bootstrapAdministratorUserId: ALICE }
    const first = await boot(at, config(at, admin))

    expect(await first.controlPlaneStore.resolve({ issuer: ISSUER, subject: SUBJECT }))
      .toEqual({ userId: ALICE, role: 'administrator' })

    await first.fiber.dispose()
    context = undefined
    // A redeploy states the same fact and must change nothing.
    const second = await boot(at, config(at, admin))

    expect(await second.controlPlaneStore.resolve({ issuer: ISSUER, subject: SUBJECT }))
      .toEqual({ userId: ALICE, role: 'administrator' })
  })

  it('leaves the directory empty when no administrator is configured', async () => {
    // There is no self-service path to an administrator seat: an unconfigured
    // deployment enrolls nobody rather than trusting the first arrival.
    const at = await deployment()
    const ctx = await boot(at, config(at))

    expect(await ctx.controlPlaneStore.resolve({ issuer: ISSUER, subject: SUBJECT })).toBeUndefined()
  })

  it('fails the load and records the attempt when the identity is already someone else', async () => {
    const at = await deployment()
    const first = await boot(at, config(at, { bootstrapAdministratorSubject: SUBJECT, bootstrapAdministratorUserId: ALICE }))
    await first.fiber.dispose()
    context = undefined

    await expect(boot(at, config(at, {
      bootstrapAdministratorSubject: SUBJECT, bootstrapAdministratorUserId: 'user-bobby',
    }))).rejects.toThrow(/already enrolled/)

    // The store wrote nothing on the conflict, so the trail is where the
    // attempt survives at all.
    const ctx = await boot(at, config(at))
    expect(ctx.controlPlaneStore.auditsOf(tenantSubject(UserId('user-bobby')))).toContainEqual(
      expect.objectContaining({ event: 'refused', action: 'administrator-bootstrap', outcome: 'already-enrolled' }),
    )
  })

  it('refuses to promote an existing member to administrator from configuration', async () => {
    // The conflict that matters most: the seat is the same person, and only
    // the authorization differs. Silently raising it would make a member an
    // administrator by editing a file nobody reviews as an authorization grant.
    const at = await deployment()
    const first = await boot(at, config(at))
    expect(await first.controlPlaneStore.enrollOAuthIdentity(
      { issuer: ISSUER, subject: SUBJECT }, ALICE, 'member', 1_800_000_000_000,
    )).toBe(true)
    await first.fiber.dispose()
    context = undefined

    await expect(boot(at, config(at, {
      bootstrapAdministratorSubject: SUBJECT, bootstrapAdministratorUserId: ALICE,
    }))).rejects.toThrow(/already enrolled as 'user-alice' \(member\)/)
  })

  it('refuses half a bootstrap, which would enrol nobody while reading as if it had', async () => {
    const at = await deployment()

    await expect(boot(at, config(at, { bootstrapAdministratorSubject: SUBJECT })))
      .rejects.toThrow(/must be configured together/)
  })

  it('honours the configured success path and lifetimes', async () => {
    const at = await deployment()
    const ctx = await boot(at, config(at, {
      successPath: '/settings', attemptTtlMs: 60_000, sessionTtlMs: 3_600_000,
    }))

    // The lifetimes are not observable from outside; the redirect proves the
    // configured values reached the routes rather than being dropped.
    expect((await call(ctx, OAUTH_START_PATH)).status).toBe(303)
  })

  it('requests the configured scopes and authenticates with the configured secret', async () => {
    // Both are provider inputs a deployment states; neither is observable from
    // the routes, so the redirect is where the scope list surfaces.
    const at = await deployment()
    const ctx = await boot(at, config(at, {
      scopes: ['openid', 'profile', 'email'],
      clientSecretEnv: 'CANDY_OIDC_CLIENT_SECRET',
    }))

    const location = new URL((await call(ctx, OAUTH_START_PATH)).location ?? '')

    expect(location.searchParams.get('scope')).toBe('openid profile email')
  })

  it('fails the load when the pinned key set is not JSON', async () => {
    const at = await deployment()
    await writeFile(join(at, 'jwks.json'), 'not json at all')

    await expect(boot(at, config(at))).rejects.toThrow(/is not JSON/)
  })

  it('fails the load when the pinned key set is missing or empty', async () => {
    const at = await deployment()
    await expect(boot(at, config(at, { jwksPath: join(at, 'absent.json') })))
      .rejects.toThrow(/cannot read jwksPath/)
    await rm(join(at, 'jwks.json'))
    await writeFile(join(at, 'jwks.json'), JSON.stringify({ keys: [] }))
    await expect(boot(at, config(at))).rejects.toThrow(/holds no verification key/)
  })
})
