# Agent Note: A revocation only one process saw

Status: implemented

English | [中文](2026-09-12-a-revocation-only-one-process-saw.zh.md)

## Problem

The device stack promised that a revocation stops the next run, but its store read `DeviceId` and pairing-code records from the snapshot loaded when that Candy process opened. In a two-process deployment, a code issued by one live process was unknown to the other, and a device revoked by one remained usable through the other's run-admission path. The existing concurrency test missed this order because it wrote the code before opening the second process.

Token authentication had the same discovery gap. It re-read a matching device from the medium, but first searched only the old in-memory snapshot for that match. A device created after the process opened therefore authenticated as unknown until some other read happened to refresh its id.

## Decision

Security decisions re-read their keyed records from the durable medium. `findDevice`, `findPairingCode`, and the first step of `claimPairingCode` use `KvTable.getCurrent` rather than an open-time snapshot.

For a lookup whose key is not known in advance, `KvTable.entriesCurrent` reloads and validates one complete table through the existing `KvUnit.loadAll` contract, replaces that table's local snapshot only after every record validates, and returns the new stable entries. Device-token lookup and the tenant device and pairing-code lists use this explicit path. Ordinary `get` and `entries` keep their synchronous snapshot semantics, and no second change-notification system is introduced.

## Alternatives considered

**Refresh only known ids and code digests.** Rejected because token authentication does not know a device id before it authenticates the token, and management lists do not know which keys another process added. It would repair admission while leaving pairing and authentication dependent on request routing.

**Add a secondary token index and per-tenant roster records.** Rejected for this data shape. The storage seam has atomic replacement for one record but no cross-table transaction, so device creation would gain several indexes that can partially land. Reloading the authoritative table keeps one record as the fact.

**Require one process per database.** Rejected because the repository's canary and rollback design explicitly exercises two live Candy processes over the same SQLite control plane. Turning a correctable read path into a deployment ban would contradict that release shape.

## Consequences

A load-balanced pairing exchange can discover a code issued after its process started. A run admission can see a device created or revoked by another process, and token authentication no longer depends on an unrelated id lookup warming the snapshot first.

The refresh is pull-based. `domain/changed` remains in-process, and consumers that require current cross-process enumeration must deliberately call `entriesCurrent`; the method does not pretend to provide push invalidation or a transaction spanning tables.

## Verification

The control-plane store test opens two runtimes before either device record exists. One writes a pairing code and device while the other discovers and claims the code, authenticates the token as its first device read, and resolves the id. On the uncorrected implementation the test first failed at the code lookup, then at token lookup after keyed reads were corrected.

The storage-domain test changes the shared medium behind an open domain and proves ordinary iteration stays on its old stable snapshot until `entriesCurrent` replaces it with the validated current table.
