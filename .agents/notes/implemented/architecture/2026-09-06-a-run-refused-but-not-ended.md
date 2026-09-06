# Agent Note: A run refused but not ended

Status: implemented

English | [中文](2026-09-06-a-run-refused-but-not-ended.zh.md)

## Problem

Revoking a provider account already stopped a live run from spending: every call it makes is refused with `CREDENTIAL_REVOKED` before the provider is reached.

It did not stop the run. A probe revoked a live run's account, charged it forty tokens first, and swept well before its lease:

`{"settled":0,"stillOpen":true,"consumed":0}`

The run stayed open for the rest of its lease — minutes — holding its funder's allowance, and the forty tokens it had already spent stayed unbilled for that whole time. Refusing every call it could make and then leaving it in place is a run that exists only to be refused.

This was recorded as needing revocation to reach the runtime as an event. That was the wrong frame: the runtime already polls.

## Decision

The sweep ends it. A run whose account can no longer authorize it is settled there, alongside the runs whose leases have run out.

The sweep is already where this runtime ends runs it has decided should end, and it runs on its own interval, so nothing has to reach it — the closure is eventual rather than immediate, bounded by `sweepMs` rather than by the lease.

The judgement is the one `meterRequest` makes: the account record is missing, revoked, or deleted. Sharing it is the point — a run whose every call is refused should not also be a run that lingers.

It is made on positive evidence only. A run whose record the store cannot answer for is left to its lease, because ending runs on a read that returned nothing is a larger mistake than ending them late.

## Consequences

A revoked account releases its runs' holds within a sweep instead of a lease, and their tenants are billed what those runs actually spent at that point rather than minutes later.

The negative control fails exactly the test that revokes an account, and leaves passing the two that pin what must not change: a usable account under a live lease is left alone, and so is a run the store cannot answer for.

Terminating the provider process those runs left behind is still not here. Settling a run closes its accounting; the process was launched by a caller this package does not have, and reaching it needs a place to register a disposer against a run's lifetime, which needs a producer that registers one.

## Alternatives considered

**Deliver revocation as an event.** Immediate instead of eventual, and it needs a seam that carries the revocation from whoever performed it — including from another process, which is where a control-plane API would perform it. The sweep needs none of that and closes most of the gap.

**Terminate on revocation without settling.** It stops the process sooner and leaves the accounting open, so the tenant is billed at the lease anyway. Settling is what releases the hold.

**Check at charge time instead.** A run that has stopped calling is exactly the one that lingers, so the check has to run on a clock rather than on the run's own activity.
