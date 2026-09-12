---
description: "The one server a Harness Host serves and the one device it serves as: a durable binding in the credential store, singular by construction, released rather than replaced."
kind: "package-reference"
---

# @deepseek-ai/dsh-device-binding

English | [中文](README.zh.md)

## Summary

A host paired through [`dsh-device-api`](../device-api/README.md) receives a device id and a token once, and until this package existed it had nowhere to keep them. The harness's only durable identity is `dsh-anonymous-user-id`, a per-installation UUID designed *not* to identify a person, and nothing in [`host/`](../../host/README.md) names a machine reached over a network.

This service holds what a pairing produced — which deployment this host answers to, whose device it is, and the token it presents — in [`ctx.credentials`](../../credentials/credentials/README.md), where the credential seam already owns durable secrets and cross-process exclusion.

The binding is singular by construction. There is one record key, and `bind` refuses to replace a binding that already stands. A host serving two tenants at once is a host on which either tenant's work can reach the other's files; the operator action that changes who a machine serves is `release` followed by a new pairing, which is deliberately not something a stray call can do by accident.

Connection state is not here. Reaching the server, noticing that the link dropped, backing off and reconnecting are the inherited transport's. This package answers which server to reach and as whom, and `verify` performs one explicit authentication request without adding a monitor or retry schedule.

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
- id: device-binding
  name: '@deepseek-ai/dsh-device-binding'
```

It has no configuration. Where the record lives is the credential provider's decision, and the local provider keeps it in `$DSH_HOME/.credentials.yaml`.

### Pairing, reading the binding, giving it up

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-device-binding'
import type { DeviceId, UserId } from '@deepseek-ai/dsh-control-plane'

declare const ctx: Context
declare const userId: UserId
declare const deviceId: DeviceId
declare const token: string

await ctx.deviceBinding.pair('https://candy.example', 'ABCD-EFGH', Date.now())
await ctx.deviceBinding.bind(
  { serverOrigin: 'https://candy.example', userId, deviceId, token },
  Date.now(),
)
export const serving = await ctx.deviceBinding.describe()
```

`pair` is the normal host-side entry: it sends the operator's one-time code to the deployment's existing exchange route and installs the returned identity in the credential store. It refuses before sending when a binding already stands, follows no redirects, and rejects incomplete response credentials. A network failure remains an error for the caller to classify; it is never reported as a bad code.

`read` answers the whole binding, token included, for whatever presents it. `describe` answers everything but the token, for anything that reports which machine this is. `release` gives the binding up.

`verify` asks the stored deployment whether the token still identifies the exact stored tenant and device. It returns `false` for an unpaired host or the server's uniform `401`. Network failures remain thrown for the inherited connection owner, while an undocumented status or mismatched identity raises `DeviceBindingVerificationError`; neither case is mistaken for revocation and the binding is never deleted automatically.

A second `bind` naming a different tenant, device or deployment is refused `already-bound`. One naming the same three replaces the token and keeps the instant the host was first bound, which is what a re-pair after a credential rotation is.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The binding record, its origin normalization, and the service over `ctx.credentials` |
| — | No runtime invariant companion is published; the one relation this owns — that a host holds at most one binding — is enforced inside the credential seam's exclusive write and checked by the concurrency test. |

### Why the credential seam holds it

The binding carries a token, which is a secret and belongs where secrets already live. `modifyRecord` is also a serialized read-modify-write that holds across processes where the store supports it, which is what makes "one binding" a fact rather than an intention: two `dsh` processes starting on one machine and pairing at the same moment cannot both install one.

### Why the origin is normalized

A person types a URL with a path, a trailing slash, or capitals in the host, and none of those distinguish one deployment from another. Comparing the raw text would let a re-pair against the same server read as a different one — the exact case `already-bound` exists to refuse — so the scheme and authority are lowercased and everything else is dropped before anything is stored or compared.

### Why a stored payload is validated on the way out

The credential seam stores a `grant` payload as opaque JSON and hands it back uninterpreted. A hand-edited file or a record left by another version therefore reaches this boundary as an ordinary possibility rather than a defensive hypothetical, and a payload that is not a binding reads as an unpaired host rather than as a binding with missing fields.

### Why a re-pair keeps its original instant

The machine has served this tenant since it was bound. A rotated token is a new credential, not a new relationship, and `boundAt` answers when the relationship started.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-device-registry`](../device-registry/README.md) — the server's half of the same relationship.
- [`dsh-device-api`](../device-api/README.md) — the pairing exchange that produces what this stores.
- [`dsh-credentials`](../../credentials/credentials/README.md) — the seam that holds the record and serializes the write.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan; this package is R5's host-side binding.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Nothing connects with it** — this service answers which server to reach and as whom, and can present its token for an explicit verification. No transport reads it during connection establishment or reconnect.
- **Revocation does not release the binding** — `verify` returns `false`, but the host keeps the record until an operator releases it. An offline or failing deployment must never look like permission to change which tenant the machine serves.
- **No command surface** — pairing and releasing are service calls. There is no `dsh` subcommand, no settings page, and no prompt that walks an operator through entering a code.
- **A simultaneous second exchange can consume its code** — `pair` refuses an already-present binding before sending, but two processes can both observe an empty store before either network request returns. The credential seam still admits only one binding; the losing one-time code may already have been consumed.
- **One binding per credential store, not per machine** — two installations with different `$DSH_HOME` values are two hosts as far as this record is concerned. That matches how every other credential behaves and is stated here because a machine is the more natural unit to assume.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
