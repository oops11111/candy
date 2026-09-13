// @vitest-environment jsdom
/** Device settings rendering at the DSH settings-section boundary. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CandyDeviceSection, type CandyDeviceSectionProps } from '../src/client/CandyDeviceSection.tsx'
import type { CandyDeviceState } from '../src/client/device-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof en, params?: Record<string, string | number>) => {
  const template = en[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (_whole, name: string) => String(params[name] ?? ''))
}) as CandyDeviceSectionProps['t']

function state(overrides: Partial<CandyDeviceState> = {}): CandyDeviceState {
  return {
    status: 'ready', failure: null, devices: [], pairingCodes: [], label: '',
    issuing: false, issued: null, busy: null, notice: null, ...overrides,
  }
}

function actions() {
  return {
    loadDevices: vi.fn(async () => {}),
    editDeviceLabel: vi.fn((_label: string) => {}),
    issueDeviceCode: vi.fn(async () => {}),
    clearDeviceCode: vi.fn(() => {}),
    revokeDevice: vi.fn(async (_id: string) => {}),
  }
}

function mount(next: CandyDeviceState): ReturnType<typeof actions> {
  const spies = actions()
  render(<CandyDeviceSection {...{
    close: () => {},
    t,
    useCandyDevices: bindSnapshotSelector(createSnapshotStore(next)),
    formatTime: (at: number) => `t+${String(at)}`,
    serverOrigin: () => 'https://candy.example',
    ...spies,
  } as unknown as CandyDeviceSectionProps} />)
  return spies
}

describe('the Candy device page', () => {
  it('loads on mount and clears the visible code on unmount', () => {
    const spies = mount(state())
    expect(spies.loadDevices).toHaveBeenCalledOnce()

    cleanup()
    expect(spies.clearDeviceCode).toHaveBeenCalledOnce()
  })

  it('requires a label, forwards edits, and issues a code', () => {
    mount(state())
    expect(screen.getByText(en.deviceLabelRequired)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.deviceIssue }).hasAttribute('disabled')).toBe(true)
    cleanup()

    const ready = mount(state({ label: 'Office PC' }))
    fireEvent.change(screen.getByPlaceholderText(en.deviceLabelPlaceholder), { target: { value: 'Laptop' } })
    fireEvent.click(screen.getByRole('button', { name: en.deviceIssue }))
    expect(ready.editDeviceLabel).toHaveBeenCalledWith('Laptop')
    expect(ready.issueDeviceCode).toHaveBeenCalledOnce()
  })

  it('shows the one-time code and exact Host command until dismissed', () => {
    const spies = mount(state({
      issued: { code: 'ABCD-EFGH', label: 'Office PC', expiresAt: 9 },
    }))

    expect(screen.getByText('ABCD-EFGH')).toBeTruthy()
    expect(screen.getByText(
      'dsh --profile candy-host pair --server https://candy.example --code ABCD-EFGH',
    )).toBeTruthy()
    expect(screen.getByText('Use this before t+9. The code will not be shown again after this page closes.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.deviceCodeDone }))
    expect(spies.clearDeviceCode).toHaveBeenCalledOnce()
  })

  it('lists live and revoked devices and revokes only a live one', () => {
    const spies = mount(state({
      devices: [
        { id: 'device-1', label: 'Office PC', pairedAt: 1, revokedAt: undefined },
        { id: 'device-2', label: 'Old laptop', pairedAt: 2, revokedAt: 3 },
      ],
    }))

    const rows = screen.getAllByRole('listitem')
    expect(within(rows[1] as HTMLElement).getByText(en.deviceRevoked)).toBeTruthy()
    expect(within(rows[1] as HTMLElement).queryByRole('button')).toBeNull()
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: en.deviceRevoke }))
    expect(spies.revokeDevice).toHaveBeenCalledWith('device-1')
  })

  it('classifies pending, consumed, and expired pairing records without showing a code', () => {
    mount(state({
      pairingCodes: [
        { label: 'Pending', issuedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, consumedAt: undefined, deviceId: undefined },
        { label: 'Paired host', issuedAt: 2, expiresAt: 3, consumedAt: 2, deviceId: 'device-1' },
        { label: 'Old invitation', issuedAt: 3, expiresAt: 4, consumedAt: undefined, deviceId: undefined },
      ],
    }))

    expect(screen.getByText(en.deviceCodePending)).toBeTruthy()
    expect(screen.getByText(en.deviceCodeConsumed)).toBeTruthy()
    expect(screen.getByText(en.deviceCodeExpired)).toBeTruthy()
    expect(screen.queryByText('ABCD-EFGH')).toBeNull()
  })

  it('shows empty rosters and offers retry only for a recoverable read', () => {
    mount(state())
    expect(screen.getByText(en.deviceEmpty)).toBeTruthy()
    expect(screen.getByText(en.deviceInvitationsEmpty)).toBeTruthy()
    cleanup()

    const unavailable = mount(state({ status: 'failed', failure: 'unavailable' }))
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(unavailable.loadDevices).toHaveBeenCalledTimes(2)
    cleanup()

    mount(state({ status: 'failed', failure: 'signedOut' }))
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
    expect(screen.getByPlaceholderText(en.deviceLabelPlaceholder).hasAttribute('disabled')).toBe(true)
  })

  it('shows mutation failure and blocks all revocations while one is running', () => {
    mount(state({
      notice: 'gone',
      busy: 'device-1',
      devices: [
        { id: 'device-1', label: 'Office PC', pairedAt: 1, revokedAt: undefined },
        { id: 'device-2', label: 'Laptop', pairedAt: 2, revokedAt: undefined },
      ],
    }))

    expect(screen.getByText(en.deviceFailureGone)).toBeTruthy()
    for (const button of screen.getAllByRole('button', { name: new RegExp(`${en.deviceRevoke}|${en.working}`, 'u') })) {
      expect(button.hasAttribute('disabled')).toBe(true)
    }
    cleanup()

    mount(state({ label: 'Office PC', issuing: true }))
    expect(screen.getByRole('button', { name: en.deviceIssuing }).hasAttribute('disabled')).toBe(true)
  })
})
