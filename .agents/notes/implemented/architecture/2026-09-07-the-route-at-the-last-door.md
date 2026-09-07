# Agent Note: The route at the last door

Status: implemented

English | [中文](2026-09-07-the-route-at-the-last-door.zh.md)

## Problem

DeepSeek Harness already discovered models, selected explicit provider/model pairs and carried a subagent `ModelSelectionPolicy`. Candy's preset guard also limited which composed agent a tenant could choose. None of those decisions authorized the final route for the tenant behind a real model call. A direct model override, another caller of `llm.stream`, or a future selection surface could therefore reach any shared adapter the process registered.

Putting tenant fields into the generic model registry would duplicate no feature, but would make a reusable Harness subsystem depend on Candy's run identity. Inferring permission from a preset would also confuse two different grants: an agent composition is not a provider account or model entitlement.

## Decision

`dsh-llm` now exposes a generic, monotonic `LlmRuntime.guard()` extension point. A session-aware `prepareCall()` runs guards before adapter preparation; final dispatch runs them again after `llm/stream` routing middleware has selected its provider/model pair. Any guard may refuse; none can force-allow a route another refused. The agent loop passes its session into preparation, so an unauthorized managed route cannot make even an adapter capability preflight.

`dsh-tenant-route-policy` is the Candy-owned consumer. For a request carrying a session, it resolves the tenant through `RunScheduler.tenantOf` and requires an exact, case-sensitive provider/model pair in that tenant's configured allowlist. A managed tenant missing from configuration is denied, as is an empty list. The refusal is a terminal stream error with `TENANT_ROUTE_NOT_ALLOWED`, produced before adapter selection.

A request without a session, or one whose session has no uniquely resolvable Candy run, passes through. That preserves the existing boundary: Candy may constrain work it admitted, but does not claim authority over unrelated Harness calls.

## Consequences

Every in-process model-call path shares the same tenant route decision, including direct selection and future preset or UI changes. One tenant cannot inherit another's route. The generic Harness registry, discovery UI and adapters remain unchanged. Only the generic final-guard seam is added to Harness; it carries no tenant concept.

The configuration is deliberately closed for managed tenants, so enabling the plugin requires an entry for every tenant that should run. A denial awaits `RunScheduler.recordRouteRefusal()` before it is returned, leaving a tenant-scoped `refused` record with `action: 'route'` and the policy code as outcome. Configuration remains deployment state rather than control-plane state.

This decision does not manufacture fallback. A useful fallback must have a second route that can serve the request and, across providers, authority to use a second provider account. The current change supplies the whitelist half of routing policy; selection and account-authorized fallback remain separate work.

## Alternatives considered

**Extend the Harness model registry with tenants.** Rejected because discovery and adapter ownership are already generic and a Candy run is not part of their contract.

**Derive route permission from the selected preset.** Rejected because callers can reach `llm.stream` without a preset and because a preset grant does not authorize a provider credential.

**Guard only the agent request builder.** Rejected because direct LLM consumers and later routing middleware could bypass an earlier construction-time check.

**Automatically fall back to any allowed route.** Deferred because an allowed name alone does not prove capability or authority over a second provider account.
