/** The device page's volatile code handling and authoritative roster refreshes. */
import { describe, expect, it, vi } from 'vitest'
import {
  CandyApiError,
  type CandyDeviceApi,
  type CandyDeviceRoster,
  type CandyIssuedPairingCode,
} from '../src/client/api.ts'
import {
  CandyDeviceController, deviceLabelBlocker, MAX_DEVICE_LABEL_LENGTH,
} from '../src/client/device-store.ts'

const ISSUED: CandyIssuedPairingCode = { code: 'ABCD-EFGH', label: 'Office PC', expiresAt: 9 }
const ROSTER: CandyDeviceRoster = {
  devices: [{ id: 'device-1', label: 'Office PC', pairedAt: 2, revokedAt: undefined }],
  pairingCodes: [{
    label: 'Office PC', issuedAt: 1, expiresAt: 9, consumedAt: 2, deviceId: 'device-1',
  }],
}

function api(overrides: Partial<CandyDeviceApi> = {}): CandyDeviceApi {
  return {
    list: vi.fn(async () => ROSTER),
    pair: vi.fn(async () => ISSUED),
    revoke: vi.fn(async () => ({ ...ROSTER.devices[0]!, revokedAt: 3 })),
    ...overrides,
  }
}

describe('deviceLabelBlocker', () => {
  it('names an absent or oversized label', () => {
    expect(deviceLabelBlocker('Office PC')).toBeUndefined()
    expect(deviceLabelBlocker('   ')).toBe('deviceLabelRequired')
    expect(deviceLabelBlocker('x'.repeat(MAX_DEVICE_LABEL_LENGTH + 1))).toBe('deviceLabelTooLong')
  })
})

describe('the Candy device controller', () => {
  it('loads the tenant device roster', async () => {
    const controller = new CandyDeviceController(api())

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', failure: null, devices: ROSTER.devices, pairingCodes: ROSTER.pairingCodes,
    })
  })

  it('keeps a non-session read failure and clears tenant data after sign-out', async () => {
    const unavailable = new CandyDeviceController(api({
      list: vi.fn(async () => { throw new TypeError('offline') }),
    }))
    await unavailable.load()
    expect(unavailable.store.getSnapshot().failure).toBe('unavailable')

    let live = true
    const signedOut = new CandyDeviceController(api({
      list: vi.fn(async () => {
        if (!live) throw new CandyApiError('signedOut', 'status 401')
        return ROSTER
      }),
    }))
    await signedOut.load()
    signedOut.store.update((state) => { state.issued = ISSUED })
    live = false
    await signedOut.load()
    expect(signedOut.store.getSnapshot()).toMatchObject({
      status: 'failed', failure: 'signedOut', devices: [], pairingCodes: [], issued: null,
    })
  })

  it('issues with a trimmed label, keeps the one-time answer, and refreshes metadata', async () => {
    const scripted = api()
    const controller = new CandyDeviceController(scripted)
    controller.editLabel('  Office PC  ')

    await controller.issue()

    expect(scripted.pair).toHaveBeenCalledWith('Office PC')
    expect(scripted.list).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot()).toMatchObject({
      label: '', issuing: false, issued: ISSUED, devices: ROSTER.devices,
    })
    controller.clearIssued()
    expect(controller.store.getSnapshot().issued).toBeNull()
  })

  it('does not issue while the label blocks it or another issue is running', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const scripted = api({ pair: vi.fn(async () => { await held; return ISSUED }) })
    const controller = new CandyDeviceController(scripted)

    await controller.issue()
    expect(scripted.pair).not.toHaveBeenCalled()
    controller.editLabel('Office PC')
    const first = controller.issue()
    await controller.issue()
    expect(scripted.pair).toHaveBeenCalledOnce()
    release()
    await first
  })

  it('reports refused and unexpected issue failures without retaining a code', async () => {
    const refused = new CandyDeviceController(api({
      pair: vi.fn(async () => { throw new CandyApiError('refused', 'label is required') }),
    }))
    refused.editLabel('Office PC')
    await refused.issue()
    expect(refused.store.getSnapshot()).toMatchObject({ issuing: false, notice: 'refused', issued: null })

    const broken = new CandyDeviceController(api({
      pair: vi.fn(async () => { throw new TypeError('boom') }),
    }))
    broken.editLabel('Office PC')
    await broken.issue()
    expect(broken.store.getSnapshot().notice).toBe('unavailable')
  })

  it('clears tenant data when code issuance finds an ended session', async () => {
    const controller = new CandyDeviceController(api({
      pair: vi.fn(async () => { throw new CandyApiError('signedOut', 'status 401') }),
    }))
    controller.store.update((state) => {
      state.devices = ROSTER.devices
      state.pairingCodes = ROSTER.pairingCodes
      state.label = 'Office PC'
    })

    await controller.issue()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'failed', failure: 'signedOut', devices: [], pairingCodes: [], issued: null,
    })
  })

  it('revokes one device at a time and refreshes the roster', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const scripted = api({ revoke: vi.fn(async () => { await held; return ROSTER.devices[0]! }) })
    const controller = new CandyDeviceController(scripted)

    const first = controller.revoke('device-1')
    await controller.revoke('device-2')
    expect(scripted.revoke).toHaveBeenCalledOnce()
    release()
    await first
    expect(scripted.list).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().busy).toBeNull()
  })

  it('reports revoke failures and clears the roster on sign-out', async () => {
    const gone = new CandyDeviceController(api({
      revoke: vi.fn(async () => { throw new CandyApiError('gone', 'status 404') }),
    }))
    await gone.revoke('device-1')
    expect(gone.store.getSnapshot()).toMatchObject({ busy: null, notice: 'gone' })

    const signedOut = new CandyDeviceController(api({
      revoke: vi.fn(async () => { throw new CandyApiError('signedOut', 'status 401') }),
    }))
    signedOut.store.update((state) => { state.devices = ROSTER.devices })
    await signedOut.revoke('device-1')
    expect(signedOut.store.getSnapshot()).toMatchObject({
      status: 'failed', failure: 'signedOut', devices: [], busy: null,
    })
  })
})
