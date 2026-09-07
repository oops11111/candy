# Agent Note: Candy session ownership and queued cancellation

Status: implemented

English | [中文](2026-09-07-candy-session-ownership-and-queued-cancellation.zh.md)

## Problem

Evicting an ended session lets its next request bypass metering. Closing an iterator while its first pull waits for another call can still start the cancelled source when that call finishes.

## Decision

The existing control-plane storage domain retains session ownership independently of run settlement. Admission writes ownership before the run record. Metering refuses an owned session without an open run, including after cache eviction or restart. This supersedes the cache-only decision in [the earlier note](../architecture/2026-09-05-a-run-that-ended-and-kept-spending.md).

The existing per-run queue checks its released state before and after waiting. A closed queued iterator returns completion without starting its source, and later calls can proceed.

## Alternatives considered

**Keep every ended session only in memory.** This removes eviction but loses the classification on restart.

**Refuse every unmanaged DSH session.** That would prevent ordinary DSH work in the same composition. Persistent Candy ownership distinguishes the two.

**Replace DSH cancellation or storage.** The defects are in Candy's queue and classification; the existing storage domain and stream mechanisms provide the needed operations.

## Consequences

Ownership storage grows with admitted sessions and has no automatic expiry. Domain version 7 rejects old records under the existing pre-release policy; this change does not deploy or migrate production data. A production transition needs separate verification.

Loader-composition regressions cover closure during queue wait, subsequent calls, cache eviction, and restart. These are keyless storage and stream checks, not real-provider or Windows ACL evidence. A recorded-session scenario remains outstanding.
