---
description: "Durable provider accounts, tenant allowances and route policies for Candy's control plane."
kind: "package-reference"
---

# @deepseek-ai/dsh-control-plane-store

English | [中文](README.zh.md)

## Summary

[`dsh-provider-accounts`](../provider-accounts/README.md) defines its account store as a port, and [`dsh-run-admission`](../run-admission/README.md) requires a credential lookup and a budget lookup as ports. Every one of them was a parameter no deployment could fill, because nothing in the repository held the data.

This service holds it: provider accounts with their sealed credentials, each tenant's allowance and exact model-route policy, the workspace grants a device issued, one record per live run, and a trail of what each tenant's runs did, from the attempt that opened one to the settlement that ended it, in one [storage domain](../../../docs/subsystems/storage.md) over the SQLite backend. A restart keeps them, which is the whole point.

It is not the ledger. `RunLedger` stays the accounting authority and answers what a run may still spend; what lives here is the record that survives a restart, and the two markers that let an interrupted settlement be finished exactly once. Session ownership is written before each run and retained after settlement; `isManagedSession` identifies these sessions for their runtime without a live run. Domain version 8 rejects older records; upgrading an existing deployment requires a separately verified data transition. Adding `tenant_routes` did not change that version or invalidate existing version-8 data because it adds an independently materialized table without changing an existing record shape. Ownership records have no automatic expiry.

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
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-sqlite
  name: '@deepseek-ai/dsh-storage-sqlite'
  config:
    path: /var/lib/candy/candy.db
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: sqlite
- id: control-plane-store
  name: '@deepseek-ai/dsh-control-plane-store'
```

The service takes no configuration of its own: which medium serves the domain is the domain plugin's routing decision, not this package's.

### Setting a tenant's model routes

```ts
await ctx.controlPlaneStore.setTenantModelRoutes(userId, [
  { provider: 'claude-cli', model: 'sonnet' },
])
```

This replaces the complete allowlist. Exact ids are case-sensitive; blank or duplicate pairs are rejected. An empty list persists an explicit deny-all policy, while `tenantModelRoutes(userId) === undefined` means no policy was provisioned. [`dsh-tenant-route-policy`](../tenant-route-policy/README.md) denies both states.

### Answering the ports admission requires

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-control-plane-store'
import type { UserId } from '@deepseek-ai/dsh-control-plane'
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import { remainingAllowance } from '@deepseek-ai/dsh-tenant-allowance'

declare const ctx: Context
declare const ledger: RunLedger
declare const partial: Omit<RunAdmissionPolicy, 'findBudget' | 'findCredential'>
/** The reservation of every run of one tenant that is still open. */
declare function heldByTenant(userId: UserId): readonly RunBudget[]

async function tenantRemaining(userId: UserId): Promise<RunBudget | undefined> {
  const allowance = await ctx.controlPlaneStore.tenantAllowance(userId)
  return allowance === undefined ? undefined : remainingAllowance(allowance, heldByTenant(userId))
}

export const policy: RunAdmissionPolicy = {
  ...partial,
  findCredential: claims => ctx.controlPlaneStore.findCredential(claims),
  findBudget: claims => claims.parentRunId === undefined
    ? tenantRemaining(claims.userId)
    : Promise.resolve(ledger.remaining(claims.parentRunId)),
}
```

`findBudget` is composed rather than provided whole, and that is the point of the split. Neither half is the answer on its own. A child run is admitted against its *parent's* remainder, which an in-memory `RunLedger` holds; answering a child from the tenant's own allowance would defeat the check the port exists for. A root run is admitted against this service's durable allowance *less what the tenant's open runs are holding*, which the same ledger knows and this service does not. [`dsh-run-scheduler`](../run-scheduler/README.md) is where both compositions are performed once, rather than at each call site.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/spec.ts`](src/spec.ts) | The domain declaration, its record schemas, and the converters between stored and runtime shapes |
| [`src/index.ts`](src/index.ts) | `ControlPlaneStore`, the service that opens the domain and answers the ports |
| — | No runtime invariant companion is published; the domain layer owns durability, and the relations here are checked by the composition test. |

### Why the stored shapes are not the runtime ones

JSON drops an `undefined` property, so a field the runtime types as `number | undefined` — a never-validated account, a never-rewrapped envelope — comes back as an absent key. The schemas declare those `optional` and the converters beside them put the field back. Reading the runtime type straight from `z.infer` would compile and then disagree with itself the first time such an account round-tripped.

### Why a read-modify-write queues here

The domain serializes each write but not the read that decides what to write. Two callers that read one record before either writes both compute from the same value, and the second write drops the first — a lost charge, or a lost audit record. Reading and writing on one chain is what makes appending to a trail and charging an allowance safe to call concurrently.

The chain is store-wide rather than per record. These are settlements, audit appends and grant changes, not a hot path, and one chain is correct without bookkeeping that could itself be wrong.

### Why a charge carries the id of the run it absorbed

Charging whoever funded a run and then forgetting that run are two writes this medium cannot make one, so a crash between them leaves a settled record a recovering runtime would charge a second time. Both funders — a tenant's allowance and a parent's run record — therefore carry the id of the settlement they last absorbed, written by the same atomic update as the charge itself. A repeat of that id is a no-op, so recovery re-drives an interrupted settlement without knowing how far it got.

The guarantee needs one settlement at a time per funder: two interleaved settlements leave the id of the later one, and a crash would then charge the earlier one twice. [`dsh-run-scheduler`](../run-scheduler/README.md) queues every write to a run record on one chain, which is where that serialization lives.

### Why a trail is a window, not an archive

The domain keeps every record it holds in memory, so an unbounded log would grow the runtime without bound. A trail is therefore capped: `recordAudit` keeps the most recent `retain` records for one subject and the rest are gone. The cap is the caller's, because how much history a deployment keeps is its choice and not a property of the medium.

That makes this a place to look at recent activity rather than somewhere to keep evidence. A deployment that needs an archive ships the records somewhere that is one, and this is where it reads them from.

A bounded trail rewritten whole is also erasable by whoever can make an event repeat. Eight refused calls against a retention of four left nothing but the refusals, and the credential and start records an operator would investigate them with were gone. A record identical to the newest one in every field but its instant therefore folds into it, as a `count` and a later `at`, rather than pushing the history out one entry at a time. It adds nothing the trail could distinguish, and what it would have displaced is exactly what makes the repetition worth reading about.

### Why some records name a runtime instead of a tenant

Every stage past the assertion works from verified claims, so its record names the tenant, account and run it refused. An assertion that fails to verify names none this runtime may believe — and it is also the record an operator most wants — so it is filed against the runtime that refused it. The `t_` and `r_` prefixes on a subject key keep the two spaces from colliding.

### Why a revoked grant is stored rather than deleted

An execution assertion names a workspace grant by id, and the record is the authority behind it. A deleted record reads as a grant that was never issued, which is a different fact from one that was withdrawn — and the run refused for it should say `revoked`, because that is what an operator investigating the refusal needs. [`dsh-workspace-grant`](../workspace-grant/README.md) reads `revokedAt` and nothing else to decide which.

### Why a run record names its account

A child run inherits a subset of its parent's grants, and tenant and account are the two a runtime can decide: the parent held exactly one of each. `findRun` is what `dsh-run-admission` checks a child's claimed identity against, and this record is where the parent's is written down.

### Why a run record names its device, workspace grant and conversation

An execution assertion's device, workspace grant and conversation claims exist only for as long as verifying that one token needs them; nothing before this kept them past admission. `RunScheduler.startChildRun` needs to mint a delegated child's own assertion from an already-open run, and a minted assertion cannot state a fact the runtime does not still have — so a run record carries the three fields a child's claims must copy from its parent's.

### Why a run record names a session

A model request carries the session it was assembled for and no Candy concept of its own, and an execution assertion names the session its run drives. Recording that session on the run makes `runsOfSession` the whole of the lookup that turns a provider stream into the run it is charged to — without a `runId` on `GenerateOptions`, which would let one consumer dictate a contract the whole `dsh-llm` seam shares.

### Why a run record is stamped with its runtime

`runsOf` answers for one runtime only. Two runtimes sharing this medium would otherwise recover each other's records at boot and settle runs that are still going. The stamp is the reading runtime's own audience identifier, which an execution assertion is already bound to, so two runtimes never share the value.

### Why the credential lookup checks the tenant

An account is read by id, and the tenant its record names must be the one the verified claims carry. The vault would refuse to open a mismatched envelope anyway, so this is not the enforcement — it keeps a mismatch out of the one call that could otherwise be handed the wrong envelope, and it costs one comparison.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain declaration, routing, and change events this service is built on.
- [`dsh-provider-accounts`](../provider-accounts/README.md) — the account operations whose store port this satisfies.
- [`dsh-run-admission`](../run-admission/README.md) — the three ports, and why a child's budget is its parent's remainder.
- [Candy control plane](../../../docs/subsystems/candy-control-plane.md) — where these lookups sit in the composition order.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **A restart ends every run it recovers** — a record this runtime wrote is a run it was driving, and the process that drove it is gone, so `dsh-run-scheduler` settles what it finds rather than resuming it. Nothing here can tell a crashed run from one whose provider is somehow still alive.
- **Recovery repairs one damage shape, not every one** — a record naming a parent the store does not hold is settled against its own tenant and cleared, because recovery settles every root it restores anyway. Damage this does not name — a record that fails its schema, a tenant allowance that is gone — still fails the boot, and there is no repair path for those.
- **One runtime per audience** — `runsOf` partitions by the runtime stamp, so two processes sharing an audience recover each other's records. An assertion is audience-bound already, so this is a deployment rule rather than a check made here.
- **A run's grants are its tenant and account** — the record carries what a child can be checked against. A workspace grant is not among them: narrowing one is legitimate and nothing here models containment.
- **`runsOfSession` scans** — the domain keeps every run record in memory and this filters them, which is right at a runtime's live-run count and would not be at a fleet's.
- **Read-modify-writes are serialized store-wide** — a slow medium therefore orders a charge for one tenant behind an audit append for another. The alternative is per-record chains, which nothing yet needs.
- **A trail is bounded and rewritten whole** — one subject's records live in one document, so each append rewrites that document, and records past the cap are dropped rather than archived. Repetition folds into a count rather than displacing history, but a subject whose events genuinely differ still loses its oldest. It suits a window of recent activity at a deployment's scale and not an audit archive at a directory's.
- **The trail records what the control plane observes** — scheduling attempts and vault operations. Routing, delegation, tool authorization and terminal state are not in it, because nothing in this repository produces those records yet.
- **No period** — an allowance runs from its grant until an operator changes it, and `setTenantGrant` deliberately keeps what was consumed. Nothing here starts a new billing period, because nothing in the repository decides when one begins.
- **`listByUser` scans** — the domain keeps every record in memory and this filters them, which is right at one deployment's account count and would not be at a directory's.
- **Durable replay requires SQLite** — `spent_nonces` uses the storage seam's optional compare/exchange operation, so two runtime processes and a restart share one single-use decision. SQLite implements that operation transactionally. JSON layouts deliberately do not pretend that an open-time snapshot plus a file rewrite is cross-process atomic; an admission routed there fails loud with `facet-unsupported`.
- **Route policy reads are process-local snapshots** — an update through this service is visible to the next call in the same runtime and survives restart. Separate long-lived processes sharing one SQLite database do not receive live invalidation from `storage-domain`; fleet-wide policy updates need an authenticated API plus explicit fan-out or reload.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
