# Agent Note: The order had no owner

Status: implemented

English | [中文](2026-09-04-the-order-had-no-owner.zh.md)

## Problem

The control-plane group composes in exactly one order, and the subsystem page says so — including the sentence "nothing in the repository performs the sequence outside its tests". That was accurate and it was the defect.

Every caller wrote the sequence itself, and none of them undid what it held when a later step refused. `RunLedger.openChild` subtracts a child's allowance from its parent the moment the child opens. Placing the run comes after, and placing can refuse: a pool base the deployment never provisioned, a link planted where the pool root goes. A sequence that opens the record and stops at the failed placement leaves the parent short of an allowance no run is spending, until the lease expires.

That window is small and it is real, and it is exactly what `packages/AGENTS.md` means by representing one asynchronous operation with one lifecycle controller, rollback preserved. Nothing owned it because nothing owned the sequence.

## Decision

`startRun` performs Admit, Open and Place, and closes the ledger record it opened when the placement throws. The hold returns at once rather than at lease expiry, and the failure keeps travelling: a missing pool base is a deployment error, not a denied run.

Binding a provider is deliberately outside. It allocates nothing, so it needs no rollback, and it is the one provider-specific step — keeping it out leaves one composition for every provider instead of one per provider. Charging and closing stay outside for the same reason: they belong to a run that is already streaming.

The allowance a run opens with is a caller's callback rather than a fixed rule. A root run is normally opened with what admission answered; a child is opened with the share its parent delegates, and only the caller knows what that share should be. The ledger still refuses a share that exceeds what the parent holds.

## Consequences

The order the subsystem page documents is now executable rather than described, and the hand-rolled copies have one place to move to.

This is not a scheduler. Which run starts, in what order, and whether a tenant may start another at all are decisions nothing here makes; this is the sequence one run goes through once those decisions exist.

Rollback is bounded by the process. The ledger is in memory, so a hold stranded by a crash is still the expiry clock's to release.

## Alternatives considered

**Open the ledger record after placing the pool.** It removes the window without any rollback, and it reverses the order the subsystem page states for a reason: the funding decision is the one a caller can fix and retry, and placing a directory for a run that will be refused for lack of budget does work on a tenant's behalf before knowing the tenant may proceed.

**Leave the sequence to callers and document the rollback.** Documentation is what there was. Each caller reproduced the steps and none reproduced the undo, which is the outcome that shape produces.

**Include the provider binding, so one call yields a launchable run.** It would make this package provider-specific and force a second copy for the next provider, to save a caller one line that allocates nothing and can fail nothing.
