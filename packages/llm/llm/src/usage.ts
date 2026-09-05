/**
 * How many tokens one model call consumed, derived once for every consumer
 * that bills, caps, or reports against a provider's own counts.
 * @module @deepseek-ai/dsh-llm/src/usage
 */

import type { TokenUsage } from './types.ts'

/**
 * The tokens one call is billed for.
 *
 * `totalTokens` is the provider's exact full-call figure and is preferred
 * whenever an adapter reported one: it covers prompt tokens the disjoint
 * counters do not always name, and `dsh-token-meter`'s turn normalizer already
 * requires it to be at least their sum. Without it the counts are added — and
 * all four are added, because `inputTokens` is uncached input only and a call
 * whose prompt was mostly a cache hit would otherwise be counted at a fraction
 * of what it cost. `reasoningTokens` is not added: it is already inside
 * `outputTokens`.
 *
 * This is not `dsh-token-meter`'s context-pressure baseline, which sums the
 * disjoint counters alone on purpose — a smaller figure is the conservative
 * one when the question is how full a context window is, and the larger one is
 * correct when the question is what a call cost.
 * @param usage - what the provider reported for one call.
 * @returns the billed token count; zero-safe for a usage with no cache fields.
 */
export function billedTokens(usage: TokenUsage): number {
  return usage.totalTokens
    ?? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
}
