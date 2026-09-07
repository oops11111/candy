# Agent Note: A nonce that survives the process

Status: implemented

English | [中文](2026-09-07-a-nonce-that-survives-the-process.zh.md)

## Problem

Candy verified an execution assertion and then spent its nonce in `RunReplayStore`, a map owned by one `RunScheduler`. That made two simultaneous calls inside one process indivisible, but a restart forgot every still-valid assertion and two runtime processes each admitted their own copy. The admission port promised a single-use decision for the deployment; the production composition only supplied one for an object.

The durable control-plane domain could not repair this with its existing API. `KvTable.get` was the snapshot loaded when that process opened the domain, and `putRecord` was an unconditional upsert. Reading, awaiting, and then writing would recreate the replay window across processes. The JSON single-file and per-record layouts also had no portable lock protocol that could make the comparison and replacement one decision.

## Decision

The KV seam now has an optional `compareExchangeRecord` operation. It compares one durable record with an expected JSON value, replaces or deletes it only on equality, and returns the current value from the same atomic operation. `KvTable.compareExchange` exposes it through the domain write chain and rejects with `facet-unsupported` when the selected backend omits it. There is no snapshot fallback.

SQLite implements the operation inside `BEGIN IMMEDIATE` through `COMMIT`. The comparison, conditional insert/update/delete, and current-value read therefore hold one write transaction across processes. JSON omits the capability rather than claiming a guarantee it cannot provide.

The control-plane domain is version 8 and owns `spent_nonces`. Its keys are SHA-256 digests of `run-replay`'s length-prefixed tenant-and-nonce key, which keeps the per-record path safe without changing the collision boundary. Its value is the assertion expiry. Admission atomically inserts a missing record, refuses an unexpired one, or replaces an expired one. Sweeping deletes an expired value only if that exact value is still current, so one process cannot erase a newer reservation made by another.

`RunScheduler` now supplies `spendNonce` from `ControlPlaneStore` and no longer owns a `RunReplayStore`. The in-memory class remains the small contract implementation used by library tests and consumers that deliberately run one process.

## Consequences

A nonce spent before a crash remains spent after the runtime restarts. Two processes sharing the SQLite control-plane database cannot both admit the same tenant and nonce. Reusing the same nonce after the earlier assertion expires is allowed, and cleanup cannot race a newer assertion out of the store.

A production control-plane domain routed to JSON now fails the first nonce decision with `facet-unsupported`. This is deliberate: availability on an incapable backend is not traded for a replay vulnerability. SQLite lock contention also propagates as a failed admission operation; this change adds no hidden retry policy.

Moving the control-plane domain from version 7 to 8 follows the repository's pre-release discard policy. An older store contains no durable replay history, so reading its other records while pretending the nonce table was complete would reopen assertions issued before the upgrade. Deployment must migrate or deliberately replace that store before rollout.

Tests pin the SQLite primitive through two independent backend connections, and a real Loader composition proves that a spent nonce is refused after a full control-plane restart and becomes usable only at expiry.

## Alternatives considered

**Keep the scheduler map and require one process.** Rejected because the Debian deployment is expected to restart and scale; the assertion is audience-bound to a runtime service, not to one JavaScript heap.

**Implement `loadAll` followed by `putRecord`.** Rejected because the await between the two calls is exactly the double-admission window, and a domain's in-memory snapshot does not observe another process.

**Add file locks to both JSON layouts.** Rejected for this boundary. The single layout rewrites an entire unit and the per-record layout has no stale-lock ownership protocol. Shipping a second, subtly different process lock beside SQLite would broaden the storage subsystem for a production path already configured to use SQLite.

**Retain nonce keys forever and only require insert-if-absent.** Rejected because the replay contract bounds retention by assertion lifetime and permanent tenant-controlled keys create unbounded storage. Compare/exchange permits safe expiry replacement and exact-value cleanup.
