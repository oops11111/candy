/**
 * What a `DeviceId` resolves to, and how a host comes to hold one.
 *
 * An execution assertion has always carried a {@link DeviceId}, and a
 * workspace grant has always named the device its roots are spelled for, but
 * nothing in the repository issued a device or could say whether one still
 * stands. The id named a record that did not exist. This package holds that
 * record: the tenant a device is bound to, the digest of the token the device
 * presents, and whether the binding was withdrawn.
 *
 * A device is bound to exactly one tenant for its whole life. There is no
 * operation that moves one, because the binding is what every later check
 * reads: a host that should serve a different person is a different device,
 * paired with its own code and holding its own token.
 *
 * The pairing code is the one moment a person is in the loop. A tenant issues
 * one from an authenticated session, reads it onto the host, and the host
 * exchanges it — once — for its device identity. The code is short-lived and
 * single-use, and only its digest is ever stored, so a copy of the durable
 * record does not let the holder pair anything.
 *
 * Transport is deliberately not here. How a host reaches the deployment, keeps
 * a socket open, or runs a tool is inherited Harness behaviour; what this
 * package decides is which tenant a device belongs to and whether it still
 * belongs to them.
 *
 * @module @deepseek-ai/dsh-device-registry
 */

import { createHash } from 'node:crypto'
import type { DeviceId, UserId } from '@deepseek-ai/dsh-control-plane'

/** Longest device or pairing label this registry accepts, in UTF-16 code units. */
export const MAX_DEVICE_LABEL_LENGTH = 120

/**
 * One host paired to exactly one tenant.
 *
 * The record is the authority; an assertion only names it. That is what keeps
 * a revocation effective against a token a host already holds, and what keeps
 * the tenant out of a claim the host could edit.
 */
export interface DeviceRecord {
  /** The id an execution assertion and a workspace grant name. */
  readonly id: DeviceId
  /**
   * The tenant this device acts for, fixed when the pairing code was consumed.
   *
   * Nothing changes it. A device that should act for someone else is paired
   * again from that person's session and receives a different id.
   */
  readonly userId: UserId
  /** Operator-supplied name, carried so a tenant can tell their devices apart. */
  readonly label: string
  /**
   * Digest of the token the device presents, never the token.
   *
   * The token is returned once, at pairing, and is not recoverable from this.
   * A dump of the durable record therefore authenticates nothing.
   */
  readonly tokenDigest: string
  /** When the pairing code was consumed and this device came into being. */
  readonly pairedAt: number
  /** When the tenant withdrew the binding; absent while it stands. */
  readonly revokedAt: number | undefined
}

/**
 * One outstanding invitation for a host to become a device of one tenant.
 *
 * The record survives its own consumption. A consumed code names the device it
 * produced, which is how an operator reading the trail can tell which pairing
 * a device came from; refusing it a second time is then a fact the record
 * states rather than the absence of a record.
 */
export interface PairingCodeRecord {
  /** Digest of the normalized code; the record's own key. */
  readonly digest: string
  /** The tenant whose session issued it, and whom the resulting device binds to. */
  readonly userId: UserId
  /** Label the resulting device is created with. */
  readonly label: string
  /** When the tenant issued it. */
  readonly issuedAt: number
  /** After this instant the code is refused, consumed or not. */
  readonly expiresAt: number
  /** When a host exchanged it; absent while it is outstanding. */
  readonly consumedAt: number | undefined
  /** The device it produced; absent while it is outstanding. */
  readonly deviceId: DeviceId | undefined
}

/** One device as a tenant reads it back; no field carries the token. */
export interface DeviceView {
  readonly id: DeviceId
  readonly label: string
  readonly pairedAt: number
  readonly revokedAt: number | undefined
}

/** One pairing code as a tenant reads it back; no field carries the code. */
export interface PairingCodeView {
  readonly label: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly consumedAt: number | undefined
  readonly deviceId: DeviceId | undefined
}

/** Durable storage for devices and pairing codes, supplied by the deployment. */
export interface DeviceRegistryStore {
  /** Read one device by the id an assertion names. */
  readonly findDevice: (id: DeviceId) => Promise<DeviceRecord | undefined>
  /** Read one tenant's devices, revoked ones included. */
  readonly listDevicesOfUser: (userId: UserId) => Promise<readonly DeviceRecord[]>
  /** Read the device presenting this token digest, whatever its state. */
  readonly findDeviceByTokenDigest: (tokenDigest: string) => Promise<DeviceRecord | undefined>
  /** Write one device, replacing any record under the same id. */
  readonly saveDevice: (record: DeviceRecord) => Promise<void>
  /** Read one pairing code by digest, consumed and expired ones included. */
  readonly findPairingCode: (digest: string) => Promise<PairingCodeRecord | undefined>
  /** Read one tenant's pairing codes, consumed and expired ones included. */
  readonly listPairingCodesOfUser: (userId: UserId) => Promise<readonly PairingCodeRecord[]>
  /** Write one pairing code, replacing any record under the same digest. */
  readonly savePairingCode: (record: PairingCodeRecord) => Promise<void>
  /**
   * Mark one outstanding, unexpired code consumed by one device, indivisibly.
   *
   * This is the operation that makes a code single-use, so it must decide both
   * consumption and expiry in the same step a concurrent caller cannot
   * interleave with. A read followed by a write cannot: two hosts reading one
   * outstanding code would each find it outstanding and each pair.
   * @param digest - the normalized code's digest.
   * @param deviceId - the device the claiming host will become.
   * @param at - epoch milliseconds of the exchange, also the expiry comparison.
   * @returns the record as it stood before the claim, or `undefined` when the
   * code was already consumed, expired or absent.
   */
  readonly claimPairingCode: (
    digest: string,
    deviceId: DeviceId,
    at: number,
  ) => Promise<PairingCodeRecord | undefined>
}

/** Error code safe to return from an authenticated API. */
export class DeviceRegistryError extends Error {
  constructor(readonly code:
    | 'pairing-code-exists'
    | 'pairing-code-unknown'
    | 'pairing-code-expired'
    | 'pairing-code-consumed'
    | 'device-not-found'
    | 'invalid-label'
    | 'invalid-lifetime',
  ) {
    super(`device registry ${code}`)
  }
}

/**
 * Reduce a typed pairing code to the form its digest is taken over.
 *
 * A code is read off one screen and typed into another, so the two spellings
 * differ in ways that carry no information: case, the separators that make it
 * readable, and the whitespace typing adds. Every one of those is removed here
 * rather than at each call site, so what a tenant is shown and what a host
 * sends digest identically.
 * @param code - the code as it was typed.
 * @returns the normalized code.
 */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/gu, '').toUpperCase()
}

/**
 * Digest one pairing code.
 * @param code - the code as it was typed; it is normalized first.
 * @returns the hex digest stored as the record's key.
 */
export function pairingCodeDigest(code: string): string {
  return createHash('sha256').update(`candy-pairing-code\0${normalizePairingCode(code)}`, 'utf8').digest('hex')
}

/**
 * Digest one device token.
 *
 * The prefix differs from {@link pairingCodeDigest}'s, so a value that is a
 * valid pairing code cannot be presented as a device token, or the reverse,
 * even if the two spaces ever came to overlap.
 * @param token - the token a paired host holds.
 * @returns the hex digest stored on the device record.
 */
export function deviceTokenDigest(token: string): string {
  return createHash('sha256').update(`candy-device-token\0${token}`, 'utf8').digest('hex')
}

/**
 * Whether a device's binding still stands.
 * @param record - the stored device.
 * @returns true while it has not been revoked.
 */
export function isDeviceUsable(record: DeviceRecord): boolean {
  return record.revokedAt === undefined
}

/** One device, without its token digest. */
function deviceView(record: DeviceRecord): DeviceView {
  return { id: record.id, label: record.label, pairedAt: record.pairedAt, revokedAt: record.revokedAt }
}

/** One pairing code, without its digest. */
function pairingView(record: PairingCodeRecord): PairingCodeView {
  return {
    label: record.label,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    consumedAt: record.consumedAt,
    deviceId: record.deviceId,
  }
}

/**
 * Check one operator-supplied label.
 * @param label - the label as it was submitted.
 * @returns the trimmed label.
 * @throws DeviceRegistryError `invalid-label` when it is empty once trimmed or
 * longer than {@link MAX_DEVICE_LABEL_LENGTH}.
 */
function checkedLabel(label: string): string {
  const trimmed = label.trim()
  if (trimmed === '' || trimmed.length > MAX_DEVICE_LABEL_LENGTH) {
    throw new DeviceRegistryError('invalid-label')
  }
  return trimmed
}

/**
 * Issue one pairing code for one tenant.
 *
 * The code itself is minted by the caller, because how much entropy a code
 * carries and which alphabet it is readable in are the transport's decisions,
 * and only its digest reaches this record.
 * @param store - the deployment's registry store.
 * @param input - the issuing tenant, the label the resulting device takes, the
 *   minted code, and the instant after which it is refused.
 * @param now - epoch milliseconds stamped on the record.
 * @returns the code as the issuing tenant reads it back.
 * @throws DeviceRegistryError `invalid-label` for an unusable label,
 * `invalid-lifetime` when the code would already be expired, or
 * `pairing-code-exists` when this exact code is already outstanding for
 * anyone — reissuing it would let one exchange settle two invitations.
 */
export async function issuePairingCode(
  store: DeviceRegistryStore,
  input: {
    readonly userId: UserId
    readonly label: string
    readonly code: string
    readonly expiresAt: number
  },
  now: number,
): Promise<PairingCodeView> {
  const label = checkedLabel(input.label)
  if (input.expiresAt <= now) throw new DeviceRegistryError('invalid-lifetime')
  const digest = pairingCodeDigest(input.code)
  if (await store.findPairingCode(digest) !== undefined) {
    throw new DeviceRegistryError('pairing-code-exists')
  }
  const record: PairingCodeRecord = {
    digest,
    userId: input.userId,
    label,
    issuedAt: now,
    expiresAt: input.expiresAt,
    consumedAt: undefined,
    deviceId: undefined,
  }
  await store.savePairingCode(record)
  return pairingView(record)
}

/**
 * Read one tenant's outstanding and spent pairing codes.
 * @param store - the deployment's registry store.
 * @param userId - the tenant reading their own codes.
 * @returns their codes, newest first, without the codes themselves.
 */
export async function listPairingCodes(
  store: DeviceRegistryStore,
  userId: UserId,
): Promise<readonly PairingCodeView[]> {
  const records = await store.listPairingCodesOfUser(userId)
  return [...records].sort((left, right) => right.issuedAt - left.issuedAt).map(pairingView)
}

/** One host's device identity, returned exactly once. */
export interface DevicePairing {
  /** The device the host has become. */
  readonly device: DeviceRecord
  /** The tenant it is bound to, for the caller that files the audit record. */
  readonly userId: UserId
}

/**
 * Exchange one pairing code for one device identity.
 *
 * The claim comes before the device is written, so a failure between the two
 * burns the code rather than leaving it usable. That is the safe direction: a
 * tenant reissues a code they never got to use, while a code that outlived a
 * partial exchange would pair a second host under an invitation the first one
 * already answered.
 *
 * The device id and token are minted by the caller for the reason the code is:
 * their entropy is the transport's decision, and only a digest of the token
 * reaches the record.
 * @param store - the deployment's registry store.
 * @param input - the typed code, and the identity the host will hold.
 * @param now - epoch milliseconds of the exchange.
 * @returns the device, bound to the tenant that issued the code.
 * @throws DeviceRegistryError `pairing-code-unknown` when nothing resolves the
 * code, `pairing-code-expired` when it outlived its window, or
 * `pairing-code-consumed` when a host already exchanged it — including a host
 * that won the same claim concurrently.
 */
export async function consumePairingCode(
  store: DeviceRegistryStore,
  input: {
    readonly code: string
    readonly deviceId: DeviceId
    readonly token: string
  },
  now: number,
): Promise<DevicePairing> {
  const digest = pairingCodeDigest(input.code)
  // Read first only to say which refusal this is; the claim below is what
  // decides, and it is checked again there against a concurrent exchange.
  const existing = await store.findPairingCode(digest)
  if (existing === undefined) throw new DeviceRegistryError('pairing-code-unknown')
  if (existing.consumedAt !== undefined) throw new DeviceRegistryError('pairing-code-consumed')
  if (existing.expiresAt <= now) throw new DeviceRegistryError('pairing-code-expired')
  const claimed = await store.claimPairingCode(digest, input.deviceId, now)
  if (claimed === undefined) throw new DeviceRegistryError('pairing-code-consumed')
  const device: DeviceRecord = {
    id: input.deviceId,
    userId: claimed.userId,
    label: claimed.label,
    tokenDigest: deviceTokenDigest(input.token),
    pairedAt: now,
    revokedAt: undefined,
  }
  await store.saveDevice(device)
  return { device, userId: claimed.userId }
}

/**
 * Read one tenant's devices.
 * @param store - the deployment's registry store.
 * @param userId - the tenant reading their own devices.
 * @returns their devices, newest pairing first, without token digests.
 */
export async function listDevices(
  store: DeviceRegistryStore,
  userId: UserId,
): Promise<readonly DeviceView[]> {
  const records = await store.listDevicesOfUser(userId)
  return [...records].sort((left, right) => right.pairedAt - left.pairedAt).map(deviceView)
}

/**
 * Withdraw one device's binding.
 *
 * The record is kept with a revocation instant rather than deleted: the id is
 * named by assertions and workspace grants that outlive it, and a deleted
 * record would make a withdrawn device read as one that was never paired.
 * Revoking a revoked device changes nothing and reports the same view, so a
 * tenant repeating the operation is not told they were too late.
 * @param store - the deployment's registry store.
 * @param userId - the tenant the device must belong to.
 * @param id - the device to revoke.
 * @param now - epoch milliseconds stamped on the revocation.
 * @returns the device as it now stands.
 * @throws DeviceRegistryError `device-not-found` when no record resolves the
 * id, and equally when it resolves to another tenant's device — the two answer
 * alike so the refusal cannot confirm an id to whoever guessed it.
 */
export async function revokeDevice(
  store: DeviceRegistryStore,
  userId: UserId,
  id: DeviceId,
  now: number,
): Promise<DeviceView> {
  const record = await store.findDevice(id)
  if (record === undefined || record.userId !== userId) {
    throw new DeviceRegistryError('device-not-found')
  }
  if (!isDeviceUsable(record)) return deviceView(record)
  const revoked: DeviceRecord = { ...record, revokedAt: now }
  await store.saveDevice(revoked)
  return deviceView(revoked)
}

/** Why a presented device token authenticates nothing. */
export type DeviceRejection =
  /** No device presents this token; an unknown token is never a new device. */
  | 'unknown'
  /** The device exists and its tenant withdrew the binding. */
  | 'revoked'

/** Whether a presented token identifies a device, and which one when it does. */
export type DeviceAuthentication =
  | { readonly authenticated: true; readonly device: DeviceRecord }
  | { readonly authenticated: false; readonly rejection: 'unknown' }
  | { readonly authenticated: false; readonly rejection: 'revoked'; readonly device: DeviceRecord }

/**
 * Identify the device presenting one token.
 *
 * The returned record's own digest is checked against the one looked up. For a
 * store that answers honestly this is already true, and it is not a timing
 * defence — the token is 256 random bits and the lookup itself is not constant
 * time. What it rejects is a store whose answer does not match the question:
 * `dsh-control-plane-store` scans a per-process snapshot to narrow the lookup,
 * so another process that rotated or replaced a record can leave this one
 * holding a stale candidate, and authenticating from it would admit a device
 * that no longer presents that token.
 *
 * A caller must answer `unknown` and `revoked` identically to the presenter —
 * the distinction is for the audit record, where an operator needs to see a
 * revoked host still trying.
 * @param store - the deployment's registry store.
 * @param token - the token the host presented.
 * @returns the device, or why the token identifies none.
 */
export async function authenticateDevice(
  store: DeviceRegistryStore,
  token: string,
): Promise<DeviceAuthentication> {
  const digest = deviceTokenDigest(token)
  const record = await store.findDeviceByTokenDigest(digest)
  if (record === undefined) return { authenticated: false, rejection: 'unknown' }
  if (record.tokenDigest !== digest) return { authenticated: false, rejection: 'unknown' }
  if (!isDeviceUsable(record)) return { authenticated: false, rejection: 'revoked', device: record }
  return { authenticated: true, device: record }
}

/** Why a run may not act as the device it named. */
export type DeviceAdmissionRejection =
  /** No record resolves the id; an unknown device is never a paired one. */
  | 'not-found'
  /** The binding was withdrawn, whatever an already-minted assertion still says. */
  | 'revoked'
  /** The device is paired to another tenant. */
  | 'tenant-mismatch'

/** Whether one run may act as the device it named, and the device when it may. */
export type DeviceAdmission =
  | { readonly admitted: true; readonly device: DeviceRecord }
  | { readonly admitted: false; readonly rejection: DeviceAdmissionRejection }

/**
 * Decide whether one run may act as the device its assertion named.
 *
 * This is the same shape {@link
 * @deepseek-ai/dsh-workspace-grant!admitWorkspaceGrant | admitWorkspaceGrant}
 * takes, and for the same reason: the record is the authority and the
 * assertion only names it, so a device revoked after a token was minted is
 * refused on the token's next use rather than at its expiry.
 * @param request - the tenant and device a verified assertion named.
 * @param record - the device the id resolved to, or `undefined` when none did.
 * @returns the device the run acts as, or the reason it acts as none.
 */
export function admitDevice(
  request: { readonly userId: UserId; readonly deviceId: DeviceId },
  record: DeviceRecord | undefined,
): DeviceAdmission {
  if (record === undefined) return { admitted: false, rejection: 'not-found' }
  if (!isDeviceUsable(record)) return { admitted: false, rejection: 'revoked' }
  if (record.userId !== request.userId) return { admitted: false, rejection: 'tenant-mismatch' }
  return { admitted: true, device: record }
}
