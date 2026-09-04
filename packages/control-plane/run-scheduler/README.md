---
description: "One Candy runtime's live run state: the ledger and replay store a run is admitted against, and the clock that releases a hold no settlement claimed."
kind: "package-reference"
---

# @deepseek-ai/dsh-run-scheduler

English | [中文](README.zh.md)

## Summary

Everything this service composes already existed as a library. What did not exist was an owner. The ledger and the replay store are per-runtime objects nothing held; admission's policy had to be assembled by hand at every call site; and `RunLedger.expire` was a call no clock made, so a run abandoned without settling held its parent's allowance until someone thought to reclaim it.

`ctx.runScheduler` holds that state, starts a run from an execution assertion, drives the clock, and charges a settled tree to its tenant. It is where a tenant's durable allowance and its live runs meet, and that meeting is the whole of Candy's tenant-level bound: read on its own, either half admits a run it should refuse. The order queued requests run in is still a decision nothing here makes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Composing it

```yaml
- id: run-scheduler
  name: '@deepseek-ai/dsh-run-scheduler'
  config:
    issuer: candy-control-plane
    audience: candy-runtime-debian-1
    credentialKeyVersion: 2026-09-a
    poolBase: /srv/candy/pools
```

It requires [`dsh-control-plane-store`](../control-plane-store/README.md) for the accounts and allowances it reads, and the `timer` service for its clock. Both secrets are named as environment variables rather than written into the composition: `assertionSecretEnv` (default `CANDY_ASSERTION_SECRET`) and `credentialKeyEnv` (default `CANDY_CREDENTIAL_KEY`). An unset one fails the boot, and a credential key that is not 32 bytes fails it too — the vault seals with exactly that.

### Starting a run

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const token: string

const outcome = await ctx.runScheduler.start(token)

export const started = outcome.started ? outcome.value.run.poolRoot : outcome.rejection.stage
```

`start` takes the assertion and, optionally, the allowance to open the run with. A root run defaults to what admission answered for it; a child is opened with the share its parent delegates, and the ledger refuses a share exceeding what that parent holds.

What comes back is not running. Binding a provider to it, streaming that provider, and charging what it spent stay with the caller — `charge` and `close` are on this service, and the run's record is open until `close`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`, the `RunScheduler` service, its admission policy, and the sweep |
| — | No runtime invariant companion is published; the relations here belong to the ledger and the store, and the composition test checks them end to end. |

### Why one instance owns one ledger

Every run this runtime admits is accounted against the same delegation trees and the same spent nonces. Two instances would each believe they held the whole allowance, and the delegation cap would hold in neither — the same reason `dsh-run-ledger` requires a parent and its children to share an instance.

### Why the budget lookup is composed rather than delegated

A child is admitted against its *parent's* remainder, which this service's ledger holds. A tenant with plenty left can have an exhausted parent, so answering a child from the tenant's own allowance would defeat the check.

A root is admitted against its tenant's durable allowance *less the reservation of every run of that tenant still open here*. Neither half is the answer alone: a grant with no consumption subtracted funds every run a tenant ever starts, and a grant with no open holds subtracted lets two unrelated trees each hold the whole allowance at once. The two lifetimes — durable per deployment, in-memory per runtime — meet here and nowhere else.

### Why only root runs carry a tenant

A `RunRecord` names a run and its parent, not an identity, so the tenant a tree is charged to is held here in a map from root run to `UserId`. Only roots are in it: a child settles into its parent's record and reaches the tenant when that parent's root closes, so a tree is charged once rather than once per run in it. A settlement for a run this instance never opened as a root — a child, or a root started before a restart — charges nothing, because there is no tenant to charge it to and guessing one would bill the wrong account.

### Why the clock is a service concern

`expire` releases a hold whose lease has passed, and `evict` drops nonce records that can no longer deny anything. Neither changes a decision a caller could make instead; both bound what the runtime holds. A caller with its own decision timestamp can call `sweep` directly, which is what the tests do.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Candy control plane](../../../docs/subsystems/candy-control-plane.md) — the composition order this service performs.
- [`dsh-run-start`](../run-start/README.md) — Admit, Open and Place, with the rollback between them.
- [`dsh-run-ledger`](../run-ledger/README.md) — the record this service opens, charges, closes and expires.
- [`dsh-control-plane-store`](../control-plane-store/README.md) — the durable accounts and allowances it reads.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No queue** — it starts the run a caller asks for, or refuses it. Whether a refused run waits and in what order queued requests run are decisions nothing makes yet; how much a tenant may have live at once is now answered, by its grant's `children`.
- **Live state is in memory** — a restart loses every open run and the holds it carried, so it returns the tenant's whole unconsumed allowance whatever was running. The store keeps accounts and allowances; durable run records need a settlement story a crash cannot corrupt.
- **One credential key** — the config names one version, so the keyring cannot open an envelope sealed under a retired one. Rotation needs the keyring to carry more than the current key.
- **A settlement is written after its hold is released** — `close` and `sweep` settle in the ledger and then charge the tenant. A crash between the two loses that tree's spend, and a rejected write loses it too: the sweep logs and carries on rather than taking the runtime down, because the holds it could not charge are already released. Bounding the loss to nothing needs durable run records.
- **A charge is not visible until settlement** — `charge` moves a run's spend into the ledger, and the tenant's consumption moves only when the tree's root closes. That is correct while the run is open, since its reservation is already held out of the tenant's remainder, and it means a tenant's consumption lags its live spending by one tree.
- **It does not run the provider** — binding, streaming and cancellation stay with the caller; this service holds no process and no stream.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
