# Agent Note: The provider that said nothing

Status: implemented

English | [中文](2026-09-05-the-provider-that-said-nothing.zh.md)

## Problem

A run's wall time was checked between chunks: after each one was yielded, the meter compared the clock to the deadline. A provider that accepts a request and then goes quiet yields no chunk, so there was nothing to check against.

A probe metered a silent source against a run allowed 50 milliseconds:

`{"raced":"still-waiting-after-1s","wallMsAllowed":50}`

Twenty times its allowance, and still counting. The wall dimension bounded the talkative failure and left the silent one to the lease sweep, minutes later — while the run held its parent's allowance and the tenant's the whole time.

## Decision

Each read races the time the run has left. The meter owns the source's iterator rather than looping with `for await`, so a read that never answers still ends on the same dimension as one that answers too slowly.

The clock is read before each race as well. A caller's clock already past the deadline gets no timer, because `setTimeout` treats a non-positive delay as one tick — which would read one more chunk from a source whose time is gone. That check also replaces the old between-chunks test, so one deadline is enforced in one place instead of two.

Owning the iterator means owning the close, and the two rules in [defensive patterns](../../../../docs/defensive-patterns.md) decide how. Quiescence is awaited from a source that is still answering. On the deadline path it is not: that path exists because the provider stopped answering, and a source blocked on the same silence would not answer a close either — awaiting it would hang exactly the call the deadline just bounded. The close is still started, so a source holding a provider process hears it, and its rejection is swallowed rather than left unhandled.

## Consequences

A silent provider now ends its call on the run's own wall time rather than on the lease.

The negative control — reading without racing the clock — fails exactly the four new tests, and fails them by hanging for the full test timeout, which is the defect stated as a duration.

Reaping the provider's process still belongs to whoever launched it. This package ends a stream; it does not run a provider, and the close it starts is a request rather than a kill.

## Alternatives considered

**Leave it to the lease.** The lease is minutes and exists to release an abandoned run's hold, not to bound one call. A run whose provider stalls on every call would spend its whole wall allowance without a single call ever being cut.

**A separate idle timeout.** A second dimension would need a value nothing has evidence for, and would let a call outlive the wall time the run actually had. The run already carries the only number that matters.

**Await the close on every path.** It is what quiescence asks for, and it hangs on the one path where the source has already proved it does not answer. Splitting by whether the source is still answering keeps the guarantee where it can be kept.
