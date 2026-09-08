---
description: "The six provider-account operations mounted on the authenticated Candy management envelope: the tenant is the session's, the credential goes in and never comes back, and another tenant's account answers as one that does not exist."
kind: "package-reference"
---

# @deepseek-ai/dsh-provider-account-api

English | [中文](README.zh.md)

## Summary

No domain logic lives here. [`dsh-provider-accounts`](../provider-accounts/README.md) already creates, lists, selects a default for, validates, revokes and deletes an account, and each of its operations takes the tenant and refuses an id that tenant does not own.

What this plugin adds is the transport: which path, which method, which least role, how a domain refusal becomes a status, and — the point of the layer — that the tenant those operations receive is the one [`dsh-control-plane-api`](../control-plane-api/README.md) derived from the session, never one a request carried.

A credential goes in and never comes back. The store holds a sealed envelope, `ProviderAccountView` has no field for a secret, and every reply here is built from that view.

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
- id: provider-credential-checks
  name: '@deepseek-ai/dsh-provider-credential-checks'
- id: provider-account-api
  name: '@deepseek-ai/dsh-provider-account-api'
  config:
    publicOrigin: 'https://candy.example'
    credentialKeyVersion: '2026-09-a'
    credentialKeyEnv: 'CANDY_CREDENTIAL_KEY'
```

`credentialKeyVersion` and the key behind it must be the ones [`dsh-run-scheduler`](../run-scheduler/README.md) opens with, or a credential sealed here is unopenable by the runtime that has to use it. Both assemble their keyring through the same `assembleKeyring`.

### The operations

| Path | Method | Effect |
| --- | --- | --- |
| `/api/candy/provider-accounts` | `GET` | Every account this tenant owns |
| `/api/candy/provider-accounts/create` | `POST` | Create one and seal its credential |
| `/api/candy/provider-accounts/validate` | `POST` | Ask the provider whether the stored credential still authenticates |
| `/api/candy/provider-accounts/default` | `POST` | Make one this provider's default |
| `/api/candy/provider-accounts/revoke` | `POST` | Revoke its credential, keeping the record readable |
| `/api/candy/provider-accounts/delete` | `POST` | Delete it, keeping its id blocked |

Every operation but the listing takes `{ "id": "…" }`. Create takes `{ "provider", "label", "secret", "isDefault"? }`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The plugin config, the request checks, the six routes, and the audit wiring |
| [`src/types.ts`](src/types.ts) | The route paths and request shapes |
| — | No runtime invariant companion is published; this plugin owns no event stream or mutable runtime data, and its behavior is proved by a real Loader/Host test with two tenants. |

### Why the account id is minted here

An id a caller chose could collide with another tenant's, and the domain refuses a collision as `account-already-exists` — which would report that the other tenant's account exists. Minting removes the question.

### Why the id in a request cannot select a tenant

It reaches `dsh-provider-accounts` beside the session's `UserId`, and that operation answers `not-found` for an id the tenant does not own — the same answer an id that was never issued gets. The envelope maps `not-found` to `404` with no detail, so a caller cannot confirm an id by the difference.

### What this layer validates, and what it forwards

The provider must be one of the three Candy supports, the secret must be a non-empty string within [`MAX_SECRET_LENGTH`](src/index.ts), and `isDefault` must be a boolean if present. Those are transport facts: the secret reaches a sealing operation and nothing else would bound it.

The label's rule belongs to `dsh-provider-accounts` and is forwarded rather than repeated — this layer establishes only that it is a string. Repeating the rule would be two places to change and one to forget.

### Why the audit records successes too

An operator investigating a revoked account needs to see who revoked it, not only the attempts that failed. The vault's own sealing and opening records reach the same tenant trail beside the API's. Neither write can fail the operation it describes: the trail is a record of what happened, not a precondition for it.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-control-plane-api`](../control-plane-api/README.md) — the envelope that derives the tenant and owns the failure vocabulary.
- [`dsh-provider-accounts`](../provider-accounts/README.md) — the six domain operations, and the ownership rule behind `not-found`.
- [`dsh-provider-credential-checks`](../provider-credential-checks/README.md) — where a provider integration answers whether a credential works.
- [Six operations that already existed](../../../.agents/notes/implemented/architecture/2026-09-08-six-operations-that-already-existed.md) — what this layer added and what it deliberately did not.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Validation reports `unsupported-provider` until an integration composes** — nothing registers a credential check yet, so `validate` succeeds as a route and answers that no provider could be asked.
- **No administrator view** — every operation acts on the acting tenant's own accounts. An administrator managing another tenant's accounts has no surface here.
- **No key rotation surface** — `assembleKeyring` retains old versions so a sealed credential stays openable, but rewrapping every envelope onto the current key is not exposed.
- **No pagination** — a tenant's accounts are answered whole. The count is bounded by what an operator provisions, not by this API.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
