/**
 * Pairing, revocation and device authentication, against an in-memory store
 * whose claim is as indivisible as the durable one has to be.
 */

import { DeviceId, UserId } from '@deepseek-ai/dsh-control-plane'
import { describe, expect, it, vi } from 'vitest'
import {
  admitDevice,
  authenticateDevice,
  consumePairingCode,
  deviceTokenDigest,
  DeviceRegistryError,
  isDeviceUsable,
  issuePairingCode,
  listDevices,
  listPairingCodes,
  MAX_DEVICE_LABEL_LENGTH,
  normalizePairingCode,
  pairingCodeDigest,
  revokeDevice,
  type DeviceRecord,
  type DeviceRegistryStore,
  type PairingCodeRecord,
} from '../src/index.ts'

const NOW = 1_780_000_000_000
const MINUTE = 60_000
const ALICE = UserId('user-alice')
const BOB = UserId('user-bob')
const DEVICE = DeviceId('device-1')
const CODE = 'RJKM-4T7Q'

/** The deployment's store, with the one-shot claim the durable one owns. */
function memoryStore(): DeviceRegistryStore & {
  readonly devices: Map<string, DeviceRecord>
  readonly codes: Map<string, PairingCodeRecord>
} {
  const devices = new Map<string, DeviceRecord>()
  const codes = new Map<string, PairingCodeRecord>()
  return {
    devices,
    codes,
    findDevice: id => Promise.resolve(devices.get(id)),
    listDevicesOfUser: userId => Promise.resolve([...devices.values()].filter(one => one.userId === userId)),
    findDeviceByTokenDigest: digest =>
      Promise.resolve([...devices.values()].find(one => one.tokenDigest === digest)),
    saveDevice: (record) => {
      devices.set(record.id, record)
      return Promise.resolve()
    },
    findPairingCode: digest => Promise.resolve(codes.get(digest)),
    listPairingCodesOfUser: userId => Promise.resolve([...codes.values()].filter(one => one.userId === userId)),
    savePairingCode: (record) => {
      codes.set(record.digest, record)
      return Promise.resolve()
    },
    claimPairingCode: (digest, deviceId, at) => {
      const record = codes.get(digest)
      if (record === undefined || record.consumedAt !== undefined || record.expiresAt <= at) {
        return Promise.resolve(undefined)
      }
      codes.set(digest, { ...record, consumedAt: at, deviceId })
      return Promise.resolve(record)
    },
  }
}

/** Issue one code for Alice, an hour long unless told otherwise. */
async function issued(
  store: DeviceRegistryStore,
  overrides: { code?: string; label?: string; expiresAt?: number; userId?: UserId } = {},
): Promise<string> {
  const code = overrides.code ?? CODE
  await issuePairingCode(store, {
    userId: overrides.userId ?? ALICE,
    label: overrides.label ?? 'Studio desktop',
    code,
    expiresAt: overrides.expiresAt ?? NOW + 60 * MINUTE,
  }, NOW)
  return code
}

/** The code the operation refused with. */
async function refusal(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof DeviceRegistryError) return error.code
    throw error
  }
  throw new Error('the operation was not refused')
}

describe('pairing codes', () => {
  it('reads one code back without the code itself', async () => {
    const store = memoryStore()
    const view = await issuePairingCode(store, {
      userId: ALICE, label: '  Studio desktop  ', code: CODE, expiresAt: NOW + MINUTE,
    }, NOW)

    expect(view).toEqual({
      label: 'Studio desktop', issuedAt: NOW, expiresAt: NOW + MINUTE, consumedAt: undefined, deviceId: undefined,
    })
    expect(JSON.stringify(view)).not.toContain(CODE)
    // Only the digest is durable, so the record cannot pair anything on its own.
    const stored = store.codes.get(pairingCodeDigest(CODE))
    expect(stored?.digest).toBe(pairingCodeDigest(CODE))
    expect(JSON.stringify(stored)).not.toContain('RJKM')
  })

  it('refuses a label that names nothing and one that is a document', async () => {
    const store = memoryStore()
    const expiresAt = NOW + MINUTE
    expect(await refusal(() => issuePairingCode(store, {
      userId: ALICE, label: '   ', code: CODE, expiresAt,
    }, NOW))).toBe('invalid-label')
    expect(await refusal(() => issuePairingCode(store, {
      userId: ALICE, label: 'x'.repeat(MAX_DEVICE_LABEL_LENGTH + 1), code: CODE, expiresAt,
    }, NOW))).toBe('invalid-label')
    expect(store.codes.size).toBe(0)

    const view = await issuePairingCode(store, {
      userId: ALICE, label: 'x'.repeat(MAX_DEVICE_LABEL_LENGTH), code: CODE, expiresAt,
    }, NOW)
    expect(view.label).toHaveLength(MAX_DEVICE_LABEL_LENGTH)
  })

  it('refuses a code that would already be expired', async () => {
    const store = memoryStore()
    expect(await refusal(() => issuePairingCode(store, {
      userId: ALICE, label: 'Laptop', code: CODE, expiresAt: NOW,
    }, NOW))).toBe('invalid-lifetime')
    expect(store.codes.size).toBe(0)
  })

  it('refuses to reissue a code that is already outstanding', async () => {
    const store = memoryStore()
    await issued(store)
    // Reissuing would let one exchange settle two invitations, and the second
    // tenant would never learn their code was someone else's.
    expect(await refusal(() => issuePairingCode(store, {
      userId: BOB, label: 'Other laptop', code: CODE, expiresAt: NOW + MINUTE,
    }, NOW))).toBe('pairing-code-exists')
    expect(store.codes.get(pairingCodeDigest(CODE))?.userId).toBe(ALICE)
  })

  it('lists a tenant their own codes, newest first', async () => {
    const store = memoryStore()
    await issued(store, { code: 'AAAA-1111' })
    await issuePairingCode(store, {
      userId: ALICE, label: 'Laptop', code: 'BBBB-2222', expiresAt: NOW + 2 * MINUTE,
    }, NOW + MINUTE)
    await issued(store, { code: 'CCCC-3333', userId: BOB })

    const codes = await listPairingCodes(store, ALICE)
    expect(codes.map(one => one.label)).toEqual(['Laptop', 'Studio desktop'])
    expect(await listPairingCodes(store, BOB)).toHaveLength(1)
  })
})

describe('normalizing a typed code', () => {
  it('digests what was read and what was typed identically', () => {
    expect(normalizePairingCode(' rjkm-4t7q ')).toBe('RJKM4T7Q')
    expect(pairingCodeDigest('rjkm 4t7q')).toBe(pairingCodeDigest('RJKM-4T7Q'))
  })

  it('separates the code space from the token space', () => {
    // A value that is a live pairing code must not authenticate as a token.
    expect(deviceTokenDigest(CODE)).not.toBe(pairingCodeDigest(CODE))
  })
})

describe('exchanging a code for a device', () => {
  it('binds the device to the issuing tenant and burns the code', async () => {
    const store = memoryStore()
    await issued(store)

    const pairing = await consumePairingCode(
      store, { code: 'rjkm 4t7q', deviceId: DEVICE, token: 'device-token' }, NOW + MINUTE,
    )

    expect(pairing.userId).toBe(ALICE)
    expect(pairing.device).toEqual({
      id: DEVICE,
      userId: ALICE,
      label: 'Studio desktop',
      tokenDigest: deviceTokenDigest('device-token'),
      pairedAt: NOW + MINUTE,
      revokedAt: undefined,
    })
    // The record survives its own consumption and names what it produced.
    const spent = store.codes.get(pairingCodeDigest(CODE))
    expect(spent).toMatchObject({ consumedAt: NOW + MINUTE, deviceId: DEVICE })
    expect(await refusal(() => consumePairingCode(
      store, { code: CODE, deviceId: DeviceId('device-2'), token: 'other' }, NOW + 2 * MINUTE,
    ))).toBe('pairing-code-consumed')
    expect(store.devices.size).toBe(1)
  })

  it('names the reason a code cannot be exchanged', async () => {
    const store = memoryStore()
    expect(await refusal(() => consumePairingCode(
      store, { code: 'NEVER-ISSUED', deviceId: DEVICE, token: 't' }, NOW,
    ))).toBe('pairing-code-unknown')

    await issued(store, { expiresAt: NOW + MINUTE })
    expect(await refusal(() => consumePairingCode(
      store, { code: CODE, deviceId: DEVICE, token: 't' }, NOW + MINUTE,
    ))).toBe('pairing-code-expired')
    expect(store.devices.size).toBe(0)
  })

  it('pairs one host when two exchange the same code at once', async () => {
    const store = memoryStore()
    await issued(store)

    const [first, second] = await Promise.allSettled([
      consumePairingCode(store, { code: CODE, deviceId: DEVICE, token: 'first' }, NOW + MINUTE),
      consumePairingCode(store, { code: CODE, deviceId: DeviceId('device-2'), token: 'second' }, NOW + MINUTE),
    ])

    const outcomes = [first, second].map(one => one.status)
    expect(outcomes.filter(status => status === 'fulfilled')).toHaveLength(1)
    const loser = [first, second].find(one => one.status === 'rejected')
    expect((loser as PromiseRejectedResult).reason).toMatchObject({ code: 'pairing-code-consumed' })
    expect(store.devices.size).toBe(1)
  })

  it('burns the code rather than leaving it usable when the device write fails', async () => {
    const store = memoryStore()
    await issued(store)
    const failing: DeviceRegistryStore = {
      ...store,
      saveDevice: vi.fn(() => Promise.reject(new Error('medium is gone'))),
    }

    await expect(consumePairingCode(
      failing, { code: CODE, deviceId: DEVICE, token: 't' }, NOW + MINUTE,
    )).rejects.toThrow('medium is gone')

    // A code that outlived a partial exchange would pair a second host under
    // an invitation the first one already answered.
    expect(await refusal(() => consumePairingCode(
      store, { code: CODE, deviceId: DeviceId('device-2'), token: 'u' }, NOW + 2 * MINUTE,
    ))).toBe('pairing-code-consumed')
  })
})

describe('a tenant reading and withdrawing their devices', () => {
  /** Pair one device of Alice's under its own code. */
  async function paired(
    store: DeviceRegistryStore, code: string, id: DeviceId, token: string, at: number, label?: string,
  ): Promise<DeviceRecord> {
    await issued(store, { code, ...label === undefined ? {} : { label } })
    const pairing = await consumePairingCode(store, { code, deviceId: id, token }, at)
    return pairing.device
  }

  it("lists only the reader's own devices, newest pairing first", async () => {
    const store = memoryStore()
    await paired(store, 'AAAA-1111', DEVICE, 'first', NOW + MINUTE, 'Desktop')
    await paired(store, 'BBBB-2222', DeviceId('device-2'), 'second', NOW + 2 * MINUTE, 'Laptop')
    await issuePairingCode(store, {
      userId: BOB, label: 'Bob laptop', code: 'CCCC-3333', expiresAt: NOW + 60 * MINUTE,
    }, NOW)
    await consumePairingCode(store, { code: 'CCCC-3333', deviceId: DeviceId('device-3'), token: 'third' }, NOW)

    const devices = await listDevices(store, ALICE)
    expect(devices.map(one => one.label)).toEqual(['Laptop', 'Desktop'])
    expect(JSON.stringify(devices)).not.toContain('tokenDigest')
    expect((await listDevices(store, BOB)).map(one => one.id)).toEqual([DeviceId('device-3')])
  })

  it('withdraws a binding and answers the same for a repeat', async () => {
    const store = memoryStore()
    await paired(store, CODE, DEVICE, 'first', NOW)

    const revoked = await revokeDevice(store, ALICE, DEVICE, NOW + MINUTE)
    expect(revoked.revokedAt).toBe(NOW + MINUTE)
    // Repeating it is not being told they were too late.
    expect(await revokeDevice(store, ALICE, DEVICE, NOW + 2 * MINUTE)).toEqual(revoked)
    expect(store.devices.get(DEVICE)?.revokedAt).toBe(NOW + MINUTE)
  })

  it("answers alike for an unknown device and another tenant's", async () => {
    const store = memoryStore()
    await paired(store, CODE, DEVICE, 'first', NOW)

    expect(await refusal(() => revokeDevice(store, BOB, DEVICE, NOW))).toBe('device-not-found')
    expect(await refusal(() => revokeDevice(store, ALICE, DeviceId('nope'), NOW))).toBe('device-not-found')
    expect(store.devices.get(DEVICE)?.revokedAt).toBeUndefined()
  })
})

describe('a host presenting its token', () => {
  it('identifies the device that holds it', async () => {
    const store = memoryStore()
    await issued(store)
    await consumePairingCode(store, { code: CODE, deviceId: DEVICE, token: 'device-token' }, NOW)

    const outcome = await authenticateDevice(store, 'device-token')
    expect(outcome).toEqual({ authenticated: true, device: store.devices.get(DEVICE) })
  })

  it('separates an unknown token from a withdrawn binding', async () => {
    const store = memoryStore()
    await issued(store)
    await consumePairingCode(store, { code: CODE, deviceId: DEVICE, token: 'device-token' }, NOW)

    expect(await authenticateDevice(store, 'other-token'))
      .toEqual({ authenticated: false, rejection: 'unknown' })
    await revokeDevice(store, ALICE, DEVICE, NOW + MINUTE)
    // The distinction is for the audit record; a caller answers both alike.
    expect(await authenticateDevice(store, 'device-token'))
      .toEqual({ authenticated: false, rejection: 'revoked' })
  })

  it('refuses a record whose stored digest does not match the token', async () => {
    const store = memoryStore()
    await issued(store)
    await consumePairingCode(store, { code: CODE, deviceId: DEVICE, token: 'device-token' }, NOW)
    // A medium that answers a digest lookup with the wrong record is a defect,
    // and the comparison here is what keeps it from authenticating anyone.
    const stored = store.devices.get(DEVICE)
    if (stored === undefined) throw new Error('the device was not paired')
    const lying: DeviceRegistryStore = {
      ...store,
      findDeviceByTokenDigest: () => Promise.resolve({ ...stored, tokenDigest: 'short' }),
    }

    expect(await authenticateDevice(lying, 'device-token'))
      .toEqual({ authenticated: false, rejection: 'unknown' })
  })
})

describe('admitting a run as the device it named', () => {
  const device: DeviceRecord = {
    id: DEVICE,
    userId: ALICE,
    label: 'Studio desktop',
    tokenDigest: deviceTokenDigest('device-token'),
    pairedAt: NOW,
    revokedAt: undefined,
  }

  it("admits a standing binding of the run's own tenant", () => {
    expect(admitDevice({ userId: ALICE, deviceId: DEVICE }, device))
      .toEqual({ admitted: true, device })
    expect(isDeviceUsable(device)).toBe(true)
  })

  it('names why a run may not act as the device', () => {
    expect(admitDevice({ userId: ALICE, deviceId: DEVICE }, undefined))
      .toEqual({ admitted: false, rejection: 'not-found' })
    // A device revoked after the assertion was minted is refused on the
    // token's next use, not at its expiry.
    expect(admitDevice({ userId: ALICE, deviceId: DEVICE }, { ...device, revokedAt: NOW }))
      .toEqual({ admitted: false, rejection: 'revoked' })
    expect(admitDevice({ userId: BOB, deviceId: DEVICE }, device))
      .toEqual({ admitted: false, rejection: 'tenant-mismatch' })
    expect(isDeviceUsable({ ...device, revokedAt: NOW })).toBe(false)
  })
})
