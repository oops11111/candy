# Agent Note: A denied run is the event the audit trail is for

Status: implemented

English | [中文](2026-09-03-run-admission-audits-every-outcome.zh.md)

## Problem

[R3's fourth bullet](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) asks for a tenant-scoped audit trail. Looking for where one would attach turned up something smaller and worse first.

`admitRun` returned the vault's audit record only when a run was admitted. Every denial returned a rejection and nothing else. `openCredential` returns a `CredentialAuditEvent` on its *failing* branch as well as its succeeding one — `CredentialOpenResult` carries `audit` in both variants — and this module discarded the failing one. What that discarded was the cross-tenant access attempt the vault had just detected: a `binding-mismatch` is one tenant's run reaching for another tenant's credential, and a `corrupt` is an envelope whose authenticated data does not match its labels. Both were detected, recorded, and thrown away.

The gap was not unnoticed, which is the part worth recording. The package README named it — "A denial returns no audit record at all" — and the package's Agent Note listed an audit sink under alternatives considered and called the omission a limitation. It was written down as a boundary of the design rather than read as a defect in it. Asking what an audit trail is *for* is what turned it over: the admitted runs are the uninteresting half.

## Decision

Every `RunAdmission` variant carries `audits`, and the type makes that unavoidable rather than optional. A denial that reached the vault carries the vault's record of the refusal; a denial that never reached it carries an empty array.

The empty array is deliberate and is not a placeholder. A token this runtime does not admit, a spent nonce, and a tenant whose account has no stored credential are all refused before any credential is touched, so the vault produced nothing and inventing a record here would mean this module fabricating an audit entry for an operation that never happened. What it does instead is documented: a caller that must log those refusals logs the rejection, which the return value already names by stage.

`AdmittedRun.credentialAudit` is gone. With `audits` on both branches it was a second home for one fact, and the two could drift.

The success and failure records share a shape because they are the same shape — the vault's `CredentialAuditEvent`, unmodified. A test asserts the key sets match across an admitted and a denied run, so one tenant-partitioned store accepts both and an operator querying a tenant's history does not join two vocabularies.

## Consequences

A cross-tenant credential attempt is now reportable. That is the whole point, and it is checked rather than asserted: reverting the one-line fix fails four tests, three naming the specific vault refusals (`binding-mismatch`, `revoked`, `corrupt`) and one the shared record shape.

Nothing here persists anything, which is unchanged. This module returns records; the tenant-partitioned store the [boundaries page](../../../../docs/candy-runtime-boundaries.md) requires stays with the caller, and no ordering, retention, or write guarantee is offered.

The audit surface is still only as wide as the vault's operations. R3's bullet also names routing, delegation, tool authorization, usage, and terminal state, and none of those is covered by this change — they belong to the scheduler and orchestration work R3 has not built. Widening the record before those exist would mean inventing a taxonomy for consumers that do not, which the [evidence rule](../../../../packages/AGENTS.md) forbids.

## Alternatives considered

**Adding an audit sink port to `RunAdmissionPolicy`.** The package's original note rejected this and the rejection still holds: a sink parameter adds an obligation the type system does not enforce, and a caller can pass a sink that drops everything. Returning the records in the result makes them impossible to not receive, which is the stronger property. Persisting them remains the caller's.

**Synthesising an admission audit for the stages the vault never sees.** This would give every denial a non-empty trail and a uniform "something was refused" record. Rejected because it invents an event: no credential operation occurred, and a record claiming otherwise is worse than an honest empty array beside a named rejection stage.

**Leaving it as a documented limitation.** This is what the package already did, and it is why the defect survived its own review. A limitation describes what a package does not do; this was a record the package received and then dropped.
