# Agent Note: The tool decision a tenant can audit

Status: implemented

English | [中文](2026-09-09-the-tool-decision-a-tenant-can-audit.zh.md)

## Problem

Candy's tenant trail recorded admission, delegation, model routing, provider-process launch, usage, and settlement, but not the final authorization decision for a tool call. Harness already owned the permission waterfall, approval resolution, monotonic guards, dispatch, and results. Observing only `tools/pre-execute` would miss later approval and guard decisions, while observing only `tools/result` could not distinguish authorization denial from an execution failure.

## Decision

The Harness tool registry now publishes scoped `tools/authorization` after approval resolution and every monotonic guard, immediately before it returns either a denied result or an allowed dispatch. The event carries the existing execution identity and the final allow/deny decision. It is an awaited, observe-only notification: listener failures are logged and contained, and no listener can change the decision or execute the tool. With no observers, publication returns synchronously so the existing cancellation and dispatch schedule gains no promise turn.

`RunScheduler` consumes that generic event only when the execution belongs to a session with one open Candy run. It writes `event: 'tool'`, the tool name as `action`, and `allowed` or `denied` as `outcome`, together with the existing run lineage, tenant, and account identity. It deliberately does not retain arguments, denial reasons, results, or calls that cannot be attributed to one managed run. The durable control-plane declaration advances to version 11.

## Consequences

An administrator can correlate a tenant's tool authorization decisions with the same run's routing, usage, and terminal state without Candy defining another tool registry, approval service, or executor. The audit write finishes before an allowed body begins or a denied result is returned, but an unavailable audit medium does not turn a tool call into a failure.

The tool registry tests pin final guard decisions, event ordering, and failure containment. The scheduler composition test pins tenant attribution and verifies that paths and denial reasons do not enter the serialized audit trail. A mutation that reverses allowed and denied outcomes makes that test fail.

## Alternatives considered

**Wrap `tools/pre-execute`.** Rejected because approval resolution and monotonic guards run after that waterfall returns, so the wrapper cannot observe the final decision.

**Infer authorization from `tools/result`.** Rejected because denied calls, invalid arguments, unknown tools, cancellation, body failures, and post-execute blocks all produce error results. Guessing from messages would make audit semantics depend on presentation text.

**Add a Candy tool gateway.** Rejected because Harness already owns tool identity, permission, approval, dispatch, and execution. Candy needs tenant attribution for the final decision, not a second enforcement pipeline.
