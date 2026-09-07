# Agent Note: Two calls that read one remainder

Status: implemented

English | [中文](2026-09-05-two-calls-that-read-one-remainder.zh.md)

## Problem

A meter reads what a run may spend once, before the provider is called, and charges once the call ends. Two calls that overlap therefore both start against a remainder neither has been charged against yet.

A probe funded a run for exactly one call from the fake adapter and made two at once:

`{"first":"finish/stop","second":"finish/stop","spent":84,"allowed":42}`

Both finished, and the run spent twice what it was allowed. The dimensions bound the run, not the call, so they hold only if the calls do not observe the same remainder — the same read-then-act shape as the tenant remainder one layer up, at the layer the earlier fix did not reach.

Concurrency here is legitimate rather than a caller error: `dsh-compaction-basic` stamps the agent's own session on its summarization call, so a session's calls need not be one at a time.

## Decision

`RunScheduler.meter` holds a run's calls in a line. Each reads a remainder the one before it has already been charged against, and a call that cannot afford what is left is refused by the meter that already refuses an exhausted run.

The line is per run. Two tenants never wait for each other, and a run whose calls are sequential — an agent loop's are — never waits either, because the line is empty when its next call starts.

Serializing rather than refusing the second call is what keeps a legitimate concurrent caller working: compaction alongside a turn is ordered, not denied.

A consumer that abandons a stream part-way leaves the line as well, or every later call on that run would wait on a stream nobody is draining. The place in the line is taken when the stream is created and can be given up from that moment, because a consumer may close a stream it never read.

`meterRun` now declares the async generator it always was, so the wrapper can close it without asking whether it can be closed.

## Consequences

A run cannot spend more than it holds, however its caller schedules its calls.

This depends on a call ending. It landed after the wall-time bound ([the provider that said nothing](2026-09-05-the-provider-that-said-nothing.md)) for that reason: before it, one silent provider would have held its run's line for as long as it stayed silent, which is a hang where there used to be an overspend.

The negative control — metering without the line — fails exactly the concurrency test and none of the others.

## Alternatives considered

**Refuse a second concurrent call.** Simpler, and it names the overlap instead of hiding it. It also breaks compaction, which is a real caller that overlaps deliberately, so it would trade a billing defect for a functional one.

**Reserve a share of the remainder per call.** A call's cost is not known before it runs, so the share would be invented — and a wrong share either refuses affordable calls or admits unaffordable ones.

**Serialize on the scheduler's existing chain.** That chain orders whole operations across the runtime; putting streams on it would make one tenant's long call block every other tenant's start. The bound being kept here is a run's, so the line is a run's.
