---
description: "The control-plane group map: the branded ids and run-ancestry record every Candy tenant-aware package builds on."
kind: "package-group"
---

# packages/control-plane

English | [中文](README.zh.md)

## Summary

The control-plane group gives every future Candy tenant-aware package one shared, non-interchangeable vocabulary for the entities the control plane is the sole authority for: `UserId`, `DeviceId`, `ProviderAccountId`, `WorkspaceGrantId`, and `ConversationId`, plus a `RunLineage` record naming a run's parent. `SessionId` is reused unchanged from [`dsh-session`](../core/session/README.md), never redefined here. The group has one package today — a dependency-free identity foundation with no running Cordis service — because the control plane's OAuth, device pairing, encrypted credential vault, and execution-assertion services described in [the accepted runtime-boundaries page](../../docs/candy-runtime-boundaries.md) and [the proposed multi-tenant runtime plan](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) have not shipped yet. This page maps the group; the package README owns the details.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`control-plane`](control-plane/README.md) | Branded `UserId`, `DeviceId`, `ProviderAccountId`, `WorkspaceGrantId`, `ConversationId`, `RunId`, and the `RunLineage` ancestry record |

<a id="related-documentation"></a>
## Related documentation

- [Candy Runtime Boundaries](../../docs/candy-runtime-boundaries.md) — the accepted trust boundaries and abuse cases this group's ids exist to name.
- [Multi-tenant CLI agent runtime](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the proposed delivery plan this group's first package (R1) starts.
- [Core session subsystem](../core/README.md) — the owner of `SessionId`, which this group's ids reference but never redefine.

<a id="dev-note"></a>
## Dev Note

None.
