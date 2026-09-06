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

### Rotating the credential key

Every sealed envelope names the version it was sealed under, so changing `credentialKeyVersion` and the key behind it makes this runtime unable to open anything sealed before: each tenant is refused with `unknown-key` on every run until the old value is put back. `retiredCredentialKeys` is what makes a rotation a migration instead of an outage — the old version stays openable while the new one seals:

```yml
    credentialKeyVersion: 2026-09-b
    retiredCredentialKeys:
      - version: 2026-09-a
        env: CANDY_CREDENTIAL_KEY_PREVIOUS
```

A retired version that is also the current one, or retired twice, fails the boot. Either would decide silently which key a version means, and the wrong answer is a tenant whose credential opens with the wrong key or not at all. An entry whose variable is unset fails the boot for the same reason every secret does.

Retiring a key is not finishing the rotation. The envelopes are rewrapped under the current key by whoever drives that pass, and only then can the retired entry go.

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

### Minting a child run for a delegated session

`start` needs a caller-supplied assertion, minted by whatever authenticated the request. A session delegated from an already-open run — a subagent, for instance — needs no new authentication: its identity is exactly its parent's, already verified when the parent's own run opened. `startChildRun` is that case handled directly, without an external issuing authority:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const parentSessionId: SessionId
declare const childSessionId: SessionId
declare const share: (run: { budget: RunBudget }) => RunBudget

const result = await ctx.runScheduler.startChildRun(parentSessionId, childSessionId, share)

export const started = result.ok ? result.outcome.started : false
```

It resolves the parent session's open run, copies its tenant, account, provider, device, workspace grant and conversation, mints a fresh assertion naming the child session and the parent's run as `parentRunId`, and drives it through the same `start` this section already documents — so a minted child is funded, ledgered and audited exactly as a caller-supplied one is, including the parent-subset budget `dsh-run-budget` already enforces for any assertion naming a `parentRunId`. The minted token is never transmitted or persisted; it exists only to drive that one call. `share` has no default: how much of a parent's remaining budget a delegated child should receive is a policy choice this service has no basis to guess, so a caller states it every time.

`result.ok` is `false` only when the parent session itself does not resolve to one open, usable run — the same ambiguity `runIdentityFor` and `tenantOf` refuse. Once minting proceeds, the child's own admission decision — started, or a named refusal — travels inside `result.outcome`, unchanged from what `start` itself would report.

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

A refused *call* is filed the same way, under `event: 'refused'` and `action: 'meter'`, with the failure code as its outcome.

A process launched during a metered call is filed too, under `event: 'launched'` with the executable as its action. `dsh-subprocess` announces every managed child it starts, and knows nothing about tenants; what supplies the rest is a run scope this service enters around each pull of a metered stream. A provider process is started deep inside an adapter, with no session and no run of its own to name — the call it was started during is the only thing that connects it to one.

The scope is entered around each pull rather than around the stream. An async generator's body runs when its consumer asks for a chunk, in the consumer's context and not the one the generator was created in, so a scope wrapped around creation reaches none of the body and attributes nothing.

A launch outside any metered call — the harness's own bash, pwsh and language-server children — is left alone. It belongs to no tenant, and filing it would push a tenant's own records out of a trail bounded per subject. Admission never sees these: a run opens its credential once and then keeps calling, so a revoked account still spending, a run that has used up its allowance, and a session no open run claims are all visible here and nowhere else. The record is durable before the caller is told, so an operator reading the trail cannot be behind a consumer acting on the refusal. A refusal whose session names no run this runtime still holds is filed against the runtime, for the same reason an unverifiable assertion is: there is no tenant to believe.

### Resolving a session's tenant, synchronously

A caller elsewhere in the harness sometimes needs to know which tenant a session belongs to without opening its credential — a synchronous policy hook, for instance, cannot await one. `tenantOf` answers from the same in-memory run index metering already reads, and nothing else:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const sessionId: SessionId

// The session's tenant, or undefined when this runtime has no single open,
// usable run for it — the same ambiguity `runIdentityFor` refuses.
export const userId = ctx.runScheduler.tenantOf(sessionId)
```

[`dsh-tenant-preset-policy`](../tenant-preset-policy/README.md) is the first consumer: it resolves a session's tenant this way to decide whether a preset id is on that tenant's allowlist, inside a synchronous `AgentPresets` guard.

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

A request naming no session, or one naming a session this runtime never had a run for, passes through untouched — it is not this runtime's to charge. A session whose run *ended* here is refused instead: a run can end under an agent that is still working — its account revoked, the tree around it closed, its root closed by a restart — and the run record is gone by then, so without a memory of the ending its next call would look like one this runtime never had and run for free.

The mapping is kept unambiguous where it is created: a run whose session another run already drives is refused at `start`, before its nonce is spent, so it can be retried once that session settles. A request whose session two records still claim is refused with a terminal `error` finish — that state arrives only from outside `start`, and charging either tree would be a misbilling the caller cannot detect.

The run's account is read again on every call, not trusted from admission. A run opens its credential once and holds it for as long as it lives, so revoking the account destroys the stored envelope without reaching a process already authenticated with it. Reading the record per call is what makes a revocation stop work that is already under way: the call is refused with `CREDENTIAL_REVOKED` before the provider is reached, and nothing is charged.

The sweep then ends the run itself. Refusing its calls alone left it open — holding its funder's allowance, with what it had already spent unbilled — until its lease ran out minutes later. The sweep is where this runtime ends runs it has decided should end, so a run whose account can no longer authorize it ends there, on the same judgement `meterRequest` makes. A run whose record the store cannot answer for is left to its lease instead: ending runs on a read that returned nothing is the larger mistake.

### Why an elapsed lease does not end a working run

A lease answers one question: did the runtime holding this run go away. A runtime that still has the run's session is answering it directly, so the sweep renews that run's lease — in the ledger and on the durable record — instead of releasing its hold. Without that, every run ended `leaseMs` after it opened however hard its agent was working, and the session was then refused for the rest of its life.

Liveness is not activity. A session parked between turns — waiting on a tool, an approval, or a person — is still this runtime's to fund, and loses its run only when the session itself goes. A composition with no session store leaves every run to its lease, exactly as before this rule existed, and a revoked account still ends its run however live the session is: this rule decides abandonment, never authority.

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

### Disposing of a run's process when it settles for cause

Settlement is accounting: it writes a charge and forgets the record. A run ended for cause — a revoked account, an expired lease, a tree closed around it — has that decided in the sweep, deep inside this service, with no reach into whatever process the run's own call is still running. `registerDisposer` is that reach, for a caller that holds the resource:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RunId } from '@deepseek-ai/dsh-control-plane'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const runId: RunId
declare const subprocess: SubprocessRuntime

// Every process this spawns for `runId` is terminated the moment the run
// settles, however it settles, and left alone once it exits on its own.
export const spawn = ctx.runScheduler.disposableSpawn(runId, (spec: SubprocessSpawnSpec) => subprocess.spawn(spec))
```

Composing `disposableSpawn` around the `spawn` function a provider binding hands its adapter is the whole of the wiring: a caller with the raw handle instead calls `registerDisposer(runId, () => handle.terminate())` directly and unregisters it once the handle's own `done` settles. Nothing calls either unless a caller does — this service still runs no provider itself, and a composition that spawns without either leaves a settled run's process running exactly as it always has.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`, the `RunScheduler` service, its admission policy, the settlement, the recovery, the meter, and the disposer registry |
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

### Why disposal runs before the settlement writes

A caller registers a disposer once, when it starts a process for a run; nothing re-registers it per call, and a run's second sequential call replaces the first's disposer rather than adding to it — the first's process has already exited by then, so only the live one still needs releasing. `settle` invokes whatever is registered for the run, and every descendant `RunLedger.settlementOf` reports closing with it, before writing the charge or forgetting the record: a process this settlement is about to stop billing for should stop running as soon as that is decided, not once the durable writes that follow it succeed. A disposer that throws is logged and swallowed, because its failure is not a reason to leave the run's accounting stuck open — the settlement it would have blocked has already been decided.

### Why a restart settles instead of resuming

A record this runtime wrote is a run it was driving, and the process that drove it is gone. `Service.init` finishes every interrupted settlement, restores what is left into the ledger, and closes each restored root — so a tenant is charged what its runs actually consumed. Leaving them open instead would hold the allowance until each lease expired, and resuming them would mean resuming providers that no longer exist.

Recovery reads its own runtime's records only, by the audience stamp on each one.

A record naming a parent the store does not hold is damage — a partial write, or a delete that took the parent and left the child. It is adopted as a root: its parent is cleared in the store, and it is settled like any other root. Refusing to boot on it instead took every tenant on the runtime down over one damaged record, a blast radius far larger than the damage. Adopting loses no accounting, because recovery settles every root it restores anyway; the run was going to be settled a moment later either way, and the only open question was who is charged for what it spent. The record names its tenant, and that is where the parent's own settlement would have carried the charge.

The parent is cleared in the store and not only in the restored ledger, because the settlement that follows reads the record back: one still naming the missing parent would charge that parent, which is to say nobody.

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
- **Nothing rewraps** — a retired key is retained until every envelope has been rewrapped under the current one, and driving that pass is the operator's; this package opens envelopes and does not migrate them, so a key retired forever is a key never actually retired.
- **A charge is not visible until settlement** — `charge` writes a run's spend to its own record at once, and the tenant's consumption moves only when the tree's root closes. That is correct while the run is open, since its reservation is already held out of the tenant's remainder, and it means a tenant's consumption lags its live spending by one tree.
- **A run's calls are serialized too** — `meter` holds one run's calls in a line so each reads a remainder the one before it has been charged against. Two tenants never wait for each other, but a run cannot make two calls at once, however long the first takes.
- **Every operation is serialized** — one chain orders every start, charge and settlement in the runtime, which is what makes the exactly-once marker and the allowance checks guarantees. It also means one tenant's start waits behind another's, including the pool directory each start creates.
- **A rejected sweep is logged, not retried immediately** — the runs it could not settle stay open with expired leases, so the next sweep retries them. A medium that stays unavailable holds those allowances until it comes back.
- **It does not run the provider** — binding and cancellation stay with the caller; `meter` wraps a stream the caller opened, and this service holds no process of its own. `registerDisposer` and `disposableSpawn` let a caller tie one it holds to a run's settlement, but nothing calls either unless the composition does.
- **A trail is a window, not an archive** — `auditRetention` records per tenant, and per runtime for attempts that named none; older records are dropped rather than shipped anywhere. A deployment that needs to keep them reads them from here and sends them on.
- **Ended sessions are remembered in memory, and capped** — `endedSessionMemory` sessions, oldest evicted first, and an evicted session's calls pass through again. The memory is deliberately not durable: it must outlive the run, not the process, because the agent that could still make a call lives in this process too.
- **One session, one run** — a second run naming a session this runtime already has open is refused. A control plane that mints one session for a parent and its child gets the child refused, which makes a session per run a requirement on the control plane rather than a convention.
- **Metering follows the session, not the process** — a request assembled for a run's session is metered wherever it is made, and a request made outside that session is not metered at all, even if the same run caused it. A deployment that runs work for a tenant without a session of its own is unmetered.
- **The trail covers scheduling, not the run's work** — starting, denying, and the vault operations an attempt produced. Routing, delegation, tool authorization and terminal state are not recorded, because nothing produces those records yet.
- **A cut call does not reap the provider by itself** — `meter` ends the stream on the run's wall time, including for a provider that goes silent, but closing that provider's process is still whoever launched it's to arrange: registering a disposer against the run is how, and nothing does it automatically.
- **Disposal is opt-in, per run, and per call** — a caller that never calls `registerDisposer` or `disposableSpawn` gets none of this; one that does must register again for each sequential call a run makes, since only the live call's process is worth releasing. No provider binding wires this yet — the composition that would is the R3 orchestration join, still unbuilt.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
