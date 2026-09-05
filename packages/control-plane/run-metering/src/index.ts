/**
 * The point where a run's allowance stops being an accounting figure and
 * starts stopping work.
 *
 * `dsh-run-budget` bounds a delegation tree, `dsh-run-ledger` records what each
 * run holds and has spent, and `dsh-run-admission` refuses a run whose
 * allowance is already gone. Between those two moments nothing was watching: a
 * run admitted with a thousand tokens could stream a million, because `charge`
 * reports the dimensions a run has used up and no caller was reading the
 * report. The boundaries page asks that a child not exceed its grant, and the
 * grant was only enforced at the gate.
 *
 * This module is the enforcement in between. It wraps one provider stream for
 * one open run: it refuses to start the call when the run has nothing left,
 * cuts the stream when the call outruns the wall time the run still had, and
 * charges what the call consumed before its terminal chunk is passed on — so
 * the next call is measured against a ledger that already knows about this one.
 *
 * It does not decide what a run may spend and does not hold a ledger. Both are
 * passed in, because the ledger belongs to a runtime and this belongs to a
 * call.
 *
 * @module @deepseek-ai/dsh-run-metering
 */

import type { RunId } from '@deepseek-ai/dsh-control-plane'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { hasRemainingBudget, type BudgetDimension, type RunBudget, type RunSpend } from '@deepseek-ai/dsh-run-budget'
import type { RunChargeResult, RunLedgerResult } from '@deepseek-ai/dsh-run-ledger'

/** The failure code a stream cut short by its run's allowance carries. */
export const RUN_BUDGET_EXHAUSTED = 'RUN_BUDGET_EXHAUSTED'

/** The failure code for a call metered against a run that is not open. */
export const RUN_NOT_OPEN = 'RUN_NOT_OPEN'

/** What one metered call needs from the runtime that owns the run. */
export interface RunMeterPorts {
  /**
   * What the run may still spend, read once before the provider is called.
   *
   * `undefined` means the run is not open, which refuses the call rather than
   * metering it against nothing.
   */
  readonly remaining: (runId: RunId) => RunBudget | undefined
  /**
   * Record what this call consumed.
   *
   * Called once per stream, so a deployment whose charge is durable writes once
   * per model call rather than once per chunk.
   */
  readonly charge: (runId: RunId, spend: RunSpend) => Promise<RunLedgerResult<RunChargeResult>>
  /** Epoch milliseconds; a caller with its own clock passes it for the wall dimension. */
  readonly now?: () => number
}

/** Tokens this call consumed, as the provider reported them. */
function tokensOf(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0
  // `totalTokens` is the provider's exact full-call figure when it gave one;
  // the sum of the disjoint counters is the derivation adapters use otherwise.
  return usage.totalTokens ?? usage.inputTokens + usage.outputTokens
}

/**
 * Money this call cost, as the provider reported it.
 *
 * An absent `costMicroUsd` means "not reported", which is not zero — a run on a
 * provider that stays silent is metered on tokens and time alone, and its money
 * dimension never moves.
 */
function costOf(usage: TokenUsage | undefined): number {
  return usage?.costMicroUsd ?? 0
}

/** The terminal chunk a refused or cut call ends with. */
function failed(message: string, code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

/**
 * Meter one provider stream against one open run.
 *
 * The stream is passed through unchanged while the run can afford it. Three
 * things end it early, each with a terminal `error` finish rather than a
 * throw, because a consumer of this seam is promised exactly one terminal
 * chunk and an exception is not one:
 *
 * - the run is not open, so nothing can be charged for the call;
 * - the run has nothing left to spend, checked before the provider is called at
 *   all, which is what stops an exhausted run from making the call whose usage
 *   would have reported the exhaustion;
 * - the call outran the wall time the run had left, checked as chunks arrive.
 *
 * A cut is not a cancellation of the run: the run stays open and its ledger
 * record keeps what this call consumed, so its caller decides what happens
 * next. Closing the source is left to the generator's own return path, which
 * runs when the consumer stops reading.
 * @param source - the provider's stream for one call.
 * @param runId - the open run this call is charged to.
 * @param ports - how to read the run's remainder, charge it, and read the clock.
 * @returns the same chunks, ending early when the run cannot afford the rest.
 */
export async function* meterRun(
  source: AsyncIterable<StreamChunk>,
  runId: RunId,
  ports: RunMeterPorts,
): AsyncIterable<StreamChunk> {
  const now = ports.now ?? Date.now
  const available = ports.remaining(runId)
  if (available === undefined) {
    yield failed(`run '${runId}' is not open, so this call cannot be charged to it`, RUN_NOT_OPEN)
    return
  }
  if (!hasRemainingBudget(available)) {
    // `hasRemainingBudget` is false exactly when a consumable dimension reached
    // zero, so the list is never empty.
    yield failed(`run '${runId}' has spent ${exhaustedIn(available).join(', ')}`, RUN_BUDGET_EXHAUSTED)
    return
  }

  const startedAt = now()
  const deadline = startedAt + available.wallMs
  let usage: TokenUsage | undefined
  let charged = false
  try {
    for await (const chunk of source) {
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') {
        charged = true
        await ports.charge(runId, spendOf(usage, now() - startedAt))
        yield chunk
        return
      }
      yield chunk
      if (now() <= deadline) continue
      charged = true
      await ports.charge(runId, spendOf(usage, now() - startedAt))
      yield failed(`run '${runId}' ran past the wall time it had left`, RUN_BUDGET_EXHAUSTED)
      return
    }
  } finally {
    // A source that ends without a finish, or a consumer that stops reading,
    // still spent this call's time and whatever usage had arrived.
    if (!charged) await ports.charge(runId, spendOf(usage, now() - startedAt))
  }
}

/**
 * What one call consumed, in the three dimensions a run is charged in.
 *
 * Elapsed time is floored at zero: a host clock that steps backwards mid-call
 * would otherwise produce a negative spend, which the ledger rejects as an
 * arithmetic defect rather than recording as a refund.
 */
function spendOf(usage: TokenUsage | undefined, wallMs: number): RunSpend {
  return { tokens: tokensOf(usage), wallMs: Math.max(0, wallMs), costMicroUsd: costOf(usage) }
}

/** The consumable dimensions an allowance has already used in full. */
function exhaustedIn(budget: RunBudget): readonly BudgetDimension[] {
  return (['tokens', 'wallMs', 'costMicroUsd'] as const).filter(dimension => budget[dimension] === 0)
}
