# Agent Note: A lease that only counted down

Status: implemented

English | [中文](2026-09-06-a-lease-that-only-counted-down.zh.md)

## Problem

`RunLedger.renew` states the contract the lease is built on: "A run that is still working says so by pushing its lease out; a run that stops saying so is settled by `expire`. Nothing else moves a lease, so a lease that stops advancing is exactly a run nothing is driving."

Nothing ever called it. Across the whole repository `renew` had exactly two call sites, both in its own unit test, so no lease ever advanced — and the second half of that sentence inverted: a lease that stops advancing was every run, working or not. `RunScheduler.sweep` settles each run whose lease has passed, so every run ended `leaseMs` (300 000 ms by default) after it opened, however hard its agent was working. Its allowance was returned, its spend absorbed into its funder, and its session added to the `ended` memory — after which `meterRequest` refused every later call with `RUN_NOT_OPEN` and the message "the run driving it has ended". A five-minute session was cut off and stayed cut off.

The `ended` memory was built for exactly this case and kept the *accounting* honest — the README said so plainly: "a lease can expire under an agent that is still working ... without a memory of the ending its next call would look like one this runtime never had and run for free". That closed the hole where a cut-off agent runs for free, and left the agent cut off.

This is the third instance of one shape in this subsystem, after [the clock nobody wound](2026-09-04-the-clock-nobody-wound.md) (`expire` was a call nothing made) and [a budget that only took notes](2026-09-05-a-budget-that-only-took-notes.md) (`charge` reported what nothing read): a mechanism built complete, with the half that drives it never wired.

## Decision

The sweep renews instead of settling when this runtime still holds the run's session.

A lease answers one question — did the runtime holding this run go away — and a runtime that still has the session is answering it directly rather than waiting to be asked. `RunScheduler.driven(runId)` reads the run's durable record for its session id and asks the session store whether that session is live here; `RunScheduler.renew(runId, now)` pushes the lease out in the ledger and on the durable record through the new `ControlPlaneStore.renewRun`. Both run on the scheduler's own chain, like every other write to a run record.

The session store is read through `ctx.get('sessions')`, the documented opportunistic pattern: a composition without one leaves every run to its lease, exactly as before. The durable record moves with the ledger because the stored lease is what a later reader — this runtime after a restart, an operator, another runtime sharing the audience — uses to tell a driven run from an abandoned one; a renewal held only in memory would leave that reader a record that looks abandoned while the run works.

Order decides the two questions separately. A revoked account still ends its run however live its session is: `spent` is checked first, so this rule decides abandonment and never authority. Liveness is also not activity — a session parked between turns, waiting on a tool, an approval, or a person, is still this runtime's to fund, and loses its run only when the session itself goes.

Metering was the alternative renewal signal and is the narrower one: a run pulling a metered stream is certainly working, but a run running a ten-minute test between two model calls is working too, and renewing only on model calls would still cut it off. Session liveness covers model time, tool time and idle time with one rule in one place.

## Consequences

A run is no longer bounded by wall-clock life. An agent working for an hour keeps the run it started with; a session parked overnight keeps it too, and releases it when the session goes. The lease is now what its own documentation says it is: the crash fallback, load-bearing exactly when this runtime cannot answer for the session — after a restart, where the restored roots are closed on `Service.init` anyway, or where no session store is composed.

The cost is that an idle-but-live session holds its tenant's allowance and one concurrency slot for as long as it lives, where before it was released after five minutes. That is the honest reading of an open session, and the previous behavior only appeared cheaper because it was releasing allowances from runs that were still being used.

Three real-composition tests pin the rule against a real scheduler, a real SQLite-backed store and a real session store: a run whose session is live survives an elapsed lease with its lease pushed out in both the ledger and the store, and still meters its next call normally; a run whose session this runtime no longer drives still settles, with the session store composed and answering for a different session; and a revoked account still settles its run with the session live. Mutation checks confirm each: removing the liveness check fails the first, treating any composed store as liveness fails the second, and letting liveness win over revocation fails the third.

## Alternatives considered

**Renew on observed work — each metered pull, each charge, each `subprocess/launched`.** Rejected as the primary rule: it is the most literal reading of "a run that is still working says so", but it only covers work this scheduler happens to observe. A long tool call with no subprocess, a wait on user approval, and a continuable child between turns are all a live run doing nothing the scheduler sees, and each would still be cut off. It also spreads renewal across several call sites where session liveness needs one.

**Give the lease a much larger default and leave the mechanism alone.** Rejected: it moves the cliff instead of removing it, and picks a number that is either too short for a long session or too long to release an abandoned run promptly. The bug is that "abandoned" was never measured, not that it was measured with the wrong constant.

**Close a run promptly when its session ends, and drop the lease entirely.** Attractive — prompt closure is strictly better than waiting a lease out — but rejected for this slice as a separate change: the scheduler listens to no session or agent lifecycle event today, and the lease must survive anyway as the crash fallback for a runtime that stops without closing anything. Adding a `session/disposed` listener would tighten release latency on top of this rule rather than replace it.
