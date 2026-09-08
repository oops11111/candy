---
description: "The control-plane group map: the branded ids and run-ancestry record every Candy tenant-aware package builds on."
kind: "package-group"
---

# packages/control-plane

English | [中文](README.zh.md)

## Summary

The control-plane group supplies shared, non-interchangeable identities and the Candy-owned authorization, persistence, budgeting, routing, and provider-launch components that use them. `SessionId` is reused unchanged from [`dsh-session`](../core/session/README.md). The package table is the current map; [Candy Runtime Boundaries](../../docs/candy-runtime-boundaries.md) owns the security split and the [multi-tenant runtime plan](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) owns unfinished delivery work.

The scheduler description above uses the original ownership shorthand. Replay decisions now live durably in `ControlPlaneStore`; the scheduler owns only its live ledger and composes that persistent nonce port.

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
| [`oauth-sign-in`](oauth-sign-in/README.md) | Completes a PKCE callback and maps verified identity to Candy authorization |
| [`control-plane-api`](control-plane-api/README.md) | The authenticated envelope every management route is registered through: session-derived identity, write protections, role guards, and uniform failures |
| [`oauth-sign-in-web`](oauth-sign-in-web/README.md) | Mounts the browser sign-in routes on the Harness Host web server and enrolls the first administrator from configuration |
| [`credential-vault`](credential-vault/README.md) | Seals a tenant's provider-account secret, rotates its key, revokes it, and records every access |
| [`provider-accounts`](provider-accounts/README.md) | Owns tenant provider-account metadata, encrypted credential lifecycle, default selection, and secret-free account views |
| [`run-budget`](run-budget/README.md) | Bounds a delegation tree's tokens, time, money, and concurrency by drawing each child's allowance out of its parent's |
| [`workspace-grant`](workspace-grant/README.md) | Resolves the workspace-grant id an assertion names into the roots and file-effect ceiling a run holds, and refuses a child that names any other |
| [`workspace-grant-execution`](workspace-grant-execution/README.md) | Revalidates that durable grant at inherited filesystem and shell executors, including canonical link containment and revocation |
| [`provider-credential-checks`](provider-credential-checks/README.md) | The registry a provider integration says through whether one stored credential still authenticates |
| [`deepseek-credential-check`](deepseek-credential-check/README.md) | Registers a redacted authenticated `/models` probe for `deepseek-api` |
| [`provider-account-api`](provider-account-api/README.md) | The six provider-account operations, mounted on the authenticated management envelope |
| [`run-ledger`](run-ledger/README.md) | Records what each open run holds and has spent, and settles an abandoned hold exactly rather than by estimate |
| [`run-replay`](run-replay/README.md) | Records an assertion's nonce as spent in one indivisible step, retained exactly while that assertion stays admissible |
| [`tenant-allowance`](tenant-allowance/README.md) | Holds a tenant's grant beside what its settled runs consumed, so one grant funds one tenant rather than every run it starts |
| [`run-metering`](run-metering/README.md) | Meters one provider stream against an open run, refusing a call it cannot afford and cutting one that outruns its wall time |
| [`run-start`](run-start/README.md) | Admits, funds and places one run in the documented order, returning a parent's hold when the placement refuses |
| [`control-plane-store`](control-plane-store/README.md) | Holds provider accounts and tenant allowances durably, answering the credential and budget lookups admission requires |
| [`run-scheduler`](run-scheduler/README.md) | Owns one runtime's ledger and replay store, starts a run from an assertion, and drives the clock that releases an abandoned hold |
| [`runtime-pool`](runtime-pool/README.md) | Derives the isolation key and the one directory a tenant's provider runtime owns |
| [`run-admission`](run-admission/README.md) | The one scheduling call: assertion, nonce, credential, and pool resolved together |
| [`claude-cli-binding`](claude-cli-binding/README.md) | Turns an admitted run into the Claude CLI launch facts that confine it to that tenant |
| [`claude-cli-route`](claude-cli-route/README.md) | A Claude CLI `dsh-llm` route resolved per call to the run driving the request's session, with disposal tied to that run's settlement |
| [`tenant-preset-policy`](tenant-preset-policy/README.md) | Restricts a tenant to a configured subset of an otherwise-shared `dsh-agent-presets` roster |
| [`tenant-route-policy`](tenant-route-policy/README.md) | Enforces an exact per-tenant provider/model allowlist before adapter preparation and final dispatch |
| [`run-delegation`](run-delegation/README.md) | Opens a funded Candy run for a subagent's in-process delegated child before it exists, refusing delegation the parent's run cannot fund |

<a id="related-documentation"></a>
## Related documentation

- [Candy control plane](../../docs/subsystems/candy-control-plane.md) — how these packages compose into one run, what a deployment must supply, and why the order is the contract.
- [Candy Runtime Boundaries](../../docs/candy-runtime-boundaries.md) — the accepted trust boundaries and abuse cases this group's ids exist to name.
- [Multi-tenant CLI agent runtime](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the proposed delivery plan this group's first package (R1) starts.
- [Core session subsystem](../core/README.md) — the owner of `SessionId`, which this group's ids reference but never redefine.

<a id="dev-note"></a>
## Dev Note

None.
