---
description: "The live record of what each run holds and has spent, so a run that is lost returns its parent's allowance exactly rather than holding it forever."
kind: "package-library"
---

# @deepseek-ai/dsh-run-ledger

English | [中文](README.zh.md)

## Summary

[`dsh-run-budget`](../run-budget/README.md) is the arithmetic: a child's allowance is subtracted from its parent when it starts, and the unspent remainder returns when it settles. It says nothing about who holds a reservation, or what happens when the run holding one never settles — a child that crashes keeps its parent's tokens for as long as the parent lives.

This package is the record that answers both. Spend is what a record stores and what a run may still spend is derived, so a provider's bill is recorded as it arrived rather than refused for not fitting, and a run that is dropped can be settled *exactly*: the ledger already knows what it consumed, and nothing has to be estimated. Each record also carries a lease, so an abandoned hold comes back on a clock rather than when someone notices.

Nothing here persists anything. A `RunRecord` is plain data a caller may store; the state machine and the arithmetic are what this package owns.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Opening a run and charging it as it goes

```ts
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'

declare const run: AdmittedRun
declare const now: number

const ledger = new RunLedger()
const opened = ledger.openRoot(run.claims.runId, run.budget, now + 60_000)

export const charged = opened.ok
  ? ledger.charge(run.claims.runId, { tokens: 1_200, wallMs: 3_400, costMicroUsd: 9_000 })
  : opened
```

A charge is recorded, never refused: a provider bills what it billed, and a spend the ledger declined to record would leave it reporting allowance the run has already used. What a charge answers instead is `exhausted` — the dimensions the run has now used in full, which is empty while it may continue and is the signal to stop it when it is not.

`ledger.remaining(runId)` is what the run may still spend, derived from its allowance, its recorded spend, and every open child's reservation. It never goes negative; a run that overdrew reads as zero, and the overdraw stays visible in its own record's `spent`.

### Delegating, and getting the allowance back

```ts
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import type { RunId } from '@deepseek-ai/dsh-control-plane'

declare const ledger: RunLedger
declare const parent: RunId
declare const child: RunId
declare const now: number

const opened = ledger.openChild(parent, child, {
  tokens: 40_000,
  wallMs: 120_000,
  costMicroUsd: 250_000,
  children: 0,
}, now + 30_000)

export const settled = opened.ok ? ledger.close(child) : opened
```

Closing a run releases its hold, so the parent's derived allowance recovers everything the child did not use, along with every slot it was holding, its own and the ones it could hand down. A run with open children closes them too: a hold left behind a closed run is a hold nothing will ever settle.

### Releasing what a lost run was holding

```ts
import type { RunLedger } from '@deepseek-ai/dsh-run-ledger'

declare const ledger: RunLedger
declare const now: number

export const released = ledger.expire(now)
```

`expire` settles every run whose lease has elapsed, earliest first. A run that is still working pushes its lease out with `renew`, so a lease that stops advancing is exactly a run nothing is driving.

### Settling durably, and coming back from a restart

```ts
import type { RunLedger, RunRecord } from '@deepseek-ai/dsh-run-ledger'

declare const ledger: RunLedger
declare const written: readonly RunRecord[]
declare function writeCharge(runId: string, spent: unknown): Promise<void>

export async function restart(): Promise<void> {
  ledger.restore(written)
  for (const record of ledger.open()) {
    const preview = ledger.settlementOf(record.runId)
    if (preview === undefined) continue
    await writeCharge(preview.runId, preview.spent)
    ledger.close(record.runId)
  }
}
```

`settlementOf` reports what closing a run would charge and which descendants it covers, and changes nothing. A caller that must make the charge durable writes it first and closes second, so a rejected write leaves the run open and nothing lost; closing first would lose the charge the write was carrying.

`restore` installs records this ledger did not open. The checks that created them are deliberately not re-run — a parent that has since spent most of its allowance no longer has room to reserve a child it already funded, so replaying `openChild` would refuse records that are correct. It refuses a record whose id is already open, or one naming a parent no record supplies, because a hold against a parent that does not exist is one nothing can settle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `RunLedger`, `RunRecord`, `RunChargeResult`, `RunSettlementPreview`, `RunSettlement`, and the ledger rejections |
| — | No runtime invariant companion is published; this module owns no event stream, and the one relation worth checking — that a tree never returns more than it reserved — is arithmetic its unit tests pin directly. |

### Why an expired run settles exactly

A lease expiry elsewhere has to guess: the holder is gone and nobody knows what it consumed, so a system either credits the whole reservation back (inventing budget the run already spent) or credits nothing (leaking the allowance until the parent ends). Neither is necessary here, because charges and holds live in the same record. What the parent absorbs is what the run consumed, capped at what it was allowed.

The one inexactness is bounded and named: a run whose final charge never reached the ledger is credited that much too generously, at most one charge interval's worth.

### Why a spend is recorded rather than refused

Charging happens after a provider has already billed. A ledger that refused a spend for not fitting would keep reporting an allowance the run had spent, and the next invocation would be sized against that phantom — which is the opposite of a cap. The refusal was standing in for a decision the caller has to make anyway, so the charge reports `exhausted` and the caller stops the run.

An overspend is therefore recorded in full, while the parent absorbs only what it authorized. A child that outspent its reservation cost the tenant that money, but its parent granted the reservation and no more; charging the excess to the parent would take it from that child's siblings.

### Why closing a run closes its descendants

A child's reservation is a subtraction from its parent's record. If the parent closes while a child is still open, that subtraction has no run left to justify it and no settlement will ever reverse it — the allowance is stranded until the whole tree ends. Closing the subtree keeps the invariant the budget arithmetic exists for: every reservation is eventually returned to the run that made it.

### Why the preview and the settlement cannot disagree

One recursion computes a subtree's charge, and `settle` calls it and then deletes what it named. The preview is not a second implementation of the same arithmetic, so a caller that writes the previewed figure down and then closes writes exactly what the close applies. Two implementations would be free to drift, and the drift would show up as a tenant charged for something other than what its run consumed.

### Why one ledger holds one tree

A reservation is a subtraction from the parent's record, so a parent and its children must share an instance. Two ledgers would each believe they held the whole allowance, and the delegation cap would hold in neither.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-run-budget`](../run-budget/README.md) — the reservation, settlement, and charge arithmetic this package records against.
- [`dsh-run-admission`](../run-admission/README.md) — where a run's opening allowance comes from.
- [`dsh-control-plane`](../control-plane/README.md) — the `RunId` and `RunLineage` a record is keyed by.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan; this package is R3's run record.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Nothing persists a ledger** — the records live in memory for the life of the instance. `settlementOf` and `restore` are what a caller needs to keep them elsewhere, and [`dsh-run-scheduler`](../run-scheduler/README.md) does; no store, format, or recovery order is offered here.
- **`restore` trusts what it is given** — the records are installed as they arrive, and a forest that is complete but wrong (a reservation larger than its parent ever held) is accepted. Re-deriving the checks is the wrong question, since the state that passed them is gone.
- **Nothing drives the clock** — `expire` is a call, not a timer. A deployment that never calls it never releases an abandoned hold, and choosing that cadence is the scheduler's.
- **A lease is not told to the run** — it bounds how long a lost run can hold its parent's tokens, and nothing cancels the run itself when it elapses. Cancelling the work belongs with whoever started it.
- **One tree, not a tenant** — a ledger holds the runs beneath one root. A tenant-wide view across concurrent unrelated trees is a different accounting seam and is not this one.
- **No Cordis service** — nothing here registers on a `Context`; it is constructed directly.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
