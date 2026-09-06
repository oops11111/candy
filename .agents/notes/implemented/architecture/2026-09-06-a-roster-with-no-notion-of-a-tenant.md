# Agent Note: A roster with no notion of a tenant

Status: implemented

English | [中文](2026-09-06-a-roster-with-no-notion-of-a-tenant.zh.md)

## Problem

R3 of the multi-tenant runtime plan named one item as genuinely Candy's to add: "restricting a tenant to a subset of an otherwise-shared preset roster or route allowlist." `dsh-agent-presets` already lists every composed preset, mounts one per session, and lets a session switch to another while blank — but it is a general-purpose Harness package with no notion of a tenant, and none of its current consumers needed one. Adding a tenant check directly into the roster would violate the package-boundary rule this monorepo already enforces elsewhere ("Design Service Definitions for all current Consumers... do not let one Consumer dictate the service contract"): Candy is one deployment of a package other compositions also load, and teaching it Candy's own vocabulary would make every non-Candy consumer carry a concept it does not need.

The check also had to be genuinely unbypassable. A session's preset is resolved in exactly two places inside `dsh-agent-presets` — `mount()` (first composition, from the agent factory's `setup` hook) and `recompose()` (a later switch, valid only while the session is blank) — and a restriction enforced only from Candy's own outer session-creation wrapper would miss the second path entirely, since a session can call `select()`/`recompose()` independently of whatever wrapper created it.

## Decision

`dsh-agent-presets` gained one generic extension point: `AgentPresets.guard(guard: AgentPresetGuard)`. A guard is `(agentCtx: Context, id: string) => string | undefined` — a synchronous check consulted inside `resolveMountable`, the one private function both `mount()` and `recompose()` call before composing or re-linking. A returned string refuses the preset with that reason as `agent-preset/refused`; `undefined` defers to the next guard, and no guard can force-allow a preset another guard refused — the same monotonic contract `dsh-tools`' `ToolRuntime.guard()` already established for tool dispatch, reusing `dsh-scope`'s `AnonymousEntries` for the same idempotent-disposer registry both packages need. `standingKeyFor()`'s cold, agent-free transcript read is deliberately not guarded: it starts no agent and no session, so there is nothing for a guard keyed on `agentCtx.agent` to judge.

The guard's only identity hook is `agentCtx.agent` — the `Agent` association `dsh-agent` installs on its own constructed context, present on both call sites since `mount()` and `recompose()` are always invoked with an Agent's own `ctx`. That is enough for `RunScheduler.tenantOf(sessionId)`, a new public method resolving `agentCtx.agent.id` to its tenant, reusing the same in-memory run index `findSessionRun` already reads for metering. It is synchronous where `runIdentityFor` is not, because a guard has no `await` to spend and reads nothing a credential vault would need to unlock — it answers from `RunLedger`/`ControlPlaneStore` state already resident in memory.

`dsh-tenant-preset-policy` is the new Candy-owned package that composes the two: a function plugin (`name`/`inject`/`Config`/`apply`, no service, no default export) whose `Config.allowlists` maps a tenant id to the preset ids it may use, registering one guard that resolves the tenant through `RunScheduler.tenantOf` and checks the preset id against that tenant's entry. A tenant absent from the map, and a session `tenantOf` cannot resolve to one tenant (no open run, an ambiguous claim, an unusable account), are both unrestricted — the same "not this runtime's to charge" default `RunScheduler.meterRequest` already applies to a session no Candy run drives.

## Consequences

A Candy deployment composing `dsh-agent-presets` + `dsh-run-scheduler` + `dsh-tenant-preset-policy` can now name, per tenant, a subset of an otherwise-shared preset roster. Any other deployment of `dsh-agent-presets` — one with no tenant concept at all — is unaffected: the roster's own tests and behavior are unchanged, since the guard registry is empty until something registers into it.

Real-composition tests in both packages prove the enforcement: `dsh-agent-presets`' own suite proves a guard refuses `mount()` and `recompose()`, sees the constructing agent's own identity, is monotonic across several registrations, and is never consulted by the cold-read path; `dsh-tenant-preset-policy`'s suite boots a real scheduler (real admitted runs, a real SQLite-backed control-plane store) alongside a real preset roster (the same fixtures `dsh-agent-presets`' own tests use) and proves a restricted tenant is refused by name, an allowed preset still mounts, an unlisted tenant is unrestricted, a session with no open run is unrestricted, and a preset switch is gated exactly as the first mount is.

## Alternatives considered

**A waterfall event (`agent-preset/resolving`) instead of a guard method.** Rejected: a waterfall's around-middleware shape (`next()` to delegate, return to short-circuit) fits a value being progressively built, not a single yes/no decision with no data to accumulate. `dsh-tools`' own `guard()` already established the simpler, precedented shape for exactly this decision kind in the same monorepo, and reusing it means one shared registry primitive (`AnonymousEntries`) rather than a second dispatch mode to document and gate.

**Check the tenant restriction only from Candy's outer session-creation wrapper.** Rejected outright: `select()`/`recompose()` is a second, independent resolution path a session can reach without going through whatever wrapper created it — an outer-only check would be bypassable by construction, which the package conventions call out explicitly ("Enforce a decision in the operation that makes it... test denial through the executor").

**Store the allowlist in `dsh-control-plane-store` as durable per-tenant state, matching `dsh-tenant-allowance`'s own grant.** Considered, since the tenant's allowance is stored data, not static config. Rejected for this slice: the closest existing precedent for a route/model restriction — `dsh-subagent`'s `ModelSelectionPolicy` — is itself resolved from Settings/config, not a mutable ledger, and a durable store would need new schema, a SQLite migration, and a much larger surface for a restriction that changes at deployment-configuration cadence, not at request cadence. Static plugin `Config` is the documented, narrower choice; moving it to durable storage is deferred to whenever an operator actually needs to change it without a restart.
