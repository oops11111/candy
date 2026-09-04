/**
 * The durable side of the Candy control plane: provider accounts with their
 * sealed credentials, and each tenant's allowance, over `storage-domain`.
 *
 * `dsh-provider-accounts` defines the account store as a port and
 * `dsh-run-admission` requires a credential lookup and a budget lookup as
 * ports. Every one of them was a parameter no deployment could fill, because
 * nothing in the repository held the data. This service holds it.
 *
 * It answers for a tenant, never for a run. `findBudget` takes a run's claims
 * and a child run is admitted against its *parent's* remainder, which lives in
 * an in-memory `RunLedger` rather than here; a caller composes the two, and
 * this service's README shows how. Answering a child from the tenant's own
 * allowance would defeat the check that port exists for.
 *
 * @module @deepseek-ai/dsh-control-plane-store
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import type { CredentialEnvelope } from '@deepseek-ai/dsh-credential-vault'
import type { ProviderAccountEntry, ProviderAccountStore } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  controlPlaneDomainSpec,
  fromStoredBudget,
  fromStoredEntry,
  toStoredEntry,
  type StoredRunBudget,
} from './spec.ts'

export { controlPlaneDomainSpec } from './spec.ts'
export type { StoredRunBudget } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    controlPlaneStore: ControlPlaneStore
  }
}

/**
 * Durable provider accounts and tenant allowances.
 *
 * Reads are synchronous against the domain's in-memory state and are exposed
 * as promises because the ports they satisfy are asynchronous. Writes reach
 * the medium before memory, so a read never sees a record the medium does not
 * hold.
 */
export class ControlPlaneStore extends Service implements ProviderAccountStore {
  static inject = ['storageDomain']

  // Assigned by `Service.init`, which Cordis awaits before the service is
  // reachable, so a guard for the unopened state would be untestable rather
  // than defensive.
  private accounts!: KvTable<ProviderAccountId, ReturnType<typeof toStoredEntry>>
  private budgets!: KvTable<UserId, StoredRunBudget>

  constructor(ctx: Context) {
    super(ctx, 'controlPlaneStore')
  }

  /** Open the domain and hold its tables for the life of this service. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(controlPlaneDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'controlPlaneStore.domainClose')
    this.accounts = domain.table('accounts')
    this.budgets = domain.table('budgets')
  }

  /**
   * Every account one tenant owns, deleted ones included.
   *
   * A deleted account is retained rather than removed: `dsh-provider-accounts`
   * keeps its id blocked so a later account cannot inherit its history.
   * @param userId - the tenant to list.
   * @returns that tenant's accounts, in no defined order.
   */
  listByUser(userId: UserId): Promise<readonly ProviderAccountEntry[]> {
    const owned: ProviderAccountEntry[] = []
    for (const [, stored] of this.accounts.entries()) {
      if (stored.record.userId === userId) owned.push(fromStoredEntry(stored))
    }
    return Promise.resolve(owned)
  }

  /**
   * One account by id.
   * @param id - the account to read.
   * @returns the account and its sealed credential, or undefined.
   */
  find(id: ProviderAccountId): Promise<ProviderAccountEntry | undefined> {
    const stored = this.accounts.get(id)
    return Promise.resolve(stored === undefined ? undefined : fromStoredEntry(stored))
  }

  /**
   * Write one account, replacing any record under the same id.
   * @param entry - the account and its sealed credential.
   * @returns resolution after the write reaches the medium.
   */
  async save(entry: ProviderAccountEntry): Promise<void> {
    await this.accounts.put(entry.record.id, toStoredEntry(entry))
  }

  /**
   * Look up the sealed credential a run's claims name.
   *
   * The account is read by id and its recorded tenant must be the one the
   * claims carry. An account that names another tenant is not returned: the
   * vault would refuse to open it, and refusing here keeps a mismatch out of
   * the one call that could otherwise be handed the wrong envelope.
   * @param claims - the tenant and account a verified assertion names.
   * @returns the sealed envelope, or undefined when there is no such account
   *   for that tenant.
   */
  async findCredential(claims: { userId: UserId; accountId: ProviderAccountId }): Promise<CredentialEnvelope | undefined> {
    const entry = await this.find(claims.accountId)
    if (entry === undefined || entry.record.userId !== claims.userId) return undefined
    return entry.credential
  }

  /**
   * One tenant's own allowance.
   *
   * This is the root-run half of `dsh-run-admission`'s `findBudget`. A child
   * run is admitted against its parent's remainder, which the ledger holds.
   * @param userId - the tenant to read.
   * @returns the tenant's allowance, or undefined when none is recorded — which
   *   denies the run, because a tenant the store does not know is not a tenant
   *   with unlimited budget.
   */
  tenantBudget(userId: UserId): Promise<RunBudget | undefined> {
    const stored = this.budgets.get(userId)
    return Promise.resolve(stored === undefined ? undefined : fromStoredBudget(stored))
  }

  /**
   * Record one tenant's allowance.
   * @param userId - the tenant.
   * @param budget - the allowance runs of that tenant start against.
   * @returns resolution after the write reaches the medium.
   */
  async setTenantBudget(userId: UserId, budget: RunBudget): Promise<void> {
    await this.budgets.put(userId, { ...budget })
  }

}

export default ControlPlaneStore
