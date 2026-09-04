---
description: "One Candy runtime's live run state: the ledger and replay store a run is admitted against, and the clock that releases a hold no settlement claimed."
kind: "package-reference"
---

# @deepseek-ai/dsh-run-scheduler

English | [中文](README.zh.md)

## Summary

Everything this service composes already existed as a library. What did not exist was an owner. The ledger and the replay store are per-runtime objects nothing held; admission's policy had to be assembled by hand at every call site; and `RunLedger.expire` was a call no clock made, so a run abandoned without settling held its parent's allowance until someone thought to reclaim it.

`ctx.runScheduler` holds that state, starts a run from an execution assertion, drives the clock, and charges a settled tree to whoever funded it. It is where a tenant's durable allowance and its live runs meet, and that meeting is the whole of Candy's tenant-level bound: read on its own, either half admits a run it should refuse.

Its records are durable and every settlement is exactly-once across a crash. The order queued requests run in is still a decision nothing here makes.

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

### Why the settlement writes before it closes

A settlement is two writes the medium cannot make one: charge whoever funded the run, then forget the run. Doing it in memory first and writing after loses the charge whenever the write fails, which is exactly when it matters. So the charge is computed with `RunLedger.settlementOf`, written down as the run's own settled figure, applied to its funder, and only then are the records forgotten and the hold released. A rejected write leaves the run open in both places, and its lease brings the next sweep back to try again.

Each funder — the tenant's allowance for a root, the parent's record for a child — stores the id of the settlement it last absorbed, in the same atomic write as the charge. A repeat of that id is a no-op, so a restarting runtime re-drives an interrupted settlement without knowing how far it got. That guarantee holds only while no two settlements interleave, which is why every write to a run record queues on one chain here.

### Why a restart settles instead of resuming

A record this runtime wrote is a run it was driving, and the process that drove it is gone. `Service.init` finishes every interrupted settlement, restores what is left into the ledger, and closes each restored root — so a tenant is charged what its runs actually consumed. Leaving them open instead would hold the allowance until each lease expired, and resuming them would mean resuming providers that no longer exist.

Recovery reads its own runtime's records only, by the audience stamp on each one. Records that do not form complete trees fail the boot rather than being dropped: a hold against a parent that does not exist is one nothing can settle.

### Why a run's tenant lives on its record

A `RunRecord` names a run and its parent, not an identity, so the tenant a tree is charged to is written on the durable record instead. That is the only place it exists, so a settlement, a recovery, and the tenant-remainder lookup all read the same fact; a map beside the ledger would be a second copy that a restart does not have.

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
- **A restart ends every run** — recovery settles what it finds rather than resuming it, because the provider processes died with the runtime. A deployment that restarts a runtime under load ends its live runs and charges their tenants for what they had spent.
- **One credential key** — the config names one version, so the keyring cannot open an envelope sealed under a retired one. Rotation needs the keyring to carry more than the current key.
- **A charge is not visible until settlement** — `charge` writes a run's spend to its own record at once, and the tenant's consumption moves only when the tree's root closes. That is correct while the run is open, since its reservation is already held out of the tenant's remainder, and it means a tenant's consumption lags its live spending by one tree.
- **Every write is serialized** — one chain orders every run-record write in the runtime, which is what makes the exactly-once marker a guarantee. It also means a slow medium serializes charges across unrelated tenants.
- **A rejected sweep is logged, not retried immediately** — the runs it could not settle stay open with expired leases, so the next sweep retries them. A medium that stays unavailable holds those allowances until it comes back.
- **It does not run the provider** — binding, streaming and cancellation stay with the caller; this service holds no process and no stream.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
