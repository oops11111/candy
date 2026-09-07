---
description: "The Candy policy plugin that authorizes an exact provider/model route for the tenant behind a managed LLM call."
kind: "package-reference"
---

# @deepseek-ai/dsh-tenant-route-policy

English | [中文](README.zh.md)

## Summary

`dsh-tenant-route-policy` enforces exact provider/model grants for Candy-managed sessions through `LlmRuntime.guard()` at the final adapter boundary. DeepSeek Harness still owns model discovery, model selection and adapters; this package only resolves the request session through [`dsh-run-scheduler`](../run-scheduler/README.md) and answers the Candy-specific authorization question. A managed tenant absent from configuration is denied. A request with no session, or a session with no uniquely resolvable Candy run, remains under ordinary Harness behavior.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the policy beside `dsh-llm` and `dsh-run-scheduler`:

```yaml
- name: '@deepseek-ai/dsh-tenant-route-policy'
  config:
    allowlists:
      user-alice:
        - provider: claude-cli
          model: sonnet
        - provider: codex-cli
          model: gpt-5.6-sol
```

Both fields are exact, case-sensitive ids. An allowed pair reaches the normal Harness waterfall and adapter. Any other pair for that managed tenant returns one terminal `error` finish with code `TENANT_ROUTE_NOT_ALLOWED`; the adapter is never called. An empty list and a missing tenant entry both mean deny.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin registers one `LlmRuntime.guard()`. A session-aware prepared call invokes it before adapter preparation; final dispatch invokes it again after routing middleware has chosen the final pair. The guard reads the session id, asks `RunScheduler.tenantOf` for the live tenant and checks that tenant's configured pairs. Direct model selection, preset changes and a later routing rewrite therefore cannot bypass it or trigger an unauthorized provider preflight. Calls that are not attached to a Candy run pass through because Candy has no tenant authority to apply to them.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema, exact-pair comparison and terminal refusal |
| [`tests/policy.spec.ts`](tests/policy.spec.ts) | Pins allowed, denied, closed-default, unmanaged and cross-tenant behavior |

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Allowlists are deployment configuration, not durable records with an admin API.
- This package authorizes a requested route; it does not select a fallback. A safe cross-provider fallback also needs authority over the second provider account and a distinguishable usable route.
- Route refusals are returned to the caller but are not yet written to Candy's durable audit trail.

-----

<a id="dev-note"></a>
### Dev Note

See [The route at the last door](../../../.agents/notes/implemented/architecture/2026-09-07-the-route-at-the-last-door.md) for why this is a Candy policy plugin at `llm/stream`, rather than a tenant feature added to the generic Harness model registry.
