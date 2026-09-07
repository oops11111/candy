---
description: "The filesystem authority one Candy run is admitted with: the roots a device granted, the file-effect ceiling for work under them, and the rule that a delegated child may widen neither."
kind: "package-library"
---

# @deepseek-ai/dsh-workspace-grant

English | [中文](README.zh.md)

## Summary

An execution assertion carries a `WorkspaceGrantId` and nothing else about the filesystem. Until this package existed the id resolved to no record anywhere in the repository, and [`dsh-run-admission`](../run-admission/README.md) never read it: a run named whatever grant it liked, a delegated child could name another one, and no step looked. The tenant and account a child inherits were checked; its filesystem authority was not.

This package holds what the id resolves to — the roots a device granted to a tenant, the file-effect ceiling for work under them, the grant's revision, and whether it still stands — and the one rule admission applies to it.

Path containment is deliberately not here. A grant's roots are spelled for the device that issued them, and deciding whether a path lies under one is that device's filesystem semantics — casing, junctions, symbolic links, 8.3 aliases. A control plane on another host cannot reproduce those by comparing strings, so what this rule decides is identity and inheritance, which are the same on every host.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Deciding whether a run may hold the grant it named

```ts
import { admitWorkspaceGrant } from '@deepseek-ai/dsh-workspace-grant'
import type { WorkspaceGrantStore } from '@deepseek-ai/dsh-workspace-grant'
import type { DeviceId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'

declare const store: WorkspaceGrantStore
declare const userId: UserId
declare const deviceId: DeviceId
declare const grantId: WorkspaceGrantId
declare const parentGrantId: WorkspaceGrantId | undefined

const outcome = admitWorkspaceGrant(
  { userId, deviceId, grantId, parentGrantId },
  await store.findGrant(grantId),
)
export const roots = outcome.admitted ? outcome.grant.roots : []
```

A run is refused when the id resolves to nothing (`not-found`), when the grant was revoked (`revoked`), when it belongs to another tenant (`tenant-mismatch`) or to another device of the same tenant (`device-mismatch`), or when a child named any grant other than the one its parent holds (`not-inherited`).

### Storing one

`WorkspaceGrantStore` is the port a deployment satisfies; [`dsh-control-plane-store`](../control-plane-store/README.md) implements it over SQLite. A revocation is `saveGrant` with `revokedAt` set rather than a delete: the record is the authority an assertion only names, so removing it would make a withdrawn grant read as one that was never issued.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| Path | Responsibility |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The grant record, the storage port, and the admission rule |
| — | No runtime invariant companion is published; this pure module owns no event stream or mutable runtime data, and its rule is enforced by unit tests. |

### Why a child must name its parent's grant exactly

Equality is the subset rule at its strongest. A child that cannot name another grant cannot widen its roots or raise its mode, so over-granting is impossible rather than detectable — the shape [`dsh-run-budget`](../run-budget/README.md) already takes for tokens and concurrency. The alternative, comparing a child's roots against its parent's, is the path arithmetic this package does not do.

Nothing in this repository issues a narrowed child grant today: [`RunScheduler.startChildRun`](../run-scheduler/README.md) copies its parent's grant id into the minted assertion. When something needs one, it will be a record the issuing device derives after checking containment with its own filesystem, and this rule will accept that derivation.

### Why the record carries a device

The roots are one machine's paths. Honouring a grant from another device would apply them to a different disk, where the same string names something else or nothing at all. The device on the record is also the answer to "who may resolve a path against these roots", which is what the filesystem-side check needs.

### Why the record carries a version

An assertion names only the id, so a run admitted before a narrowing and one admitted after it are indistinguishable by id alone. Admission records the version it read on the admitted run, which is what lets a later check tell a run holding authority that has since been reduced from one holding what it was given.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan; this package is the workspace half of R3's parent-child grants.
- [A grant nobody could resolve](../../../.agents/notes/implemented/architecture/2026-09-07-a-grant-nobody-could-resolve.md) — why the id had no record, and what admission now refuses.
- [`dsh-run-admission`](../run-admission/README.md) — the one caller, and where the refusal is ordered against the other checks.
- [`dsh-sandbox`](../../sandbox/sandbox/README.md) — the `SandboxMode` vocabulary a grant's ceiling is spelled in.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Nothing enforces the roots yet** — admission decides that a run may hold a grant, not that a given path lies under it. The second check belongs where the file operation happens, on the device the grant names, and no filesystem seam reads `roots` today.
- **Nothing issues a grant** — a deployment writes records through the store by hand. There is no pairing flow, no operator surface, and no lifecycle that creates one when a device is registered.
- **A narrowed child grant cannot be expressed** — a child names its parent's grant or is refused. Narrowing needs a derived record the issuing device creates, and nothing creates one.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly, like `dsh-run-budget`.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
