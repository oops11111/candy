# Agent Note: The adapter that could not be shared

Status: implemented

English | [中文](2026-09-06-the-adapter-that-could-not-be-shared.zh.md)

## Problem

`dsh-llm-claude-cli` registers a `ClaudeCliAdapter` whose isolation — a home directory and an API key — is fixed on the instance at composition time. That is correct for the package's own stated contract: "a multi-tenant runtime does not load this plugin once and vary identity per request — it constructs one adapter per runtime pool." Nothing in the harness constructed those per-pool adapters. A multi-tenant runtime that wanted this route had no composition to reach for: registering the shared adapter once would authenticate every tenant's calls with whichever credential happened to be configured, and no mechanism existed to construct, register, and dispose an adapter per admitted run.

This was flagged and deliberately left open twice this session — as a question returned to the user rather than decided alone, since it touches how a request gets routed to a tenant-scoped provider instance, a decision the LLM seam's own neutrality rules make consequential. The user's direction: solve it.

## Decision

`dsh-claude-cli-route` mounts one `SessionRoutedClaudeCliAdapter` under the fixed route name `claude-cli`, and resolves identity per call instead of per instance. Every `stream()` call reads `options.sessionId`, asks `RunScheduler.runIdentityFor` which run drives it, and constructs a fresh `ClaudeCliAdapter` for that one call from the answer. Nothing is retained between calls, including two calls of the same run: the credential is read fresh from the vault every time, which is the same property `meterRequest`'s own account check already has, and for the same reason — a revocation between two calls must stop the second, not merely the next metered chunk.

`RunScheduler.runIdentityFor(sessionId)` is the new surface this composition needed and none of the pieces alone could answer: it resolves the session to its one open, usable run (the same check `meterRequest` makes, extracted into `findSessionRun` and shared rather than duplicated), reads the account's own provider and opens its credential through the runtime's own keyring, and returns the pool root and remaining budget beside it. `dsh-claude-cli-binding` gained `bindClaudeCliCredential`, the two fields `bindClaudeCliRun` actually used — a secret and a pool root — pulled out from behind the full `AdmittedRun` interface a later call has no way to reconstruct honestly.

Disposal closes the same loop this session's earlier work opened the reach for: the route composes `RunScheduler.disposableSpawn(runId, spawn)` around the `spawn` it hands `ClaudeCliAdapter`, so a process this route starts is registered against the run's lifetime the moment it exists. Ending the run for cause reaches it, proven against a real hanging process and a real settlement rather than a mocked handle.

## Consequences

A multi-tenant Candy runtime mounts `dsh-claude-cli-route` once. No composition constructs or disposes a `ClaudeCliAdapter` per pool by hand; every tenant a `dsh-run-scheduler` admits is served by the one mounted route.

Five tests in `session-routing.spec.ts` prove this against a real process: two tenants' calls (sequential, on the same run) land the right credential in a real child's environment, a revoked account refuses the next call, a request with no session is refused before anything resolves, and a hanging launch is reaped when the scheduler settles the run — confirmed by a negative control that removes the `disposableSpawn` wiring and times the same test out. Ten more tests in `refusals.spec.ts` pin every refusal branch against a fake `runIdentityFor`, since the real scheduler's own resolution is that package's to test.

## Alternatives considered

**Register a dynamic route per run, disposed when the run settles.** `ctx.llm.registerAdapter` already returns a disposer, so a per-run route name (`claude-cli/${runId}`) composed the same way is mechanically possible. Rejected because it pushes a routing decision onto whoever assembles `GenerateOptions.provider` — the session/preset composition would need to know a per-run name that does not exist until the run starts, which is exactly the kind of Candy-specific concept `dsh-run-scheduler`'s own README already declines to put on the LLM seam's request vocabulary. Resolving identity inside one fixed-name adapter, from the session already on every request, needed no new naming scheme at all.

**Cache the opened credential per run, refresh only on a vault miss.** Rejected on the same grounds `meterRequest` already settled: a cached credential cannot observe a revocation that happens after it is cached, and the cost of a vault open — one AES-GCM decrypt over a config lookup — is not a cost this route's own limitations section has measured as worth avoiding without evidence.

**Extend `dsh-run-scheduler` no further and put credential/pool resolution in the new package instead.** Considered and rejected: it would need its own copy of the runtime's credential key configuration to open a vault envelope, duplicating a secret two plugins would each read independently. Routing the resolution through the scheduler, which already assembles the identical recipe once at a run's admission, means one configured key, read once, used both ways.
