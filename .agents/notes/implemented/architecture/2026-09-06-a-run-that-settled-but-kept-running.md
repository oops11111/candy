# Agent Note: A run that settled but kept running

Status: implemented

English | [中文](2026-09-06-a-run-that-settled-but-kept-running.zh.md)

## Problem

`RunScheduler.settle` ends a run as accounting: it writes a charge to whoever funded it and forgets the record. A run ended for cause — a revoked account, an expired lease, a tree closed around it — has that decided deep inside the scheduler's sweep, which has no reach into whatever process the run's own call is still running. Every prior fix in this thread ended the run's *ledger* record; none of them reached the process. The gap was named twice in the plan note and left open both times: "terminating the provider process such a run left behind still waits on a place to register a disposer against a run's lifetime, and on a producer that registers one," and "closing that provider's process stays with whoever launched it."

Closing it properly is not a small change. `GenerateOptions` is deep-frozen before dispatch specifically so a metering listener cannot rewrite what an adapter receives, and the caller's own `AbortSignal` — the only cancellation an adapter obeys — is not something the scheduler holds a reference to trigger. Reaching a live process from settlement therefore cannot go through the `llm/stream` waterfall at all; it needs a channel the LLM seam's neutral vocabulary was never meant to carry.

## Decision

The channel is the process handle itself, reached at the moment it is created rather than through the frozen request. `RunScheduler.registerDisposer(runId, dispose)` holds one disposer per run and invokes it, then clears it, when `settle` closes that run or any descendant `RunLedger.settlementOf` reports closing with it — before the durable writes, since a process about to stop being billed for should stop running as soon as that is decided, not once the writes that follow succeed. `disposableSpawn(runId, spawn)` wraps a spawn function so a provider binding gets this by composing it around the `spawn` it already hands its adapter, with no other change: every handle it returns is registered on creation and unregistered once the handle's own `done` settles, so a process that exits on its own is never a stale registration `settle` mistakenly signals later.

This is opt-in and deliberately unwired to any provider today. No composition calls `disposableSpawn` yet — that composition is the R3 orchestration join this release has not built — so the fix is the reach, not yet the reaching. A disposer that throws is logged and swallowed: its failure is not a reason to leave the run's accounting stuck open, since the settlement it might have blocked has already been decided by the time it runs.

## Consequences

A future provider binding closes this by composing one call around the `spawn` function it already threads through to its adapter; nothing else about the binding, the adapter, or the LLM seam needs to change. At most one disposer is held per run rather than one per call, which is correct for a run that makes several sequential calls — only the live one still needs releasing, and a second registration correctly replaces rather than accumulates.

Six tests pin this at the scheduler level: a disposer runs on close, a child's disposer runs when its parent's tree closes around it, an unregistered disposer does not run, a second registration replaces rather than accumulates, a run settles despite a throwing disposer, and `disposableSpawn` both terminates a still-open handle on settlement and leaves an already-exited one alone.

## Alternatives considered

**Thread a scheduler-owned `AbortSignal` into `GenerateOptions`.** Rejected on the same grounds `dsh-run-scheduler`'s own README already states for not adding `runId` there: `dsh-llm` is the inherited, provider-neutral seam, and a Candy-owned kill switch in its request vocabulary would let one consumer dictate a contract every other consumer shares. Requests are also deep-frozen before dispatch precisely so a listener cannot rewrite them; making an exception for this one purpose undermines the reason the freeze exists.

**Reach the process by pid, from the `subprocess/launched` event this scheduler already listens to for attribution.** The event deliberately carries a pid and nothing else — "the payload names the executable and where it ran, never the arguments or the environment... a consumer that needs more knows more than this seam does" — and building a pid-keyed termination path back into `dsh-subprocess` would give any holder of that registry the means to reach into any tenant's process, which is the opposite of what the seam's own ignorance of tenant and run is protecting.

**Call the outer stream's `.return()` from the scheduler instead of registering a disposer.** The scheduler does not hold the outer stream's iterator across the whole call — `oneCallAtATime` does, inside its own closure — and even if it did, calling `.return()` concurrently with a pending `.next()` on the same async generator queues behind that pending step rather than pre-empting it, so it would not reliably interrupt a call blocked reading a process that is not writing.
