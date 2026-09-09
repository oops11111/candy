# Agent Note: A trail that only said a run began

Status: implemented

English | [中文](2026-09-07-a-trail-that-only-said-a-run-began.zh.md)

## Problem

A completed delegation left four records in the tenant's audit trail: a `credential`/`open`/`ok` and a `started`/`start`/`ok` for the parent's run, then the same pair for the child's minted run. Neither of the two things an operator would ask about that pair was in it.

Nothing said the second run was the first one's child. The lineage exists — `ExecutionAssertionClaims.parentRunId` carries it into admission and `DurableRunRecord.record.parentRunId` holds it while the run is open — but the audit record had no field for it, and the durable run record is deleted at settlement. So the trail of an agent that delegated three children read back as four unrelated runs of one tenant that happened to overlap, and reconstructing the tree from it was not possible at all, not merely inconvenient.

Nothing said a run had ended, either. `RunScheduler.settle` deletes the run record; no record replaced it. A trail therefore showed a run starting and then nothing, forever, and the four ways a run can end — a caller closing it, a lapsed lease, a revoked account, a runtime restart — were indistinguishable from each other and from a run still working. The lease and revocation paths are exactly the ones an operator investigating an agent that stopped early would be looking for.

## Decision

`RunAuditRecord` gains `parentRunId`, and `event` gains `settled`.

Every record about a run carries the lineage its subject had: the `started` record from `claims.parentRunId`, refusals from the same claims, launches and refused calls from the run's durable record, and the new terminal record from the record read before deletion. A root run contributes no field rather than an explicit absence, so the record round-trips through the medium as the value it was written as.

`RunScheduler.settle` takes the cause of the settlement from its caller and files one record under `event: 'settled'`, `action: 'settle'`, with that cause as the outcome: `closed` from `close`, `expired` and `revoked` from the two branches of `sweep`, and `recovered` from `recover`. The sweep computes `spent(runId)` once and passes which branch it took, rather than deciding again where the record is written — the caller is the only place the cause is known.

Only the run a settlement was asked for is recorded. A descendant closed with its ancestor left a `started` record naming that ancestor, so the tree is readable from that end; and a delegated child normally ends in its own right, through `closeSessionRun` from `subagent/end`, which reaches `settle` as the run it was asked about. Filing a record per closed descendant would need each one's durable record read back before deletion for a case the lineage already answers.

The record is written after the charge lands and the run records are deleted, so it describes a settlement that has happened; the write is awaited and its rejection logged rather than thrown, because a store that cannot take the record must not turn a completed settlement into a failure.

`parentRunId` takes no part in `sameEvent`, the fold that collapses a repeated record into a count. It is a property of `runId`, which is already compared: two records naming one run name one parent, and a record naming no run was refused before any lineage was believed.

The terminal record now also carries `spent`: the exact `RunSpend` settlement computed before it charged the funder, including spend absorbed from descendants. The fold compares all three dimensions by value, so two otherwise identical terminal records with different tokens, wall time, or micro-USD cost cannot collapse into one.

The durable declaration moves to version 5. Under the pre-release stance a version 4 medium is not read as one, and the reason is not that its records are the wrong shape — they parse — but that they would answer both new questions wrongly rather than not at all: every run in an old trail reads as parentless, and every run that finished reads as still open.

## Consequences

An operator reading `auditsOfTenant` can reconstruct a delegating agent's run tree and see how each run in it ended, from records that outlive the runs themselves. That is the first thing in the control plane that survives a settlement: the allowance keeps an aggregate, and everything else about a run is deleted with it.

The trail is a window, not an archive, and a terminal record per settlement makes it fill roughly twice as fast at the same `auditRetention`. A deployment that reads the trail for recent activity is unaffected; one that wanted history was already being told to ship the records somewhere that is an archive.

What a run cost is now survives settlement in the same terminal record that names why it ended. The durable declaration advances to version 9: a version 8 trail can parse without `spent`, but accepting it as current would silently turn an operator's run-cost query into an absent answer.

A real-composition test in `dsh-run-delegation` pins the delegated case end to end: a real scheduler, a real SQLite-backed store and a real subagent runtime produce a child whose `started` and `settled` records both name the parent's run, against a parent whose own records name none. Four tests in `dsh-run-scheduler` pin each cause, one pins the final spend, and one pins that a settlement completes when the trail cannot take its record. A store test proves different spend figures do not fold together. Mutation checks confirm the usage seam: removing `spent` from the terminal record makes the focused close test fail.

## Alternatives considered

**Derive the end from the run record's absence.** `findRun` answering nothing for a run the trail says started does mean the run ended, and it needs no schema change. Rejected: it says only *that* it ended, which is the least useful half. The cause is what separates an agent that finished from one a revoked account cut off, and absence cannot carry it. It also answers nothing after a restart, where the records of both runs are gone.

**Put the lineage in `action` or `outcome` rather than a field of its own.** Rejected: both are already occupied — `action` names the step and `outcome` its result — and packing an id into either would make `sameEvent` compare lineage as part of the event's identity, which is exactly what it should not do.

**File a terminal record for every descendant a settlement closes.** Rejected for this slice: each would need its durable record read back before the deletion loop, and the case is narrow — a parent closing while a child is still open, which the delegation path avoids by settling children as they end. The child's own `started` record already names the ancestor whose settlement took it.

**Keep `event` closed at four values and file settlements as `refused`-style records with a distinct action.** Rejected: `refused` means an attempt that did not proceed, and a settlement is the opposite. Reusing it would make every consumer filtering on `event` wrong, for the sake of avoiding a version bump that the pre-release stance does not ask us to avoid.
