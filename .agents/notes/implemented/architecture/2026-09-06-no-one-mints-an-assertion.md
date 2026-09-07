# Agent Note: No one mints an assertion

Status: implemented

English | [中文](2026-09-06-no-one-mints-an-assertion.zh.md)

## Problem

A subagent delegated in-process gets a fresh `SessionId` and a fresh Agent, and its LLM calls carry that new session id, not its parent's. Under a Candy deployment using `dsh-claude-cli-route`, `RunScheduler.runIdentityFor` resolves no run for that session and the route refuses the call outright with `RUN_NOT_OPEN` — a delegated child cannot call the model at all, not merely unmetered.

Fixing this by minting the child its own execution assertion ran into a fact that changed the shape of the fix: `mintExecutionAssertion` has exactly one call site in the entire repository, inside the package that declares it — every other reference is in test code minting a token by hand. Nothing in this codebase's production path has ever minted an assertion. The whole admission, ledger, metering and credential pipeline this session's work built is exercised end to end only by tests that construct a signed token directly; no real entry point — an authenticated HTTP request, a device-paired session start — produces one. The architecture diagram in the plan note's own proposal names this authority (`AUTH`, `DEVICE`, `GATEWAY` boxes feeding a control plane that "exchanges a short-lived, audience-bound execution assertion for each run"), but no task in the delivery table builds it, and neither R4 ("Harness Web and account configuration") nor R5 ("Tenant binding for Windows Harness Hosts") covers minting one — R4 is provider-account configuration UI for an already-signed-in user, and R5 is a later Windows-specific host-registration step.

A subagent child's assertion needs `workspaceGrantId`, `deviceId` and `conversationId` — none of which `DurableRunRecord` retained, because nothing before this needed them once a run opened.

## Decision

Scoped narrower than "build the full authentication and device-pairing gateway," which is a security-critical, multi-package effort this note does not attempt. What this delivers is the one piece a real production caller needs today: **a delegated child needs no new authentication, because it asserts no new identity** — it is exactly its parent's, already verified once. Minting its assertion is a restatement of authority already held, not a grant of new authority, so it needs no external issuing authority to exist first.

`DurableRunRecord` gained `deviceId`, `workspaceGrantId` and `conversationId`, threaded through `RunScheduler.admitAndOpen`'s `openRun` call from the admitted claims. `RunScheduler.startChildRun(parentSessionId, childSessionId, share, now?)` resolves the parent session's open run through the same `findSessionRun` every other identity-resolution method already shares, copies its tenant, account, provider, device, workspace grant and conversation, mints a fresh assertion naming the child session and the parent's run as `parentRunId`, and drives it through the exact same `start()` a caller-supplied token would — reusing the parent-subset budget and concurrency accounting `dsh-run-budget` already enforces for any assertion naming a `parentRunId`, unchanged. `share` is required, not defaulted: how much of a parent's remaining budget a delegated child should receive is a policy choice this service has no basis to guess.

The minted token is never transmitted or persisted; it exists for the single, synchronous purpose of driving `start()`'s existing admission path, so a minted child run is funded, ledgered and audited exactly as a root run is — no second code path to keep in sync with the first.

This is the RunScheduler capability alone, built and tested in isolation, mirroring how `runIdentityFor` and `disposableSpawn` were built before `dsh-claude-cli-route` consumed them. Wiring an actual subagent driver to call it is deliberately not part of this change: `dsh-subagent` is a general-purpose Harness package with no notion of Candy, and giving it one needs the same kind of Candy-agnostic extension point `dsh-agent-presets`' `guard()` gave the preset roster — a separate, follow-on design.

## Consequences

A Candy runtime can now open a real, ledgered, budgeted, audited child run for a session it did not itself admit from an external token — the first production (non-test) call site for `mintExecutionAssertion`. Seven new tests in `run-scheduler`'s suite prove it against a real store and ledger: a child run opens with a fresh `RunId` naming its parent, its session immediately resolves through `runIdentityFor`/`tenantOf` where it previously refused with `no-open-run`, the parent's remaining budget is subtracted by exactly the requested share, an unresolvable parent session is refused with the same ambiguity `runIdentityFor` already names, the child's own admission refusal (an exhausted share) surfaces unchanged, and two children opened this way meter independently — proving the reason a real child run was minted rather than the session aliased onto its parent's: `oneCallAtATime`'s per-run call line would otherwise have serialized every parallel delegation onto one line.

The general assertion-minting authority (real user authentication, device pairing, workspace-grant issuance) remains unbuilt. This note's fix does not need it and should not be read as having built it — a session that is not already a verified delegation from an open run still has no way to obtain its first assertion in production.

## Alternatives considered

**Alias the child's session onto the parent's run instead of minting a separate one.** Rejected: `RunScheduler.meterRequest`/`meter` serialize calls per `RunId` (`oneCallAtATime`), so two children sharing one run's id would have their calls forced onto one line regardless of how independent the work actually is — silently serializing exactly the parallel-subagent-delegation case `dsh-tools`' own parallel tool-call pool exists to support. A separate `RunId` per child, reusing the already-built parent-subset budget and concurrency machinery, was the only option that does not regress this.

**Build the full assertion-issuing authority (OAuth, device pairing, gateway) now, since it is what the plan's architecture diagram calls for.** Rejected as this note's scope: it is a distinct, security-critical, multi-package design the user's own framing separated from the narrower, already-justified subagent case — attempting it here would have meant guessing at OAuth flows and device-pairing semantics nothing in this repository has designed yet.

**Have the caller (a future `dsh-subagent` wiring) supply the child's full claims directly, keeping `RunScheduler` a pure verifier.** Rejected: reconstructing a parent's account, provider, device, workspace grant and conversation from outside `RunScheduler` would mean exposing durable run internals this service does not otherwise publish, and the assertion secret needed to mint any token is already private to this service — asking an external caller to hold or re-derive it would duplicate a secret two components would each need to read independently, the same reasoning `dsh-claude-cli-route` already rejected for credential resolution.
