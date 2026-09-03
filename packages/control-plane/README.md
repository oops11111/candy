---
description: "The control-plane group map: the branded ids and run-ancestry record every Candy tenant-aware package builds on."
kind: "package-group"
---

# packages/control-plane

English | [中文](README.zh.md)

## Summary

The control-plane group gives every future Candy tenant-aware package one shared, non-interchangeable vocabulary for the entities the control plane is the sole authority for: `UserId`, `DeviceId`, `ProviderAccountId`, `WorkspaceGrantId`, and `ConversationId`, plus a `RunLineage` record naming a run's parent. `SessionId` is reused unchanged from [`dsh-session`](../core/session/README.md), never redefined here. The group has nine packages today — an identity vocabulary, the per-run credential that carries it, the vault holding a tenant's provider secrets, the account manager that owns user-visible provider-account metadata, the delegation-tree budget, the ledger of live runs that settles an abandoned hold, the pool key partitioning runtime state, the admission call composing run authority, and the binding that turns an admitted run into a confined Claude CLI launch — and no running Cordis service, because the control plane's OAuth, device pairing, and persistent account store described in [the accepted runtime-boundaries page](../../docs/candy-runtime-boundaries.md) and [the proposed multi-tenant runtime plan](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) have not shipped yet. This page maps the group; the package README owns the details.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`control-plane`](control-plane/README.md) | Branded `UserId`, `DeviceId`, `ProviderAccountId`, `WorkspaceGrantId`, `ConversationId`, `RunId`, and the `RunLineage` ancestry record |
| [`execution-assertion`](execution-assertion/README.md) | Mints and admits the signed, short-lived assertion that authorizes one run |
| [`credential-vault`](credential-vault/README.md) | Seals a tenant's provider-account secret, rotates its key, revokes it, and records every access |
| [`provider-accounts`](provider-accounts/README.md) | Owns tenant provider-account metadata, encrypted credential lifecycle, default selection, and secret-free account views |
| [`run-budget`](run-budget/README.md) | Bounds a delegation tree's tokens, time, money, and concurrency by drawing each child's allowance out of its parent's |
| [`run-ledger`](run-ledger/README.md) | Records what each open run holds and has spent, and settles an abandoned hold exactly rather than by estimate |
| [`runtime-pool`](runtime-pool/README.md) | Derives the isolation key and the one directory a tenant's provider runtime owns |
| [`run-admission`](run-admission/README.md) | The one scheduling call: assertion, nonce, credential, and pool resolved together |
| [`claude-cli-binding`](claude-cli-binding/README.md) | Turns an admitted run into the Claude CLI launch facts that confine it to that tenant |

<a id="related-documentation"></a>
## Related documentation

- [Candy Runtime Boundaries](../../docs/candy-runtime-boundaries.md) — the accepted trust boundaries and abuse cases this group's ids exist to name.
- [Multi-tenant CLI agent runtime](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the proposed delivery plan this group's first package (R1) starts.
- [Core session subsystem](../core/README.md) — the owner of `SessionId`, which this group's ids reference but never redefine.

<a id="dev-note"></a>
## Dev Note

None.
