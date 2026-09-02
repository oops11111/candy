# Agent Note: Candy control-plane identifiers

Status: implemented

English | [中文](2026-09-02-candy-control-plane-identifiers.zh.md)

## Problem

The [proposed multi-tenant CLI agent runtime](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) names `userId`, `deviceId`, `accountId`, `workspaceGrantId`, `conversationId`, `sessionId`, and child-run ancestry as the values the Candy control plane is the sole authority for — a fact [Candy Runtime Boundaries](../../../../docs/candy-runtime-boundaries.md) then accepted as part of R0. Nothing in the repository named these as types: every future control-plane package (the tenant/credential model, the provider adapters, the orchestration authorization check, the Web account APIs, and the Windows Harness Host device binding) would otherwise invent its own `string`-typed tenant id, or copy one from whichever package happened to need it first.

## Decision

`@deepseek-ai/dsh-control-plane` (`packages/control-plane/control-plane`) brands `UserId`, `DeviceId`, `ProviderAccountId`, `WorkspaceGrantId`, and `ConversationId` on `@deepseek-ai/dsh-brand`, following the same-named-constructor pattern `dsh-session`'s `SessionId` and `dsh-workspace`'s `WorkspaceId` already use. `SessionId` is not redefined: it already exists in `dsh-session` and names the Harness session log, which the control plane partitions by tenant rather than owning outright. `ConversationId` is kept distinct from `SessionId` because one control-plane conversation can own more than one Harness session over its lifetime (fork, resume).

`RunLineage` (`{ runId: RunId, parentRunId: RunId | undefined }`) names run ancestry. There is no separate `ChildRunId`: the boundary page calls this authority "child-run ancestry," not a second id space, and nothing distinguishes a child run's identity from a root run's except `parentRunId`. `RunLineage` records the chain only — it does not perform the parent-subset grant check (account, workspace, tool, token, time, concurrency) that admits a child run, because that check needs the grant model R1's later bullets and R3's orchestration work have not built yet.

None of the six constructors validate their input. No control-plane service exists yet to define a grammar they could check, and inventing one now would be an unfounded guess the eventual issuer would likely have to change. The package has no Cordis service and no storage; it is imported directly, like `dsh-brand`.

The new `control-plane/` package group carries a `GROUPS_WITHOUT_SUBSYSTEM_PAGE` exemption (`scripts/verify-subsystem-pages.ts`) instead of a `docs/subsystems/` page: there is no running mechanism yet to document as a subsystem, and `docs/candy-runtime-boundaries.md` already owns the accepted architecture. The package README carries a real `## Known Limitations and Deferred Work` section — no validation grammar, no credential/grant/account storage, no runtime-pool-key helper (`userId + provider + accountId` needs a `provider` representation R2 has not defined), no Cordis service — and omits `## Model Experience` through the audited allowlist in `scripts/verify-package-readme-model-experience.ts`, matching `dsh-brand`'s precedent for a pure, model-agnostic id-branding package.

## Alternatives considered

**Let each future control-plane package brand its own tenant id where it first needs one.** This is the pattern `dsh-brand`'s own README recommends for ids that stay local to one package. It fails here because `userId`, `deviceId`, and `accountId` are cross-cutting from the start — R1's credential vault, R2's provider adapters (keyed by `userId + provider + accountId`), R3's orchestration, R4's Web account APIs, and R5's Windows device binding all reference the same entities. Letting five packages independently brand `UserId` would silently fragment one concept into five incompatible types.

**Add a separate `ChildRunId` brand alongside `RunId`.** Rejected because nothing about a child run's identity differs from a root run's except its ancestry link; a second brand would duplicate `RunId` without adding a real constraint, and every consumer would need to convert between the two brands for no benefit.

**Model the full grant-inheritance record in `RunLineage` now** (account, workspace, tool, token, time, concurrency). Deferred to R3, which owns the parent-subset authorization design ("Multi-agent orchestration" in the proposed plan). Adding partial grant fields today, before that design exists, would either omit fields R3 turns out to need or invent placeholder ones it would have to change.

**Write a `docs/subsystems/control-plane.md` page now.** Rejected for the same reason as the grant record: there is no running mechanism yet, and a subsystem page describing types with no service behind them would misrepresent the boundary page's already-accepted content as something new.

## Consequences

Every later control-plane package can import `UserId`, `DeviceId`, `ProviderAccountId`, `WorkspaceGrantId`, `ConversationId`, `RunId`, and `RunLineage` from one place instead of inventing them, and TypeScript rejects passing one kind of id where another is expected. The package remains dependency-free (only `dsh-brand`) so nothing downstream pays for infrastructure it does not use yet. The cost is that this ships ahead of any consumer: `dsh-control-plane` compiles and tests green but nothing imports it until a later R1 bullet (the tenant/credential model) or R2 (provider adapters) lands. The `GROUPS_WITHOUT_SUBSYSTEM_PAGE` exemption and the id constructors' absent validation are both named as review triggers in the package README, so the next PR that adds real control-plane behavior is expected to either fill them in or extend the documented reasoning, not silently accumulate more ungrounded scaffolding.
