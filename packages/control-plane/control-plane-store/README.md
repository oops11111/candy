---
description: "Durable provider accounts and tenant allowances, so the credential and budget lookups admission requires are answered from a medium rather than left as parameters."
kind: "package-reference"
---

# @deepseek-ai/dsh-control-plane-store

English | [中文](README.zh.md)

## Summary

[`dsh-provider-accounts`](../provider-accounts/README.md) defines its account store as a port, and [`dsh-run-admission`](../run-admission/README.md) requires a credential lookup and a budget lookup as ports. Every one of them was a parameter no deployment could fill, because nothing in the repository held the data.

This service holds it: provider accounts with their sealed credentials, and each tenant's allowance, in one [storage domain](../../../docs/subsystems/storage.md) over the SQLite backend. A restart keeps them, which is the whole point.

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
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunLedger } from '@deepseek-ai/dsh-run-ledger'

declare const ctx: Context
declare const ledger: RunLedger
declare const partial: Omit<RunAdmissionPolicy, 'findBudget' | 'findCredential'>

export const policy: RunAdmissionPolicy = {
  ...partial,
  findCredential: claims => ctx.controlPlaneStore.findCredential(claims),
  findBudget: claims => claims.parentRunId === undefined
    ? ctx.controlPlaneStore.tenantBudget(claims.userId)
    : Promise.resolve(ledger.remaining(claims.parentRunId)),
}
```

`findBudget` is composed rather than provided whole, and that is the point of the split. A child run is admitted against its *parent's* remainder, which an in-memory `RunLedger` holds; answering a child from the tenant's own allowance would defeat the check the port exists for. This service owns the tenant half and says so.

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

- **No run records** — the ledger is still in memory, so a restart keeps a tenant's accounts and allowance but loses every open run and the holds it carried. Durable run records need a settlement story a crash cannot corrupt, which is not this package.
- **No spend write-back** — a tenant's allowance is what a deployment recorded; nothing here decrements it as runs charge. Folding a run's spend into a durable tenant total is the scheduler's, and needs the same crash story.
- **`listByUser` scans** — the domain keeps every record in memory and this filters them, which is right at one deployment's account count and would not be at a directory's.
- **No replay store** — the nonce port is [`dsh-run-replay`](../run-replay/README.md), which is in-process by design. A deployment running more than one runtime process needs a durable one, and this domain would be a reasonable home for it.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
