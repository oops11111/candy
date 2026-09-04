---
description: "A tenant's standing grant and what its settled runs consumed of it, so one grant funds one tenant rather than every run it starts."
kind: "package-library"
---

# @deepseek-ai/dsh-tenant-allowance

English | [中文](README.zh.md)

## Summary

[`dsh-run-budget`](../run-budget/README.md) bounds one delegation tree and [`dsh-run-ledger`](../run-ledger/README.md) holds that tree's live records. Neither says anything about the tenant above them, and until this package nothing did: `dsh-run-admission`'s `findBudget` port was answered with a grant read straight out of a store, so a tenant granted a million tokens could start a run, spend the million, close it, and start another against the same million. The grant bounded one run, not a tenant.

This package is the missing quantity. A tenant is the root every delegation tree hangs from, so it is accounted exactly as a parent run is: an open run's reservation is held out of what remains while it runs, and what it actually spent is added to the tenant's consumption when it settles.

Nothing here persists anything and nothing here holds a clock. A `TenantAllowance` is plain data a caller stores, and which runs are open is the caller's to know.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Answering what a tenant may start a run against

```ts
import { remainingAllowance, type TenantAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'

declare const allowance: TenantAllowance
declare const openRuns: readonly RunBudget[]

export const available: RunBudget = remainingAllowance(allowance, openRuns)
```

`held` is the reservation of every run of that tenant still open. Passing `[]` answers what the tenant has left *ignoring* what is running, which is the reading that lets two live trees each hold the whole allowance; a caller with a ledger passes what that ledger holds.

### Charging a settled tree

```ts
import { consumeAllowance, openAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import type { RunSpend } from '@deepseek-ai/dsh-run-budget'

declare const settled: RunSpend

const opened = openAllowance({ tokens: 1_000_000, wallMs: 3_600_000, costMicroUsd: 5_000_000, children: 8 })

export const charged = consumeAllowance(opened, settled)
```

The settlement `RunLedger` reports for a root run already covers its whole subtree, so a tree is charged once — when its root closes — rather than once per run in it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `TenantAllowance`, and the four functions over it |
| — | No runtime invariant companion is published; this module owns no event stream and holds no state, so its arithmetic is checked by unit tests. |

### Why the grant is kept beside the consumption

A single remaining figure decremented in place would answer the admission question just as well and lose everything else: what an operator granted, how much of it the tenant has used, and therefore whether a quota report can be produced at all. Keeping both also makes changing a grant well-defined — an operator who doubles a quota mid-period means the tenant may now spend twice as much in total, not that its history was erased.

### Why consumption is recorded rather than capped

A provider bills what it billed. A settlement the tenant record declined to absorb would leave the tenant reporting an allowance it has already spent, and a subtraction clamped at zero would erase how far past its grant a run went. What is clamped is only the answer to "what may start now", which cannot be negative.

### Why a held run costs the slots it may hand down

`remainingAllowance` charges a held run one concurrency slot for itself plus every slot it may itself delegate, which is the arithmetic `reserveChild` performs one level lower. Charging one slot per open run would leave `children` unbounded across a tenant's forest for the same reason it did across one tree: a tenant granted four concurrent runs could open four that each delegate four, and nothing at any level would have paid for the ones below.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-run-budget`](../run-budget/README.md) — the four dimensions, and the child reservation this module mirrors one level higher.
- [`dsh-run-ledger`](../run-ledger/README.md) — where the open reservations `held` names come from, and where a settlement is produced.
- [`dsh-control-plane-store`](../control-plane-store/README.md) — the durable home of a tenant's allowance.
- [`dsh-run-scheduler`](../run-scheduler/README.md) — where the store and the ledger meet, which is the only place the composition is complete.
- [Candy control plane](../../../docs/subsystems/candy-control-plane.md) — the composition order these packages sit in.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No period** — an allowance runs from its grant until an operator changes it. There is no month, no reset, and no rollover, because nothing in the repository yet decides when a billing period begins; a deployment that wants one resets consumption by writing a fresh allowance.
- **`held` is the caller's to be right about** — a caller that forgets an open run admits a second one against allowance the first is holding. This module cannot check the claim, because it holds no records; `dsh-run-scheduler` is where the two halves are composed exactly once.
- **One grant, not a rate** — the dimensions are totals. A tenant limited to a number of tokens per minute rather than per grant needs a different record, which no consumer has asked for.
- **No Cordis service** — nothing here registers on a `Context`; the functions are called directly.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
