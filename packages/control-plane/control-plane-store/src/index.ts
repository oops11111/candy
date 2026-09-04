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
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { consumeAllowance, openAllowance, type TenantAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import {
  controlPlaneDomainSpec,
  fromStoredAllowance,
  fromStoredEntry,
  toStoredAllowance,
  toStoredEntry,
  type StoredTenantAllowance,
} from './spec.ts'

export { controlPlaneDomainSpec } from './spec.ts'
export type { StoredTenantAllowance } from './spec.ts'

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
  private allowances!: KvTable<UserId, StoredTenantAllowance>

  constructor(ctx: Context) {
    super(ctx, 'controlPlaneStore')
  }

  /** Open the domain and hold its tables for the life of this service. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(controlPlaneDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'controlPlaneStore.domainClose')
    this.accounts = domain.table('accounts')
    this.allowances = domain.table('allowances')
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
   * One tenant's grant and what its settled runs have consumed of it.
   *
   * This is the durable half of the root-run answer to `dsh-run-admission`'s
   * `findBudget`. It is deliberately not that answer: what a new run may start
   * against is this record less the reservation of every run of that tenant
   * still open, and which runs are open lives in a `RunLedger` rather than
   * here. `dsh-tenant-allowance`'s `remainingAllowance` composes the two, and
   * `dsh-run-scheduler` is where they meet.
   * @param userId - the tenant to read.
   * @returns the tenant's allowance, or undefined when none is recorded — which
   *   denies the run, because a tenant the store does not know is not a tenant
   *   with unlimited budget.
   */
  tenantAllowance(userId: UserId): Promise<TenantAllowance | undefined> {
    const stored = this.allowances.get(userId)
    return Promise.resolve(stored === undefined ? undefined : fromStoredAllowance(stored))
  }

  /**
   * Set what one tenant is granted, keeping what it has already consumed.
   *
   * Raising or lowering a grant does not return spent tokens: an operator who
   * doubles a quota mid-period means the tenant may now spend twice as much in
   * total, not that its history was erased. A tenant with no record is opened
   * with nothing consumed.
   * @param userId - the tenant.
   * @param grant - the allowance that tenant's runs draw on.
   * @returns the stored allowance, after the write reaches the medium.
   * @throws RangeError when the grant is not made of non-negative safe integers.
   */
  async setTenantGrant(userId: UserId, grant: RunBudget): Promise<TenantAllowance> {
    const current = this.allowances.get(userId)
    const opened = openAllowance(grant)
    const allowance: TenantAllowance = current === undefined
      ? opened
      : { grant: opened.grant, consumed: fromStoredAllowance(current).consumed }
    await this.allowances.put(userId, toStoredAllowance(allowance))
    return allowance
  }

  /**
   * Add one settled run's spending to what its tenant has consumed.
   *
   * The settlement `dsh-run-ledger` reports for a root run already covers its
   * whole subtree, so one call per tree is the whole of a tenant's charge.
   * @param userId - the tenant that ran it.
   * @param spent - what the settled root run and its descendants consumed.
   * @returns the tenant's allowance after the charge, or undefined when no
   *   allowance is recorded for that tenant and the charge therefore landed
   *   nowhere.
   * @throws RangeError when the spend is not made of non-negative safe integers.
   */
  async consumeTenantAllowance(userId: UserId, spent: RunSpend): Promise<TenantAllowance | undefined> {
    const stored = this.allowances.get(userId)
    if (stored === undefined) return undefined
    const charged = consumeAllowance(fromStoredAllowance(stored), spent)
    await this.allowances.put(userId, toStoredAllowance(charged))
    return charged
  }

}

export default ControlPlaneStore
