---
description: "Admission, funding and placement performed once in the documented order, so a failed placement does not leave a parent short of an allowance nothing is spending."
kind: "package-library"
---

# @deepseek-ai/dsh-run-start

English | [中文](README.zh.md)

## Summary

The [control-plane group](../README.md) composes in exactly one order, and [the subsystem page](../../../docs/subsystems/candy-control-plane.md) states what that order is and why each step sits where it does. Until this package, nothing performed it: every caller wrote the sequence itself, and none of them undid what it held when a later step refused.

`startRun` performs Admit, Open and Place, and owns the rollback between them. That rollback is the reason it exists rather than being left as three calls in a row.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Starting one run

```ts
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import { startRun } from '@deepseek-ai/dsh-run-start'
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'

declare const policy: RunAdmissionPolicy
declare const ledger: RunLedger
declare const token: string

const outcome = await startRun({ token }, policy, {
  ledger,
  share: run => run.budget,
  leaseExpiresAt: Date.now() + 60_000,
}, Date.now())

export const started = outcome.started ? outcome.value.run.poolRoot : outcome.rejection.stage
```

`share` chooses what the run is opened with once its identity is known. A root run is normally opened with what admission answered for it; a child is opened with the share its parent delegates, which the ledger refuses when it exceeds what that parent holds.

What comes back is not yet running. Binding a provider, streaming it, charging what it spent, and closing the run stay with the caller — the ledger record is open until `close`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `startRun`, its options, and the outcome and rejection types |
| — | No runtime invariant companion is published; this module owns no event stream, and the one relation it holds is checked by unit tests. |

### Why the rollback is the point

`RunLedger.openChild` subtracts a child's allowance from its parent the moment the child opens. Creating a pool directory can refuse — a base the deployment never provisioned, a link planted where the root goes. A sequence that opens the record and stops there leaves the parent short of an allowance no run is spending, until the lease expires.

The record is closed on the way out, so the hold comes back at once. The failure keeps travelling: it is a deployment error, not a denied run.

### Why binding is not here

Binding a provider allocates nothing, so it needs no rollback, and it is provider-specific where every step here is not. Keeping it out leaves this package one composition for every provider rather than one per provider.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Candy control plane](../../../docs/subsystems/candy-control-plane.md) — the order this package performs, and what each step decides.
- [`dsh-run-admission`](../run-admission/README.md) — the admission step and the three ports a deployment supplies.
- [`dsh-run-ledger`](../run-ledger/README.md) — the record this package opens and closes.
- [`dsh-runtime-pool`](../runtime-pool/README.md) — the placement step.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **It starts a run, and does not run it** — binding a provider, streaming it, charging what it spent and closing the record stay with the caller. This package holds no process and no stream.
- **No scheduling decision** — which run starts, in what order, and whether a tenant may start another at all belong to a scheduler this release has not built. This is the sequence one run goes through once that decision is made.
- **The ledger is in memory** — a restart loses every open run, as [`dsh-run-ledger`](../run-ledger/README.md) records. Rollback returns a hold within one process; it cannot recover one a crash stranded.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
