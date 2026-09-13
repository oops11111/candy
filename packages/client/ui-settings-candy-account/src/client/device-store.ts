/** Browser state for tenant-owned Candy devices and one-time pairing codes. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  CandyApiError,
  type CandyDeviceApi,
  type CandyDeviceView,
  type CandyFailureKind,
  type CandyIssuedPairingCode,
  type CandyPairingCodeView,
} from './api.ts'

/** Longest device label accepted by the control plane. */
export const MAX_DEVICE_LABEL_LENGTH = 120

/** State rendered by the Candy device settings section. */
export interface CandyDeviceState {
  /** Whether the tenant roster has settled. */
  status: 'idle' | 'loading' | 'ready' | 'failed'
  /** Why the last roster read failed. */
  failure: CandyFailureKind | null
  /** Paired devices, including revoked records. */
  devices: readonly CandyDeviceView[]
  /** Issued code metadata; the code itself is never present here. */
  pairingCodes: readonly CandyPairingCodeView[]
  /** Label being entered for the next Host. */
  label: string
  /** Whether code issuance is in flight. */
  issuing: boolean
  /** The newest clear-text code, retained only until this section closes. */
  issued: CandyIssuedPairingCode | null
  /** Device whose revocation is in flight. */
  busy: string | null
  /** Fixed safe reason for the last mutation failure. */
  notice: CandyFailureKind | null
}

function initialState(): CandyDeviceState {
  return {
    status: 'idle', failure: null, devices: [], pairingCodes: [], label: '',
    issuing: false, issued: null, busy: null, notice: null,
  }
}

/**
 * Why a proposed Host label cannot be submitted.
 * @param label - text entered by the tenant.
 * @returns the locale key for the refusal, or `undefined`.
 */
export function deviceLabelBlocker(label: string): 'deviceLabelRequired' | 'deviceLabelTooLong' | undefined {
  if (label.trim() === '') return 'deviceLabelRequired'
  if (label.length > MAX_DEVICE_LABEL_LENGTH) return 'deviceLabelTooLong'
  return undefined
}

function failureOf(error: unknown): CandyFailureKind {
  return error instanceof CandyApiError ? error.kind : 'unavailable'
}

/** Drives the device page through the existing tenant-authenticated API. */
export class CandyDeviceController {
  /** Page state bound by the renderer as `useCandyDevices`. */
  readonly store: SnapshotStore<CandyDeviceState> = createSnapshotStore(initialState())

  readonly #api: CandyDeviceApi

  /** @param api - tenant-scoped device operations. */
  constructor(api: CandyDeviceApi) {
    this.#api = api
  }

  /**
   * Refresh the tenant's authoritative device roster.
   * @returns when the roster read has settled in the store.
   */
  async load(): Promise<void> {
    this.store.update((state) => { state.status = 'loading' })
    try {
      const roster = await this.#api.list()
      this.store.update((state) => {
        state.status = 'ready'
        state.failure = null
        state.devices = roster.devices
        state.pairingCodes = roster.pairingCodes
      })
    } catch (error) {
      this.#fail(failureOf(error))
    }
  }

  #fail(failure: CandyFailureKind): void {
    this.store.update((state) => {
      state.status = 'failed'
      state.failure = failure
      if (failure === 'signedOut') {
        state.devices = []
        state.pairingCodes = []
        state.issued = null
        state.notice = null
      }
    })
  }

  /**
   * Replace the proposed label for the next Host.
   * @param label - replacement value for the next Host label.
   */
  editLabel(label: string): void {
    this.store.update((state) => {
      state.label = label
      state.notice = null
    })
  }

  /**
   * Issue a code and keep its clear text only in this section's volatile store.
   * @returns when issuance and the following roster refresh have settled.
   */
  async issue(): Promise<void> {
    const snapshot = this.store.getSnapshot()
    if (snapshot.issuing || deviceLabelBlocker(snapshot.label) !== undefined) return
    this.store.update((state) => {
      state.issuing = true
      state.notice = null
      state.issued = null
    })
    try {
      const issued = await this.#api.pair(snapshot.label.trim())
      this.store.update((state) => {
        state.issuing = false
        state.label = ''
        state.issued = issued
      })
    } catch (error) {
      const failure = failureOf(error)
      this.store.update((state) => {
        state.issuing = false
        state.notice = failure
      })
      if (failure === 'signedOut') this.#fail(failure)
      return
    }
    await this.load()
  }

  /** Remove the only retained clear-text pairing code from browser memory. */
  clearIssued(): void {
    this.store.update((state) => { state.issued = null })
  }

  /**
   * Revoke one tenant-owned device, then refresh the authoritative roster.
   * @param id - device selected by the tenant.
   * @returns when the operation has settled.
   */
  async revoke(id: string): Promise<void> {
    if (this.store.getSnapshot().busy !== null) return
    this.store.update((state) => {
      state.busy = id
      state.notice = null
    })
    try {
      await this.#api.revoke(id)
    } catch (error) {
      const failure = failureOf(error)
      this.store.update((state) => {
        state.busy = null
        state.notice = failure
      })
      if (failure === 'signedOut') this.#fail(failure)
      return
    }
    this.store.update((state) => { state.busy = null })
    await this.load()
  }
}
