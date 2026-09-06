---
description: "The Candy plugin that opens a funded run for a subagent's delegated child before it exists, refusing delegation the parent's run cannot fund."
kind: "package-reference"
---

# @deepseek-ai/dsh-run-delegation

English | [中文](README.zh.md)

## Summary

`dsh-run-delegation` opens a Candy run for a subagent's in-process delegated child, before the child agent exists. It registers one hook against [`dsh-subagent`](../../subagent/subagent/README.md)'s `SubagentRuntime.onBeforeDelegate()` — the driver's own extension point for a consumer-owned "prepare this delegation" step — and answers it by resolving the delegating parent's own open run through [`dsh-run-scheduler`](../run-scheduler/README.md)'s `startChildRun`, requesting the fixed allowance `config.childBudget` names. A parent whose run cannot fund that request, or whose run the control plane has already flagged as broken, refuses the delegation outright with no child ever created; a parent with no open Candy run at all is unrestricted. The package registers no service and has no public methods beyond the plugin entry point; removing it returns delegation to the state before this package existed — an in-process child with no Candy run of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin alongside `dsh-subagent` and `dsh-run-scheduler` in a Candy composition that delegates work to in-process subagents and wants each delegated child funded and bounded like any other run. The plugin needs no other wiring: it discovers both services through `inject` and installs one hook for the life of its own fiber.

### Minimal composition

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-run-scheduler'
  config:
    issuer: candy-control-plane
    audience: candy-runtime-1
    credentialKeyVersion: 2026-09-a
    poolBase: /var/lib/candy/pools
- name: '@deepseek-ai/dsh-run-delegation'
  config:
    childBudget:
      tokens: 20000
      wallMs: 300000
      costMicroUsd: 500000
      children: 1
```

`childBudget` is the fixed allowance requested for every delegated child, regardless of which tool or provider started the delegation. There is no default: an operator states the number explicitly, the same way `RunScheduler.startChildRun`'s own `share` parameter has none — see [no hardcoded tunables in plugins](../../../AGENTS.md#conventions). A request is refused, never silently shrunk, when the parent cannot afford it in full.

### What changes for the operator

A subagent delegation through `dsh-subagent`'s shipped in-process spawn or fork provider now opens its own Candy run before the child agent is created, parented to the delegating run and funded from `childBudget`. A continuable child is funded once per residency epoch — a dormant child's run is released while it is away, so its next resume opens a new one; a child that resumes while its previous run is still open keeps that run rather than opening a second. That run meters the child's own model calls exactly like a root run, and closes when the child settles: its unspent remainder, and the concurrency slot it held, return to the parent then rather than minutes later when a lease would have lapsed. A parent delegating in sequence therefore reuses one slot instead of running out of slots no child still holds. A delegation whose parent cannot afford the configured request fails before any child exists, with a message naming why. A parent with no open Candy run — a local `dsh --profile headless` run, for instance — sees no change: this plugin only ever funds a Candy tenant's own delegation, never an unrelated composition's.

### Failures and recovery

A refused delegation is the caller's `ctx.subagents.start()` call rejecting with an `Error` naming the reason: the parent's session has no single open run to mint from (claimed by several open runs, or its account revoked), or the minted child could not be funded (the parent's tenant allowance exhausted, or its own remaining allowance short of `childBudget` in one dimension). Widen `childBudget` or investigate the named parent run, and retry; nothing about a refused attempt is recorded beyond the error the caller already sees and whatever `dsh-run-scheduler`'s own audit trail files for the admission attempt.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the hook; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

- **A policy plugin, not a driver feature.** `dsh-subagent` is a general-purpose Harness package with no notion of a Candy run; this plugin is the Candy-owned consumer of its `onBeforeDelegate()` extension point, so the driver never needs to change for Candy's own funding step to exist — the same relationship [`dsh-tenant-preset-policy`](../tenant-preset-policy/README.md) has with `dsh-agent-presets`' `guard()`.
- **Before the child exists, not after.** `onBeforeDelegate()` runs from the in-process driver before `ctx.agents.create()`, so a hook's asynchronous mint-and-open completes before the child could possibly make its first request, and a hook that throws leaves nothing published to roll back — see the [Agent Note](#dev-note) for why `subagent/start`, which fires after publication, was rejected as the hook point.
- **Opened before the child, closed after it.** The mint has to precede creation so nothing runs unfunded; the close has to follow settlement, and reads `subagent/end` for it. Leaving the run to its lease instead would hold the parent's allowance and one concurrency slot for minutes after the child stopped using them.
- **A fixed request, not a computed share.** `config.childBudget` is one deployment-wide allowance asked for every delegated child; a request `RunLedger.reserveChild` cannot fund is refused, never clamped, so a delegated child never starts under a budget its caller never chose.
- **Open by default for sessions outside Candy.** A parent whose session resolves to no open run at all is left alone — the same "not this runtime's to fund" default `RunScheduler.meterRequest` and `tenantOf` already apply. A parent whose run exists but is unusable (claimed by several open runs, or its account revoked) is refused loudly instead: unlike an absent run, a broken one is something the control plane has already flagged, and letting a child through would bypass that flag rather than defer to it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config` schema and the plugin entry point: mints and opens a child run through `RunScheduler.startChildRun`, and renders why a refusal happened |
| — | No runtime invariant companion is published; the hook's decision is a plain function of its config and `RunScheduler.startChildRun`, fully exercised by the real-composition tests in `tests/run-delegation.spec.ts`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-subagent](../../subagent/subagent/README.md) — the delegation driver this plugin hooks, and `onBeforeDelegate()`'s own contract.
- [dsh-run-scheduler](../run-scheduler/README.md) — `startChildRun`, the mint-and-open call this plugin drives.
- [dsh-tenant-preset-policy](../tenant-preset-policy/README.md) — the same extension-point pattern applied to a different roster.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-run-delegation) — every accepted config field and its source declaration.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **In-process children only.** `onBeforeDelegate()` is wired from `dsh-subagent`'s one-shot driver and its continuation manager; an out-of-process product provider (`dsh-subagent-claude-code`, for instance) delegates without this plugin funding it, so those children reach their provider with no Candy run behind them.
- **One fixed allowance, not a computed share.** Every delegated child is funded identically regardless of the task, the tool that started it, or how much of the parent's own allowance remains beyond the bare admission check; a deployment wanting per-tool or per-task shares composes its own hook against `onBeforeDelegate()` rather than extending this plugin's config shape.

-----

<a id="dev-note"></a>
## Dev Note

See the [Agent Note](../../../.agents/notes/implemented/architecture/2026-09-06-a-driver-with-no-notion-of-a-run.md) for the design record: why the extension point lives in `dsh-subagent` as a generic pre-delegation hook rather than a Candy-specific check, why it runs before publication rather than off `subagent/start`, and why a delegated child mints its own execution assertion instead of reusing its parent's.
