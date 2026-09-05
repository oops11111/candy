/**
 * The Candy control plane's composition root: the one place that performs
 * Admit, Open and Place in order, and undoes what it holds when a later step
 * refuses.
 *
 * [The subsystem page](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/candy-control-plane.md)
 * states the order those steps run in and why each is placed where it is.
 * Until this module, nothing performed it: each caller wrote the sequence
 * itself, and none of them undid the funding when the placement failed.
 *
 * That rollback is what this module owns. `RunLedger.openChild` subtracts a
 * child's allowance from its parent the moment the child opens, and creating
 * a pool directory can refuse — a base the deployment never provisioned, a
 * link planted where the root goes. A sequence that opens the ledger record
 * first and stops there leaves the parent short of an allowance no run is
 * spending, until the lease expires. Closing the record on the way out returns
 * it immediately.
 *
 * Binding a provider is deliberately not here. It allocates nothing, so it
 * needs no rollback, and it is provider-specific where every step here is not.
 *
 * @module @deepseek-ai/dsh-run-start
 */

import type { RunId } from '@deepseek-ai/dsh-control-plane'
import type { CredentialAuditEvent } from '@deepseek-ai/dsh-credential-vault'
import type { ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'
import {
  admitRun,
  type AdmittedRun,
  type RunAdmissionPolicy,
  type RunRejection,
  type RunRequest,
} from '@deepseek-ai/dsh-run-admission'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { RunLedger, RunLedgerRejection } from '@deepseek-ai/dsh-run-ledger'
import { openRuntimePool } from '@deepseek-ai/dsh-runtime-pool'

/** What one deployment brings to starting a run, beyond the admission policy. */
export interface RunStartOptions {
  /** The tree this run joins; a child's hold is taken from its parent here. */
  readonly ledger: RunLedger
  /**
   * The allowance to open this run with, chosen once its identity is known.
   *
   * A root run is normally opened with what admission answered for it. A child
   * is opened with the share its parent is delegating, which is the caller's
   * decision and is refused here when it exceeds what the parent holds.
   * @param run - the admitted run, carrying its claims and admitted budget.
   * @returns the allowance to reserve.
   */
  readonly share: (run: AdmittedRun) => RunBudget
  /** Epoch milliseconds this run's unsettled hold is released at. */
  readonly leaseExpiresAt: number
}

/** Why a run did not start, tagged by the step that refused it. */
export type RunStartRejection =
  | { readonly stage: 'admission'; readonly rejection: RunRejection }
  | {
    readonly stage: 'ledger'
    readonly rejection: RunLedgerRejection
    /**
     * The verified claims of the run the ledger refused.
     *
     * Funding happens after admission, so the identity is known by then; a
     * refusal that dropped it would report that a run was refused without
     * saying whose, which is what `dsh-run-admission` already fixed for every
     * stage of its own.
     */
    readonly claims: ExecutionAssertionClaims
  }

/** One run that is admitted, funded, and placed in its own directory. */
export interface StartedRun {
  /** The admitted run: verified claims, opened credential, pool key and root. */
  readonly run: AdmittedRun
  /** The allowance the ledger opened this run with. */
  readonly reserved: RunBudget
}

/**
 * The outcome of starting one run. Both branches carry the vault records the
 * attempt produced, for the reason `admitRun` does: a denied run is the event
 * an audit trail exists to record.
 */
export type RunStartOutcome =
  | {
    readonly started: true
    readonly value: StartedRun
    readonly audits: readonly CredentialAuditEvent[]
  }
  | {
    readonly started: false
    readonly rejection: RunStartRejection
    readonly audits: readonly CredentialAuditEvent[]
  }

/**
 * Admit one request, fund the run it names, and place it in its pool.
 *
 * The steps run in the order the subsystem page states, and the run holds
 * nothing until every one of them has succeeded: a placement that throws
 * closes the ledger record this call opened, so a parent's allowance comes
 * back at once rather than when the lease expires.
 *
 * What this returns is not yet running. Binding a provider to it, streaming
 * that provider, charging what it spent, and closing the run stay with the
 * caller — the ledger record is open until it calls `close`.
 *
 * @param request - the scheduling attempt, carrying only a token.
 * @param policy - the runtime's expectation, keys, pool base, and stores.
 * @param options - the ledger this run joins, its share, and its lease.
 * @param now - epoch milliseconds from the caller's clock.
 * @returns the started run, or the first step that refused it, either way with
 *   every audit record the attempt produced.
 * @throws RangeError when the assertion secret, a keyring key, or the pool base
 *   is unusable, and Error when the pool's path is not a directory — each a
 *   deployment error rather than a denied run.
 */
export async function startRun(
  request: RunRequest,
  policy: RunAdmissionPolicy,
  options: RunStartOptions,
  now: number,
): Promise<RunStartOutcome> {
  const admission = await admitRun(request, policy, now)
  if (!admission.admitted) {
    return { started: false, rejection: { stage: 'admission', rejection: admission.rejection }, audits: admission.audits }
  }
  const { run, audits } = { run: admission.run, audits: admission.audits }

  const opened = openLedgerRecord(options, run)
  if (!opened.ok) {
    return { started: false, rejection: { stage: 'ledger', rejection: opened.rejection, claims: run.claims }, audits }
  }

  try {
    await openRuntimePool(policy.poolBase, run.poolKey)
  } catch (placementFailed) {
    // The record was opened a moment ago and has spent nothing, so closing it
    // returns a child's whole hold to its parent rather than waiting out the
    // lease. The failure is a deployment error and keeps travelling.
    options.ledger.close(run.claims.runId)
    throw placementFailed
  }

  return { started: true, value: { run, reserved: opened.reserved }, audits }
}

/** Open this run's ledger record as a root or against the parent its claims name. */
function openLedgerRecord(
  options: RunStartOptions,
  run: AdmittedRun,
): { ok: true; reserved: RunBudget } | { ok: false; rejection: RunLedgerRejection } {
  const share = options.share(run)
  const runId: RunId = run.claims.runId
  const parentRunId = run.claims.parentRunId
  const record = parentRunId === undefined
    ? options.ledger.openRoot(runId, share, options.leaseExpiresAt)
    : options.ledger.openChild(parentRunId, runId, share, options.leaseExpiresAt)
  return record.ok ? { ok: true, reserved: record.value.reserved } : { ok: false, rejection: record.rejection }
}
