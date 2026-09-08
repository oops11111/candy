/**
 * The request shapes and route paths of the provider-account API.
 * @module @deepseek-ai/dsh-provider-account-api/src/types
 */

import type { ProviderKind } from '@deepseek-ai/dsh-control-plane'

/** Where each operation is mounted, so a client and a test name one thing. */
export const ACCOUNT_PATHS = {
  /** Every account this tenant owns that is not deleted, revoked ones included. */
  list: '/api/candy/provider-accounts',
  /** Create one account and seal its credential. */
  create: '/api/candy/provider-accounts/create',
  /** Ask the provider whether a stored credential still authenticates. */
  validate: '/api/candy/provider-accounts/validate',
  /** Make one account this provider's default for the tenant. */
  default: '/api/candy/provider-accounts/default',
  /** Revoke one account's credential, leaving the record readable. */
  revoke: '/api/candy/provider-accounts/revoke',
  /** Delete one account, keeping its id blocked. */
  delete: '/api/candy/provider-accounts/delete',
} as const

/** What a client sends to create one account. */
export interface CreateAccountRequest {
  /** Which provider this account authenticates with. */
  readonly provider: ProviderKind
  /** Display label the tenant chose; 1 to 120 characters. */
  readonly label: string
  /** The plaintext credential, sealed on arrival and never returned. */
  readonly secret: string
  /** Whether this becomes the provider's default for the tenant. */
  readonly isDefault?: boolean
}

/** What every operation on one existing account sends. */
export interface SelectAccountRequest {
  /**
   * The account to act on.
   *
   * It locates a record and never selects a tenant: the domain operation
   * receives the session's tenant, and an id that tenant does not own answers
   * exactly as an id that was never issued.
   */
  readonly id: string
}
