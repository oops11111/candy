/**
 * What a tenant was granted, what its finished runs have taken from it, and
 * what a new run may therefore be started against.
 *
 * `dsh-run-budget` bounds one delegation tree and `dsh-run-ledger` holds that
 * tree's live records. Neither says anything about the tenant above them: a
 * grant read straight out of a store bounds one run, not a tenant, so a tenant
 * granted a million tokens could start a run, spend the million, close it, and
 * start another against the same million. Nothing was wrong with either module
 * — the quantity they were handed had simply never been consumed.
 *
 * This module is that consumption. A tenant is the root every delegation tree
 * hangs from, so it is accounted exactly as a parent run is: an open run's
 * reservation is held out of what remains while it runs, and what it actually
 * spent is added to the tenant's consumption when it settles. The concurrency
 * arithmetic is the same one `reserveChild` performs, one level higher, which
 * is what makes `grant.children` a bound on the tenant's whole forest rather
 * than on any single tree in it.
 *
 * Consumption is recorded, never capped. A tenant that overdrew is a fact to
 * report, and a subtraction that stopped at zero would erase how far past the
 * grant a run went. What is clamped is only the answer to "what may start now",
 * which cannot be negative.
 *
 * Nothing here persists anything and nothing here holds a clock. A
 * `TenantAllowance` is plain data a caller stores, and which runs are open is
 * the caller's to know.
 *
 * @module @deepseek-ai/dsh-tenant-allowance
 */

import {
  assertRunBudget,
  assertRunSpend,
  type RunBudget,
  type RunSpend,
} from '@deepseek-ai/dsh-run-budget'

/**
 * One tenant's standing grant and what has been taken from it.
 *
 * The two fields are kept apart rather than folded into one remaining figure
 * because they answer different questions: the grant is what an operator set
 * and a decrementing number loses it after the first run, while consumption is
 * what the tenant used and is the quantity a quota report is made of.
 */
export interface TenantAllowance {
  /** The allowance an operator granted this tenant, unchanged by any run. */
  readonly grant: RunBudget
  /**
   * Everything this tenant's settled runs consumed, added up.
   *
   * It may exceed the grant in any consumable dimension: a provider bills what
   * it billed, and a settlement the tenant record declined to absorb would
   * leave the tenant reporting an allowance it has already spent.
   */
  readonly consumed: RunSpend
}

/** Nothing consumed yet. */
const NOTHING: RunSpend = { tokens: 0, wallMs: 0, costMicroUsd: 0 }

/**
 * Open a fresh allowance for one tenant.
 * @param grant - what the tenant may spend before any run has run.
 * @returns the allowance with nothing consumed against it.
 * @throws RangeError when the grant is not made of non-negative safe integers.
 */
export function openAllowance(grant: RunBudget): TenantAllowance {
  assertRunBudget(grant, 'grant')
  return { grant, consumed: NOTHING }
}

/**
 * Reject an allowance that is not made of non-negative safe integers.
 * @param allowance - the tenant record to check.
 * @param label - which argument it is, for the failure message.
 * @throws RangeError when either half is negative, fractional, or beyond safe
 *   integer range, since an allowance arriving in that state is a storage or
 *   arithmetic defect rather than an exhausted tenant.
 */
export function assertTenantAllowance(allowance: TenantAllowance, label = 'allowance'): void {
  assertRunBudget(allowance.grant, `${label}.grant`)
  assertRunSpend(allowance.consumed, `${label}.consumed`)
}

/**
 * What one tenant may start a new root run against.
 *
 * Both subtractions are the enforcement. Consumption is taken out because a
 * grant that is never drawn down bounds one run rather than a tenant. Every
 * open run's reservation is taken out as well, because two runs live at once
 * would otherwise each be admitted against the whole remainder and could
 * together spend it twice.
 *
 * A held run costs one concurrency slot for itself plus every slot it may hand
 * down, exactly as a child costs its parent in `reserveChild`. The tenant is
 * the root of its forest, so `grant.children` is the number of runs that may
 * be live anywhere across every tree the tenant has open.
 * @param allowance - the tenant's grant and what it has consumed.
 * @param held - the reservation of every run of this tenant that is still open.
 * @returns what remains, with nothing negative; a tenant that overdrew reads as
 *   zero and the overdraw stays visible in `allowance.consumed`.
 * @throws RangeError when the allowance or any held reservation is not made of
 *   non-negative safe integers.
 */
export function remainingAllowance(allowance: TenantAllowance, held: readonly RunBudget[]): RunBudget {
  assertTenantAllowance(allowance)
  const { grant, consumed } = allowance
  let tokens = grant.tokens - consumed.tokens
  let wallMs = grant.wallMs - consumed.wallMs
  let costMicroUsd = grant.costMicroUsd - consumed.costMicroUsd
  let slots = grant.children
  for (const reservation of held) {
    assertRunBudget(reservation, 'held')
    tokens -= reservation.tokens
    wallMs -= reservation.wallMs
    costMicroUsd -= reservation.costMicroUsd
    slots -= 1 + reservation.children
  }
  return {
    tokens: Math.max(0, tokens),
    wallMs: Math.max(0, wallMs),
    costMicroUsd: Math.max(0, costMicroUsd),
    children: Math.max(0, slots),
  }
}

/**
 * Add one settlement to what a tenant has consumed.
 *
 * The settlement `dsh-run-ledger` reports for a root run already covers its
 * whole subtree, so a tree is folded into its tenant once, when its root
 * closes, rather than once per descendant.
 * @param allowance - the tenant's current record.
 * @param spent - what a settled root run and its descendants consumed.
 * @returns the record with that spend added; the grant is untouched.
 * @throws RangeError when the allowance or the spend is not made of
 *   non-negative safe integers.
 */
export function consumeAllowance(allowance: TenantAllowance, spent: RunSpend): TenantAllowance {
  assertTenantAllowance(allowance)
  assertRunSpend(spent, 'spent')
  return {
    grant: allowance.grant,
    consumed: {
      tokens: allowance.consumed.tokens + spent.tokens,
      wallMs: allowance.consumed.wallMs + spent.wallMs,
      costMicroUsd: allowance.consumed.costMicroUsd + spent.costMicroUsd,
    },
  }
}
