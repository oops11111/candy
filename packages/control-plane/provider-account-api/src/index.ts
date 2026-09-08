/**
 * The six provider-account operations, mounted on the authenticated Candy
 * management envelope.
 *
 * No domain logic lives here. `dsh-provider-accounts` already creates, lists,
 * selects a default for, validates, revokes and deletes an account, and each
 * of its operations takes the tenant and refuses an id that tenant does not
 * own. What this module adds is the transport: which path, which method,
 * which least role, how a domain refusal becomes a status, and — the point of
 * the whole layer — that the tenant those operations receive is the one the
 * session established and never one a request carried.
 *
 * A credential goes in and never comes back. The store holds a sealed
 * envelope, `ProviderAccountView` has no field for a secret, and every reply
 * here is built from that view.
 *
 * @module @deepseek-ai/dsh-provider-account-api
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { ProviderAccountId, type UserId } from '@deepseek-ai/dsh-control-plane'
import type {} from '@deepseek-ai/dsh-provider-credential-checks'
import { tenantSubject, type RunAuditRecord } from '@deepseek-ai/dsh-control-plane-store'
import { assembleKeyring, type CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'
import {
  createProviderAccount,
  deleteProviderAccount,
  listProviderAccounts,
  ProviderAccountError,
  revokeProviderAccount,
  selectDefaultProviderAccount,
  validateProviderAccount,
  type ProviderAccountStore,
  type ProviderAccountView,
} from '@deepseek-ai/dsh-provider-accounts'
import {
  registerApiRoute,
  type ApiHost,
  type ApiResult,
  type ApiWebServer,
} from '@deepseek-ai/dsh-control-plane-api'

export { ACCOUNT_PATHS } from './types.ts'
export type { CreateAccountRequest, SelectAccountRequest } from './types.ts'

import { ACCOUNT_PATHS, type CreateAccountRequest, type SelectAccountRequest } from './types.ts'

/**
 * Longest secret this API accepts, in UTF-16 code units.
 *
 * Provider credentials are keys and tokens, not documents. The cap is far
 * above any real one and far below anything worth sealing, so a body that
 * passes the envelope's own limit still cannot store an arbitrary blob under
 * a tenant's account.
 */
export const MAX_SECRET_LENGTH = 4096

/** Providers a tenant may hold an account for. */
const PROVIDERS: ReadonlySet<string> = new Set(['deepseek-api', 'claude-cli', 'codex-cli'])

/** Cordis plugin name. */
export const name = 'provider-account-api'

/** The envelope's authority, the socket, and the durable store must all exist. */
export const inject = ['webServer', 'controlPlaneStore', 'providerCredentialChecks']

/** Deployment-owned facts this API needs beyond what the envelope carries. */
export interface Config {
  /** Exact externally visible HTTPS origin, matching what sign-in was configured with. */
  publicOrigin: string
  /** Keyring version a newly sealed credential is stamped with. */
  credentialKeyVersion: string
  /** Environment variable holding the current credential key. */
  credentialKeyEnv: string
  /** Retained key versions this deployment still opens, so an older envelope stays readable. */
  retiredCredentialKeys: {
    /** Version the envelopes sealed under this key name. */
    version: string
    /** Environment variable holding that key. */
    env: string
  }[]
  /** Most audit records kept per tenant. */
  auditRetention: number
}

export const Config: z<Config> = z.object({
  publicOrigin: z.string().required(),
  credentialKeyVersion: z.string().required(),
  credentialKeyEnv: z.string().role('credential-ref').default('CANDY_CREDENTIAL_KEY'),
  retiredCredentialKeys: z.array(z.object({
    version: z.string().required(),
    env: z.string().role('credential-ref').required(),
  })).default([]),
  auditRetention: z.number().step(1).min(1).default(200),
})

/**
 * Map one domain refusal onto a reply.
 *
 * `not-found` covers both an id that was never issued and one belonging to
 * another tenant — `dsh-provider-accounts` answers the same for each — so the
 * status this produces cannot confirm an id to whoever guessed it. Every other
 * code describes the caller's own account in a state that refuses the
 * operation, which is a fact it is entitled to, and the domain error's own
 * message is documented as safe to return from an authenticated API.
 */
function refusalOf(error: ProviderAccountError): ApiResult {
  if (error.code === 'not-found') return { kind: 'notFound' }
  return { kind: 'invalid', reason: error.message }
}

/** Run one domain operation, turning its documented refusals into replies. */
async function attempt(operation: () => Promise<ApiResult>): Promise<ApiResult> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ProviderAccountError) return refusalOf(error)
    throw error
  }
}

/** The account id a request names, or `undefined` when it named none usable. */
function requestedId(body: unknown): ProviderAccountId | undefined {
  const id = (body as SelectAccountRequest | undefined)?.id
  if (typeof id !== 'string' || id.trim() === '' || id.length > 200) return undefined
  return ProviderAccountId(id)
}

/**
 * Read one create request.
 *
 * Every field is checked here rather than trusted to the domain, because the
 * secret reaches a sealing operation and the label reaches durable storage:
 * both are caller-supplied and neither is validated by the transport.
 * @param body - the parsed JSON body.
 * @returns the request, or the reason it is not one.
 */
function createRequest(body: unknown): CreateAccountRequest | string {
  const input = body as Partial<CreateAccountRequest> | undefined
  if (typeof input?.provider !== 'string' || !PROVIDERS.has(input.provider)) return 'unknown provider'
  // The label's own rule is `dsh-provider-accounts`', and it reports a refusal
  // this layer forwards; only its type is this layer's to establish.
  if (typeof input.label !== 'string') return 'label is required'
  if (typeof input.secret !== 'string' || input.secret === '') return 'secret is required'
  if (input.secret.length > MAX_SECRET_LENGTH) return 'secret is too long'
  if (input.isDefault !== undefined && typeof input.isDefault !== 'boolean') return 'isDefault must be a boolean'
  return {
    provider: input.provider,
    label: input.label,
    secret: input.secret,
    ...input.isDefault === undefined ? {} : { isDefault: input.isDefault },
  }
}

/**
 * Mount the six account operations.
 * @param ctx - the plugin context; the web server, store and checks are injected.
 * @param config - the deployment's origin and credential keyring facts.
 */
export function apply(ctx: Context, config: Config): void {
  const keyring: CredentialKeyring = assembleKeyring({
    component: 'dsh-provider-account-api',
    environment: process.env,
    currentVersion: config.credentialKeyVersion,
    currentEnv: config.credentialKeyEnv,
    retired: config.retiredCredentialKeys,
  })
  const retain = config.auditRetention
  const store: ProviderAccountStore = ctx.controlPlaneStore

  const host: ApiHost = {
    publicOrigin: config.publicOrigin,
    sessions: ctx.controlPlaneStore,
    audit: async (event) => {
      const record: RunAuditRecord = {
        at: Date.now(),
        userId: event.userId,
        event: 'refused',
        action: event.action,
        outcome: event.outcome,
      }
      // Every management operation is recorded, successes included: an
      // operator investigating a revoked account needs to see who revoked it,
      // not only the attempts that failed.
      await ctx.controlPlaneStore.recordAudit(tenantSubject(event.userId), [record], retain).catch((error: unknown) => {
        ctx.logger.warn(`provider-account-api: could not record '${event.action}': ${String(error)}`)
      })
    },
    log: (rejection, path) => {
      ctx.logger.info(`provider-account-api: refused ${path} (${rejection})`)
    },
  }

  /** Record the vault's own audits for one mutation, beside the API's. */
  const fileVaultAudits = async (userId: UserId, audits: readonly { action: string; outcome: string }[]): Promise<void> => {
    // An empty batch is written as one: the store documents it as a no-op, so
    // a guard here would be a second answer to a question already settled.
    const records: RunAuditRecord[] = audits.map(audit => ({
      at: Date.now(), userId, event: 'credential', action: audit.action, outcome: audit.outcome,
    }))
    await ctx.controlPlaneStore.recordAudit(tenantSubject(userId), records, retain).catch((error: unknown) => {
      ctx.logger.warn(`provider-account-api: could not record a vault operation: ${String(error)}`)
    })
  }

  /** One account as a client reads it; no field of the view carries a secret. */
  const view = (account: ProviderAccountView): ApiResult => ({ kind: 'json', status: 200, body: account })

  const routes = [
    {
      path: ACCOUNT_PATHS.list,
      methods: ['GET'],
      role: 'member' as const,
      action: 'accounts.list',
      handle: async (actor: { userId: UserId }): Promise<ApiResult> => ({
        kind: 'json',
        status: 200,
        body: await listProviderAccounts(store, actor.userId),
      }),
    },
    {
      path: ACCOUNT_PATHS.create,
      methods: ['POST'],
      role: 'member' as const,
      action: 'accounts.create',
      // The secret dominates this body; the cap leaves room for it and the
      // label and nothing that would make the request a document.
      maxBodyBytes: MAX_SECRET_LENGTH + 2048,
      handle: async (actor: { userId: UserId }, body: unknown): Promise<ApiResult> => {
        const request = createRequest(body)
        if (typeof request === 'string') return { kind: 'invalid', reason: request }
        return attempt(async () => {
          const created = await createProviderAccount(store, keyring, {
            // The id is minted here, not accepted: an id a caller chose could
            // collide with another tenant's and would be refused as
            // `account-already-exists`, reporting that theirs exists.
            id: ProviderAccountId(randomUUID()),
            userId: actor.userId,
            provider: request.provider,
            label: request.label,
            secret: Buffer.from(request.secret, 'utf8'),
            makeDefault: request.isDefault ?? false,
          }, Date.now())
          await fileVaultAudits(actor.userId, created.audits)
          return { kind: 'json', status: 201, body: created.value }
        })
      },
    },
    {
      path: ACCOUNT_PATHS.validate,
      methods: ['POST'],
      role: 'member' as const,
      action: 'accounts.validate',
      handle: async (actor: { userId: UserId }, body: unknown): Promise<ApiResult> => {
        const id = requestedId(body)
        if (id === undefined) return { kind: 'invalid', reason: 'id is required' }
        return attempt(async () => {
          const checked = await validateProviderAccount(
            store, keyring, actor.userId, id,
            (provider, secret) => ctx.providerCredentialChecks.check(provider, secret),
            Date.now(),
          )
          await fileVaultAudits(actor.userId, checked.audits)
          return { kind: 'json', status: 200, body: checked.value }
        })
      },
    },
    {
      path: ACCOUNT_PATHS.default,
      methods: ['POST'],
      role: 'member' as const,
      action: 'accounts.default',
      handle: async (actor: { userId: UserId }, body: unknown): Promise<ApiResult> => {
        const id = requestedId(body)
        if (id === undefined) return { kind: 'invalid', reason: 'id is required' }
        return attempt(async () => view(await selectDefaultProviderAccount(store, actor.userId, id, Date.now())))
      },
    },
    {
      path: ACCOUNT_PATHS.revoke,
      methods: ['POST'],
      role: 'member' as const,
      action: 'accounts.revoke',
      handle: async (actor: { userId: UserId }, body: unknown): Promise<ApiResult> => {
        const id = requestedId(body)
        if (id === undefined) return { kind: 'invalid', reason: 'id is required' }
        return attempt(async () => {
          const revoked = await revokeProviderAccount(store, actor.userId, id, Date.now())
          await fileVaultAudits(actor.userId, revoked.audits)
          return view(revoked.value)
        })
      },
    },
    {
      path: ACCOUNT_PATHS.delete,
      methods: ['POST'],
      role: 'member' as const,
      action: 'accounts.delete',
      handle: async (actor: { userId: UserId }, body: unknown): Promise<ApiResult> => {
        const id = requestedId(body)
        if (id === undefined) return { kind: 'invalid', reason: 'id is required' }
        return attempt(async () => {
          const removed = await deleteProviderAccount(store, actor.userId, id, Date.now())
          await fileVaultAudits(actor.userId, removed.audits)
          return view(removed.value)
        })
      },
    },
  ]

  const server: ApiWebServer = ctx.webServer
  for (const route of routes) ctx.effect(() => registerApiRoute(server, host, route), `providerAccountApi.${route.action}`)
}
