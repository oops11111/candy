# Agent Note: The read that was not in the queue

Status: implemented

English | [中文](2026-09-05-the-read-that-was-not-in-the-queue.zh.md)

## Problem

`storage-domain` states its guarantee precisely: every write queues on one per-domain chain, awaits durability, then mutates memory. What it does not queue is the read a caller makes to decide what to write.

`ControlPlaneStore` appended to an audit trail, charged a tenant's allowance, and changed a grant by reading the record and putting a new one. Two callers that read before either wrote both computed from the same value, and the second write dropped the first.

A probe against the booted store measured it. Thirty-two concurrent audit appends kept one record. Thirty-two concurrent charges of one token consumed one token. Thirty-one of each were lost, silently, with every call resolving successfully.

The audit case is the reachable one: `RunScheduler.start` files its records outside the write chain it uses for run records, so a tenant starting several runs at once loses the records of all but one — an audit trail that under-reports exactly when a runtime is busiest. The charge case is currently held closed by the scheduler serializing settlements, which is a caller's discipline standing in for a store's contract.

## Decision

Every read-modify-write in the store queues on one chain, so the read and the write it feeds happen together.

The chain is store-wide rather than per record. These are settlements, audit appends and grant changes — not a hot path — and one chain is correct without per-key bookkeeping that could itself be wrong. The cost is that a slow medium orders one tenant's charge behind another's audit append, which is stated rather than discovered.

`KvTable.update` already solves this for a record that exists, and `recordRunSpend`, `absorbChild` and `markRunSettled` use it. It does not solve a first write: `update` rejects a missing key, and the get-then-put that would create the record is the same race one step earlier. The chain covers both.

`setTenantGrant` and `recordAudit` stay `async` so the argument checks above the chain reject the returned promise rather than throwing synchronously at a caller that only awaits.

## Consequences

Concurrent appends all land, concurrent charges all count, and a grant change concurrent with a charge keeps both. A rejected write leaves the chain usable, which the tests pin: one refused charge does not stop the next.

The exactly-once settlement markers still require one settlement at a time per funder — that is a semantic requirement on the caller, unchanged by this, and `dsh-run-scheduler` still meets it. What changed is that losing a write no longer depends on the caller getting that right.

## Alternatives considered

**Use `KvTable.update` everywhere.** It is the domain's own answer and it is atomic, and it cannot create the record a first append needs. Mixing update-when-present with put-when-absent leaves the creation race open.

**Chain per record key.** It would let unrelated tenants write concurrently. It needs a map of chains with its own lifetime, and nothing here is frequent enough to pay for that.

**Leave it to callers.** The scheduler already serializes run-record writes, so it looked handled. It was not: the audit path does not go through that chain, and a store whose correctness depends on which caller happens to serialize is a store whose next caller gets it wrong.
