---
description: "The token, time, money, and concurrency allowance a child run draws out of its parent's, so a delegation tree cannot outspend the run that started it."
kind: "package-library"
---

# @deepseek-ai/dsh-run-budget

English | [中文](README.zh.md)

## Summary

`dsh-run-budget` bounds what a tree of runs may consume. The harness already caps delegation *depth* — `dsh-subagent` raises `SubagentDepthError` past a `maxDepth` — and pins a delegated child's sandbox mode and approval policy to its parent's. None of that bounds spend: depth 3 with ten children at each level is a thousand runs, every one free to consume a tenant's tokens, time, and money. This module is the missing half. A child's allowance is subtracted from its parent when the child starts, so a parent cannot promise the same tokens twice however many children it delegates, and the unspent remainder returns only when the child settles.

Money is integer micro-USD throughout. A limit compared or decremented in floating point drifts, and a spend limit that drifts is not a limit.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Delegating part of a run's allowance

```ts
import { reserveChild, settleChild } from '@deepseek-ai/dsh-run-budget'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'

declare const parent: RunBudget

const reservation = reserveChild(parent, {
  tokens: 40_000,
  wallMs: 120_000,
  costMicroUsd: 250_000,
  children: 2,
})

export const outcome = reservation.reserved
  ? { child: reservation.child, parentNow: reservation.parent }
  : { refused: reservation.denial.dimension }
```

`reservation.parent` is the parent's allowance *after* the delegation. Using it is the enforcement: a parent that keeps spending its pre-reservation budget can hand the same tokens to every child it starts.

When the child ends, return what it did not use:

```ts
import { settleChild } from '@deepseek-ai/dsh-run-budget'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'

declare const parentNow: RunBudget
declare const childBudget: RunBudget
declare const childSpent: RunSpend

export const parentAfter = settleChild(parentNow, childBudget, childSpent)
```

### Charging a run as it consumes

```ts
import { chargeRun, hasRemainingBudget } from '@deepseek-ai/dsh-run-budget'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'

declare const budget: RunBudget

const charge = chargeRun(budget, { tokens: 1_200, wallMs: 3_400, costMicroUsd: 9_000 })

export const next = charge.charged
  ? { budget: charge.remaining, keepGoing: hasRemainingBudget(charge.remaining) }
  : { stop: charge.denial }
```

A refused charge deducts nothing, so a caller that stops the run on a denial never leaves the budget partly spent by the charge it rejected.

### Requests are refused, never shrunk

Every operation returns a denial naming the one dimension that was insufficient, and changes nothing. Quietly clamping a request to what remains would start a child under a budget its caller never chose, and a subagent that stops mid-task because it was silently given a fifth of what it asked for is harder to diagnose than one that was refused outright.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `RunBudget`, `RunSpend`, `reserveChild`, `settleChild`, `chargeRun`, `hasRemainingBudget`, and the budget assertions |
| — | No runtime invariant companion is published; this pure module owns no event stream or mutable runtime data, and its arithmetic is enforced by unit tests. |

### Why a child slot is held rather than spent

`children` is the count of child runs that may be live at once, so it behaves unlike the other three dimensions: reserving a child takes one slot, and settling returns it. Tokens, milliseconds and money are consumed for good. That is why `RunSpend` has no `children` field at all — a caller that could "spend" concurrency would destroy the very capacity it is supposed to release.

The concurrency a child may itself delegate is its own to hold and is not taken from the parent's slots; only the one slot the child occupies is. A parent with one slot left can therefore start a child permitted five grandchildren.

### Why an overspend is not credited back

`settleChild` returns `max(0, reserved - spent)`. A child that consumed more than it reserved has already cost the tenant that money; crediting the difference would invent budget and let the parent spend it a second time. The overspend is prevented during the run by `chargeRun`, not corrected at settlement — which is the reason a run is charged as it goes rather than reconciled at the end.

### Why the assertions throw instead of denying

A negative, fractional, or unsafe-integer budget is a storage or arithmetic defect, not an exhausted run, and the two must not arrive at a caller through the same channel. Exhaustion is a value the caller routes on; a malformed budget is a `RangeError` naming the argument and field, because continuing with it would produce limits that do not hold.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan; this package is the budget half of R3's parent-child run records.
- [Run budgets across a delegation tree](../../../.agents/notes/implemented/architecture/2026-09-03-run-budget-delegation.md) — what the harness already caps, and why the reservation is subtracted rather than checked.
- [`dsh-control-plane`](../control-plane/README.md) — the `RunId` and `RunLineage` a budget is recorded against.
- [`dsh-subagent`](../../subagent/subagent/README.md) — the inherited delegation depth cap and the policy a child inherits from its parent.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Nothing stores or enforces a budget** — this is arithmetic over values a caller holds. Persisting a run's remaining allowance, reloading it, and refusing to schedule an exhausted run belong to the scheduler and run store that R3 has not built.
- **No wall-clock source** — `wallMs` is a number the caller measures and charges. Nothing here reads a clock, so a run that never charges its elapsed time is never stopped for exceeding it.
- **Cost must be supplied, and the adapters cannot supply it** — `costMicroUsd` is enforceable only if something computes it. `TokenUsage` carries no cost, and [`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.md) drops the CLI's own `total_cost_usd`, so today a caller must price tokens itself.
- **A reservation is not a lease** — nothing expires an unsettled reservation, so a child that is lost without settling holds its parent's allowance until the caller reconciles it. A crash-safe hold needs the durable run records R3 owns.
- **One tree, not a tenant** — these operations bound a delegation tree beneath one run. A tenant-wide cap across concurrent unrelated runs is a different accounting seam and is not this one.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly, like `dsh-brand`.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
