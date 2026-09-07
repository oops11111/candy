# Agent Note: A budget that only took notes

Status: implemented

English | [中文](2026-09-05-a-budget-that-only-took-notes.zh.md)

## Problem

Candy's budget machinery was complete at both ends and absent in the middle.

`admitRun` refuses a run whose allowance is gone, `reserveChild` subtracts a child's grant from its parent, and `RunLedger.charge` reports the dimensions a run has used in full. That last report was the enforcement point, and nothing read it. `charge` had exactly one caller in the repository: its own tests.

So a run admitted with a thousand tokens could stream a million. The ledger would have recorded it faithfully, the settlement would have charged the tenant for it, and no step between admission and settlement would have stopped it. The boundaries page asks that a child not exceed its parent's token, time, or cost grants; the grant was enforced at the gate and nowhere after it.

## Decision

`dsh-run-metering` wraps one provider stream for one open run, and `RunScheduler.meter` binds it to that runtime's ledger and its durable charge.

Three things end a call early, each as a terminal `error` finish rather than a thrown exception, because a consumer of the `dsh-llm` seam is promised exactly one terminal chunk and an exception is not one: the run is not open, the run has nothing left, or the call outran the wall time the run still had.

The refusal is read before the provider is reached, and that ordering is the point. A stream carries usage at most once and usually near its end, so an already-spent run would otherwise make the whole call and learn it could not afford it from the very chunk that spent the money. Reading the remainder first is what turns "an exhausted run is surprised" into "an exhausted run stops calling".

For the same reason the charge lands before the terminal chunk reaches the consumer: an agent loop asks for the next call the moment it sees a finish, and a charge applied after would let it make one call too many. The composition test pins that ordering by reading the ledger from inside the loop that consumes the finish.

A cut ends the call, not the run. The record stays open with what the call consumed, so whoever started the run decides whether to report the exhaustion, ask for more allowance, or settle. What the meter guarantees is that the work stops.

Money moves only where a provider reported a bill. `TokenUsage.costMicroUsd` is absent when the provider said nothing, and absent is not zero: deriving a figure from a price list here would be indistinguishable from a reported one and wrong wherever a deployment's contract is not list price.

## Consequences

The budget now stops work. An exhausted run's next call never reaches the provider, and a call that runs past its run's remaining wall time is cut with what it had consumed already charged.

`RunScheduler.meter` makes that durable: the charge reaches the run's record before the call's terminal chunk is delivered, so a restart between two calls loses nothing and the second call is measured against the first.

Three limits are exact and stated rather than implied. A provider that stalls without emitting anything is not cut, because wall time is checked as chunks arrive — `dsh-run-ledger`'s lease is what bounds an abandoned run, and this bounds a talkative one. A stream reports usage once, so an over-long single response is measured only when it ends. And two calls metered concurrently against one run both start against an allowance neither has charged yet, so a run whose calls overlap can overshoot by one call's worth per stream.

Nothing wires the meter into the agent loop yet. Doing that needs a run id on a model request, which is the same attribution the launch-audit record has been waiting for, and it is not this note's.

## Alternatives considered

**Refuse the charge in `RunLedger` instead.** It is where the overspend is first visible, and refusing there is exactly what that package argues against: a provider has already billed, and a ledger that declined to record the spend would report an allowance the run had already used. Reporting `exhausted` and having a caller act on it was always the design; this supplies the caller.

**Throw when a run cannot afford a call.** Shorter, and it breaks the seam's one-terminal-chunk guarantee that `dsh-llm/invariant` enforces around every provider stream. A consumer already handles a failed call; it does not already handle an exception from an async iterator mid-stream.

**Check wall time on a timer inside the meter.** It would cut a silent stream too. It also puts a clock and a disposal path into a module that has neither, and gives every test one to stop. The lease already covers a run nothing is driving.

**Charge per chunk rather than per call.** It would bound an over-long single response. With a durable charge behind it that is one medium write per delta, which is the wrong trade for a bound the wall-time cut already provides.
