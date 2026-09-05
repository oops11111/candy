---
description: "One Candy runtime's live run state: the ledger and replay store a run is admitted against, and the clock that releases a hold no settlement claimed."
kind: "package-reference"
---

# @deepseek-ai/dsh-run-scheduler

English | [中文](README.zh.md)

## Summary

Everything this service composes already existed as a library. What did not exist was an owner. The ledger and the replay store are per-runtime objects nothing held; admission's policy had to be assembled by hand at every call site; and `RunLedger.expire` was a call no clock made, so a run abandoned without settling held its parent's allowance until someone thought to reclaim it.

`ctx.runScheduler` holds that state, starts a run from an execution assertion, drives the clock, and charges a settled tree to whoever funded it. It is where a tenant's durable allowance and its live runs meet, and that meeting is the whole of Candy's tenant-level bound: read on its own, either half admits a run it should refuse.

It also meters the provider streams a run makes, which is where an allowance stops being an accounting figure: a call is refused before the provider is reached when the run has nothing left, and cut when it outruns the wall time the run still had. It finds those streams by the session a request was assembled for, so an agent driven on a run's session is metered without anyone threading a run id through the model request.

Its records are durable and every settlement is exactly-once across a crash, and every scheduling attempt it makes leaves a record — a started run, a denial and the tenant it refused, and the vault operations each attempt produced. The order queued requests run in is still a decision nothing here makes.

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
    auditRetention: 200
    endedSessionMemory: 1000
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

What comes back is not running. Binding a provider to it stays with the caller — `charge` and `close` are on this service, and the run's record is open until `close`.

### Reading what a tenant's attempts did

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { UserId } from '@deepseek-ai/dsh-control-plane'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const userId: UserId

export const recent = ctx.runScheduler.auditsOfTenant(userId)
export const unattributed = ctx.runScheduler.auditsOfRuntime()
```

Every stage past the assertion works from verified claims, so its record names the tenant, account and run it refused. An assertion that fails to verify names none this runtime may believe, so `auditsOfRuntime` is where that record goes rather than into a tenant's trail — it is the clearest attack signal admission can observe, and dropping it was the alternative. Both trails are capped by `auditRetention`.

### Metering the calls a run makes

Nothing has to ask. Every model request the harness assembles carries the session it was assembled for, and an execution assertion names the session its run drives — so a request whose session belongs to an open run of this runtime is metered against it automatically:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const request: GenerateOptions

// Charged to the run whose claims named `request.sessionId`, if there is one.
export const stream = ctx.llm.stream(request)
```

A request naming no session, or one naming a session this runtime never had a run for, passes through untouched — it is not this runtime's to charge. A session whose run *ended* here is refused instead: a lease can expire under an agent that is still working, and the run record is gone by then, so without a memory of the ending its next call would look like one this runtime never had and run for free.

The mapping is kept unambiguous where it is created: a run whose session another run already drives is refused at `start`, before its nonce is spent, so it can be retried once that session settles. A request whose session two records still claim is refused with a terminal `error` finish — that state arrives only from outside `start`, and charging either tree would be a misbilling the caller cannot detect.

### Metering one stream by hand

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RunId } from '@deepseek-ai/dsh-control-plane'
import type { LlmAdapter, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const runId: RunId
declare const adapter: LlmAdapter
declare const request: GenerateOptions

export const stream = ctx.runScheduler.meter(runId, adapter.stream(request))
```

A caller holding a run and a stream directly can skip the lookup. `meter` charges the call — durably — before its terminal chunk reaches the consumer, so the next call is admitted against a ledger that already knows about this one. A run with nothing left never reaches the provider, and a call that outruns the wall time its run had is cut with a terminal `error` finish. A cut ends the call, not the run: the record stays open with what the call consumed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`, the `RunScheduler` service, its admission policy, the settlement, the recovery, and the meter |
| — | No runtime invariant companion is published; the relations here belong to the ledger and the store, and the composition test checks them end to end. |

### Why one instance owns one ledger

Every run this runtime admits is accounted against the same delegation trees and the same spent nonces. Two instances would each believe they held the whole allowance, and the delegation cap would hold in neither — the same reason `dsh-run-ledger` requires a parent and its children to share an instance.

### Why the budget lookup is composed rather than delegated

A child is admitted against its *parent's* remainder, which this service's ledger holds. A tenant with plenty left can have an exhausted parent, so answering a child from the tenant's own allowance would defeat the check.

A root is admitted against its tenant's durable allowance *less the reservation of every run of that tenant still open here*. Neither half is the answer alone: a grant with no consumption subtracted funds every run a tenant ever starts, and a grant with no open holds subtracted lets two unrelated trees each hold the whole allowance at once. The two lifetimes — durable per deployment, in-memory per runtime — meet here and nowhere else.

### Why a start runs under the chain too

Every check a start makes reads state a later step of the same start changes: the tenant's remainder, the parent's allowance, the session's holder. Read outside a critical section, two concurrent starts for one tenant both see the whole remainder and both open against it, and the tenant ends up holding twice its grant — measured against a booted runtime before this held.

So the chain orders whole operations rather than writes. The state a decision was made from cannot change before that decision is applied, which is what makes the tenant remainder, the one-session rule and the parent-subset rule bounds rather than likelihoods.

### Why the settlement writes before it closes

A settlement is two writes the medium cannot make one: charge whoever funded the run, then forget the run. Doing it in memory first and writing after loses the charge whenever the write fails, which is exactly when it matters. So the charge is computed with `RunLedger.settlementOf`, written down as the run's own settled figure, applied to its funder, and only then are the records forgotten and the hold released. A rejected write leaves the run open in both places, and its lease brings the next sweep back to try again.

Each funder — the tenant's allowance for a root, the parent's record for a child — stores the id of the settlement it last absorbed, in the same atomic write as the charge. A repeat of that id is a no-op, so a restarting runtime re-drives an interrupted settlement without knowing how far it got. That guarantee holds only while no two settlements interleave, which is why every write to a run record queues on one chain here.

### Why a restart settles instead of resuming

A record this runtime wrote is a run it was driving, and the process that drove it is gone. `Service.init` finishes every interrupted settlement, restores what is left into the ledger, and closes each restored root — so a tenant is charged what its runs actually consumed. Leaving them open instead would hold the allowance until each lease expired, and resuming them would mean resuming providers that no longer exist.

Recovery reads its own runtime's records only, by the audience stamp on each one. Records that do not form complete trees fail the boot rather than being dropped: a hold against a parent that does not exist is one nothing can settle.

### Why the session is the join

A model request carries no Candy concept and should not: `dsh-llm` is the inherited seam, and adding a `runId` to `GenerateOptions` would let one consumer dictate a service contract every other consumer shares. What the request already carries is `sessionId`, stamped by the loop, and an execution assertion already names the session its run drives. The two meet without either side learning about the other — the same selection [`dsh-session-checkpoint-policy`](../../session/session-checkpoint-policy/README.md) makes for its own streams.

That leaves one case the mapping cannot answer: a session two open runs both claim. It means the control plane minted two runs for one session, and the call is refused rather than charged to whichever was found first, because a misbilled tenant is not a failure anyone would notice.

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
- [`dsh-control-plane-store`](../control-plane-store/README.md) — the durable accounts, allowances and run records it reads.
- [`dsh-run-metering`](../run-metering/README.md) — the stream wrapper `meter` binds to this runtime's ledger.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No queue** — it starts the run a caller asks for, or refuses it. Whether a refused run waits and in what order queued requests run are decisions nothing makes yet; how much a tenant may have live at once is now answered, by its grant's `children`.
- **A restart ends every run** — recovery settles what it finds rather than resuming it, because the provider processes died with the runtime. A deployment that restarts a runtime under load ends its live runs and charges their tenants for what they had spent.
- **One credential key** — the config names one version, so the keyring cannot open an envelope sealed under a retired one. Rotation needs the keyring to carry more than the current key.
- **A charge is not visible until settlement** — `charge` writes a run's spend to its own record at once, and the tenant's consumption moves only when the tree's root closes. That is correct while the run is open, since its reservation is already held out of the tenant's remainder, and it means a tenant's consumption lags its live spending by one tree.
- **Every operation is serialized** — one chain orders every start, charge and settlement in the runtime, which is what makes the exactly-once marker and the allowance checks guarantees. It also means one tenant's start waits behind another's, including the pool directory each start creates.
- **A rejected sweep is logged, not retried immediately** — the runs it could not settle stay open with expired leases, so the next sweep retries them. A medium that stays unavailable holds those allowances until it comes back.
- **It does not run the provider** — binding and cancellation stay with the caller; `meter` wraps a stream the caller opened, and this service holds no process.
- **A trail is a window, not an archive** — `auditRetention` records per tenant, and per runtime for attempts that named none; older records are dropped rather than shipped anywhere. A deployment that needs to keep them reads them from here and sends them on.
- **Ended sessions are remembered in memory, and capped** — `endedSessionMemory` sessions, oldest evicted first, and an evicted session's calls pass through again. The memory is deliberately not durable: it must outlive the run, not the process, because the agent that could still make a call lives in this process too.
- **One session, one run** — a second run naming a session this runtime already has open is refused. A control plane that mints one session for a parent and its child gets the child refused, which makes a session per run a requirement on the control plane rather than a convention.
- **Metering follows the session, not the process** — a request assembled for a run's session is metered wherever it is made, and a request made outside that session is not metered at all, even if the same run caused it. A deployment that runs work for a tenant without a session of its own is unmetered.
- **The trail covers scheduling, not the run's work** — starting, denying, and the vault operations an attempt produced. Routing, delegation, tool authorization and terminal state are not recorded, because nothing produces those records yet.
- **A metered call is bounded, a silent one is not** — `meter` checks wall time as chunks arrive, so a provider that stalls without emitting runs past its deadline until the lease sweep reaches its run.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
