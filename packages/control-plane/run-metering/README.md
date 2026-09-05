---
description: "Meters one provider stream against an open run's allowance, so a budget stops work instead of only recording it."
kind: "package-library"
---

# @deepseek-ai/dsh-run-metering

English | [中文](README.zh.md)

## Summary

[`dsh-run-admission`](../run-admission/README.md) refuses a run whose allowance is already gone, and [`dsh-run-ledger`](../run-ledger/README.md) records what each run has spent. Between those two moments nothing was watching. A run admitted with a thousand tokens could stream a million: `charge` reports the dimensions a run has used up, and no caller was reading the report.

This package is the enforcement in between. It wraps one provider stream for one open run — refusing the call before the provider is reached when the run has nothing left, cutting the stream when the call outruns the wall time the run still had, and charging what the call consumed before its terminal chunk is passed on.

It holds no ledger and decides no allowance. Both are passed in, because a ledger belongs to a runtime and this belongs to a call.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Metering one call

```ts
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RunId } from '@deepseek-ai/dsh-control-plane'
import type { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import { meterRun } from '@deepseek-ai/dsh-run-metering'

declare const ledger: RunLedger
declare const runId: RunId
declare const provider: AsyncIterable<StreamChunk>

export const metered = meterRun(provider, runId, {
  remaining: id => ledger.remaining(id),
  charge: (id, spend) => Promise.resolve(ledger.charge(id, spend)),
})
```

The result is the same stream while the run can afford it. A deployment that already has a scheduler does not call this directly — [`dsh-run-scheduler`](../run-scheduler/README.md)'s `meter` binds it to that runtime's ledger and its durable charge.

### Reading what ended a call early

```ts
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { RUN_BUDGET_EXHAUSTED, RUN_NOT_OPEN } from '@deepseek-ai/dsh-run-metering'

export function endedByBudget(chunk: StreamChunk): boolean {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return false
  return chunk.reason.failure.code === RUN_BUDGET_EXHAUSTED || chunk.reason.failure.code === RUN_NOT_OPEN
}
```

Both endings are a terminal `error` finish rather than a thrown exception, because a consumer of the [`dsh-llm`](../../llm/llm/README.md) seam is promised exactly one terminal chunk and an exception is not one.

`refusedCall` builds the same ending for a caller that decides a call cannot be metered before `meterRun` could — because it cannot tell which run to charge. [`dsh-run-scheduler`](../run-scheduler/README.md) uses it for a session two open runs both claim.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `meterRun`, its ports, and the two failure codes |
| — | No runtime invariant companion is published; the stream grammar this produces is already enforced by [`dsh-llm`](../../llm/llm/README.md)'s own invariant. |

### Why the refusal comes before the provider is called

A stream carries usage at most once, usually near its end, so a run that is already spent would otherwise make the whole call and learn it could not afford it from the very chunk that spent the money. Reading the remainder first is what makes an exhausted run stop making calls rather than stop being surprised by them.

That check is also why the charge lands before the terminal chunk reaches the consumer: an agent loop asks for the next call the moment it sees a finish, and a charge applied after would let it make one call too many.

### Why a cut is one call, not the run

The stream ends; the run stays open with what the call consumed on its record. Ending the run here would take a decision that belongs to whoever started it — a caller may report the exhaustion, ask for more allowance, or settle. What this guarantees is that the work stops.

### Why the token count comes from `dsh-llm`

`billedTokens` is that package's own derivation and the one place it lives. It prefers the provider's exact `totalTokens` and, without one, adds all four disjoint counters — `inputTokens` is uncached input only, so a call whose prompt was mostly a cache hit would otherwise be charged at a fraction of what it cost. `reasoningTokens` is already inside `outputTokens` and is not added again.

It is deliberately not `dsh-token-meter`'s context-pressure baseline, which sums the disjoint counters alone: a smaller figure is the conservative one when the question is how full a context window is, and the larger one is correct when the question is what a call cost.

### Why an unreported cost is not zero spend

`TokenUsage.costMicroUsd` is present only when the provider reported a billed figure. Absent means "not reported", so a run on a silent provider is metered on tokens and time and its money dimension never moves. Deriving a figure from a price list here would be indistinguishable from a reported one and wrong wherever the deployment's contract is not list price.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-run-ledger`](../run-ledger/README.md) — where the remainder read here is derived and the charge is recorded.
- [`dsh-run-scheduler`](../run-scheduler/README.md) — the runtime that binds this to a durable charge.
- [`dsh-llm`](../../llm/llm/README.md) — the stream vocabulary and the grammar every metered stream still satisfies.
- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — the rule that a child may not exceed its parent's token, time, or cost grants.

-----

<a id="model-experience"></a>
## Model Experience

### A call the run could not afford

#### What the model sees

Nothing of the metering itself. The refusal and the cut are terminal `error` finish chunks on the provider stream, in the same vocabulary a provider failure uses, so a consumer handles them where it already handles a failed call. A cut leaves whatever the provider had already streamed; the partial content is the consumer's to keep or discard, and this package writes none of its own.

#### Token effect

None added. Every token counted here was billed by the provider for a call the consumer asked for. What changes is which calls happen: an exhausted run makes no further request at all, so the tokens a refused call would have spent are never spent.

#### KV Cache effect

None. The request is untouched, so a metered call has exactly the prefix and cache identity it would have had unmetered. A refused call makes no request, so it neither reads nor writes a provider cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **A silent stream is not cut** — wall time is checked as chunks arrive, so a provider that stalls without emitting anything runs past its deadline unnoticed. `dsh-run-ledger`'s lease is what bounds an abandoned run; this bounds a talkative one.
- **Tokens are charged once per call** — a stream reports usage at most once, so an over-long single response is measured only when it ends. The wall-time cut is what bounds one call; the token cut bounds the next.
- **Concurrent calls each read the same remainder** — two streams metered against one run both start against the allowance neither has charged yet. A run whose calls overlap can overshoot by one call's worth per stream.
- **A charge that cannot be written is thrown, not finished** — the two budget endings are terminal chunks, but a rejected charge leaves the stream by throwing. That is what the [`dsh-llm`](../../llm/llm/README.md) seam says of middleware failures, and it means a consumer that only handles a failed call also needs to handle a failed medium.
- **No cancellation is propagated** — a cut stops reading the source and lets the generator close it. A provider that ignores that keeps running until whoever launched it reaps it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
