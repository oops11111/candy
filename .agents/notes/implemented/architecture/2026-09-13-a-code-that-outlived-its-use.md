# Agent Note: A code that outlived its use

Status: implemented

English | [中文](2026-09-13-a-code-that-outlived-its-use.zh.md)

## Problem

Pairing codes were single-use and expired correctly, but their durable records never left SQLite. A tenant could keep issuing codes and make consumed and expired metadata grow without bound. Removing records on a timer would add another process lifecycle, while a global sweep could let one tenant's request affect another tenant's records.

## Decision

Add a tenant-scoped `sweepPairingCodes` registry operation and a `deletePairingCode` storage port. A code becomes terminal at its consumption time, or at its expiry when it was never consumed. Once the configured retention window closes, the operation deletes only terminal records returned by that tenant's list. Outstanding records are never selected.

The device API invokes the sweep before returning a device list and before issuing another code. The retention window defaults to seven days and may be configured from zero to one year. This is opportunistic cleanup: it requires tenant activity and deliberately does not introduce a timer, background worker, or another transport.

## Alternatives considered

- Sweep every tenant from one request. Rejected because a tenant operation must not mutate another tenant's state and the store exposes no administrator-wide maintenance contract here.
- Delete a record immediately on exchange or expiry. Rejected because the settings page uses terminal metadata to explain whether an invitation was used or merely expired.
- Add the device/code cap in the same change with a read-then-write count. Rejected because two Candy processes could both observe room and exceed the cap. An exact cap needs an atomic per-tenant reservation ledger or a store transaction spanning issuance and quota.

## Consequences

Active tenants retain a bounded time window of terminal pairing metadata, while cross-tenant records and usable invitations remain untouched. Quiet tenants retain old records until their next list or issue operation, so deployments requiring wall-clock deletion need an external maintenance trigger. The exact multi-process device and outstanding-code cap remains a separate security slice.
