# Agent Note: Cancellation keeps the inherited tool lifecycle

Status: implemented

English | [中文](2026-09-09-cancellation-keeps-the-inherited-tool-lifecycle.zh.md)

## Problem

Harness already propagated a caller's cancellation signal into a running tool, waited for a started body to quiesce, normalized the outcome to `ABORTED`, and then published one final `tools/result`. Candy added an awaited tool-authorization audit observer, but no real composition test proved that this observer preserved those lifecycle guarantees for a tenant-managed run. The R3 checklist therefore still described tools and event streams through a Candy run as unverified.

## Decision

Keep execution and event ownership in the inherited `dsh-tools` runtime. Add a Loader composition test to `dsh-run-scheduler` that opens a real Candy run, executes a scoped Harness tool for that run's session, cancels it after its body starts, and deliberately holds the body's cleanup open.

The test requires the original signal to reach the body, the execution promise and `tools/result` event to remain pending while cleanup is held, the final result to carry `ABORTED`, exactly one terminal result event to match it, and Candy to retain exactly one allowed authorization audit for the managed run. It tests the tool event flow Candy actually observes; Remote Gateway/WebSocket transport remains inherited DSH work and its tenant-bound deployment belongs to R5.

## Consequences

R3 cancellation now has composition evidence for delegated children, provider processes and streams, metered cancellation, tools, and the final event emitted for a tool execution. Candy gains no tool runner, cancellation controller, event bus, or remote stream implementation.

A mutation that raced the tool body against cancellation returned before cleanup and made the new test fail at its pending-state assertion. Restoring the inherited wait made the test pass again.

## Alternatives considered

**Add a Candy tool wrapper.** Rejected because it would duplicate DSH execution and create a bypassable lifecycle layer.

**Treat the authorization audit as the terminal tool event.** Rejected because authorization precedes the body; it says whether execution may begin, not whether execution and cleanup have ended.

**Build Remote Gateway cancellation here.** Rejected because the remote transport is a DSH responsibility and Candy's tenant/device binding for it is R5 work.
