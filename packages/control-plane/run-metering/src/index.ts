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
import { billedTokens, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { hasRemainingBudget, type BudgetDimension, type RunBudget, type RunSpend } from '@deepseek-ai/dsh-run-budget'
import type { RunChargeResult, RunLedgerResult } from '@deepseek-ai/dsh-run-ledger'

/** The failure code a stream cut short by its run's allowance carries. */
export const RUN_BUDGET_EXHAUSTED = 'RUN_BUDGET_EXHAUSTED'

/** The failure code for a call metered against a run that is not open. */
export const RUN_NOT_OPEN = 'RUN_NOT_OPEN'

/**
 * The failure code for a call whose run authenticated with an account that has
 * since been revoked or deleted.
 *
 * A run opens its credential once, at admission, and holds it for as long as it
 * lives. Revoking the account destroys the stored envelope, which stops the
 * next admission but reaches nothing already running, so this is the code an
 * in-flight call is refused with.
 */
export const CREDENTIAL_REVOKED = 'CREDENTIAL_REVOKED'

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
  /**
   * Report one call this meter refused or cut short.
   *
   * The refusal is the whole of what a consumer sees — a terminal `error`
   * finish — and it says nothing to anyone watching the deployment. A caller
   * that keeps an audit trail records the call here; one metering by hand
   * passes nothing and the refusals go unrecorded, as they did before.
   *
   * Awaited before the terminal chunk is yielded, so a consumer cannot act on
   * a refusal the trail does not yet have. An implementation whose recording
   * can fail settles that itself: a rejection here would leave the stream
   * without the one terminal chunk this seam promises.
   */
  readonly refused?: (runId: RunId, code: string, message: string) => void | Promise<void>
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
 * A stream that is only a refusal.
 *
 * A caller that decides a call cannot be metered before {@link meterRun} could
 * — because it cannot tell which run to charge — owes its consumer the same
 * one terminal chunk this module produces, in the same vocabulary.
 * @param message - what an operator needs to know about the refusal.
 * @param code - the machine-routing code; one of this module's two.
 * @returns a stream of exactly that terminal chunk.
 */
export function refusedCall(message: string, code: string): AsyncIterable<StreamChunk> {
  const chunk = failed(message, code)
  return {
    [Symbol.asyncIterator]: () => {
      let sent = false
      return {
        next: (): Promise<IteratorResult<StreamChunk>> => {
          if (sent) return Promise.resolve({ done: true, value: undefined })
          sent = true
          return Promise.resolve({ done: false, value: chunk })
        },
      }
    },
  }
}

/**
 * Report one refusal, then build the terminal chunk that carries it.
 *
 * Reporting happens here rather than at each site so a refusal cannot reach a
 * consumer without having reached the trail first.
 *
 * @param ports - the meter's ports, whose `refused` observer is optional.
 * @param runId - the run whose call was refused.
 * @param message - what the consumer is told.
 * @param code - the failure code the consumer matches on.
 * @returns the terminal `error` finish for this refusal.
 */
async function refuse(ports: RunMeterPorts, runId: RunId, message: string, code: string): Promise<StreamChunk> {
  await ports.refused?.(runId, code, message)
  return failed(message, code)
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
 * - the call outran the wall time the run had left, waited for rather than
 *   noticed, so a provider that accepts the request and then says nothing is
 *   bounded by the same dimension as one that talks too long.
 *
 * A cut is not a cancellation of the run: the run stays open and its ledger
 * record keeps what this call consumed, so its caller decides what happens
 * next.
 * @param source - the provider's stream for one call.
 * @param runId - the open run this call is charged to.
 * @param ports - how to read the run's remainder, charge it, and read the clock.
 * @returns the same chunks, ending early when the run cannot afford the rest;
 *   a generator, so a consumer that stops reading can close the source it holds.
 */
export async function* meterRun(
  source: AsyncIterable<StreamChunk>,
  runId: RunId,
  ports: RunMeterPorts,
): AsyncGenerator<StreamChunk, void, undefined> {
  const now = ports.now ?? Date.now
  const available = ports.remaining(runId)
  if (available === undefined) {
    yield await refuse(ports, runId, `run '${runId}' is not open, so this call cannot be charged to it`, RUN_NOT_OPEN)
    return
  }
  if (!hasRemainingBudget(available)) {
    // `hasRemainingBudget` is false exactly when a consumable dimension reached
    // zero, so the list is never empty.
    yield await refuse(ports, runId, `run '${runId}' has spent ${exhaustedIn(available).join(', ')}`, RUN_BUDGET_EXHAUSTED)
    return
  }

  const startedAt = now()
  const deadline = startedAt + available.wallMs
  const reader = source[Symbol.asyncIterator]()
  let usage: TokenUsage | undefined
  let charged = false
  let answering = true
  try {
    for (;;) {
      const step = await nextBefore(reader, deadline, now)
      if (step === 'timeout') {
        answering = false
        charged = true
        await ports.charge(runId, spendOf(usage, now() - startedAt))
        yield await refuse(ports, runId, `run '${runId}' ran past the wall time it had left`, RUN_BUDGET_EXHAUSTED)
        return
      }
      if (step.done === true) return
      const chunk = step.value
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') {
        charged = true
        await ports.charge(runId, spendOf(usage, now() - startedAt))
        yield chunk
        return
      }
      yield chunk
    }
  } finally {
    // A source that ends without a finish, or a consumer that stops reading,
    // still spent this call's time and whatever usage had arrived.
    if (!charged) await ports.charge(runId, spendOf(usage, now() - startedAt))
    await closeSource(reader, answering)
  }
}

/**
 * The source's next chunk, or `timeout` once the run's wall time is gone.
 *
 * The deadline is waited for rather than checked between chunks. A provider
 * that accepts a request and then goes quiet produces no chunk to check
 * against, so a between-chunks test bounds only the talkative failure and
 * leaves the silent one to whatever else eventually notices the run.
 *
 * @param reader - the source, read one chunk at a time.
 * @param deadline - epoch millisecond the run's wall time runs out at.
 * @param now - the caller's clock.
 * @returns the read, or `timeout` when the deadline arrived first.
 */
async function nextBefore(
  reader: AsyncIterator<StreamChunk>,
  deadline: number,
  now: () => number,
): Promise<IteratorResult<StreamChunk> | 'timeout'> {
  const left = deadline - now()
  // A clock that has already passed the deadline gets no timer: `setTimeout`
  // treats a non-positive delay as one tick, which would read one more chunk
  // from a source whose time is gone.
  if (left <= 0) return 'timeout'
  let expire!: (outcome: 'timeout') => void
  const expired = new Promise<'timeout'>((resolve) => { expire = resolve })
  const timer = setTimeout(() => { expire('timeout') }, left)
  try {
    return await Promise.race([reader.next(), expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Close the source this call was reading.
 *
 * Quiescence is awaited only from a source that is still answering. On the
 * deadline path it is not: that path exists because the provider stopped
 * answering, and a source blocked on the same silence would not answer a
 * close either — awaiting it would hang exactly the call the deadline just
 * bounded. The close is still started, so a source that can act on it, such
 * as one holding a provider process, still hears it.
 *
 * @param reader - the source this call read.
 * @param answering - whether the source is still responding to reads.
 * @returns resolution once the source is closed, or immediately when it is not
 *   answering or has no close of its own.
 */
async function closeSource(reader: AsyncIterator<StreamChunk>, answering: boolean): Promise<void> {
  if (reader.return === undefined) return
  const closing = reader.return()
  if (!answering) {
    closing.then(() => undefined, () => undefined)
    return
  }
  await closing
}

/**
 * What one call consumed, in the three dimensions a run is charged in.
 *
 * Elapsed time is floored at zero: a host clock that steps backwards mid-call
 * would otherwise produce a negative spend, which the ledger rejects as an
 * arithmetic defect rather than recording as a refund.
 */
function spendOf(usage: TokenUsage | undefined, wallMs: number): RunSpend {
  return { tokens: usage === undefined ? 0 : billedTokens(usage), wallMs: Math.max(0, wallMs), costMicroUsd: costOf(usage) }
}

/** The consumable dimensions an allowance has already used in full. */
function exhaustedIn(budget: RunBudget): readonly BudgetDimension[] {
  return (['tokens', 'wallMs', 'costMicroUsd'] as const).filter(dimension => budget[dimension] === 0)
}
