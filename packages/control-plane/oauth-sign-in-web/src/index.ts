/**
 * The deployment face of Candy browser sign-in: it mounts the authorization
 * routes on the Harness Host web server and enrolls the first administrator.
 *
 * Everything it composes already existed as a library. `dsh-oauth-sign-in`
 * owns the PKCE callback, the session cookies and the four routes;
 * `createOidcUserInfoProvider` owns ID Token verification;
 * `ControlPlaneStore` owns the durable attempts, sessions and identity
 * directory; `dsh-host-webserver` owns the socket. What did not exist was a
 * composition: every one of those was reachable only from a test, so no
 * deployment could sign a person in.
 *
 * The identity directory is the reason this plugin also enrolls. Sign-in
 * resolves a verified issuer and subject through `ControlPlaneStore.resolve`,
 * and an empty directory resolves nobody — a correctly configured deployment
 * would refuse every person who signed in, including the operator who has to
 * enrol the rest. There is deliberately no self-service path to that first
 * enrollment: it is a configured fact an operator states offline, by exact
 * issuer and subject, and never something a browser can ask for.
 *
 * @module @deepseek-ai/dsh-oauth-sign-in-web
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { UserId, type OAuthIdentity } from '@deepseek-ai/dsh-control-plane'
import { tenantSubject, type RunAuditRecord } from '@deepseek-ai/dsh-control-plane-store'
import {
  createOidcUserInfoProvider,
  registerOAuthHttpRoutes,
} from '@deepseek-ai/dsh-oauth-sign-in'

/** Cordis plugin name. */
export const name = 'oauth-sign-in-web'

/**
 * The socket and the durable authority must both exist before routes mount.
 *
 * `credentials` is not injected: a deployment that puts the client secret in
 * the process environment needs no credential service, and the optional read
 * goes through `ctx.get`.
 */
export const inject = ['webServer', 'controlPlaneStore']

/** Deployment-owned sign-in configuration. */
export interface Config {
  /** Exact externally visible HTTPS origin browsers reach this deployment at. */
  publicOrigin: string
  /** OIDC issuer identifier, exactly as the provider publishes it. */
  issuer: string
  /** The provider's authorization endpoint. */
  authorizationEndpoint: string
  /** The provider's token endpoint. */
  tokenEndpoint: string
  /** The provider's UserInfo endpoint. */
  userInfoEndpoint: string
  /** This deployment's registered OIDC client identifier. */
  clientId: string
  /**
   * File holding the JSON Web Key Set this deployment verifies ID Tokens with.
   *
   * A path rather than inline keys: the set is the deployment's trust anchor
   * and rotating it is an operator action on one file, which also keeps a key
   * blob out of a configuration file that is read for other reasons.
   */
  jwksPath: string
  /**
   * Environment variable holding the OIDC client secret.
   *
   * Read through the credential seam at load, never stored in this config and
   * never logged. A public client that authenticates with PKCE alone omits it.
   */
  clientSecretEnv?: string
  /** Scope tokens requested; `openid` is mandatory. */
  scopes?: string[]
  /** Relative destination after a successful callback. */
  successPath?: string
  /** PKCE transaction lifetime in milliseconds. */
  attemptTtlMs?: number
  /** Browser user-session lifetime in milliseconds. */
  sessionTtlMs?: number
  /**
   * The provider's exact subject claim for the administrator enrolled at load.
   *
   * It is the subject and not an email or a name because those are
   * re-assignable at most providers, and an identity that can be re-assigned
   * is an administrator seat that can be inherited. Omitting this pair leaves
   * the directory as it stands, which is the steady state once the first
   * administrator exists and has enrolled everyone else.
   */
  bootstrapAdministratorSubject?: string
  /** The Candy user that subject signs in as; every tenant-owned record is keyed by it. */
  bootstrapAdministratorUserId?: string
}

export const Config: z<Config> = z.object({
  publicOrigin: z.string().required(),
  issuer: z.string().required(),
  authorizationEndpoint: z.string().required(),
  tokenEndpoint: z.string().required(),
  userInfoEndpoint: z.string().required(),
  clientId: z.string().required(),
  jwksPath: z.string().required(),
  clientSecretEnv: z.string().role('credential-ref'),
  scopes: z.array(z.string()),
  successPath: z.string(),
  attemptTtlMs: z.number().step(1).min(1),
  sessionTtlMs: z.number().step(1).min(1),
  bootstrapAdministratorSubject: z.string(),
  bootstrapAdministratorUserId: z.string(),
})

/**
 * Read one configured string, treating blank as unconfigured.
 *
 * A schemastery string field arrives as an empty string when a `cordis.yml`
 * names the key and leaves it blank, and an empty subject is not an
 * administrator this deployment can enrol.
 * @param value - the configured value, if the key was present at all.
 * @returns the trimmed value, or `undefined` when nothing was configured.
 */
function blankToAbsent(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** Retained audit records per subject, matching what the scheduler keeps. */
const AUDIT_RETENTION = 200

/**
 * Read the verification keys this deployment pins.
 *
 * A set that cannot be read, parsed, or that holds no key fails the load: it
 * is the trust anchor for every ID Token, and a deployment that mounted
 * sign-in without one would verify nothing.
 * @param path - the configured JWKS file.
 * @returns the parsed key set.
 * @throws Error when the file is unreadable, not JSON, or holds no key.
 */
async function readJwks(path: string): Promise<{ keys: Record<string, unknown>[] }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`oauth-sign-in-web: cannot read jwksPath ${JSON.stringify(path)}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`oauth-sign-in-web: jwksPath ${JSON.stringify(path)} is not JSON: ${String(error)}`)
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`oauth-sign-in-web: jwksPath ${JSON.stringify(path)} holds no verification key`)
  }
  return { keys: keys as Record<string, unknown>[] }
}

/**
 * Enrol the configured administrator, exactly once and never over somebody
 * else.
 *
 * Three states, and the third is the one this exists for. An unenrolled
 * identity is created. An identity already enrolled as this same user and
 * role is the idempotent case: a second boot, a redeploy, a restart, none of
 * which should change anything or report a problem. An identity enrolled as
 * anyone else is a conflict — the configuration says this person is the
 * administrator and the directory says they are somebody else — so it fails
 * the load and leaves a record behind, because `enrollOAuthIdentity` writes
 * nothing on a conflict and the attempt would otherwise vanish.
 *
 * @param ctx - the plugin's context, for the store and the log.
 * @param identity - the issuer and subject an operator configured.
 * @param userId - the Candy user that identity signs in as.
 * @param now - epoch milliseconds recorded on the enrollment.
 * @throws Error when the identity is already enrolled as another user or role.
 */
async function enrolAdministrator(
  ctx: Context,
  identity: OAuthIdentity,
  userId: UserId,
  now: number,
): Promise<void> {
  const store = ctx.controlPlaneStore
  if (await store.enrollOAuthIdentity(identity, userId, 'administrator', now)) {
    ctx.logger.info(
      `oauth-sign-in-web: enrolled the first administrator '${userId}' for subject '${identity.subject}'`,
    )
    return
  }
  const held = await store.resolve(identity)
  /* v8 ignore next 3 -- the enrollment was refused because a record exists, and
   * `resolve` reads that same table, so the held seat is always readable here. */
  if (held === undefined) {
    throw new Error(`oauth-sign-in-web: the seat enrolled for subject '${identity.subject}' is unreadable`)
  }
  if (held.userId === userId && held.role === 'administrator') return

  const record: RunAuditRecord = {
    at: now,
    userId,
    event: 'refused',
    action: 'administrator-bootstrap',
    outcome: 'already-enrolled',
  }
  await store.recordAudit(tenantSubject(userId), [record], AUDIT_RETENTION)
  throw new Error(
    `oauth-sign-in-web: subject '${identity.subject}' at '${identity.issuer}' is already enrolled as `
    + `'${held.userId}' (${held.role}); refusing to re-assign an administrator seat from configuration`,
  )
}

/**
 * Read the OIDC client secret for one code exchange.
 *
 * Resolution is per exchange, not per load: the credential seam's own rule is
 * that a consumer re-resolves at each operation, which is what lets a rotated
 * secret reach the next sign-in without a restart. The credential service is
 * optional — a deployment that puts the secret in the process environment
 * composes no provider — so the environment is read when nothing answers.
 *
 * The value is never logged and never returned to a caller other than the
 * token request that needs it.
 *
 * @param ctx - the plugin context, for the optional credential service.
 * @param env - the configured environment-variable name holding the secret.
 * @returns the secret in force at this moment.
 * @throws Error when neither source has a non-empty value.
 */
export function clientSecretLoader(ctx: Context, env: string): () => Promise<string> {
  return async () => {
    const resolved = await ctx.get('credentials')?.resolve(credentialRef(env))
    const value = resolved?.value ?? process.env[env]
    if (value === undefined || value === '') {
      throw new Error(`oauth-sign-in-web: the OIDC client secret in ${env} is not configured`)
    }
    return value
  }
}

/**
 * Mount browser sign-in and enrol the configured administrator.
 * @param ctx - the plugin context; the web server and store are injected.
 * @param config - the deployment's provider, origin and enrollment facts.
 * @returns resolution once the routes are registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const jwks = await readJwks(config.jwksPath)
  const secretEnv = config.clientSecretEnv
  const provider = createOidcUserInfoProvider({
    issuer: config.issuer,
    authorizationEndpoint: config.authorizationEndpoint,
    tokenEndpoint: config.tokenEndpoint,
    userInfoEndpoint: config.userInfoEndpoint,
    clientId: config.clientId,
    jwks,
    // An empty array is what a `cordis.yml` that never named the key
    // produces, and it is not a scope list the provider would accept.
    ...config.scopes === undefined || config.scopes.length === 0 ? {} : { scopes: config.scopes },
    ...secretEnv === undefined ? {} : { loadClientSecret: clientSecretLoader(ctx, secretEnv) },
  })

  const subject = blankToAbsent(config.bootstrapAdministratorSubject)
  const userId = blankToAbsent(config.bootstrapAdministratorUserId)
  if ((subject === undefined) !== (userId === undefined)) {
    throw new Error(
      'oauth-sign-in-web: bootstrapAdministratorSubject and bootstrapAdministratorUserId are one fact and '
      + 'must be configured together; half of it would enrol nobody while reading as if it had',
    )
  }
  if (subject !== undefined && userId !== undefined) {
    await enrolAdministrator(ctx, { issuer: config.issuer, subject }, UserId(userId), Date.now())
  }

  ctx.effect(() => registerOAuthHttpRoutes(ctx.webServer, ctx.controlPlaneStore, provider, {
    publicOrigin: config.publicOrigin,
    ...config.successPath === undefined ? {} : { successPath: config.successPath },
    ...config.attemptTtlMs === undefined ? {} : { attemptTtlMs: config.attemptTtlMs },
    ...config.sessionTtlMs === undefined ? {} : { sessionTtlMs: config.sessionTtlMs },
  }), 'oauthSignInWeb.routes')
}
