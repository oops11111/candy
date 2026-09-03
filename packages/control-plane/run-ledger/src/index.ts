/**
 * What each live run holds, what it has spent, and how an abandoned hold comes
 * back.
 *
 * `dsh-run-budget` is the arithmetic: a child's allowance is subtracted from
 * its parent at reservation and the unspent remainder returns at settlement.
 * It says nothing about *who* holds a reservation, or what happens when the run
 * holding one never settles — a child that crashes keeps its parent's tokens
 * for as long as the parent lives.
 *
 * This module is the record that makes those questions answerable. Every charge
 * goes through it, so a run that is dropped can be settled exactly rather than
 * estimated: the ledger already knows what the run had left. Each record also
 * carries a lease, so an abandoned hold is released on a clock rather than on
 * someone noticing.
 *
 * Nothing here persists anything. A `RunRecord` is plain data a caller may
 * store, and a deployment that wants a ledger to survive a restart owns that
 * store; the state machine and the arithmetic are what this module owns.
 *
 * @module @deepseek-ai/dsh-run-ledger
 */

import type { RunId } from '@deepseek-ai/dsh-control-plane'
import {
  assertRunBudget,
  assertRunSpend,
  chargeRun,
  reserveChild,
  settleChild,
  type RunBudget,
  type RunBudgetDenial,
  type RunSpend,
} from '@deepseek-ai/dsh-run-budget'

/** One live run's accounting. */
export interface RunRecord {
  /** The run this record is for. */
  readonly runId: RunId
  /** The run that reserved this one's allowance, or `undefined` for a root. */
  readonly parentRunId: RunId | undefined
  /** What this run may still spend. */
  readonly remaining: RunBudget
  /**
   * The allowance this run was opened with.
   *
   * Settlement needs it and `remaining` together: what came back to the parent
   * is the difference, and neither number alone gives it.
   */
  readonly reserved: RunBudget
  /**
   * When an unsettled hold is released, in epoch milliseconds.
   *
   * A run that outlives its lease has its allowance returned to its parent and
   * is removed. The lease is not a deadline the run is told about: it bounds
   * how long a lost run can hold a parent's tokens, nothing more.
   */
  readonly leaseExpiresAt: number
}

/** Why the ledger refused an operation. */
export type RunLedgerRejection =
  /** The run named by the operation is not open. */
  | { readonly reason: 'unknown-run'; readonly runId: RunId }
  /** A run with this id is already open, and reopening it would double its allowance. */
  | { readonly reason: 'duplicate-run'; readonly runId: RunId }
  /** The parent could not fund the requested child allowance. */
  | { readonly reason: 'parent-exhausted'; readonly denial: RunBudgetDenial }
  /** The charge would overdraw the run, which is stopped rather than allowed to continue. */
  | { readonly reason: 'overdrawn'; readonly denial: RunBudgetDenial }

/** The outcome of an operation that changes the ledger. */
export type RunLedgerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: RunLedgerRejection }

/** What one run's spending consumed of its parent's allowance when it closed. */
export interface RunSettlement {
  /** The run that closed. */
  readonly runId: RunId
  /** Everything this run and its descendants spent while they were open. */
  readonly spent: RunSpend
  /** Descendants closed with it, deepest first; empty when it had no open children. */
  readonly closed: readonly RunId[]
  /** The parent's allowance after the unspent remainder returned; absent for a root run. */
  readonly parentRemaining: RunBudget | undefined
}

/**
 * The live runs of one delegation tree and the allowance each holds.
 *
 * One ledger owns one tree. A parent and its children must share an instance,
 * because a reservation is a subtraction from the parent's record and two
 * ledgers would each believe they held the whole allowance.
 */
export class RunLedger {
  private readonly records = new Map<RunId, RunRecord>()

  /**
   * Open the run at the root of a tree, holding the allowance admission granted.
   * @param runId - the run being opened.
   * @param budget - the allowance the run may spend, as admission reported it.
   * @param leaseExpiresAt - when an unsettled hold is released, in epoch milliseconds.
   * @returns the new record, or the reason the id could not be opened.
   * @throws RangeError when the budget is not made of non-negative safe integers.
   */
  openRoot(runId: RunId, budget: RunBudget, leaseExpiresAt: number): RunLedgerResult<RunRecord> {
    assertRunBudget(budget)
    if (this.records.has(runId)) return { ok: false, rejection: { reason: 'duplicate-run', runId } }
    const record: RunRecord = { runId, parentRunId: undefined, remaining: budget, reserved: budget, leaseExpiresAt }
    this.records.set(runId, record)
    return { ok: true, value: record }
  }

  /**
   * Open a child run, taking its allowance out of its parent's.
   *
   * The subtraction is the enforcement, so the parent's record is updated
   * before this returns and cannot fund the same tokens twice.
   * @param parentRunId - the delegating run, which must be open here.
   * @param runId - the child being opened.
   * @param request - the allowance asked for the child.
   * @param leaseExpiresAt - when the child's unsettled hold is released.
   * @returns the child's record, or the reason it could not be opened.
   * @throws RangeError when the request is not made of non-negative safe integers.
   */
  openChild(
    parentRunId: RunId,
    runId: RunId,
    request: RunBudget,
    leaseExpiresAt: number,
  ): RunLedgerResult<RunRecord> {
    assertRunBudget(request, 'request')
    const parent = this.records.get(parentRunId)
    if (parent === undefined) return { ok: false, rejection: { reason: 'unknown-run', runId: parentRunId } }
    if (this.records.has(runId)) return { ok: false, rejection: { reason: 'duplicate-run', runId } }
    const reservation = reserveChild(parent.remaining, request)
    if (!reservation.reserved) {
      return { ok: false, rejection: { reason: 'parent-exhausted', denial: reservation.denial } }
    }
    this.records.set(parentRunId, { ...parent, remaining: reservation.parent })
    const record: RunRecord = {
      runId,
      parentRunId,
      remaining: reservation.child,
      reserved: reservation.child,
      leaseExpiresAt,
    }
    this.records.set(runId, record)
    return { ok: true, value: record }
  }

  /**
   * Charge one open run for what it consumed since its last charge.
   *
   * A charge that would overdraw is refused and nothing is deducted, so a
   * caller that stops the run on a denial never leaves it partly charged.
   * @param runId - the run to charge.
   * @param spend - what it consumed.
   * @returns the run's record after the charge, or the reason it was refused.
   * @throws RangeError when the spend is not made of non-negative safe integers.
   */
  charge(runId: RunId, spend: RunSpend): RunLedgerResult<RunRecord> {
    assertRunSpend(spend)
    const record = this.records.get(runId)
    if (record === undefined) return { ok: false, rejection: { reason: 'unknown-run', runId } }
    const charged = chargeRun(record.remaining, spend)
    if (!charged.charged) return { ok: false, rejection: { reason: 'overdrawn', denial: charged.denial } }
    const next: RunRecord = { ...record, remaining: charged.remaining }
    this.records.set(runId, next)
    return { ok: true, value: next }
  }

  /**
   * Extend one open run's lease.
   *
   * A run that is still working says so by pushing its lease out; a run that
   * stops saying so is settled by {@link expire}. Nothing else moves a lease,
   * so a lease that stops advancing is exactly a run nothing is driving.
   * @param runId - the run whose hold should be held longer.
   * @param leaseExpiresAt - the new release time, in epoch milliseconds.
   * @returns the updated record, or the reason the run is not open.
   */
  renew(runId: RunId, leaseExpiresAt: number): RunLedgerResult<RunRecord> {
    const record = this.records.get(runId)
    if (record === undefined) return { ok: false, rejection: { reason: 'unknown-run', runId } }
    const next: RunRecord = { ...record, leaseExpiresAt }
    this.records.set(runId, next)
    return { ok: true, value: next }
  }

  /**
   * Close one run and return its unspent allowance to its parent.
   *
   * A run with open children closes them too: a child's hold belongs to a tree
   * that no longer has a run to serve, and leaving it would strand the parent's
   * allowance behind a record nothing will settle. The settlement's `spent`
   * therefore covers the whole subtree, and `closed` names the descendants.
   * @param runId - the run to close.
   * @returns the settlement, or the reason the run is not open.
   */
  close(runId: RunId): RunLedgerResult<RunSettlement> {
    const record = this.records.get(runId)
    if (record === undefined) return { ok: false, rejection: { reason: 'unknown-run', runId } }
    return { ok: true, value: this.settle(record) }
  }

  /**
   * Settle every run whose lease has elapsed, earliest lease first.
   *
   * The settlement is exact rather than estimated, because every charge went
   * through this ledger: what returns to the parent is what the run had left.
   * A run whose final charge never arrived is credited that much too
   * generously, which is bounded by one charge interval.
   * @param now - the current time in epoch milliseconds.
   * @returns one settlement per expired run, in the order they were settled;
   *   a run closed as a descendant of an expired one has no settlement of its
   *   own and appears in its ancestor's `closed`.
   */
  expire(now: number): RunSettlement[] {
    const settlements: RunSettlement[] = []
    // Re-read rather than iterate a snapshot: settling a parent closes its
    // children, and a child already gone must not be settled a second time.
    while (true) {
      const expired = [...this.records.values()]
        .filter(record => record.leaseExpiresAt <= now)
        .sort((left, right) => left.leaseExpiresAt - right.leaseExpiresAt)[0]
      if (expired === undefined) return settlements
      settlements.push(this.settle(expired))
    }
  }

  /**
   * Read one open run's record.
   * @param runId - the run to read.
   * @returns the record, or `undefined` when the run is not open.
   */
  get(runId: RunId): RunRecord | undefined {
    return this.records.get(runId)
  }

  /**
   * Every open run, in the order they were opened.
   * @returns a detached list of the current records.
   */
  open(): RunRecord[] {
    return [...this.records.values()]
  }

  /** Close one record with its descendants and credit whatever reserved it. */
  private settle(record: RunRecord): RunSettlement {
    const closed: RunId[] = []
    const spent = this.closeSubtree(record, closed)
    this.records.delete(record.runId)
    return {
      runId: record.runId,
      spent,
      closed,
      parentRemaining: record.parentRunId === undefined
        ? undefined
        : this.creditParent(record.parentRunId, record.reserved, spent),
    }
  }

  /**
   * Close every descendant of one record and report what its subtree spent.
   *
   * The remainder is carried in a local rather than written back per child:
   * the record itself is deleted by the caller, so the only value that has to
   * survive is the total.
   */
  private closeSubtree(record: RunRecord, closed: RunId[]): RunSpend {
    let remaining = record.remaining
    for (const child of [...this.records.values()]) {
      if (child.parentRunId !== record.runId) continue
      const childSpent = this.closeSubtree(child, closed)
      this.records.delete(child.runId)
      closed.push(child.runId)
      remaining = settleChild(remaining, child.reserved, childSpent)
    }
    return {
      tokens: record.reserved.tokens - remaining.tokens,
      wallMs: record.reserved.wallMs - remaining.wallMs,
      costMicroUsd: record.reserved.costMicroUsd - remaining.costMicroUsd,
    }
  }

  /**
   * Return one closed run's unspent allowance to the run that reserved it.
   *
   * The parent is open whenever this runs: closing a parent closes its children
   * first, and `expire` cannot reach a child whose parent it already settled.
   */
  private creditParent(parentRunId: RunId, reserved: RunBudget, spent: RunSpend): RunBudget {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the doc above states the invariant
    const parent = this.records.get(parentRunId)!
    const remaining = settleChild(parent.remaining, reserved, spent)
    this.records.set(parent.runId, { ...parent, remaining })
    return remaining
  }
}
