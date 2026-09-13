/** Tenant device pairing and revocation inside the inherited settings panel. */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CandyFailureKind, CandyPairingCodeView } from './api.ts'
import {
  deviceLabelBlocker,
  MAX_DEVICE_LABEL_LENGTH,
  type CandyDeviceState,
} from './device-store.ts'
import type { CandyAccountKey } from './locales.ts'
import css from './CandyAccountSection.module.css'

/** Registration-side operations and state for the device settings page. */
export interface CandyDeviceInjected {
  hooks: {
    /** Device snapshot bound by the renderer as `useCandyDevices`. */
    candyDevices: SnapshotStore<CandyDeviceState>
  }
  /** Read the tenant's authoritative device roster. */
  loadDevices: () => Promise<void>
  /** Change the proposed Host label. */
  editDeviceLabel: (label: string) => void
  /** Issue a one-time pairing code. */
  issueDeviceCode: () => Promise<void>
  /** Clear the only browser-held copy of the latest code. */
  clearDeviceCode: () => void
  /** Revoke one device. */
  revokeDevice: (id: string) => Promise<void>
  /** Render an epoch-millisecond timestamp in the viewer's locale. */
  formatTime: (at: number) => string
  /** Origin the Windows Host pairs to, read from the current page. */
  serverOrigin: () => string
}

/** Full component props. */
export type CandyDeviceSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.candyAccount'>
  & InjectFace<CandyDeviceInjected>

const FAILURE_KEY = {
  signedOut: 'deviceFailureSignedOut',
  forbidden: 'deviceFailureForbidden',
  gone: 'deviceFailureGone',
  refused: 'deviceFailureRefused',
  unavailable: 'deviceFailureUnavailable',
} as const satisfies Record<CandyFailureKind, CandyAccountKey>

function pairingState(pairing: CandyPairingCodeView, now: number): CandyAccountKey {
  if (pairing.consumedAt !== undefined) return 'deviceCodeConsumed'
  return pairing.expiresAt <= now ? 'deviceCodeExpired' : 'deviceCodePending'
}

/**
 * The Candy device settings page.
 * @param props - settings runtime, locale, and device operations.
 * @returns the responsive device management section.
 */
export function CandyDeviceSection(props: CandyDeviceSectionProps): ReactNode {
  const { t, useCandyDevices, loadDevices, clearDeviceCode } = props
  const state = useCandyDevices(snapshot => snapshot)
  const blocker = deviceLabelBlocker(state.label)

  useEffect(() => {
    void loadDevices()
    return () => { clearDeviceCode() }
  }, [clearDeviceCode, loadDevices])

  return (
    <section className={css.section}>
      <h3 className={css.title}>{t('deviceTitle')}</h3>
      <p className={css.intro}>{t('deviceIntro')}</p>

      {state.failure === null
        ? null
        : (
          <div className={css.failure}>
            <p className={css.error}>{t(FAILURE_KEY[state.failure])}</p>
            {state.failure === 'signedOut'
              ? null
              : <Button size="sm" onClick={() => { void loadDevices() }}>{t('retry')}</Button>}
          </div>
        )}

      <form
        className={css.form}
        onSubmit={(event) => {
          event.preventDefault()
          void props.issueDeviceCode()
        }}
      >
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('deviceLabel')}</span>
          <Input
            value={state.label}
            maxLength={MAX_DEVICE_LABEL_LENGTH}
            placeholder={t('deviceLabelPlaceholder')}
            disabled={state.issuing || state.failure === 'signedOut'}
            onChange={(event) => { props.editDeviceLabel(event.target.value) }}
          />
        </label>
        {blocker === undefined ? null : <p className={css.error}>{t(blocker)}</p>}
        {state.notice === null ? null : <p className={css.error}>{t(FAILURE_KEY[state.notice])}</p>}
        <div className={css.formActions}>
          <Button
            type="submit"
            variant="primary"
            disabled={state.issuing || blocker !== undefined || state.failure === 'signedOut'}
          >
            {state.issuing ? t('deviceIssuing') : t('deviceIssue')}
          </Button>
        </div>
      </form>

      {state.issued === null
        ? null
        : (
          <div className={css.pairCode} role="status">
            <h4 className={css.cliTitle}>{t('deviceCodeTitle')}</h4>
            <p className={css.cliIntro}>{t('deviceCodeOnce', { time: props.formatTime(state.issued.expiresAt) })}</p>
            <code className={css.code}>{state.issued.code}</code>
            <code className={css.command}>{t('deviceCommand', {
              origin: props.serverOrigin(),
              code: state.issued.code,
            })}</code>
            <Button size="sm" onClick={() => { props.clearDeviceCode() }}>{t('deviceCodeDone')}</Button>
          </div>
        )}

      <h4 className={css.cliTitle}>{t('deviceRosterTitle')}</h4>
      {state.status === 'ready' && state.devices.length === 0
        ? <p className={css.empty}>{t('deviceEmpty')}</p>
        : null}
      <ul className={css.rows}>
        {state.devices.map(device => (
          <li className={css.row} key={device.id}>
            <div className={css.rowHead}>
              <span className={css.rowLabel}>{device.label}</span>
              {device.revokedAt === undefined ? null : <span className={css.badgeMuted}>{t('deviceRevoked')}</span>}
            </div>
            <p className={css.rowMeta}>{t('devicePairedAt', { time: props.formatTime(device.pairedAt) })}</p>
            {device.revokedAt === undefined
              ? (
                <div className={css.rowActions}>
                  <Button
                    size="sm"
                    className={css.danger}
                    disabled={state.busy !== null}
                    onClick={() => { void props.revokeDevice(device.id) }}
                  >
                    {state.busy === device.id ? t('working') : t('deviceRevoke')}
                  </Button>
                </div>
              )
              : null}
          </li>
        ))}
      </ul>

      <h4 className={css.cliTitle}>{t('deviceInvitationsTitle')}</h4>
      {state.status === 'ready' && state.pairingCodes.length === 0
        ? <p className={css.empty}>{t('deviceInvitationsEmpty')}</p>
        : null}
      <ul className={css.rows}>
        {state.pairingCodes.map((pairing, index) => (
          <li className={css.row} key={`${pairing.issuedAt}:${String(index)}`}>
            <div className={css.rowHead}>
              <span className={css.rowLabel}>{pairing.label}</span>
              <span className={css.badgeMuted}>{t(pairingState(pairing, Date.now()))}</span>
            </div>
            <p className={css.rowMeta}>{t('deviceCodeExpiresAt', { time: props.formatTime(pairing.expiresAt) })}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
