/**
 * The single-use record behind an execution assertion's nonce.
 *
 * `dsh-run-admission` requires a `spendNonce` port and never retries a nonce
 * it reports as spent, which makes that port the whole of Candy's replay
 * protection. This module is that port's in-process implementation and, more
 * to the point, the statement of what any implementation owes:
 *
 * - **The decision is one indivisible step.** {@link RunReplayStore.spend}
 *   reads and writes without an intervening `await`, so two concurrent
 *   admissions of one token cannot both observe the nonce as fresh. An
 *   implementation that awaits between its read and its write admits both,
 *   which is the failure this port exists to prevent.
 * - **Retention is bounded by the assertion, not by a timer.** A nonce is
 *   remembered while its assertion is still admissible and forgotten after.
 *   Forgetting sooner reopens replay inside the assertion's own lifetime;
 *   remembering longer keeps a record that can no longer deny anything.
 * - **The record is partitioned by tenant.** A nonce spent for one tenant
 *   leaves another tenant's identical nonce spendable, so one tenant cannot
 *   deny another's run by spending a value first.
 *
 * @module @deepseek-ai/dsh-run-replay
 */

import type { ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'

/**
 * Build the key one nonce is recorded under.
 *
 * The tenant is part of the key, and the fields are length-prefixed so no
 * pair of values can forge the boundary between them: both are opaque strings
 * this package does not constrain, and `('ab', 'c')` must not collide with
 * `('a', 'bc')`.
 */
function replayKey(claims: ExecutionAssertionClaims): string {
  return `${String(claims.userId.length)}:${claims.userId}${String(claims.nonce.length)}:${claims.nonce}`
}

/**
 * The nonces spent by assertions that are still admissible.
 *
 * One instance serves one runtime process. It holds no clock: every operation
 * takes the caller's `now`, the same way `dsh-execution-assertion` and
 * `dsh-run-ledger` do, so a scheduler that already has a decision timestamp
 * admits against that instant.
 */
export class RunReplayStore {
  /** Spent nonce key to the epoch millisecond its assertion stops being admissible. */
  private readonly spent = new Map<string, number>()

  /**
   * Record one assertion's nonce as spent, and say whether it was fresh.
   *
   * The read and the write are one synchronous step. A caller wraps this in
   * the `Promise` the port returns; it must not insert an `await` between
   * asking and recording, because that is the window in which two copies of
   * one token both pass.
   *
   * A record whose assertion has expired counts as absent. That costs nothing:
   * `admitExecutionAssertion` refuses an expired assertion before admission
   * reaches this store, so no expired nonce can arrive to take advantage of it.
   *
   * @param claims - the verified claims, whose `nonce`, `userId`, and
   *   `expiresAt` are the record.
   * @param now - epoch milliseconds from the caller's clock.
   * @returns true when this nonce had not been spent, which admits the run;
   *   false when it had, which denies it.
   */
  spend(claims: ExecutionAssertionClaims, now: number): boolean {
    const key = replayKey(claims)
    const expiresAt = this.spent.get(key)
    if (expiresAt !== undefined && expiresAt > now) return false
    this.spent.set(key, claims.expiresAt)
    return true
  }

  /**
   * Drop the records whose assertions can no longer be admitted.
   *
   * This reclaims memory and never changes a decision: {@link spend} already
   * treats an expired record as absent, so a deployment that never calls this
   * denies exactly the same runs and only holds more of them. It is a call
   * rather than a timer for the reason `RunLedger.expire` is: the store owns no
   * clock, and a caller that drives one drives both.
   *
   * @param now - epoch milliseconds from the caller's clock.
   * @returns how many records were dropped.
   */
  evict(now: number): number {
    let dropped = 0
    for (const [key, expiresAt] of this.spent) {
      if (expiresAt <= now) {
        this.spent.delete(key)
        dropped += 1
      }
    }
    return dropped
  }

  /**
   * How many records are held, expired ones included until {@link evict} runs.
   *
   * The count is bounded by the assertions admitted within one maximum
   * lifetime, so a deployment sizes it from its own issue rate rather than
   * from a limit this store imposes.
   */
  get size(): number {
    return this.spent.size
  }
}
