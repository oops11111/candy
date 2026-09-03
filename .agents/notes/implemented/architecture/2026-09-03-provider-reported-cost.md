# Agent Note: The bill the provider already sent

Status: implemented

English | [中文](2026-09-03-provider-reported-cost.zh.md)

## Problem

`RunBudget` bounds a run in tokens, wall time, money, and concurrency. Three of those can be measured from what the harness already has. Money could not: `TokenUsage` had no cost field, nothing in `packages/` priced a token, and the package README recorded that as a limitation a caller would have to answer by pricing tokens itself.

That framing was wrong, and the evidence was in a fixture recorded for this repository. The Claude CLI's terminal frame carries `total_cost_usd`, and `ClaudeCliFrameTranslator` read the frame, used its token counts, and dropped the cost beside them. The number a tenant is actually billed was arriving on every run and being discarded one line away from where it was needed.

## Decision

`TokenUsage` gains an optional `costMicroUsd`, and the Claude CLI translator fills it from `total_cost_usd`.

### Reported, never derived

The field carries a figure the provider stated and nothing else. An adapter does not compute one from a price list, because a computed number would be indistinguishable from a reported one while being wrong wherever a deployment's contract is not list price — and wrong in the direction that costs money.

That makes absence meaningful: it is "not reported", not zero. A failed run in the recorded fixture reports `total_cost_usd: 0`, and that zero is a real fact — the CLI billed nothing for a run whose every request was refused. A consumer that reads an absent field as zero undercounts every provider that stays silent, so a test pins the two apart.

### Integer micro-USD, converted once

The CLI reports dollars as a float; `RunBudget` counts integer micro-USD because a limit compared or decremented in floating point drifts. The rounding therefore happens once, in `mapUsage`, where the float arrives. A cost that is not a finite non-negative number, or that would round past safe integer range, is omitted rather than clamped: a repaired figure would be charged to a tenant as though the CLI had reported it.

### The whole invocation, not the counts beside it

`total_cost_usd` covers every model the CLI ran, including the auxiliary calls it makes for itself — a recorded two-token request also billed a `claude-haiku-4-5` call, and the frame's per-model totals sum to exactly the reported figure. That is what the tenant pays, so it is the right number for a budget, and the field's documentation says it is the provider's total for the call rather than the price of the counts in the same object.

## Consequences

`RunBudget.costMicroUsd` is enforceable on the one route that reports a cost. That is a smaller claim than "cost accounting works", and the READMEs make it: an HTTP route reports nothing, so a caller charging against one still prices tokens itself.

The cost reaches the session log without any new event. It rides `TokenUsage`, which `assistant/chunk` and `assistant/message` already carry, so a run's billed total is durable and replayable for free. Nothing folds it into a running total yet — `dsh-token-meter`'s `tokenUsage` projection sums token buckets and would need its state version bumped and its client view widened to add money, which is a separate decision with a client surface attached.

Cost arrives only at the end. Only the terminal frame reports one, so a run killed mid-stream reports no cost however much it spent. `maxBudgetUsd` still caps such a run, because the ceiling is enforced by the CLI rather than by what it reports.

## Alternatives considered

**Leaving cost out of `dsh-llm` and exposing it from the CLI packages.** It would keep money out of a seam most adapters cannot fill. Rejected because a side channel out of one adapter is exactly what the seam exists to prevent: no generic consumer — a budget, a meter, a usage view — could read it without knowing which provider it was talking to.

**Carrying the provider's float and converting at each consumer.** Simpler at the adapter and wrong everywhere else: every consumer would repeat the rounding, and two consumers rounding differently produce two answers to what one run cost.

**Deriving a cost for providers that report none, from a price table.** This would make the field always present and uniformly useless: the derived figures would be indistinguishable from reported ones, so no consumer could tell which numbers were the provider's. A price table is a deployment fact that belongs wherever prices are configured, not inside an adapter.
