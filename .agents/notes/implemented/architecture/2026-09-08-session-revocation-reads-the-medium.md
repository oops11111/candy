# Agent Note: Session revocation reads the medium

Status: implemented

English | [中文](2026-09-08-session-revocation-reads-the-medium.zh.md)

## Problem

A browser session revoked in one Candy process remained valid in another live process sharing the database until that process restarted. Logout therefore depended on deployment topology instead of the durable session record.

## Decision

Browser authentication is asynchronous and re-reads the matching session record from the durable storage unit before accepting it. `KvUnit.readRecord` and `KvTable.getCurrent` are the generic DSH extension points; the SQLite backend implements the actual medium read and the domain layer validates the value and refreshes its local snapshot.

## Alternatives considered

**Enforce one process per database.** This would make revocation depend on deployment topology and still leave an operator mistake as an authentication bypass.

**Broadcast process-local invalidation messages.** A notification path would introduce delivery and recovery semantics while the durable record already provides the authority each process can read.

## Boundary

Candy owns session validity and consumes the storage extension. DSH continues to own storage backends and domain validation. Canary deployments still use separate databases because mixed schema versions and runtime audiences are unsafe; that rule is no longer a workaround for stale sessions.

## Consequences

One indexed SQLite lookup is performed per authenticated HTTP request, keeping revocation visible to every live process sharing the database. The two-process Candy composition proves the second process rejects the next request without restart. The mutation negative control replaced the medium read with the in-memory `get`; that exact assertion failed, then passed again after restoration.
