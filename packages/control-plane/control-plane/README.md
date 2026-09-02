---
description: "Branded ids for the entities the Candy control plane is the sole authority for, plus the run-ancestry record a child-run authorization check walks."
kind: "package-library"
---

# @deepseek-ai/dsh-control-plane

English | [中文](README.zh.md)

## Summary

`dsh-control-plane` brands the ids the Candy control plane is the sole authority for — `UserId`, `DeviceId`, `ProviderAccountId`, `WorkspaceGrantId`, and `ConversationId` — and defines `RunLineage`, the record naming a run's parent. It is a dependency-free identity foundation with no Cordis service and no storage: it exists so every later control-plane package (the tenant/credential model, the provider adapters, the orchestration authorization check, the Web account APIs, and the Windows Harness Host device binding) shares one non-interchangeable vocabulary from the start, instead of each package inventing its own `string`-typed tenant id. `SessionId` — also under control-plane authority — is reused unchanged from [`dsh-session`](../../core/session/README.md); this package never redefines it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Branding a control-plane id

```ts
import { UserId, DeviceId, ProviderAccountId, WorkspaceGrantId, ConversationId } from '@deepseek-ai/dsh-control-plane'

const userId = UserId('user-1')
const deviceId = DeviceId('device-1')
const accountId = ProviderAccountId('account-1')
const workspaceGrantId = WorkspaceGrantId('grant-1')
const conversationId = ConversationId('conversation-1')
```

Every constructor brands its input without validating or transforming it: no issuer exists yet to define a grammar these constructors could check, so each function documents that no validation is performed. Once the control plane's issuing service exists, it owns adding any validation at the point it admits a raw string — this package stays the shared brand, not the validator.

### Naming a run's ancestry

```ts
import { RunId, type RunLineage } from '@deepseek-ai/dsh-control-plane'

const rootRun: RunLineage = { runId: RunId('run-1'), parentRunId: undefined }
const childRun: RunLineage = { runId: RunId('run-2'), parentRunId: rootRun.runId }
```

A "child run" is a `RunId` whose `RunLineage.parentRunId` is set, not a separate id brand — nothing distinguishes a child run's identity from a root run's except that link. `RunLineage` only names the chain; it does not perform or encode the parent-subset authorization check that admits a child run (see [Known Limitations](#known-limitations-and-deferred-work)).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Every id is a `Branded<'...'>` string from [`dsh-brand`](../../util/brand/README.md), applied through a same-named constructor function — the pattern `dsh-session`'s `SessionId` and `dsh-workspace`'s `WorkspaceId` already use. `RunLineage` is a plain interface with no branding of its own.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `UserId`, `DeviceId`, `ProviderAccountId`, `WorkspaceGrantId`, `ConversationId`, `RunId`, and `RunLineage` |
| — | No runtime invariant companion is published; this pure utility owns no event stream or mutable runtime data; its value algebra is enforced by unit tests. |

### Why `SessionId` is not redefined here

[Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) lists `sessionId` alongside the ids this package owns as a control-plane authority, but the Harness session log — and the `SessionId` brand naming it — already exists and is owned by `dsh-session`. Redefining it here would split one entity's identity across two incompatible brands. `ConversationId` stays distinct: a control-plane conversation is the tenant-visible thread that can own more than one `SessionId` over its lifetime (for example across a fork or resume), so the two ids name different things and neither substitutes for the other.

### Why there is no `ChildRunId`

The [accepted boundary page](../../../docs/candy-runtime-boundaries.md) names "child-run ancestry" as a control-plane authority, not a distinct id space. A run's own identity is a `RunId` regardless of whether it is a root or child run; only `RunLineage.parentRunId` distinguishes the two. An unexplained separate `ChildRunId` brand would duplicate `RunId` without adding a real constraint.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the accepted architecture this package's ids name, and for the plan its first package starts.

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — the accepted trust boundaries, abuse cases, and the full authority list (`userId`, `deviceId`, `accountId`, `workspaceGrantId`, `conversationId`, `sessionId`, child-run ancestry) this package's ids implement.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the proposed R1–R6 delivery plan; this package is the first slice of R1.
- [`dsh-brand`](../../util/brand/README.md) — the nominal-typing primitive every id in this package is built on.
- [`dsh-session`](../../core/session/README.md) — the owner of `SessionId`, reused here unchanged.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog; each is a later R1 delivery-plan bullet this package intentionally does not start.

- **No validation grammar** — every constructor brands its input without checking format, uniqueness, or origin, because no issuing service exists yet. Adding validation here before an issuer exists would invent an unfounded grammar; the issuing control-plane service owns that check when it lands.
- **No credential, grant, or account storage** — this package defines ids only. Encrypted credential envelopes, execution-assertion issuance and validation, and workspace-grant records are separate, unbuilt R1 work.
- **The runtime-pool key lives elsewhere** — [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) names `userId + provider + accountId` as the runtime-pool isolation key, and [`dsh-runtime-pool`](../runtime-pool/README.md) derives it. It stays out of this package because it needs a `ProviderKind` and a digest, and this package holds only the ids and stays dependency-free.
- **No Cordis service** — nothing in this package registers on a `Context`; it is imported directly by TypeScript, like `dsh-brand`.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
