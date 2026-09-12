/**
 * The one server a Harness Host serves, and the one device it serves as.
 *
 * A host paired through `dsh-device-api` receives a device id and a token
 * once, and until this existed it had nowhere to keep them: the harness's only
 * durable identity is `dsh-anonymous-user-id`, a per-installation UUID
 * designed not to identify a person, and nothing in `host/` names a machine
 * reached over a network. This service holds what the pairing produced —
 * which deployment this host answers to, whose device it is, and the token it
 * presents — in `ctx.credentials`, where the credential seam already owns
 * durable secrets and cross-process exclusion.
 *
 * The binding is singular by construction. There is one record key, and
 * {@link DeviceBinding.bind} refuses to replace a binding that already stands:
 * a host that serves two tenants at once is a host on which either tenant's
 * work can reach the other's files, and the operator action that changes who a
 * machine serves is {@link DeviceBinding.release} followed by a new pairing,
 * which is deliberately not something a stray call can do by accident.
 *
 * Connecting is not here. Reaching the server, noticing that the link dropped,
 * backing off and reconnecting are the inherited transport's, and this package
 * adds nothing to them; what it answers is which server to reach and as whom.
 *
 * @module @deepseek-ai/dsh-device-binding
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { DeviceId, UserId } from '@deepseek-ai/dsh-control-plane'
import { DEVICE_PATHS, type AuthenticatedDevice } from '@deepseek-ai/dsh-device-api'

/** Where the binding is stored; one key, because a host has one binding. */
const BINDING_KEY: CredentialKey = credentialKey('device-binding', 'host')

/** What a paired host knows about itself. */
export interface HostDeviceBinding {
  /**
   * Origin of the deployment this host serves, scheme and authority only.
   *
   * It is normalized on the way in, so a binding written as
   * `https://Candy.example/` and one written as `https://candy.example`
   * compare equal rather than reading as two different servers.
   */
  readonly serverOrigin: string
  /** The tenant this host acts for; never changes while the binding stands. */
  readonly userId: UserId
  /** The device this host is; never changes while the binding stands. */
  readonly deviceId: DeviceId
  /** The token this host presents. Held here and sent nowhere else. */
  readonly token: string
  /** When the pairing that produced this binding was completed. */
  readonly boundAt: number
}

/** The binding without the token, for anything that reports it. */
export type HostDeviceBindingView = Omit<HostDeviceBinding, 'token'>

/** Why a host may not take the binding it was asked to take. */
export type DeviceBindingRejection =
  /** A binding already stands, and this host may serve only one deployment. */
  | 'already-bound'
  /** The origin is not an absolute `http` or `https` origin. */
  | 'invalid-origin'
  /** The tenant, device or token is blank. */
  | 'invalid-identity'

/** A binding this host may not take, and why. */
export class DeviceBindingError extends Error {
  constructor(readonly code: DeviceBindingRejection) {
    super(`device binding ${code}`)
  }
}

/** A deployment answered a device verification with no usable decision. */
export class DeviceBindingVerificationError extends Error {
  constructor(readonly code: 'unexpected-status' | 'invalid-response') {
    super(`device binding verification ${code}`)
  }
}

/**
 * Reduce one server origin to the form two bindings are compared in.
 *
 * A person types a URL with a path, a trailing slash, or capitals in the host,
 * and none of those distinguish one deployment from another. Comparing the raw
 * text would let a re-bind to the same server read as a different one, which
 * is the case this record exists to refuse.
 * @param origin - the server URL as it was supplied.
 * @returns the scheme and authority, lowercased, with no trailing slash.
 * @throws DeviceBindingError `invalid-origin` when it is not an absolute
 * `http` or `https` URL.
 */
export function normalizeServerOrigin(origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new DeviceBindingError('invalid-origin')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DeviceBindingError('invalid-origin')
  }
  return parsed.origin.toLowerCase()
}

/** The stored payload's shape, as this service writes and reads it. */
interface StoredBinding {
  readonly serverOrigin: string
  readonly userId: string
  readonly deviceId: string
  readonly token: string
  readonly boundAt: number
}

/**
 * Read one stored payload back, refusing anything that is not a binding.
 *
 * The credential seam stores a `grant` payload as opaque JSON and hands it
 * back uninterpreted, so a record edited by hand or left by another version is
 * a real possibility at this boundary rather than a defensive hypothetical.
 * @param payload - the record's payload exactly as stored.
 * @returns the binding, or `undefined` when the payload is not one.
 */
function readBinding(payload: unknown): HostDeviceBinding | undefined {
  const stored = payload as Partial<StoredBinding> | null | undefined
  if (stored === null || typeof stored !== 'object') return undefined
  const { serverOrigin, userId, deviceId, token, boundAt } = stored
  if (typeof serverOrigin !== 'string' || serverOrigin === '') return undefined
  if (typeof userId !== 'string' || userId === '') return undefined
  if (typeof deviceId !== 'string' || deviceId === '') return undefined
  if (typeof token !== 'string' || token === '') return undefined
  if (typeof boundAt !== 'number' || !Number.isFinite(boundAt)) return undefined
  return { serverOrigin, userId: UserId(userId), deviceId: DeviceId(deviceId), token, boundAt }
}

/**
 * The binding as anything but its holder may see it.
 * @param binding - the binding this host holds.
 * @returns its server, tenant, device and instant, without the token.
 */
export function describeBinding(binding: HostDeviceBinding): HostDeviceBindingView {
  return {
    serverOrigin: binding.serverOrigin,
    userId: binding.userId,
    deviceId: binding.deviceId,
    boundAt: binding.boundAt,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    deviceBinding: DeviceBinding
  }
}

/**
 * The host's own record of which deployment it serves and as which device.
 *
 * Every write goes through the credential seam's serialized read-modify-write,
 * which holds across processes where the store supports it. That is what makes
 * "one binding" a fact rather than an intention: two `dsh` processes starting
 * on one machine and pairing at the same moment cannot both install one.
 */
export class DeviceBinding extends Service {
  static inject = ['credentials']

  constructor(ctx: Context) {
    super(ctx, 'deviceBinding')
  }

  /**
   * The binding this host holds.
   * @returns the binding, or `undefined` while this host is unpaired.
   */
  async read(): Promise<HostDeviceBinding | undefined> {
    const record = await this.ctx.credentials.readRecord(BINDING_KEY)
    if (record?.kind !== 'grant') return undefined
    return readBinding(record.payload)
  }

  /**
   * The binding this host holds, without its token.
   * @returns the binding's server, tenant, device and instant, or `undefined`
   * while this host is unpaired.
   */
  async describe(): Promise<HostDeviceBindingView | undefined> {
    const binding = await this.read()
    return binding === undefined ? undefined : describeBinding(binding)
  }

  /**
   * Ask the bound deployment whether this host's token still identifies it.
   *
   * This is one request, not a connection monitor. Network failure keeps
   * throwing for the inherited connection owner to classify; only the
   * deployment's uniform `401` means the binding no longer authenticates.
   *
   * @returns `true` only when the deployment authenticates the exact tenant
   * and device stored locally; `false` while unpaired or after a `401`.
   * @throws DeviceBindingVerificationError when a successful reply names a
   * different identity or the deployment answers an undocumented status.
   */
  async verify(): Promise<boolean> {
    const binding = await this.read()
    if (binding === undefined) return false
    const response = await globalThis.fetch(`${binding.serverOrigin}${DEVICE_PATHS.authenticate}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${binding.token}` },
    })
    if (response.status === 401) return false
    if (response.status !== 200) throw new DeviceBindingVerificationError('unexpected-status')
    let identity: unknown
    try {
      identity = await response.json()
    } catch (_malformedJson) {
      throw new DeviceBindingVerificationError('invalid-response')
    }
    if (!sameIdentity(identity, binding)) throw new DeviceBindingVerificationError('invalid-response')
    return true
  }

  /**
   * Take one binding, if this host holds none.
   *
   * Re-binding to the exact deployment, tenant and device already stored is
   * accepted and replaces the token, because that is what a host does when a
   * tenant re-pairs it after rotating its credential. Anything else is
   * refused: changing which tenant a machine serves without releasing it first
   * would leave one tenant's work reachable from the next tenant's session.
   *
   * @param request - the deployment, identity and token the pairing produced.
   * @param now - epoch milliseconds recorded as the binding's instant.
   * @returns the binding now stored.
   * @throws DeviceBindingError `invalid-origin` for a server that is not an
   * absolute `http` or `https` URL, `invalid-identity` for a blank tenant,
   * device or token, and `already-bound` when a different binding stands.
   */
  async bind(
    request: {
      readonly serverOrigin: string
      readonly userId: UserId
      readonly deviceId: DeviceId
      readonly token: string
    },
    now: number,
  ): Promise<HostDeviceBinding> {
    const serverOrigin = normalizeServerOrigin(request.serverOrigin)
    if (request.userId === '' || request.deviceId === '' || request.token === '') {
      throw new DeviceBindingError('invalid-identity')
    }
    let taken: HostDeviceBinding | undefined
    let refused: DeviceBindingRejection | undefined
    await this.ctx.credentials.modifyRecord(BINDING_KEY, (current) => {
      const held = current?.kind === 'grant' ? readBinding(current.payload) : undefined
      if (held !== undefined && !sameHost(held, { ...request, serverOrigin })) {
        refused = 'already-bound'
        return Promise.resolve(undefined)
      }
      // A re-pair of the same host keeps the instant it was first bound: the
      // machine has served this tenant since then, and a rotated token is not
      // a new binding.
      taken = {
        serverOrigin,
        userId: request.userId,
        deviceId: request.deviceId,
        token: request.token,
        boundAt: held?.boundAt ?? now,
      }
      const record: CredentialRecord = { kind: 'grant', payload: { ...taken } }
      return Promise.resolve(record)
    })
    if (refused !== undefined) throw new DeviceBindingError(refused)
    // `taken` is assigned on every path the mutation did not refuse, and the
    // seam runs the mutation before resolving.
    /* v8 ignore next -- unreachable: the mutation either assigns or refuses. */
    if (taken === undefined) throw new DeviceBindingError('already-bound')
    return taken
  }

  /**
   * Give up this host's binding.
   *
   * It is the operator action that follows a revocation, and the one that has
   * to happen before a machine can serve someone else. Releasing an unpaired
   * host changes nothing, so an operator repeating it is not told they were
   * too late.
   * @returns resolution once no binding is stored.
   */
  async release(): Promise<void> {
    await this.ctx.credentials.deleteRecord(BINDING_KEY)
  }
}

/** Whether a wire reply names exactly the locally held tenant and device. */
function sameIdentity(value: unknown, binding: HostDeviceBinding): value is AuthenticatedDevice {
  if (value === null || typeof value !== 'object') return false
  const identity = value as Partial<AuthenticatedDevice>
  return identity.userId === binding.userId && identity.deviceId === binding.deviceId
}

/** Whether a stored binding names the same deployment, tenant and device. */
function sameHost(
  held: HostDeviceBinding,
  request: { readonly serverOrigin: string; readonly userId: UserId; readonly deviceId: DeviceId },
): boolean {
  return held.serverOrigin === request.serverOrigin
    && held.userId === request.userId
    && held.deviceId === request.deviceId
}

export default DeviceBinding
