---
description: "Durable provider accounts and tenant allowances, so the credential and budget lookups admission requires are answered from a medium rather than left as parameters."
kind: "package-reference"
---

# @deepseek-ai/dsh-control-plane-store

English | [中文](README.zh.md)

## Summary

[`dsh-provider-accounts`](../provider-accounts/README.md) defines its account store as a port, and [`dsh-run-admission`](../run-admission/README.md) requires a credential lookup and a budget lookup as ports. Every one of them was a parameter no deployment could fill, because nothing in the repository held the data.

This service holds it: provider accounts with their sealed credentials, each tenant's allowance, one record per live run, and a trail of what each tenant's scheduling attempts did, in one [storage domain](../../../docs/subsystems/storage.md) over the SQLite backend. A restart keeps them, which is the whole point.

It is not the ledger. `RunLedger` stays the accounting authority and answers what a run may still spend; what lives here is the record that survives a restart, and the two markers that let an interrupted settlement be finished exactly once.

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

### Why a charge carries the id of the run it absorbed

Charging whoever funded a run and then forgetting that run are two writes this medium cannot make one, so a crash between them leaves a settled record a recovering runtime would charge a second time. Both funders — a tenant's allowance and a parent's run record — therefore carry the id of the settlement they last absorbed, written by the same atomic update as the charge itself. A repeat of that id is a no-op, so recovery re-drives an interrupted settlement without knowing how far it got.

The guarantee needs one settlement at a time per funder: two interleaved settlements leave the id of the later one, and a crash would then charge the earlier one twice. [`dsh-run-scheduler`](../run-scheduler/README.md) queues every write to a run record on one chain, which is where that serialization lives.

### Why a trail is a window, not an archive

The domain keeps every record it holds in memory, so an unbounded log would grow the runtime without bound. A trail is therefore capped: `recordAudit` keeps the most recent `retain` records for one subject and the rest are gone. The cap is the caller's, because how much history a deployment keeps is its choice and not a property of the medium.

That makes this a place to look at recent activity rather than somewhere to keep evidence. A deployment that needs an archive ships the records somewhere that is one, and this is where it reads them from.

### Why some records name a runtime instead of a tenant

Every stage past the assertion works from verified claims, so its record names the tenant, account and run it refused. An assertion that fails to verify names none this runtime may believe — and it is also the record an operator most wants — so it is filed against the runtime that refused it. The `t_` and `r_` prefixes on a subject key keep the two spaces from colliding.

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
- **Recovery is all-or-nothing on a corrupt store** — records that do not form complete trees fail the boot rather than being dropped, because a hold against a parent that does not exist is one nothing can settle. There is no repair path.
- **One runtime per audience** — `runsOf` partitions by the runtime stamp, so two processes sharing an audience recover each other's records. An assertion is audience-bound already, so this is a deployment rule rather than a check made here.
- **A trail is bounded and rewritten whole** — one subject's records live in one document, so each append rewrites that document, and records past the cap are dropped rather than archived. It suits a window of recent activity at a deployment's scale and not an audit archive at a directory's.
- **The trail records what the control plane observes** — scheduling attempts and vault operations. Routing, delegation, tool authorization and terminal state are not in it, because nothing in this repository produces those records yet.
- **No period** — an allowance runs from its grant until an operator changes it, and `setTenantGrant` deliberately keeps what was consumed. Nothing here starts a new billing period, because nothing in the repository decides when one begins.
- **`listByUser` scans** — the domain keeps every record in memory and this filters them, which is right at one deployment's account count and would not be at a directory's.
- **No replay store** — the nonce port is [`dsh-run-replay`](../run-replay/README.md), which is in-process by design. A deployment running more than one runtime process needs a durable one, and this domain would be a reasonable home for it.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
