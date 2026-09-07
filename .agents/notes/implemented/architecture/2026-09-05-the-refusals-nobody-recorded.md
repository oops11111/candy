# Agent Note: The refusals nobody recorded

Status: implemented

English | [中文](2026-09-05-the-refusals-nobody-recorded.zh.md)

## Problem

The delivery plan asks that operators be able to detect and audit quota violations and cross-tenant attempts. Admission files a record for every scheduling attempt, and a probe read a tenant's trail after a live run's account was revoked and the next call refused:

`{"before":2,"after":2,"events":["credential/open/ok","started/start/ok"]}`

The credential open and the start, and nothing about the refusal. Admission never sees these: a run opens its credential once and then keeps calling, so everything decided per call — a revoked account still spending, a run that has used up its allowance, a session no open run claims — happened where no record was written. The clearest signal of the three is a credential that was revoked being used again, and it was the least visible.

## Decision

Every call this runtime refuses is filed, under `event: 'refused'` and `action: 'meter'`, with the failure code as its outcome.

The refusals the scheduler makes are filed where it makes them. The ones inside `dsh-run-metering` are reported through a new optional `refused` port, beside the `now` port that is optional for the same reason: a caller metering by hand passes neither and loses neither anything it had.

The record is durable before the caller is told. The port is awaited, and the scheduler's own refusals await their write before yielding the chunk, so an operator reading the trail is never behind a consumer already acting on the refusal.

The port's implementation settles its own failures and never rejects. A rejection would leave the stream without the one terminal chunk the seam promises, which is worse than an unrecorded refusal — a test asserts the caller still gets its terminal chunk when the store cannot take the record.

A refusal whose session names no run this runtime still holds is filed against the runtime, for the same reason an unverifiable assertion is: there is no tenant this runtime may believe.

## Consequences

`auditsOfTenant` now answers what a tenant's runs were stopped from doing, not only what they were allowed to start.

The negative control — dropping both filing paths — fails exactly the three tests that assert the records, and none of the tests that assert the refusals themselves.

The trail is still a window: what falls past `auditRetention` is gone, and a run refused repeatedly can push its own earlier records out. Nothing rate-limits a caller that retries into the trail.

## Alternatives considered

**File the record without awaiting it.** This is what the first implementation did, and the probe against it still read a trail two records long — the caller saw the refusal first. For a signal whose whole purpose is to be read by someone reacting, being behind the reaction is the wrong order.

**Have `dsh-run-metering` write the trail itself.** It would need the store, the subject rules and the retention, none of which a package that meters one stream should own. The port hands the fact to whoever already has them.

**Record refusals as a new event kind.** `refused` already existed in the stored enum for admission's own refusals, and a call refused at the meter is the same thing one layer later — a separate kind would have split one question across two names and bumped the schema version for nothing.
