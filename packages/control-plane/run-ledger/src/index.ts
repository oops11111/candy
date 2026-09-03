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
 * This module is the record that makes those questions answerable. Spend is
 * what a record stores and what it may still spend is derived, so a run that
 * consumed more than its allowance is recorded truthfully rather than refused,
 * and a run that is dropped can be settled exactly: the ledger already knows
 * what it consumed. Each record also carries a lease, so an abandoned hold is
 * released on a clock rather than on someone noticing.
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
  reserveChild,
  type BudgetDimension,
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
  /** The allowance this run was opened with. */
  readonly reserved: RunBudget
  /**
   * Everything charged to this run so far, including what its closed children
   * consumed.
   *
   * It may exceed `reserved`: a provider bills what it billed, and a spend
   * refused rather than recorded would leave the ledger reporting an allowance
   * that is already gone. What the run may still spend is derived from this,
   * never stored beside it.
   */
  readonly spent: RunSpend
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

/** The outcome of an operation that changes the ledger. */
export type RunLedgerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: RunLedgerRejection }

/** One recorded spend and what it leaves the run able to do. */
export interface RunChargeResult {
  /** The record after the spend was added to it. */
  readonly record: RunRecord
  /**
   * The consumable dimensions this run has now used in full.
   *
   * Empty while the run may continue. A caller stops a run whose list is not
   * empty; the ledger records the spend either way, because the spend already
   * happened.
   */
  readonly exhausted: readonly BudgetDimension[]
}

/** What one run's spending consumed of its parent's allowance when it closed. */
export interface RunSettlement {
  /** The run that closed. */
  readonly runId: RunId
  /**
   * What this run's allowance was charged: its own spend plus each closed
   * descendant's, capped at what that descendant reserved.
   *
   * It is not the tree's billed total when a descendant overdrew — the excess
   * was spent, but its parent never authorized it, and letting it through here
   * would take it from that descendant's siblings. The true figure for one run
   * is its own record's `spent`, read while it is open.
   */
  readonly spent: RunSpend
  /** Descendants closed with it, deepest first; empty when it had no open children. */
  readonly closed: readonly RunId[]
  /** The parent's remaining allowance after this run's hold was released; absent for a root run. */
  readonly parentRemaining: RunBudget | undefined
}

/** Add two spends together. */
function plus(left: RunSpend, right: RunSpend): RunSpend {
  return {
    tokens: left.tokens + right.tokens,
    wallMs: left.wallMs + right.wallMs,
    costMicroUsd: left.costMicroUsd + right.costMicroUsd,
  }
}

/**
 * The part of one run's spend its parent's allowance absorbs.
 *
 * A child that consumed more than it reserved has already cost the tenant that
 * money, but its parent authorized only the reservation. Capping here is what
 * keeps an overspending child from silently drawing on allowance nobody granted
 * it, while the settlement still reports the true figure.
 */
function cappedAt(spent: RunSpend, reserved: RunBudget): RunSpend {
  return {
    tokens: Math.min(spent.tokens, reserved.tokens),
    wallMs: Math.min(spent.wallMs, reserved.wallMs),
    costMicroUsd: Math.min(spent.costMicroUsd, reserved.costMicroUsd),
  }
}

/** Nothing spent yet. */
const NOTHING: RunSpend = { tokens: 0, wallMs: 0, costMicroUsd: 0 }

/**
 * The live runs of one delegation tree and the allowance each holds.
 *
 * One ledger owns one tree. A parent and its children must share an instance,
 * because a child's reservation is held against its parent's record and two
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
    const record: RunRecord = { runId, parentRunId: undefined, reserved: budget, spent: NOTHING, leaseExpiresAt }
    this.records.set(runId, record)
    return { ok: true, value: record }
  }

  /**
   * Open a child run, holding its allowance against its parent's.
   *
   * The hold is the enforcement: the parent's remaining allowance is derived
   * with every open child's reservation already taken out, so it cannot fund
   * the same tokens twice however many children it starts.
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
    const available = this.remaining(parentRunId)
    if (available === undefined) return { ok: false, rejection: { reason: 'unknown-run', runId: parentRunId } }
    if (this.records.has(runId)) return { ok: false, rejection: { reason: 'duplicate-run', runId } }
    const reservation = reserveChild(available, request)
    if (!reservation.reserved) {
      return { ok: false, rejection: { reason: 'parent-exhausted', denial: reservation.denial } }
    }
    const record: RunRecord = { runId, parentRunId, reserved: reservation.child, spent: NOTHING, leaseExpiresAt }
    this.records.set(runId, record)
    return { ok: true, value: record }
  }

  /**
   * Record what one open run consumed since its last charge.
   *
   * The spend is added, never refused: a provider bills what it billed, and a
   * charge the ledger declined to record would leave it reporting an allowance
   * the run has already used. A run that has exhausted a dimension is reported
   * as such so its caller can stop it, which is the decision refusing was
   * standing in for.
   * @param runId - the run to charge.
   * @param spend - what it consumed.
   * @returns the updated record and the dimensions it has now used in full, or
   *   the reason the run is not open.
   * @throws RangeError when the spend is not made of non-negative safe integers.
   */
  charge(runId: RunId, spend: RunSpend): RunLedgerResult<RunChargeResult> {
    assertRunSpend(spend)
    const record = this.records.get(runId)
    if (record === undefined) return { ok: false, rejection: { reason: 'unknown-run', runId } }
    const next: RunRecord = { ...record, spent: plus(record.spent, spend) }
    this.records.set(runId, next)
    const available = this.allowanceOf(next)
    const exhausted: BudgetDimension[] = (['tokens', 'wallMs', 'costMicroUsd'] as const)
      .filter(dimension => available[dimension] === 0)
    return { ok: true, value: { record: next, exhausted } }
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
   * Close one run and release its hold on its parent.
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
   * through this ledger: what the parent absorbs is what the run consumed,
   * capped at what it was allowed. A run whose final charge never arrived is
   * credited that much too generously, which is bounded by one charge interval.
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
   * What one open run may still spend.
   *
   * Derived rather than stored: the record holds what the run was given and
   * what it has consumed, and every open child's reservation is held out of the
   * result. Nothing is negative — a run that overdrew reads as zero, and the
   * overdraw is visible in its own `spent`.
   * @param runId - the run to measure.
   * @returns its remaining allowance, or `undefined` when the run is not open.
   */
  remaining(runId: RunId): RunBudget | undefined {
    const record = this.records.get(runId)
    return record === undefined ? undefined : this.allowanceOf(record)
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

  /** What one open record may still spend, with every open child's hold taken out. */
  private allowanceOf(record: RunRecord): RunBudget {
    let held = record.spent
    let slots = record.reserved.children
    for (const child of this.records.values()) {
      if (child.parentRunId !== record.runId) continue
      held = plus(held, child.reserved)
      slots -= 1
    }
    return {
      tokens: Math.max(0, record.reserved.tokens - held.tokens),
      wallMs: Math.max(0, record.reserved.wallMs - held.wallMs),
      costMicroUsd: Math.max(0, record.reserved.costMicroUsd - held.costMicroUsd),
      children: Math.max(0, slots),
    }
  }

  /** Close one record with its descendants and release its hold on its parent. */
  private settle(record: RunRecord): RunSettlement {
    const closed: RunId[] = []
    const spent = this.closeSubtree(record, closed)
    this.records.delete(record.runId)
    if (record.parentRunId === undefined) {
      return { runId: record.runId, spent, closed, parentRemaining: undefined }
    }
    // A record carrying a parent id is only ever settled while that parent is
    // open: closing a parent closes its children first, and `expire` cannot
    // reach a child whose parent it already settled.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the comment above states the invariant
    const parent = this.records.get(record.parentRunId)!
    const settledParent: RunRecord = { ...parent, spent: plus(parent.spent, cappedAt(spent, record.reserved)) }
    this.records.set(parent.runId, settledParent)
    return { runId: record.runId, spent, closed, parentRemaining: this.allowanceOf(settledParent) }
  }

  /**
   * Close every descendant of one record and report what its subtree consumed.
   *
   * A descendant's spend is capped at what it reserved before it joins its
   * parent's, for the same reason a settled child's is: the parent authorized
   * the reservation, not whatever the child managed to spend beyond it.
   */
  private closeSubtree(record: RunRecord, closed: RunId[]): RunSpend {
    let spent = record.spent
    for (const child of [...this.records.values()]) {
      if (child.parentRunId !== record.runId) continue
      const childSpent = this.closeSubtree(child, closed)
      this.records.delete(child.runId)
      closed.push(child.runId)
      spent = plus(spent, cappedAt(childSpent, child.reserved))
    }
    return spent
  }
}
