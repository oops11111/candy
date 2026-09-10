# Agent Note: Nobody chooses a route

Status: proposed

English | [中文](2026-09-10-nobody-chooses-a-route.zh.md)

## Problem

R3's remaining item is capability matching and account-authorized fallback, gated on at least two genuinely interchangeable agent routes existing. That gate is satisfied now, and the item is still blocked — by something else.

Two routes are interchangeable. `dsh-llm-pi-ai` is a multi-provider adapter whose hand-declared routes need no code change, so a deployment can stand up an OpenAI-compatible route beside `dsh-llm-deepseek` from configuration alone. Both were pointed at one `dsh-llm-mock-server` and handed the same conversation carrying the same tool schema; both accepted it and both streamed to a terminal finish. `dsh-llm-claude-cli` remains outside this set by its own README: it refuses conversation history and tool schemas, so it cannot serve the loop.

What does not exist is a place where a route is chosen.

A managed run's provider and account arrive already decided. `ExecutionAssertionClaims` carries exactly one `accountId` and one `provider`, both inside the signature, and `admitRun` reads them rather than selecting them. `RunScheduler.startChildRun` copies its parent's: a child names `account.provider` and `run.accountId` and may name no other, which is the subset rule R3's budget and workspace work already established. Nothing in `packages/control-plane` consults `selectDefaultProviderAccount` or an account's `isDefault` flag at run time; the default exists for the management API to record and for a person to read.

Both route mechanisms that do exist are refuse-only. `dsh-tenant-route-policy` enforces an exact provider/model allowlist through `LlmRuntime.guard()`, and that seam is documented as monotonic: every guard may refuse and no guard can force-allow what another refused. `tool-subagent`'s `assertAllowedModelSelection` is the same shape one level up — it validates a route the model asked for against a list, and returns silently when no explicit choice was made.

So "fall back to the next authorized route" has nowhere to run. A guard cannot substitute a route; it can only deny. An allowlist cannot order candidates; it can only contain them. And the one value that determines the provider is signed into a token minted before any of this repository's code sees the request.

## Proposal

Decide who chooses, before building anything that chooses.

Three designs answer it, and they differ in what an assertion means rather than in how a matcher is written.

**The minting control plane chooses.** The component that issues assertions picks the account, so the signed token keeps naming exactly one. Capability matching and fallback become its problem, and this repository gains nothing but a reason to leave the seam alone. It is the smallest change and it moves the feature out of the runtime entirely, which is wrong if a fallback has to react to a failure the runtime is the first to see — a credential that fails at dispatch, a route that turns out to lack a capability.

**The assertion names a set.** `accountId` becomes the accounts this run may draw on, ordered, and admission selects the first whose account is usable and whose model serves the request's capabilities. The subset rule still holds: a child may name a subset of its parent's set. This puts fallback where failures are observed and keeps the decision inside the signature, so a caller still cannot widen it. It changes the assertion format, every consumer of `claims.accountId`, and the audit records that name one account per run.

**The Harness offers candidates.** `dsh-llm` or `tool-subagent` grows an extension point that asks registered policies for an ordered candidate list rather than a yes or no, and Candy answers it from the tenant's accounts and allowlist. This is the only design where capability matching can use what the registry already knows — `resolveModel` answers context window, default max tokens and reasoning efforts per exact model — without Candy duplicating a model catalog. It is also a change to a documented Harness extension point, which `docs/architecture.md` governs, and it leaves the provider on the assertion inconsistent with the route actually used unless admission is taught about the set as well.

Whichever is chosen, capability matching should match only on what the registry can answer today: an exact model's context window, its default max tokens, and its reasoning efforts. Tool support and input modalities are not in `LlmResolvedModelInfo`, so matching on them means first adding them there, which is a second decision and not this one.

## Alternatives considered

**Build the matcher and the fallback now, against the refuse-only guard.** Rejected because the guard cannot do it. `LlmRuntime.guard()` is documented as monotonic — no guard can force-allow what another refused — so a guard that wanted to substitute a route would have to deny the request and hope something else retried with a different one. Nothing retries.

**Treat the account's `isDefault` flag as the selection rule.** Rejected: it already means something else. A default is what the management API records so a person sees which account a provider prefers, and `selectDefaultProviderAccount` keeps exactly one per tenant and provider. Reading it as a run-time route choice would make a tenant's display preference silently authoritative over a signed claim.

**Leave the assertion singular and fall back by minting a second assertion.** Rejected on replay grounds. An assertion's nonce is single-use and spent at admission, so a fallback would need a fresh token per attempt, which means the runtime mints its own assertions — the control plane's authority, and the one thing the audience binding exists to prevent.

**Infer tool support from the provider id.** Rejected as the guess this repository has twice avoided. The Claude CLI work found three behaviors that contradicted the reasonable assumption, and the Codex recording found usage where nobody would have looked. A capability the registry does not state is a capability to add to the registry, not to predict.

**Record nothing and revisit when a deployment asks.** Rejected because the gate the plan states — two interchangeable routes — is now satisfied, so the next reader would conclude the item is ready and discover this the hard way.

## Acceptance criteria

- One of the three designs is recorded as decided, with the assertion-format consequence stated if the second is chosen.
- Capability matching refuses a route whose exact model cannot serve a stated requirement, using `LlmRuntime.resolveModel` rather than a catalog of Candy's own, and the refusal names the requirement and the route.
- Account-authorized fallback skips a route whose tenant account is absent or revoked and proceeds to the next authorized one, with the skip recorded against the tenant.
- A delegated child's candidate set is a subset of its parent's, proven by a case where the child names a route the parent could not.
- A real composition drives two interchangeable routes: the first unusable, the second serving the request, with the tenant's audit trail naming both.
- Nothing force-allows what `LlmRuntime.guard()` refused; the guard remains the last door.

## Risks

**Building the matcher first.** A capability matcher with no caller is an abstraction with no owner, which this repository's package rules refuse. It would also fix a capability vocabulary before knowing which design consumes it.

**Matching on capabilities the registry does not carry.** Tool support is the capability a router most wants and the one `LlmResolvedModelInfo` does not state. Inferring it from a provider id would be the guess the Claude CLI and Codex work both avoided.

**Fallback hiding a misconfiguration.** A route that silently falls back on every request looks healthy while the tenant's primary account has been broken for a month. Every skip needs to reach the audit trail, which is also what makes the feature testable.

**Fallback crossing a tenant boundary.** The candidate set must come from the verified claims and the tenant's own records, never from a request field. This is the confused-deputy rule the assertion format exists to hold, and a set-valued claim is a larger surface for getting it wrong than a single id.

**Changing what a signed token means.** The second design rewrites the one field every downstream consumer trusts to be singular — the pool key, the credential lookup, the audit record, the child subset check. A migration that leaves any of them reading the first element silently reintroduces single-account behavior under a set-shaped name.
