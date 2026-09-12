/**
 * The five device operations: three a tenant performs from their browser
 * session, the pairing-code exchange, and bearer-token authentication.
 *
 * No domain logic lives here. `dsh-device-registry` issues a code, exchanges
 * one, lists a tenant's devices and revokes one, and each of its operations
 * takes the tenant and refuses an id that tenant does not own. What this
 * module adds is the transport: which path, which method, how a domain
 * refusal becomes a status, and — for the three session routes — that the
 * tenant those operations receive is the one the session established and
 * never one a request carried.
 *
 * The exchange is the exception, and deliberately so. A Harness Host holds no
 * browser session and has not been anyone yet; the code in its body is its
 * whole claim, and the tenant it becomes bound to is the one that issued that
 * code. It is registered through `registerAnonymousRoute`, which hands the
 * handler no `Actor` at all, so the rule that an `Actor` means an
 * authenticated session survives unchanged.
 *
 * A code and a token each appear in exactly one reply and are never readable
 * again; the medium holds only their digests.
 *
 * @module @deepseek-ai/dsh-device-api
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { DeviceId, type UserId } from '@deepseek-ai/dsh-control-plane'
import { tenantSubject, type RunAuditRecord } from '@deepseek-ai/dsh-control-plane-store'
import {
  consumePairingCode,
  authenticateDevice,
  DeviceRegistryError,
  issuePairingCode,
  listDevices,
  listPairingCodes,
  MAX_DEVICE_LABEL_LENGTH,
  revokeDevice,
  type DeviceRegistryStore,
} from '@deepseek-ai/dsh-device-registry'
import {
  registerAnonymousRoute,
  registerApiRoute,
  type ApiHost,
  type ApiResult,
  type ApiWebServer,
} from '@deepseek-ai/dsh-control-plane-api'

export { DEVICE_PATHS } from './types.ts'
export type {
  AuthenticatedDevice, DeviceCredential, ExchangeCodeRequest, IssuedPairingCode, PairDeviceRequest,
  RevokeDeviceRequest,
} from './types.ts'

import {
  DEVICE_PATHS,
  type AuthenticatedDevice,
  type DeviceCredential,
  type IssuedPairingCode,
} from './types.ts'

/**
 * Alphabet one pairing code is spelled in.
 *
 * Thirty-two glyphs with no `I`, `L`, `O` or `U`: the first three are read
 * back as `1`, `1` and `0` by whoever types the code, and the fourth turns a
 * random code into a word often enough to matter. The size is also what makes
 * the selection below unbiased.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Glyphs in one pairing code, five bits each.
 *
 * Sixteen of them is eighty bits, which is not a tunable: the code is a bearer
 * credential a host presents over the public internet with nothing beside it,
 * and no rate limit stands between a guess and an attempt. Eighty bits is what
 * makes guessing one within its lifetime impossible rather than merely slow.
 */
const CODE_LENGTH = 16

/** Bytes of entropy in one device token. */
const TOKEN_BYTES = 32

/** Longest pairing code this API will even normalize, in UTF-16 code units. */
const MAX_SUBMITTED_CODE_LENGTH = 200

/** A 256-bit base64url device token has exactly this many glyphs. */
const DEVICE_TOKEN_LENGTH = 43

/** Cordis plugin name. */
export const name = 'device-api'

/** The envelope's authority, the socket, and the durable store must all exist. */
export const inject = ['webServer', 'controlPlaneStore']

/** Deployment-owned facts this API needs beyond what the envelope carries. */
export interface Config {
  /** Exact externally visible HTTPS origin, matching what sign-in was configured with. */
  publicOrigin: string
  /**
   * How long an issued pairing code stays exchangeable, in milliseconds.
   *
   * It is the time a person needs to carry the code to the machine, which is
   * a minute in one deployment and an afternoon in another.
   */
  pairingCodeTtlMs: number
  /** Most audit records kept per tenant. */
  auditRetention: number
}

export const Config: z<Config> = z.object({
  publicOrigin: z.string().required(),
  pairingCodeTtlMs: z.number().step(1).min(30_000).max(86_400_000).default(900_000),
  auditRetention: z.number().step(1).min(1).default(200),
})

/**
 * Mint one pairing code.
 *
 * Each glyph is five bits taken from a cryptographic byte. The alphabet's size
 * divides 256 exactly, so masking introduces no bias toward its first glyphs —
 * which a remainder against a 26- or 36-glyph alphabet would.
 * @returns the code, in groups of four for whoever has to read it aloud.
 */
function mintCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  const glyphs = [...bytes].map(byte => CODE_ALPHABET[byte & 31])
  const groups: string[] = []
  for (let at = 0; at < glyphs.length; at += 4) groups.push(glyphs.slice(at, at + 4).join(''))
  return groups.join('-')
}

/**
 * Map one domain refusal onto a reply.
 *
 * `device-not-found` covers both an id that was never issued and one belonging
 * to another tenant — `dsh-device-registry` answers the same for each — so the
 * status this produces cannot confirm an id to whoever guessed it. Every other
 * code describes the caller's own submission, which it is entitled to know.
 */
function refusalOf(error: DeviceRegistryError): ApiResult {
  if (error.code === 'device-not-found') return { kind: 'notFound' }
  return { kind: 'invalid', reason: error.message }
}

/** Run one domain operation, turning its documented refusals into replies. */
async function attempt(operation: () => Promise<ApiResult>): Promise<ApiResult> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DeviceRegistryError) return refusalOf(error)
    throw error
  }
}

/** The label a pair request names, or the reason it named none usable. */
function requestedLabel(body: unknown): string | undefined {
  const label = (body as { label?: unknown } | undefined)?.label
  if (typeof label !== 'string' || label.length > MAX_DEVICE_LABEL_LENGTH) return undefined
  return label
}

/** The device id a revoke request names, or `undefined` when it named none usable. */
function requestedId(body: unknown): DeviceId | undefined {
  const id = (body as { id?: unknown } | undefined)?.id
  if (typeof id !== 'string' || id.trim() === '' || id.length > 200) return undefined
  return DeviceId(id)
}

/** The code an exchange request carries, or `undefined` when it carries none usable. */
function submittedCode(body: unknown): string | undefined {
  const code = (body as { code?: unknown } | undefined)?.code
  if (typeof code !== 'string' || code === '' || code.length > MAX_SUBMITTED_CODE_LENGTH) return undefined
  return code
}

/** Read the sole bearer credential form this endpoint accepts. */
function submittedDeviceToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string') return undefined
  const match = /^Bearer ([a-z0-9_-]{43})$/iu.exec(authorization)
  const token = match?.[1]
  return token?.length === DEVICE_TOKEN_LENGTH ? token : undefined
}

/**
 * Mount the three tenant operations and two host operations.
 * @param ctx - the plugin context; the web server and store are injected.
 * @param config - the deployment's origin, code lifetime and audit retention.
 */
export function apply(ctx: Context, config: Config): void {
  const retain = config.auditRetention
  const store: DeviceRegistryStore = ctx.controlPlaneStore

  /** File one record against the tenant it is about, never failing the operation. */
  const file = async (userId: UserId, action: string, outcome: string): Promise<void> => {
    const record: RunAuditRecord = { at: Date.now(), userId, event: 'refused', action, outcome }
    await ctx.controlPlaneStore.recordAudit(tenantSubject(userId), [record], retain).catch((error: unknown) => {
      ctx.logger.warn(`device-api: could not record '${action}': ${String(error)}`)
    })
  }

  const host: ApiHost = {
    publicOrigin: config.publicOrigin,
    sessions: ctx.controlPlaneStore,
    // Every operation is recorded, successes included: an operator asking why
    // a host is paired needs to see who paired it, not only failed attempts.
    audit: event => file(event.userId, event.action, event.outcome),
    log: (rejection, path) => {
      ctx.logger.info(`device-api: refused ${path} (${rejection})`)
    },
    report: (error, path) => {
      ctx.logger.warn(`device-api: ${path} failed: ${String(error)}`)
    },
  }

  const routes = [
    {
      path: DEVICE_PATHS.list,
      methods: ['GET'],
      role: 'member' as const,
      action: 'devices.list',
      handle: async (actor: { userId: UserId }): Promise<ApiResult> => ({
        kind: 'json',
        status: 200,
        body: {
          devices: await listDevices(store, actor.userId),
          pairingCodes: await listPairingCodes(store, actor.userId),
        },
      }),
    },
    {
      path: DEVICE_PATHS.pair,
      methods: ['POST'],
      role: 'member' as const,
      action: 'devices.pair',
      handle: async (actor: { userId: UserId }, body: unknown): Promise<ApiResult> => {
        const label = requestedLabel(body)
        if (label === undefined) return { kind: 'invalid', reason: 'label is required' }
        const now = Date.now()
        const code = mintCode()
        return attempt(async () => {
          const issued = await issuePairingCode(store, {
            userId: actor.userId,
            label,
            code,
            expiresAt: now + config.pairingCodeTtlMs,
          }, now)
          const reply: IssuedPairingCode = { code, label: issued.label, expiresAt: issued.expiresAt }
          return { kind: 'json', status: 201, body: reply }
        })
      },
    },
    {
      path: DEVICE_PATHS.revoke,
      methods: ['POST'],
      role: 'member' as const,
      action: 'devices.revoke',
      handle: async (actor: { userId: UserId }, body: unknown): Promise<ApiResult> => {
        const id = requestedId(body)
        if (id === undefined) return { kind: 'invalid', reason: 'id is required' }
        return attempt(async () => ({
          kind: 'json',
          status: 200,
          body: await revokeDevice(store, actor.userId, id, Date.now()),
        }))
      },
    },
  ]

  const server: ApiWebServer = ctx.webServer
  for (const route of routes) ctx.effect(() => registerApiRoute(server, host, route), `deviceApi.${route.action}`)

  ctx.effect(() => registerAnonymousRoute(server, host, {
    path: DEVICE_PATHS.exchange,
    methods: ['POST'],
    action: 'devices.exchange',
    handle: async (body: unknown): Promise<ApiResult> => {
      const code = submittedCode(body)
      if (code === undefined) return { kind: 'invalid', reason: 'code is required' }
      const token = randomBytes(TOKEN_BYTES).toString('base64url')
      try {
        const pairing = await consumePairingCode(store, {
          code,
          // Minted here, not accepted: a host that chose its own id could name
          // a device of another tenant and overwrite the record binding it.
          deviceId: DeviceId(randomUUID()),
          token,
        }, Date.now())
        await file(pairing.userId, 'devices.exchange', 'ok')
        const credential: DeviceCredential = {
          deviceId: pairing.device.id,
          userId: pairing.device.userId,
          label: pairing.device.label,
          token,
        }
        return { kind: 'json', status: 201, body: credential }
      } catch (error) {
        if (!(error instanceof DeviceRegistryError)) throw error
        // No tenant to file this against: an unusable code names nobody this
        // deployment may believe, so the refusal reaches the log alone.
        ctx.logger.info(`device-api: refused ${DEVICE_PATHS.exchange} (${error.code})`)
        return { kind: 'invalid', reason: error.message }
      }
    },
  }), 'deviceApi.devices.exchange')

  ctx.effect(() => registerAnonymousRoute(server, host, {
    path: DEVICE_PATHS.authenticate,
    methods: ['GET'],
    action: 'devices.authenticate',
    handle: async (_body: unknown, request: IncomingMessage): Promise<ApiResult> => {
      const token = submittedDeviceToken(request)
      if (token === undefined) {
        ctx.logger.info(`device-api: refused ${DEVICE_PATHS.authenticate} (unauthenticated)`)
        return { kind: 'empty', status: 401 }
      }
      const authentication = await authenticateDevice(store, token)
      if (!authentication.authenticated) {
        ctx.logger.info(`device-api: refused ${DEVICE_PATHS.authenticate} (unauthenticated)`)
        if (authentication.rejection === 'revoked') {
          await file(authentication.device.userId, 'devices.authenticate', 'revoked')
        }
        return { kind: 'empty', status: 401 }
      }
      const identity: AuthenticatedDevice = {
        deviceId: authentication.device.id,
        userId: authentication.device.userId,
      }
      await file(authentication.device.userId, 'devices.authenticate', 'ok')
      return { kind: 'json', status: 200, body: identity }
    },
  }), 'deviceApi.devices.authenticate')
}
