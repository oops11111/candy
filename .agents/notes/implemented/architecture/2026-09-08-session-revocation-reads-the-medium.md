---
title: Session revocation reads the medium
status: implemented
date: 2026-09-08
---

# Session revocation reads the medium

English | [中文](2026-09-08-session-revocation-reads-the-medium.zh.md)

## Decision

Browser authentication is asynchronous and re-reads the matching session record from the durable storage unit before accepting it. `KvUnit.readRecord` and `KvTable.getCurrent` are the generic DSH extension points; the SQLite backend implements the actual medium read and the domain layer validates the value and refreshes its local snapshot.

## Why

Logout is a security boundary. Enforcing one process per database would make revocation depend on deployment topology and would still leave an operator error as an authentication bypass. One indexed SQLite lookup per authenticated HTTP request is bounded and keeps a revocation visible to every live process sharing the database.

## Boundary

Candy owns session validity and consumes the storage extension. DSH continues to own storage backends and domain validation. Canary deployments still use separate databases because mixed schema versions and runtime audiences are unsafe; that rule is no longer a workaround for stale sessions.

## Proof

The two-process Candy composition creates a session, authenticates it in the second live process, revokes it in the first, and proves the second rejects the next request without restart. The mutation negative control replaced the medium read with the in-memory `get`; that exact assertion failed, then passed again after restoration.
