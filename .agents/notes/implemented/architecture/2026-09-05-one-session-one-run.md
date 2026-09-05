# Agent Note: One session, one run

Status: implemented

English | [中文](2026-09-05-one-session-one-run.zh.md)

## Problem

Metering finds a run by the session a model request was assembled for. Nothing made that mapping unique.

Two runs could open on one session — `admitRun` never looked — and only the metering lookup noticed, one call at a time, long after the conflict was created. A probe against the booted runtime confirmed it: two tenants' runs both started on `session-1`, both held their allowances, and the first model request in that session came back refused.

The reachability is bounded — a session id is inside the assertion's signature, so a tenant cannot claim another's session without the control plane minting it — but the shape of the failure is the wrong way round. A tenant minted onto another tenant's session stops that tenant's work rather than being stopped itself, and the runtime that could have said so said nothing.

## Decision

`admitRun` gains a `findSessionRun` port and refuses the second run at the `session` stage, naming the run that already holds it.

The check sits after the budget and before the nonce. Both refusals are ones a caller can fix and retry — top up, or wait for the session's run to settle, then present the same still-valid assertion — so neither may burn a single-use token on a conflict the caller did not cause.

A child run is not exempt. It needs a session of its own for the same reason its parent does, which makes one-session-per-run a requirement on the control plane that mints the assertions rather than a convention. The composition tests now mint a session per run, which is what a correct control plane does.

The metering refusal stays. `start` is not the only writer of a run record: another runtime sharing this audience, or a direct `openRun`, can still produce a session two records claim, and this runtime does not own that table exclusively. Its test now builds that state the way it actually arises.

## Consequences

The conflict is refused where it is created, before a hold is taken, and the refused run keeps its nonce.

Writing this found a second defect, in the review rather than the code: the negative control failed only one test where it should have failed three. Two composition tests had been deleted by a later edit to an overlapping region, so the coverage they were supposed to give did not exist. The control is what noticed; the tests are back and the control now fails all three.

## Alternatives considered

**Refuse in the store's `openRun`.** The fact lives there and the scheduler already rolls back a failed record write. It would turn a denied run into a thrown medium error, which is what that path means, and the caller could not tell a conflicting session from a broken disk.

**Refuse only across tenants.** It is the case with an attacker in it. Two runs of one tenant on one session are equally unattributable, and charging either is a misbilling of the same tenant rather than of a different one — quieter, not better.

**Leave it to the metering lookup.** Already the behavior, and it refuses every call in the session forever rather than the one run that caused the conflict.
