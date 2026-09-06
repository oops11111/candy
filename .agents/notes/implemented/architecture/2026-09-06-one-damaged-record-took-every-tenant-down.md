# Agent Note: One damaged record took every tenant down

Status: implemented

English | [中文](2026-09-06-one-damaged-record-took-every-tenant-down.zh.md)

## Problem

`RunLedger.restore` refuses a forest that is not whole: a record naming a parent no record supplies throws. Recovery calls it during `Service.init`, so the throw failed the plugin, and the runtime did not start.

A probe wrote one child record whose parent was then gone — a partial write, or a delete that took the parent and left the child — and booted:

`threw: failed to apply loader entry run-scheduler: restored run 'run-orphan' names parent 'run-gone', which no record supplies`

Every tenant on that runtime was down over one damaged record. The reasoning behind refusing was sound as far as it went — a hold against a parent that does not exist is one nothing can settle, and dropping it silently loses the accounting — but refusing is not the only alternative to dropping.

## Decision

A record whose parent the store does not hold is adopted as a root and settled like any other.

This loses no accounting, because recovery settles every root it restores anyway. The run was going to be settled a moment later either way, and the only open question was who is charged for what it spent. The record names its tenant, and that is where the parent's own settlement would have carried the charge.

The parent is cleared in the store, not only in the restored ledger. The settlement that follows reads the record back from the store, and one still naming the missing parent charges that parent — which is to say nobody. The first version of this cleared it in memory only, booted successfully, and left the tenant charged nothing for a run that had spent forty tokens: the same silent loss the refusal existed to prevent, arrived at from the other direction.

The adoption is logged, naming the run, the missing parent and the tenant now charged.

## Consequences

A damaged record costs its own run's accounting precision, not the runtime.

The boot repairs the store rather than reporting it: the adopted record is settled and deleted, so the damage does not meet the next boot.

An existing test pinned the refusal and was removed rather than kept. It built the same record this one does and asserted the boot rejects, which is the behavior that deliberately changed; the replacement asserts the accounting survives and the tenant can start again.

Damage this does not name still fails the boot — a record that fails its schema, a tenant allowance that is gone — and has no repair path.

## Alternatives considered

**Drop the orphan.** The original decision rejected this and was right: the run holds a reservation and has spent something, and dropping it silently loses both. Adoption keeps what dropping loses.

**Refuse only that tenant's runs.** It contains the blast radius without deciding anything about the damaged record, and the runtime would then hold a tenant it refuses to serve, with no path back except an operator editing the store by hand.

**Repair offline.** A separate tool that reads the store and rewrites it is the general answer to corruption, and it is a tool nobody has. This shape is decidable at boot with information the record already carries, so it does not need one.
