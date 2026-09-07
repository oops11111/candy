# Agent Note: A line a failed close could hold

Status: implemented

English | [中文](2026-09-06-a-line-a-failed-close-could-hold.zh.md)

## Problem

The delivery plan asks that cancellation propagate through provider processes and that cleanup be verified, and the Candy-owned half of that is what a cancelled call does to the run it belonged to.

A probe cancelled a metered call mid-stream against a booted runtime. The result was correct in every dimension: the stream ended rather than hanging, the provider source was closed, the run was charged the 42 tokens the call had consumed before the caller gave up, the run stayed open, and the next call on it ran. That audit is now pinned rather than assumed.

What the probe did expose is one step further along. A run's calls wait in a line, and the place in it was given up after closing the abandoned call's source. Closing can fail: a cancelled call closes a source that is itself failing, and a provider whose teardown throws — reaping a process that will not die — rejects out of that close. The line was then never given up, and every later call on that run waited on it for the rest of the run's life.

## Decision

The line is given up in a `finally`. Closing is still awaited and its failure still reaches the caller; what changes is that the place is released either way.

## Consequences

A failed teardown costs the call it happened in, not the run.

The negative control — releasing after the close instead of in a `finally` — fails exactly the test that closes a failing source, and fails it by hanging for the full test timeout, which is the defect stated as a duration.

## Alternatives considered

**Swallow the close failure.** Releasing the line and reporting nothing would also fix the hang, and would hide a provider process that could not be reaped — which is the thing the boundaries page most wants an operator to hear about.

**Release before closing.** The next call would start while the previous one is still tearing down, so two provider processes for one run could overlap — the opposite of what the line is for.

## A note on the probes

Two apparent findings before this one were defects in the probe, not the product: an abort listener registered after the signal had already fired, and a fake adapter that hung on any call without a signal. Both looked exactly like a cancellation defect — a stream that never ends, and a run whose next call never starts. Each was found by instrumenting rather than by reasoning about the code: counting adapter invocations showed the third call had reached the provider, so nothing was waiting in the line. A probe is evidence about whatever it actually measures, which is not always what it was written to measure.
