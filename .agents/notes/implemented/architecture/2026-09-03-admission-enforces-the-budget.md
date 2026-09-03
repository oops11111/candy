# Agent Note: The budget nothing consulted

Status: implemented

English | [中文](2026-09-03-admission-enforces-the-budget.zh.md)

## Problem

`dsh-run-budget` bounds what a delegation tree may spend, and `dsh-run-admission` is the one path a run takes from a token to a scheduled invocation. Neither knew about the other. `RunAdmissionPolicy` held an expectation, a secret, a keyring, a pool base, and two ports — replay and credential lookup — and no budget anywhere.

The consequence is the plain one: a tenant whose tokens, time, or money were exhausted was admitted anyway. Admission verified the assertion, spent the nonce, opened the credential, resolved the pool, and handed back a run ready to spend money the tenant did not have. The budget arithmetic was correct and had no caller at all.

Two packages, each defensible alone, leaving a hole between them. The [enforcement rule](../../../../packages/AGENTS.md) is the one that names it: a decision is enforced in the operation that makes it, and admission is where a run is allowed to start.

## Decision

`RunAdmissionPolicy` gains a third port, `findBudget`, and `RunRejection` gains a `budget` stage. An admitted run carries the allowance it may spend, so the caller charges against it with `dsh-run-budget` rather than discovering a limit later.

### An absent budget denies the run

`findBudget` returning `undefined` is a denial, not permission. A tenant the budget store does not know is not a tenant with unlimited budget, and treating an absent record as unmetered would make a store outage the most expensive possible failure. A deployment that genuinely means unmetered says so with an explicit large allowance, which is a value someone chose rather than a gap nobody filled.

### Only the consumable dimensions stop a run

`hasRemainingBudget` ignores `children`, and admission inherits that. A run with no delegation slots left can still do its own work; it simply cannot start a child. Refusing it would confuse "cannot delegate" with "cannot proceed", and a test pins the distinction.

### The budget is read before the nonce is spent

This changed the documented order, and the reason is worth keeping. An exhausted budget is the one denial here a caller can fix and retry: top up, present the same still-valid assertion. Spending the nonce first would burn a single-use token on a recoverable refusal and force a round trip to the control plane for a fresh assertion. The budget read is also cheap and touches no secret, so it costs nothing to do early.

The nonce is still spent before the credential. Its job there is to serialize concurrent duplicates so two copies of one token cannot both reach a secret, and that job is unchanged by moving a read in front of it. A test pins the whole sequence — budget, nonce, credential — because the order is the contract, and another asserts that a run refused on budget reads no credential at all.

## Consequences

`dsh-run-budget` now has a consumer, which is what makes it a component rather than a library nobody calls. The compiler enforced the change: adding a required port broke every existing caller until each supplied a budget, which is the property a required field has and an optional one does not.

Admission still performs one read and no write. It reports the allowance a run was admitted against; it does not decrement it, because a spend is a durable write and this module owns no store. A deployment that reads a budget here and never charges against it has a limit that only ever holds at admission, and the README says so rather than implying enforcement this module cannot provide.

The port is a parameter for the same reason the other two are: none of the three stores exists in this repository, and naming them forces a deployment to have answered budget, replay, and credential lookup before a run can start.

## Alternatives considered

**Treating an absent budget record as unmetered.** Simpler for a deployment that has not built a budget store yet, and wrong in the direction that costs money: a store that fails to answer would silently lift every tenant's limit. Denying is the failure this can afford.

**Checking the budget after the nonce, keeping the original order.** This was the shape before the change and it works, but it burns a single-use token on the one refusal a caller can recover from. The security argument for spending early — serializing duplicates before a secret is touched — is preserved by keeping the nonce ahead of the credential rather than ahead of everything.

**Charging the budget here as well as reading it.** Rejected: a charge is a durable write, and a module that reads through a caller-supplied port cannot make one atomically with the read. Doing it non-atomically would produce exactly the double-spend the budget exists to prevent. Charging stays with the caller that owns the store, and `chargeRun` refuses an overdraw without deducting anything, so a caller that stops on a denial leaves nothing half-spent.
