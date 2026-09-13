# Agent Note: Tenant device quota atomicity

Status: proposed

English | [中文](2026-09-13-tenant-device-quota-atomicity.zh.md)

## Problem

Candy needs limits for paired devices and outstanding pairing codes. The current `DeviceRegistryStore` can compare-and-exchange one record, but device records, pairing-code records, and a tenant's counters are separate keys. A read-then-write count lets two processes both observe capacity and exceed the limit. A second failure mode is a crash between consuming a code and writing its device, which can leak or duplicate a counter.

## Proposal

Introduce a durable, tenant-scoped reservation primitive in DSH storage and consume it from Candy's device registry operations.

## Required DSH storage seam

The storage layer should expose one tenant-scoped atomic reservation primitive, backed by SQLite transaction semantics:

```ts
reserveTenantSlot(userId, kind, limit, reservationId): Promise<boolean>
releaseTenantSlot(userId, kind, reservationId): Promise<void>
commitTenantSlot(userId, kind, reservationId): Promise<void>
```

`kind` is `device` or `pairing-code`. `reservationId` is a unique opaque id; the operation is idempotent for retries. The reservation and its state are durable. A limit of zero refuses every new reservation. The operation must refresh the current tenant row inside the same transaction that decides the count, so two Candy processes cannot both win the final slot.

## Candy composition

Issuing a code reserves a `pairing-code` slot before writing the digest. A write failure releases the reservation; recovery releases stale reservations using a bounded lease. Exchanging a code reserves a `device` slot before the one-shot claim, then commits it after the device record is durable. A failed claim releases the device reservation. A consumed code whose device write fails is not restored: the bearer code is burned, while the device reservation is released, so retry requires a newly issued code.

The exchange also releases the pairing-code reservation in the same durable transaction as the code claim. Cleanup releases reservations only when it deletes terminal records. Revocation releases a device slot only after the revocation record is durable. All operations remain tenant-scoped and never accept a client-supplied tenant or counter.

## Acceptance criteria

- Two processes racing for the last device slot produce exactly one device.
- Two processes racing for the last outstanding-code slot produce exactly one code, and a failed write does not permanently consume the slot after recovery.
- A code claim plus device write is retry-safe: at most one device is created, and a burned code cannot be exchanged twice.
- Revocation and terminal-code cleanup release only the owning tenant's slots.
- Restart recovery reclaims only expired reservations, never committed ones.
- Limits and reservation identifiers are never returned in HTTP replies or audit payloads.

## Risks

The reservation lease must be long enough for a device write but short enough to recover crashed issuers. A deployment that cannot provide the transaction must fail closed and keep the cap disabled rather than approximate it with process-local counts.

## Alternatives considered

- Count records before writing. Rejected because concurrent processes can both observe capacity.
- Keep counters only in memory. Rejected because restart and multi-process behavior would diverge.

## Explicit non-goals

This seam does not implement Remote Gateway, WebSocket transport, Windows file operations, sandboxing, Agent/Skills/Tools, or a second Web surface. Those stay with DSH and its existing extension points.
