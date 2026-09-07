---
description: "A Claude CLI dsh-llm route resolved per call to the Candy run driving the request's session, for a multi-tenant runtime that cannot pin one tenant's isolation to one adapter instance."
kind: "package-reference"
---

# @deepseek-ai/dsh-claude-cli-route

English | [中文](README.zh.md)

## Summary

`dsh-claude-cli-route` mounts a `dsh-llm` provider route named `claude-cli` whose credential, working pool, and spend ceiling are resolved fresh for every call from the Candy run driving the request's session, rather than pinned once at composition time. Mount it in a multi-tenant Candy runtime instead of `dsh-llm-claude-cli` directly: that package's own composition holds one tenant's isolation on the adapter instance, correct for one process serving one tenant, and its README states this is why the agent loop cannot share it as a route. This package is the join that lets one mounted route serve every tenant a `dsh-run-scheduler` admits, and lets ending a run for cause — a revoked account, an expired lease, a tree closed around it — reach the process that run's own call started.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this once per Candy runtime, alongside `dsh-run-scheduler`, `dsh-llm`, and a `dsh-subprocess` provider. Every call whose `GenerateOptions.provider` is `claude-cli` and whose `sessionId` names a run that runtime's scheduler has open is served against that run's own tenant.

### When to choose it

Choose it for a Candy deployment serving more than one tenant's Claude CLI calls through one mounted composition. Choose `dsh-llm-claude-cli` directly for a single-tenant deployment, or for the auxiliary one-shot calls (`dsh-compaction`, `dsh-session-title`) that already construct their own adapter per pool — this package adds session resolution neither needs.

### Minimal configuration

```yml
- id: claude-cli-route
  name: '@deepseek-ai/dsh-claude-cli-route'
  config:
    executable: /opt/candy/bin/claude
```

| Field | Default | Meaning |
|---|---|---|
| `executable` | `claude` | Absolute path to the `claude` executable this host runs |
| `graceMs` | `5000` | Process-tree termination grace, in milliseconds |
| `maxOutputBytes` | `16777216` | Most stdout bytes one call may write before it is failed and reaped |
| `maxStderrBytes` | `8192` | Most stderr bytes kept from one call, as that stream's tail |

Every field is a host fact — the same for every tenant this route serves — which is why none of them is read from the run. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-claude-cli-route) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `SessionRoutedClaudeCliAdapter`, the plugin, its `Config`, and `resolveDeployment` |
| — | No runtime invariant companion is published; this package holds no state of its own between calls, and the seam's own `dsh-llm/invariant` already checks the chunk grammar around every provider stream. |

### One call, one resolution, nothing retained

`stream()` is the whole of this package's logic: read `options.sessionId`, ask `RunScheduler.runIdentityFor` which run drives it and what that run may authenticate with, bind the answer to a Claude CLI launch, and delegate to a freshly constructed `ClaudeCliAdapter`. Nothing survives between two calls, including two calls of the same run — the credential `runIdentityFor` opens is read fresh from the vault each time, so a run whose account is revoked between its first and second call has its second call refused rather than served on a secret that should no longer work. This is the same property `dsh-run-scheduler`'s own metering already has for the identical reason, stated in its README: a run opens its credential once and holds it, so revoking the account destroys the stored envelope without reaching a process already authenticated with it, and reading fresh is what lets a revocation stop work already under way.

### Termination reaches the process this route starts

`RunScheduler.disposableSpawn(runId, spawn)` wraps the `spawn` function this route hands `ClaudeCliAdapter`, so the process it starts is registered against the run's own lifetime. Ending the run for cause — from the scheduler's sweep, independent of anything this call's own caller does — terminates that process the same way cancelling the call would. This package does not implement disposal itself; it is the first and, today, only composition that wires `disposableSpawn` into a real launch, closing the gap [`dsh-run-scheduler`'s own note](../../../.agents/notes/implemented/architecture/2026-09-06-a-run-that-settled-but-kept-running.md) named as reach without a reacher.

### Why the provider is checked against the account, not only configured

`runIdentityFor` answers with whatever provider the run's account actually is — it does not assume `claude-cli`. This route checks that fact before binding a launch: a session whose run authenticates a DeepSeek account reaching this route by misconfiguration is refused by name (`PROVIDER_MISMATCH`) rather than handed a Claude CLI process it was never meant to authenticate.

### Why refusal is a thrown `LlmError`, not a silent pass-through

Every failure this package can produce — no session, no open run, an unusable account, an unopenable credential, a provider mismatch, or a launch a spent budget cannot support — throws before any process spawns. `dsh-llm-claude-cli`'s own README notes this choice is worth revisiting only once a caller exists that would rather route around a refusal than fail loud; none does yet, so this package throws for the same reason that one does.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-run-scheduler`](../run-scheduler/README.md) — `runIdentityFor`, `disposableSpawn`, and the run-lifetime disposal this route composes.
- [`dsh-claude-cli-binding`](../claude-cli-binding/README.md) — `bindClaudeCliCredential`, the pure join from an opened credential to a launch.
- [`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.md) — `ClaudeCliAdapter`, the process lifetime and protocol this route delegates every call to.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R3 orchestration join this package is the first piece of.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-llm-claude-cli`, which owns every prompt, response, and token effect the `ClaudeCliAdapter` this route constructs per call produces.

#### KV Cache effect

Independent per call, for the same reason `dsh-llm-claude-cli` itself is: each call constructs a fresh adapter over a fresh process, so no prefix is carried between two calls this route serves, including two calls of the same run.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **One provider, one package** — this route serves `claude-cli` only; a Codex CLI route resolved the same way is a separate package once that adapter exists, not a configurable provider name here.
- **A fresh `ClaudeCliAdapter` per call** — nothing is pooled or reused across calls, including two calls of one run. This is what makes credential re-opening correct rather than a needed optimization: a deployment with very high call rates pays one credential-open per call, which `dsh-credential-vault`'s own cost this package has not measured against.
- **No retry classification of its own** — a refusal this package throws (`PROVIDER_MISMATCH`, `CREDENTIAL_UNAVAILABLE`, `BINDING_REFUSED`, `NO_SESSION`) carries no route-owned retry policy; `dsh-llm-retry` treats these with its defaults, the same as `dsh-llm-claude-cli`'s own failures.
- **Depth of the R3 orchestration join** — this package resolves identity and disposal for one call; agent-registry routing policy, delegation-tree audit coverage beyond scheduling, and a Codex CLI counterpart remain the parts of that join this package does not build.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
