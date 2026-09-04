---
description: "The token, time, money, and concurrency allowance a child run draws out of its parent's, so a delegation tree cannot outspend the run that started it."
kind: "package-library"
---

# @deepseek-ai/dsh-run-budget

English | [中文](README.zh.md)

## Summary

`dsh-run-budget` bounds what a tree of runs may consume. The harness already caps delegation *depth* — `dsh-subagent` raises `SubagentDepthError` past a `maxDepth` — and pins a delegated child's sandbox mode and approval policy to its parent's. None of that bounds spend: depth 3 with ten children at each level is a thousand runs, every one free to consume a tenant's tokens, time, and money. This module is the arithmetic that bounds it: a child's allowance is taken out of its parent's when the child starts, so a parent cannot promise the same tokens twice however many children it delegates.

Holding those reservations, recording what a run spends, and returning an unspent remainder all need records of live runs, which is [`dsh-run-ledger`](../run-ledger/README.md)'s. This package is the values and the two decisions that need no record: whether a request fits, and whether an allowance has anything left.

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
import { reserveChild } from '@deepseek-ai/dsh-run-budget'
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

`reservation.parent` is the parent's allowance *after* the delegation. Using it is the enforcement: a parent that keeps spending its pre-reservation budget can hand the same tokens to every child it starts. A caller holding a [`dsh-run-ledger`](../run-ledger/README.md) never does this arithmetic itself — the ledger holds the reservation and derives what the parent has left.

### Asking whether an allowance is spent

```ts
import { hasRemainingBudget } from '@deepseek-ai/dsh-run-budget'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'

declare const budget: RunBudget

export const mayStart = hasRemainingBudget(budget)
```

`children` is not consulted. A run with no delegation slots left can still do its own work; it simply cannot start a child, and refusing it would confuse "cannot delegate" with "cannot proceed".

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
| [`src/index.ts`](src/index.ts) | `RunBudget`, `RunSpend`, `reserveChild`, `hasRemainingBudget`, and the budget assertions |
| — | No runtime invariant companion is published; this pure module owns no event stream or mutable runtime data, and its arithmetic is enforced by unit tests. |

### Why a child slot is held rather than spent

`children` is the count of runs that may be live at once, so it behaves unlike the other three dimensions: reserving a child takes slots, and they come back when that child ends. Tokens, milliseconds and money are consumed for good. That is why `RunSpend` has no `children` field at all — a caller that could "spend" concurrency would destroy the very capacity it is supposed to release.

### Why a child pays for the slots it hands down

A child costs its parent one slot for itself plus every slot it may delegate, so the count bounds a whole subtree rather than only its top level. A run granted four slots can start four childless children, or one child that may run three of its own, and no arrangement in between puts more than four runs live beneath it.

Charging one slot per child instead would leave the dimension unbounded across a tree: four children each granted four of their own, and their children again, reaches over thirteen hundred live runs at depth five from a grant that reads as four. Nothing at any level would have paid for the ones below, which contradicts the parent-subset rule in [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — a child may use only the concurrency authority its parent already had. Spend is conserved either way; concurrency was not.

The cost is that a grant now reads as a subtree size. Expressing "four children that may each delegate two" asks for twelve, not four.

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

- **Nothing here stores a budget** — this is arithmetic over values a caller holds. [`dsh-run-admission`](../run-admission/README.md) refuses to start a run whose budget is exhausted and [`dsh-run-ledger`](../run-ledger/README.md) holds the live records, but persisting those records belongs to the run store R3 has not built.
- **No wall-clock source** — `wallMs` is a number the caller measures and charges. Nothing here reads a clock, so a run that never charges its elapsed time is never stopped for exceeding it.
- **Only one route reports cost** — `TokenUsage.costMicroUsd` carries a provider-reported figure, and [`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.md) is the one route that supplies it. A caller charging `costMicroUsd` against an HTTP route still prices tokens itself, and nothing folds the reported figure into a durable total.
- **One tree, not a tenant** — these operations bound a delegation tree beneath one run. A tenant-wide cap across concurrent unrelated runs is a different accounting seam and is not this one.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly, like `dsh-brand`.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
