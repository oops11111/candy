# Agent Note: A check and the hold it authorizes

Status: implemented

English | [中文](2026-09-05-a-check-and-the-hold-it-authorizes.zh.md)

## Problem

Three of this runtime's bounds are read-then-act: the tenant's remainder, the parent's allowance, and the run already driving a session. Each was read during admission and consumed a few awaits later, when the ledger record opened. Nothing held the state still in between.

A probe against the booted runtime measured it. Two concurrent starts for one tenant, each opened with what admission answered, both started — and the ledger held two hundred thousand tokens against a grant of one hundred thousand. Two concurrent starts on one session both passed the session check for the same reason.

This is the defect the store had, one layer up and found by looking for it there: a decision made from state that something else changes before the decision is applied. The chain that already existed here ordered *writes*, which is not the same thing as ordering the operations those writes conclude.

## Decision

The chain orders whole operations. `start` runs on it, alongside `charge` and every settlement.

That makes each check decide about the state its own hold is then taken from. The tenant remainder, the one-session rule and the parent-subset rule become bounds rather than likelihoods, and none of them needed changing — only the window they were read in.

`openRun` inside a start is called directly rather than queued: the start already holds the chain, and queueing behind itself would never resolve. `charge` moves fully inside its queued section for the same reason its write did.

The cost is real and stated: one tenant's start waits behind another's, including the pool directory each start creates. Admission does an HMAC verification and a filesystem `mkdir`, so this is not free. Correctness first, and a runtime that needs concurrent starts can have per-tenant chains once something measures that it needs them.

## Consequences

Two concurrent starts for one tenant now leave exactly the grant held, and two on one session leave exactly one run. The negative control — removing the chain from `start` — fails both, so the tests measure the chain rather than the checks they sit behind.

Settlement and start can no longer interleave either, which was already necessary and previously accidental: a settlement changes the holds a start reads.

## Alternatives considered

**Re-check inside the ledger.** `RunLedger.openRoot` could refuse a root that exceeds the tenant's remainder, which would close the allowance race at the point of the hold. The ledger deliberately knows runs and allowances and not tenants, and the session and lineage races would still be open.

**A per-tenant chain.** It keeps unrelated tenants concurrent, and the session and lineage checks span tenants — a child's parent and a session's holder need not belong to the tenant starting the run — so a per-tenant chain would close one race and leave two.

**Optimistic retry.** Open, detect the overshoot, roll back and retry. It needs a detection this has no place to put, and a rollback of a hold whose credential has already been opened.
