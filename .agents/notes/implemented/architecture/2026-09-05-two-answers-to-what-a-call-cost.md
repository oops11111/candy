# Agent Note: Two answers to what a call cost

Status: implemented

English | [中文](2026-09-05-two-answers-to-what-a-call-cost.zh.md)

## Problem

`dsh-run-metering` charged a run `totalTokens ?? inputTokens + outputTokens`. `inputTokens` is uncached input only — `TokenUsage` says so, and says billed input is the sum of it with `cacheReadTokens` and `cacheWriteTokens` — so an adapter that reported cache counts and no total would have had its call charged at a fraction of what it cost. Anthropic-style prompts are mostly cache hits, which is exactly where the fraction is smallest.

Every shipped adapter does report `totalTokens`, so nothing was being undercharged today. What was wrong was the fallback, and that the repository had three answers to the same question: this one, the four-way sum hand-written in `dsh-claude-cli-binding`'s accounting test, and `dsh-token-meter`'s own `usageTokens`.

## Decision

`billedTokens` lives in `dsh-llm`, beside the type it reads.

It prefers the provider's exact `totalTokens` and, without one, adds all four disjoint counters. `dsh-token-meter`'s turn normalizer already requires `totalTokens` to be at least their sum and to equal it when both cache counters are present, so preferring it can only be more complete, never double-counted. `reasoningTokens` is not added: it is already inside `outputTokens`.

`dsh-token-meter`'s `usageTokens` stays as it is and is not folded in. It sums the disjoint counters alone on purpose: it is a conservative baseline for how full a context window is, and a smaller figure is the safe one for that question where a larger one is correct for what a call cost. The two look like duplicates and are not, so the new function's contract says which is which.

## Consequences

`dsh-run-metering` and `dsh-claude-cli-binding`'s accounting test both call it, and the third copy is gone. A provider that reports cache counts without a total is now charged for its whole prompt.

## Alternatives considered

**Sum the counters and ignore `totalTokens`.** It matches `dsh-token-meter` and undercharges any provider whose total covers prompt tokens the disjoint counters do not name — the case `turn-usage`'s normalizer explicitly admits.

**Fold `dsh-token-meter`'s helper into the shared one.** It would make the two agree and make the context-pressure baseline less conservative, which is a change to a measurement nothing asked for.
