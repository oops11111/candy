/**
 * What one run may consume, and how a child run draws its allowance from its
 * parent's.
 *
 * The harness already caps delegation *depth* (`dsh-subagent`'s
 * `SubagentDepthError`) and pins a child's sandbox and approval policy to its
 * parent's. Neither bounds what a tree of runs may spend: depth 3 with ten
 * children at each level is 1000 runs, each free to consume a tenant's tokens,
 * time, and money. This module supplies the missing half — a budget a child
 * takes *from* its parent rather than alongside it.
 *
 * The one rule everything here serves: a subtree can never spend more than the
 * run that delegated it had left. A child's allowance is subtracted from its
 * parent at reservation, so the parent cannot hand out more than it holds, and
 * an unspent remainder returns only when the child settles.
 *
 * Money is integer micro-USD. A budget compared or decremented in floating
 * point drifts, and a spend limit that drifts is not a limit.
 *
 * @module @deepseek-ai/dsh-run-budget
 */

/** The dimensions a run is bounded in. */
export type BudgetDimension = 'tokens' | 'wallMs' | 'costMicroUsd' | 'children'

/** Every dimension, in the order denials report them. */
export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = ['tokens', 'wallMs', 'costMicroUsd', 'children']

/**
 * One run's remaining allowance.
 *
 * Every field is a non-negative safe integer. `children` is the number of
 * child runs that may be live at once — a slot returned when a child settles,
 * unlike the other three, which are consumed for good.
 */
export interface RunBudget {
  /** Model tokens, billed input and output together. */
  readonly tokens: number
  /** Wall-clock milliseconds. */
  readonly wallMs: number
  /** Money, in integer micro-USD. */
  readonly costMicroUsd: number
  /** Child runs that may be live at once. */
  readonly children: number
}

/**
 * What a run consumed. Deliberately has no `children`: a child slot is held
 * and returned, never spent, so allowing one here would let a caller destroy
 * concurrency it is supposed to release.
 */
export interface RunSpend {
  /** Model tokens consumed. */
  readonly tokens: number
  /** Wall-clock milliseconds elapsed. */
  readonly wallMs: number
  /** Money spent, in integer micro-USD. */
  readonly costMicroUsd: number
}

/** Why a request was refused, naming the one dimension that stopped it. */
export interface RunBudgetDenial {
  /** The dimension that was insufficient. */
  readonly dimension: BudgetDimension
  /** What the request needed. */
  readonly requested: number
  /** What the budget held. */
  readonly available: number
}

/** The outcome of asking a parent for a child's allowance. */
export type ChildReservation =
  | {
    readonly reserved: true
    /** The allowance the child runs under. */
    readonly child: RunBudget
    /** The parent's allowance after the reservation, with one child slot held. */
    readonly parent: RunBudget
  }
  | { readonly reserved: false; readonly denial: RunBudgetDenial }

/** The outcome of charging a run for what it consumed. */
export type RunCharge =
  | { readonly charged: true; readonly remaining: RunBudget }
  | { readonly charged: false; readonly denial: RunBudgetDenial }

/** Require one field to be a non-negative safe integer. */
function requireCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`run budget ${field} must be a non-negative safe integer, got ${String(value)}`)
  }
}

/**
 * Reject a budget that is not made of non-negative safe integers.
 * @param budget - the allowance to check.
 * @param label - which argument it is, for the failure message.
 * @throws RangeError when any field is negative, fractional, or beyond safe
 * integer range, since a budget arriving in that state is a storage or
 * arithmetic defect rather than an exhausted run.
 */
export function assertRunBudget(budget: RunBudget, label = 'budget'): void {
  requireCount(budget.tokens, `${label}.tokens`)
  requireCount(budget.wallMs, `${label}.wallMs`)
  requireCount(budget.costMicroUsd, `${label}.costMicroUsd`)
  requireCount(budget.children, `${label}.children`)
}

/**
 * Reject a spend that is not made of non-negative safe integers.
 * @param spend - the consumption to check.
 * @param label - which argument it is, for the failure message.
 * @throws RangeError under the same conditions as {@link assertRunBudget}.
 */
export function assertRunSpend(spend: RunSpend, label = 'spend'): void {
  requireCount(spend.tokens, `${label}.tokens`)
  requireCount(spend.wallMs, `${label}.wallMs`)
  requireCount(spend.costMicroUsd, `${label}.costMicroUsd`)
}

/** The first consumable dimension where `requested` exceeds `available`. */
function shortfall(available: RunBudget, requested: RunBudget): RunBudgetDenial | undefined {
  for (const dimension of BUDGET_DIMENSIONS) {
    if (requested[dimension] > available[dimension]) {
      return { dimension, requested: requested[dimension], available: available[dimension] }
    }
  }
  return undefined
}

/**
 * Take a child's allowance out of its parent's.
 *
 * The subtraction is the enforcement: after this returns, the parent holds
 * only what it did not delegate, so it cannot promise the same tokens twice
 * however many children it starts. One child slot is held for the duration and
 * returned by {@link settleChild}.
 *
 * A request is refused, not clamped. Silently shrinking it would start a child
 * under a budget its caller never chose, and a subagent that stops mid-task
 * because it was quietly given a tenth of what it asked for is harder to
 * diagnose than one that was refused.
 * @param parent - the delegating run's remaining allowance.
 * @param request - the allowance asked for the child; its `children` is the
 *   grandchild concurrency the child may itself delegate.
 * @returns the child's allowance and the parent's reduced remainder, or the
 *   one dimension that was insufficient.
 * @throws RangeError when either argument is not made of non-negative safe integers.
 */
export function reserveChild(parent: RunBudget, request: RunBudget): ChildReservation {
  assertRunBudget(parent, 'parent')
  assertRunBudget(request, 'request')
  if (parent.children < 1) {
    return { reserved: false, denial: { dimension: 'children', requested: 1, available: parent.children } }
  }
  // The requested grandchild concurrency is the child's own to spend and is
  // not taken from the parent's slots; only the one slot this child occupies is.
  const consumable = { ...request, children: 0 }
  const denial = shortfall(parent, consumable)
  if (denial !== undefined) return { reserved: false, denial }
  return {
    reserved: true,
    child: request,
    parent: {
      tokens: parent.tokens - request.tokens,
      wallMs: parent.wallMs - request.wallMs,
      costMicroUsd: parent.costMicroUsd - request.costMicroUsd,
      children: parent.children - 1,
    },
  }
}

/**
 * Return a finished child's unspent allowance to its parent.
 *
 * Only the genuinely unused remainder returns. A child that consumed more than
 * it reserved has already cost the tenant that money, so crediting the
 * difference would invent budget; the overspend is prevented during the run by
 * {@link chargeRun}, not corrected here.
 * @param parent - the parent's remaining allowance, as {@link reserveChild} left it.
 * @param reserved - the allowance that child was started with.
 * @param spent - what the child actually consumed.
 * @returns the parent's allowance with the unused remainder and the child slot restored.
 * @throws RangeError when any argument is not made of non-negative safe integers.
 */
export function settleChild(parent: RunBudget, reserved: RunBudget, spent: RunSpend): RunBudget {
  assertRunBudget(parent, 'parent')
  assertRunBudget(reserved, 'reserved')
  assertRunSpend(spent, 'spent')
  const settled = {
    tokens: parent.tokens + Math.max(0, reserved.tokens - spent.tokens),
    wallMs: parent.wallMs + Math.max(0, reserved.wallMs - spent.wallMs),
    costMicroUsd: parent.costMicroUsd + Math.max(0, reserved.costMicroUsd - spent.costMicroUsd),
    children: parent.children + 1,
  }
  assertRunBudget(settled, 'settled')
  return settled
}

/**
 * Charge one run for what it consumed.
 *
 * A charge that would overdraw any dimension is refused and nothing is
 * deducted, so a caller that stops the run on a denial never leaves a budget
 * partially spent by a charge it rejected.
 * @param budget - the run's remaining allowance.
 * @param spend - what it consumed since the last charge.
 * @returns the remaining allowance, or the dimension it would have overdrawn.
 * @throws RangeError when either argument is not made of non-negative safe integers.
 */
export function chargeRun(budget: RunBudget, spend: RunSpend): RunCharge {
  assertRunBudget(budget, 'budget')
  assertRunSpend(spend, 'spend')
  const denial = shortfall(budget, { ...spend, children: 0 })
  if (denial !== undefined) return { charged: false, denial }
  return {
    charged: true,
    remaining: {
      tokens: budget.tokens - spend.tokens,
      wallMs: budget.wallMs - spend.wallMs,
      costMicroUsd: budget.costMicroUsd - spend.costMicroUsd,
      children: budget.children,
    },
  }
}

/**
 * Whether a budget has anything left to spend in every consumable dimension.
 *
 * A run whose tokens, time, or money reached zero cannot make progress even
 * though it still holds child slots, so `children` is not consulted.
 * @param budget - the allowance to inspect.
 * @returns true while every consumable dimension is above zero.
 * @throws RangeError when the budget is not made of non-negative safe integers.
 */
export function hasRemainingBudget(budget: RunBudget): boolean {
  assertRunBudget(budget)
  return budget.tokens > 0 && budget.wallMs > 0 && budget.costMicroUsd > 0
}
