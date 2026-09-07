# Agent Note: An audit trail with no reader

Status: implemented

English | [中文](2026-09-05-an-audit-trail-with-no-reader.zh.md)

## Problem

`admitRun` was made to return its vault records on every outcome, and every denial past the assertion was made to name the tenant, account and run it refused. Both were the right fix and neither finished the job: the records were returned to a caller that dropped them. `RunScheduler.start` handed `audits` back and wrote nothing.

That is the same defect the metering slice found in `charge` — a report nobody read — one layer up. The boundaries page asks that operators be able to detect, contain, and audit cross-tenant attempts; a run that was refused produced a record that reached no one, and the R1 and R3 bullets both ended on the same line: the store that persists them remains unbuilt.

The refusal that mattered most had a second problem. A `ledger`-stage refusal in `dsh-run-start` carried only the reason. Funding happens after admission, so the identity was known by then, and the rejection dropped it — a run refused without saying whose.

## Decision

`ControlPlaneStore` keeps a trail per subject, and `RunScheduler` files everything one scheduling attempt produced.

A trail is a window on recent activity, not an archive. The domain keeps every record it holds in memory, so an unbounded log would grow the runtime without bound; `recordAudit` keeps the most recent `retain` records for a subject and the rest are gone. The cap is the caller's, because how much history a deployment keeps is its choice and not a property of the medium, and it arrives as the scheduler's `auditRetention` config field.

A subject is the tenant when the attempt named one, and the runtime when it did not. Every stage past the assertion works from verified claims. An assertion that fails to verify names no tenant this runtime may believe — and it is the record an operator most wants — so it is filed against the runtime that refused it rather than dropped or guessed at. The `t_` and `r_` prefixes keep the two key spaces from colliding.

`RunStartRejection`'s ledger variant now carries the verified claims, for the reason `dsh-run-admission`'s own denials do.

Records are grouped by subject before they are written, so one attempt is one write per subject rather than one per record — the trail is a whole document and each append rewrites it.

## Consequences

A denied run is recorded where an operator can read it: `auditsOfTenant` for a tenant's own attempts, `auditsOfRuntime` for the tokens this runtime refused before it knew whose they were. Both survive a restart, because they are in the same domain as the accounts and the run records.

The trail records what the control plane observes and no more: a run started, a run refused and by which step, and the vault operations the attempt produced. Routing, delegation, tool authorization and terminal state are named in the boundaries page and are not here, because nothing in this repository produces those records yet.

Retention is the honest limit. A deployment that must keep evidence reads the trail and ships it somewhere that is an archive; what falls out of the window is gone, and the README says so rather than implying durability the medium does not offer.

## Alternatives considered

**One document per record, keyed by time.** It matches what an append-only log is and lets a single write add one record instead of rewriting a document. The domain loads every record into memory, so the growth is the runtime's, and pruning would still be a scan. A bounded trail is the same bound stated up front.

**Drop the unverifiable-token record.** There is no tenant to file it under, and inventing one would put an attacker's chosen identity into a tenant's trail. Filing it against the runtime keeps the record without believing anything the token said.

**Extend the storage seam with an append-only unit.** It is the right medium for an archive and a much larger change than this one, and it would not be Candy's to design alone: `dsh-storage`'s KV facet is the whole of what backends implement today.

**Write each record as its own store call.** Simpler code, one medium write per vault event plus one per outcome. Grouping by subject costs a `Map` and turns a started run's two records into one write.
