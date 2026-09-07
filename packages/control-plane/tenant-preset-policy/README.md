---
description: "The tenant preset allowlist plugin for Candy operators restricting which of a shared dsh-agent-presets roster a tenant may use."
kind: "package-reference"
---

# @deepseek-ai/dsh-tenant-preset-policy

English | [中文](README.zh.md)

## Summary

`dsh-tenant-preset-policy` restricts a Candy tenant to a configured subset of an otherwise-shared [`dsh-agent-presets`](../../preset/agent-presets/README.md) roster. It registers one guard against `AgentPresets.guard()` — the roster's own extension point for a consumer-owned "may this agent compose this preset" decision — and answers it by resolving a session's tenant through [`dsh-run-scheduler`](../run-scheduler/README.md)'s `tenantOf`, then checking the preset id against that tenant's configured allowlist. A tenant absent from the configuration, or a session no Candy run drives, is unrestricted. The package registers no service and has no public methods beyond the plugin entry point; removing it returns every tenant to the unrestricted roster the bare `dsh-agent-presets` composition already gives them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin alongside `dsh-agent-presets` and `dsh-run-scheduler` in a Candy composition that wants to restrict which presets a tenant may run. The plugin needs no other wiring: it discovers both services through `inject` and installs one guard for the life of its own fiber.

### Minimal composition

```yaml
- name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
- name: '@deepseek-ai/dsh-run-scheduler'
  config:
    issuer: candy-control-plane
    audience: candy-runtime-1
    credentialKeyVersion: 2026-09-a
    poolBase: /var/lib/candy/pools
- name: '@deepseek-ai/dsh-tenant-preset-policy'
  config:
    allowlists:
      user-alice: [minimal, standard]
      user-bobby: [minimal]
```

`allowlists` maps a tenant id to the preset ids that tenant may mount or switch to. A tenant with no entry in the map is unrestricted — the config states exceptions to an open default, not a closed one, so onboarding a new tenant needs no configuration change until an operator chooses to narrow it.

### What changes for the operator

A tenant's session creation, and any later preset switch, now refuses a preset id absent from that tenant's allowlist with `agent-preset/refused` and a message naming the tenant and the preset. A tenant with no allowlist entry, and a session with no Candy run behind it at all (a local `dsh --profile headless` run, for instance), see no change: this plugin only ever narrows what a Candy run's own tenant may use, never what an unrelated composition permits.

### Failures and recovery

A refused mount or switch is the caller's `agentPresets.mount()`/`recompose()` call rejecting with `agent-preset/refused`, exactly as a broken preset composition would — see [`dsh-agent-presets`' own failure documentation](../../preset/agent-presets/README.md#use-this-package). Widen the tenant's `allowlists` entry, or remove it to lift the restriction entirely, and retry; nothing about a refused attempt is recorded beyond the error the caller already sees.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the guard; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

- **A policy plugin, not a roster feature.** `dsh-agent-presets` is a general-purpose Harness package with no notion of a tenant; this plugin is the Candy-owned answer to its `guard()` extension point, so the roster never needs to change for Candy's own restriction to exist.
- **Resolved fresh, per guard call.** The guard reads `config.allowlists` and calls `RunScheduler.tenantOf` on every invocation — nothing is cached — so a configuration change takes effect on the very next mount or switch attempt, and a session whose run just opened is judged against current state.
- **Unbypassable by construction, not by convention.** `AgentPresets.guard()` is consulted inside `resolveMountable`, the one function behind both `mount()` and `recompose()` — the only two operations that ever install an agent's preset binding — so there is no second call path this plugin would need to guard separately.
- **Open by default, narrowed by exception.** A tenant absent from `allowlists`, and a session `tenantOf` cannot resolve to one tenant (no open run, an ambiguous claim, or a run whose account is no longer usable), are both unrestricted — the same "not this runtime's to charge" default `RunScheduler.meterRequest` already applies to a session with no Candy run behind it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config` schema and the plugin entry point: resolves a session's tenant and checks it against the configured allowlist |
| — | No runtime invariant companion is published; the guard's decision is a plain function of its config and `RunScheduler.tenantOf`, fully exercised by the real-composition tests in `tests/policy.spec.ts`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-agent-presets](../../preset/agent-presets/README.md) — the roster this plugin restricts, and the `guard()` extension point it consumes.
- [dsh-run-scheduler](../run-scheduler/README.md) — `tenantOf`, the synchronous session-to-tenant lookup this plugin's guard reads.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tenant-preset-policy) — every accepted config field and its source declaration.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Allowlists are static plugin configuration, not durable per-tenant state.** Unlike a tenant's allowance (held in `dsh-control-plane-store`), a preset allowlist changes only by editing and reloading the composition; there is no admin API or store-backed record a deployment can update at runtime without a config change.
- **One guard, one deployment-wide config.** A single `allowlists` map covers every tenant this runtime serves; a deployment wanting a different enforcement rule (a route allowlist alongside the preset one, for instance) composes a separate guard rather than extending this plugin's config shape.

-----

<a id="dev-note"></a>
## Dev Note

See the [Agent Note](../../../.agents/notes/implemented/architecture/2026-09-06-a-roster-with-no-notion-of-a-tenant.md) for the design record: why the extension point lives in `dsh-agent-presets` as a generic guard rather than a Candy-specific check, and why `RunScheduler.tenantOf` is synchronous.
