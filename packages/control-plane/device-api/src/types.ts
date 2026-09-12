/**
 * The request shapes and route paths of the device pairing API.
 * @module @deepseek-ai/dsh-device-api/src/types
 */

/** Where each operation is mounted, so a client and a test name one thing. */
export const DEVICE_PATHS = {
  /** Every device this tenant paired, and every code they issued. */
  list: '/api/candy/devices',
  /** Issue one single-use pairing code for a host that is not yet a device. */
  pair: '/api/candy/devices/pair',
  /** Withdraw one device's binding, keeping the record. */
  revoke: '/api/candy/devices/revoke',
  /**
   * Exchange a pairing code for a device identity.
   *
   * The only route here a browser session does not authenticate: a host
   * completing this has not been anyone yet, and the code in its body is the
   * whole of its claim.
   */
  exchange: '/api/candy/devices/exchange',
  /** Prove that a held device token still identifies a live binding. */
  authenticate: '/api/candy/devices/authenticate',
} as const

/** Identity a live device token proves, with no token or registry metadata. */
export interface AuthenticatedDevice {
  /** Device presenting the token. */
  readonly deviceId: string
  /** Tenant that paired the device. */
  readonly userId: string
}

/** What a tenant sends to issue one pairing code. */
export interface PairDeviceRequest {
  /** Display label the resulting device takes; 1 to 120 characters. */
  readonly label: string
}

/** What a tenant sends to withdraw one device's binding. */
export interface RevokeDeviceRequest {
  /**
   * The device to revoke.
   *
   * It locates a record and never selects a tenant: the operation receives the
   * session's tenant, and an id that tenant does not own answers exactly as an
   * id that was never issued.
   */
  readonly id: string
}

/** What a host sends to become a device. */
export interface ExchangeCodeRequest {
  /** The pairing code as it was typed; separators and case do not matter. */
  readonly code: string
}

/**
 * What issuing a code answers.
 *
 * This is the one moment the code exists in the clear. Nothing stores it and
 * no later read returns it, so a tenant who loses this reply issues another.
 */
export interface IssuedPairingCode {
  /** The code to carry to the host. */
  readonly code: string
  /** Label the resulting device will take. */
  readonly label: string
  /** After this instant the code is refused, used or not. */
  readonly expiresAt: number
}

/**
 * What a completed exchange answers, exactly once.
 *
 * The token is not recoverable afterwards: only its digest is stored. A host
 * that loses it is paired to a device it can no longer prove it is, and the
 * fix is a revocation and a new code.
 */
export interface DeviceCredential {
  /** The device this host has become, for the life of the binding. */
  readonly deviceId: string
  /** The tenant it acts for, which nothing later changes. */
  readonly userId: string
  /** The label the issuing tenant gave it. */
  readonly label: string
  /** The token this host presents; returned here and never again. */
  readonly token: string
}
