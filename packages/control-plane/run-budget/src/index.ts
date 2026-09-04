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
 * run that delegated it had left. A child's allowance is taken out of its
 * parent's at reservation, so the parent cannot hand out more than it holds.
 * Holding those reservations and returning an unspent remainder needs records
 * of live runs, which is `dsh-run-ledger`'s and not this module's.
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
 * however many children it starts. The held slots come back when the child
 * settles.
 *
 * A child costs its parent one slot for itself plus every slot it may hand
 * down, so `children` counts the runs that may be live anywhere in a subtree
 * rather than only its top level. Charging one slot per child would leave the
 * dimension unbounded across a tree: a run granted four slots could seed four
 * children each granted four of their own, and nothing at any level would have
 * paid for the ones below. That contradicts the parent-subset rule
 * ([Candy Runtime Boundaries](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/candy-runtime-boundaries.md)),
 * under which a child may use only the concurrency authority its parent
 * already had.
 *
 * A request is refused, not clamped. Silently shrinking it would start a child
 * under a budget its caller never chose, and a subagent that stops mid-task
 * because it was quietly given a tenth of what it asked for is harder to
 * diagnose than one that was refused.
 * @param parent - the delegating run's remaining allowance.
 * @param request - the allowance asked for the child; its `children` is the
 *   concurrency the child may itself delegate, and the parent pays for it.
 * @returns the child's allowance and the parent's reduced remainder, or the
 *   one dimension that was insufficient.
 * @throws RangeError when either argument is not made of non-negative safe integers.
 */
export function reserveChild(parent: RunBudget, request: RunBudget): ChildReservation {
  assertRunBudget(parent, 'parent')
  assertRunBudget(request, 'request')
  const consumable = { ...request, children: request.children + 1 }
  const denial = shortfall(parent, consumable)
  if (denial !== undefined) return { reserved: false, denial }
  return {
    reserved: true,
    child: request,
    parent: {
      tokens: parent.tokens - request.tokens,
      wallMs: parent.wallMs - request.wallMs,
      costMicroUsd: parent.costMicroUsd - request.costMicroUsd,
      children: parent.children - consumable.children,
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
