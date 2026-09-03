# Agent Note: A lost run does not have to be guessed at

Status: implemented

English | [中文](2026-09-03-run-ledger-settles-exactly.zh.md)

## Problem

`dsh-run-budget` subtracts a child's allowance from its parent at reservation and returns the unspent remainder at settlement. Both halves assume a settlement happens. Its own README recorded what happens when one does not: "nothing expires an unsettled reservation, so a child that is lost without settling holds its parent's allowance until the caller reconciles it."

That is the whole delegation cap failing quietly. A parent with four child slots that loses three children has one slot and a quarter of its tokens, forever, with no error anywhere. R3 names the missing piece as the durable run record, and the arithmetic package could not be it: the reservation is a value a caller holds, and a value cannot notice that its holder is gone.

The second problem is what a lease expiry is normally worth. Elsewhere it has to guess — the holder is gone and nothing knows what it consumed — so a system either credits the whole reservation back, inventing budget the run already spent, or credits nothing and leaks the allowance. Both are wrong in a way that shows up on a bill.

## Decision

`RunLedger` holds the open runs of one delegation tree: what each was given, what it has left, and when its hold is released. Every charge goes through it.

### Spend is stored, and what is left is derived

A record holds what a run was given and what it has consumed; what it may still spend is computed from those plus every open child's reservation. The first shape stored `remaining` and refused a charge that did not fit, which is the wrong direction for this seam: charging happens after a provider has already billed, so a refused charge leaves the ledger reporting an allowance the run has spent, and the next invocation is sized against a figure that is not real. It also contradicted the settlement rule beside it, which has always accepted that a child "consumed more than it reserved".

So a spend is recorded in full and the charge reports which dimensions are now used up, which is the decision the refusal was standing in for. The parent still absorbs only what it authorized — an overspending child must not draw on its siblings' allowance — and the settlement reports the true figure.

### Charges and holds in one place make expiry exact

Because the ledger records each charge, a dropped run needs no estimate: what returns to the parent is that run's own `remaining`, which is precisely what it did not spend. The guess disappears, not because expiry got cleverer, but because the two facts that make it a guess elsewhere were never separated here.

One inexactness survives and is named rather than implied: a run whose final charge never reached the ledger is credited that much too generously, bounded by one charge interval.

### Closing a run closes its descendants

A child's reservation is a subtraction from its parent's record. A parent that closes while a child is open leaves that subtraction with no run to justify it and no settlement that will ever reverse it — the allowance is stranded until the whole tree ends. So a close settles the subtree, its reported `spent` covers the subtree, and `closed` names the descendants that went with it, since an operator otherwise cannot tell which runs a single expiry ended.

### A lease is a hold, not a deadline

Expiry releases what a run was holding; it does not cancel the run. Cancelling work belongs to whoever started it, and a ledger that killed runs would be two things at once. `renew` is how a live run says it is still working, which makes a lease that stops advancing exactly a run nothing is driving.

### One ledger holds one tree

A reservation is a subtraction from a record, so a parent and its children share an instance. Two ledgers would each believe they held the whole allowance and the cap would hold in neither.

## Consequences

Three pieces that had no caller now have one. `reserveChild` and `settleChild` were arithmetic nothing invoked; the budget `admitRun` reads through `findBudget` had no writer; the cost `TokenUsage.costMicroUsd` now reports had nothing to charge it against. The ledger is where all three meet, which is what makes them a mechanism rather than three defensible parts.

Nothing persists a ledger. R3 asks for a durable run record and this is the record without the durability: the records are plain data a caller may store, and no store, format, or recovery order is offered, because none exists to design against. A restart loses every open run and the holds they carried.

Nothing drives the clock either. `expire` is a call, not a timer, and a deployment that never makes it never releases an abandoned hold. Choosing that cadence needs the scheduler R3 has not built.

## Alternatives considered

**Leaving expiry to the caller, as the budget README described.** This is the state the change replaced. It is not workable in the direction that matters: the caller that would reconcile a lost child is the parent run, which is the one thing that cannot observe its own child's death, and a reconciliation nobody runs is indistinguishable from a leak.

**Crediting the full reservation back when a lease expires.** Simpler, and it invents budget: a child that spent its whole allowance and then died would return all of it, letting the parent spend the same money twice. Reverting the exact settlement to this shape fails five tests, three of them about ordinary closes rather than expiry, because it is the same arithmetic.

**Making the ledger a Cordis service.** It would give the tree a lifetime tied to a fiber and dispose the records with it. Rejected for now on the same ground as the rest of this group: nothing in the repository schedules runs, so the service would have a lifecycle and no caller, and the class is directly constructible by whichever scheduler eventually owns one.
