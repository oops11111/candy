/**
 * The durable side of the Candy control plane: provider accounts with their
 * sealed credentials, and each tenant's allowance, over `storage-domain`.
 *
 * `dsh-provider-accounts` defines the account store as a port and
 * `dsh-run-admission` requires a credential lookup and a budget lookup as
 * ports. Every one of them was a parameter no deployment could fill, because
 * nothing in the repository held the data. This service holds it.
 *
 * It holds run records too, but it is not the ledger. `RunLedger` remains the
 * accounting authority and answers what a run may still spend; what lives here
 * is the record that survives a restart, and the settlement marker that lets an
 * interrupted charge be finished exactly once. A child run is still admitted
 * against its *parent's* remainder, which only a live ledger knows.
 *
 * @module @deepseek-ai/dsh-control-plane-store
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ProviderAccountId, RunId, UserId } from '@deepseek-ai/dsh-control-plane'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CredentialEnvelope } from '@deepseek-ai/dsh-credential-vault'
import type { ProviderAccountEntry, ProviderAccountStore } from '@deepseek-ai/dsh-provider-accounts'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { consumeAllowance, openAllowance, type TenantAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import {
  controlPlaneDomainSpec,
  fromStoredAllowance,
  fromStoredEntry,
  fromStoredRun,
  toStoredAllowance,
  toStoredEntry,
  toStoredRun,
  type AuditSubject,
  type DurableRunRecord,
  type RunAuditRecord,
  type StoredAuditTrail,
  type StoredRun,
  type StoredTenantAllowance,
} from './spec.ts'

export { controlPlaneDomainSpec, runtimeSubject, tenantSubject } from './spec.ts'
export type { AuditSubject, DurableRunRecord, RunAuditRecord, StoredAuditTrail, StoredRun, StoredTenantAllowance } from './spec.ts'

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
  private runs!: KvTable<RunId, StoredRun>
  private audits!: KvTable<AuditSubject, StoredAuditTrail>

  constructor(ctx: Context) {
    super(ctx, 'controlPlaneStore')
  }

  /** Open the domain and hold its tables for the life of this service. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(controlPlaneDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'controlPlaneStore.domainClose')
    this.accounts = domain.table('accounts')
    this.allowances = domain.table('allowances')
    this.runs = domain.table('runs')
    this.audits = domain.table('audits')
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
   * Add one settled run's spending to what its tenant has consumed, at most once.
   *
   * The settlement `dsh-run-ledger` reports for a root run already covers its
   * whole subtree, so one call per tree is the whole of a tenant's charge.
   *
   * Charging the tenant and deleting the settled run record are two writes this
   * medium cannot make one, so a crash between them leaves a settled record a
   * recovering runtime finds and charges again. The run's id is written into
   * the same record as the charge, by the same atomic update, and a repeat of
   * the same id is a no-op — so recovery may re-drive an interrupted settlement
   * without knowing how far it got.
   *
   * That guarantee needs one settlement at a time per tenant: two interleaved
   * settlements leave the id of the later one, and a crash would then charge
   * the earlier one twice. `dsh-run-scheduler` serializes them.
   * @param userId - the tenant that ran it.
   * @param runId - the settled root run, which this charge is recorded under.
   * @param spent - what that run and its descendants consumed.
   * @returns the tenant's allowance after the charge — unchanged when this run
   *   was already charged — or undefined when no allowance is recorded for that
   *   tenant and the charge therefore landed nowhere.
   * @throws RangeError when the spend is not made of non-negative safe integers.
   */
  async consumeTenantAllowance(userId: UserId, runId: RunId, spent: RunSpend): Promise<TenantAllowance | undefined> {
    const stored = this.allowances.get(userId)
    if (stored === undefined) return undefined
    if (stored.lastSettledRunId === runId) return fromStoredAllowance(stored)
    const charged = consumeAllowance(fromStoredAllowance(stored), spent)
    await this.allowances.put(userId, { ...toStoredAllowance(charged), lastSettledRunId: runId })
    return charged
  }

  /**
   * Every run one runtime has open or part-way through settling.
   *
   * Only that runtime's own records: two runtimes sharing this medium would
   * otherwise recover each other's live runs and settle them at boot.
   * @param runtime - the reading runtime's own audience identifier.
   * @returns its records, in no defined order.
   */
  runsOf(runtime: string): Promise<readonly DurableRunRecord[]> {
    const owned: DurableRunRecord[] = []
    for (const [, stored] of this.runs.entries()) {
      if (stored.runtime === runtime) owned.push(fromStoredRun(stored))
    }
    return Promise.resolve(owned)
  }

  /**
   * One run's record by id, whatever runtime opened it.
   *
   * A child run is checked against its parent's identity, and the parent is
   * named by the claims rather than found by scanning.
   * @param runId - the run to read.
   * @returns its record, or undefined when none is held.
   */
  findRun(runId: RunId): DurableRunRecord | undefined {
    const stored = this.runs.get(runId)
    return stored === undefined ? undefined : fromStoredRun(stored)
  }

  /**
   * Every run of this runtime that drives one harness session.
   *
   * A model request carries the session it was assembled for, so this is the
   * lookup that turns a stream into the run it is charged to. More than one
   * result means the control plane minted two runs for one session, which is
   * a bookkeeping error rather than a choice a caller may resolve.
   * @param runtime - the reading runtime's own audience identifier.
   * @param sessionId - the session a request names.
   * @returns the matching records, in no defined order.
   */
  runsOfSession(runtime: string, sessionId: SessionId): readonly DurableRunRecord[] {
    const found: DurableRunRecord[] = []
    for (const [, stored] of this.runs.entries()) {
      if (stored.runtime === runtime && stored.sessionId === sessionId) found.push(fromStoredRun(stored))
    }
    return found
  }

  /**
   * Write the record of one newly opened run.
   * @param run - the run's accounting, tenant, runtime, and settlement state.
   * @returns resolution after the write reaches the medium.
   */
  async openRun(run: DurableRunRecord): Promise<void> {
    await this.runs.put(run.record.runId, toStoredRun(run))
  }

  /**
   * Update what one run has spent, leaving every other field as it is.
   *
   * A whole-record write would erase {@link DurableRunRecord.absorbed}, whose
   * whole purpose is to survive until the settled child it names is deleted.
   * @param runId - the run being charged.
   * @param spent - everything charged to it so far.
   * @returns resolution after the write reaches the medium; a run with no
   *   record is a no-op, because only a live ledger can say it exists.
   */
  async recordRunSpend(runId: RunId, spent: RunSpend): Promise<void> {
    if (this.runs.get(runId) === undefined) return
    await this.runs.update(runId, current => ({
      ...current,
      spent: { tokens: spent.tokens, wallMs: spent.wallMs, costMicroUsd: spent.costMicroUsd },
    }))
  }

  /**
   * Fold one settled child's charge into its parent, at most once.
   *
   * The parent's allowance is what a child's spend is charged to, exactly as a
   * tenant's is for a root, so this is {@link consumeTenantAllowance} one level
   * lower and carries the same marker for the same reason: crediting the parent
   * and deleting the child are two writes, and a crash between them must not
   * credit the parent twice.
   * @param parentRunId - the delegating run.
   * @param childRunId - the settled child, recorded as absorbed.
   * @param spent - the child's charge, already capped at what it reserved.
   * @returns resolution after the write reaches the medium; a parent with no
   *   record is a no-op.
   */
  async absorbChild(parentRunId: RunId, childRunId: RunId, spent: RunSpend): Promise<void> {
    const parent = this.runs.get(parentRunId)
    if (parent === undefined || parent.absorbed === childRunId) return
    await this.runs.update(parentRunId, current => ({
      ...current,
      spent: {
        tokens: current.spent.tokens + spent.tokens,
        wallMs: current.spent.wallMs + spent.wallMs,
        costMicroUsd: current.spent.costMicroUsd + spent.costMicroUsd,
      },
      absorbed: childRunId,
    }))
  }

  /**
   * Write down what settling one run charges, before that charge is applied.
   *
   * This is the durable decision point of a settlement: after it, a recovering
   * runtime knows the run is finished and how much it owes, whatever else was
   * interrupted.
   * @param runId - the run being settled.
   * @param spent - what it and its descendants consumed.
   * @returns the marked record, which carries the tenant the charge belongs to.
   * @throws DomainError when no record is held for that run — a run open in a
   *   ledger always has one, so an absent record is a lost write rather than a
   *   run to settle silently.
   */
  async markRunSettled(runId: RunId, spent: RunSpend): Promise<DurableRunRecord> {
    const stored = await this.runs.update(runId, current => ({
      ...current,
      settledSpent: { tokens: spent.tokens, wallMs: spent.wallMs, costMicroUsd: spent.costMicroUsd },
    }))
    return fromStoredRun(stored)
  }

  /**
   * Remove one run's record.
   * @param runId - the run to forget.
   * @returns true when a record was removed, false when it was already absent.
   */
  deleteRun(runId: RunId): Promise<boolean> {
    return this.runs.delete(runId)
  }

  /**
   * Append records to one subject's trail, keeping the most recent `retain`.
   *
   * The cap is the caller's because it is a deployment's retention choice, not
   * a property of the medium. It is also the whole of the retention policy:
   * a trail is a window on recent activity, and the record that falls out of it
   * is gone.
   * @param subject - the tenant or runtime the records belong to.
   * @param records - what happened, oldest first.
   * @param retain - most records to keep for this subject; at least one.
   * @returns the trail as stored, after the write reaches the medium.
   * @throws RangeError when `retain` is not a positive safe integer, which is a
   *   deployment error rather than a record to drop.
   */
  async recordAudit(
    subject: AuditSubject,
    records: readonly RunAuditRecord[],
    retain: number,
  ): Promise<readonly RunAuditRecord[]> {
    if (!Number.isSafeInteger(retain) || retain <= 0) {
      throw new RangeError(`dsh-control-plane-store: audit retention must be a positive safe integer, got ${String(retain)}`)
    }
    if (records.length === 0) return this.auditsOf(subject)
    const kept = [...this.audits.get(subject)?.records ?? [], ...records].slice(-retain)
    await this.audits.put(subject, { records: kept })
    return kept
  }

  /**
   * One subject's recorded activity, oldest first.
   * @param subject - the tenant or runtime to read.
   * @returns its retained records; empty when nothing is recorded for it.
   */
  auditsOf(subject: AuditSubject): readonly RunAuditRecord[] {
    return this.audits.get(subject)?.records ?? []
  }

}

export default ControlPlaneStore
