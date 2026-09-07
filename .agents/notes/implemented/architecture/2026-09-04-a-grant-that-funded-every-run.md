# Agent Note: A grant that funded every run

Status: implemented

English | [中文](2026-09-04-a-grant-that-funded-every-run.zh.md)

## Problem

`dsh-run-admission` reads a run's allowance through a `findBudget` port, and `dsh-control-plane-store` answered the root-run half of it by returning the tenant's stored budget. That answer bounded one run, not a tenant.

Nothing consumed the record. A tenant granted a million tokens started a run against a million, spent them, closed it, and started the next run against the same million — the store returned the same value every time, because no step wrote to it. Two runs live at once were worse: each was admitted against the whole grant, so together they could spend it twice.

The scheduler's own README named the gap as "no spend write-back", and the delivery plan's R3 bullet ended on it: "the run records are plain data and nothing stores them, so a restart still loses every open run, and no spend is folded back into a tenant's durable allowance". The tenant-level bound the boundaries page asks for did not exist; what existed was a per-run ceiling with a tenant's name on it.

## Decision

A tenant is the root every delegation tree hangs from, and is accounted exactly as a parent run is.

`dsh-tenant-allowance` holds the record: a `grant` an operator set and the `consumed` its settled runs took from it. `remainingAllowance(allowance, held)` subtracts both the consumption and the reservation of every run of that tenant still open, and charges a held run one concurrency slot for itself plus every slot it may hand down — the arithmetic `reserveChild` performs one level lower. `grant.children` therefore bounds the tenant's whole forest rather than any one tree in it, which is the tenant-wide concurrency cap `RunScheduler` previously declined to invent.

The grant is kept beside the consumption rather than decremented in place. A single decremented figure answers admission just as well and loses what an operator granted, which is half of any quota report, and makes changing a grant ambiguous. Keeping both makes it definite: `setTenantGrant` replaces the grant and keeps the consumption, so doubling a quota mid-period lets the tenant spend twice as much in total rather than erasing its history.

Consumption is recorded, never capped, for the reason `RunLedger` records an overspending run truthfully: a provider bills what it billed. Only the answer to "what may start now" is clamped at zero.

`RunScheduler` is where the durable half and the live half meet, and it now holds the one fact neither had: which tenant a tree belongs to. A `RunRecord` names a run and its parent, not an identity, so the scheduler keeps a map from root run to `UserId`. Only roots are in it — a child settles into its parent's record and reaches the tenant when that parent's root closes — so a tree is charged once rather than once per run. A settlement for a run this instance never opened as a root charges nothing, because there is no tenant to charge it to and guessing one would bill the wrong account.

The domain version moves 0 → 1 with no compatible version listed, so records stamped 0 are discarded. A bare budget cannot say how much of itself was already spent, and admitting one would restore a tenant's whole allowance rather than migrate it.

## Consequences

A tenant's grant now funds a tenant. A run that spends the grant and closes leaves the next run denied at the budget stage, and a run that is merely open holds its reservation out of what the tenant's next run starts against.

Settlement is where a tenant's durable allowance moves, so `close` and `sweep` are asynchronous. The sweep is driven by the service's own interval, and a rejected write is logged rather than left to become an unhandled rejection: the holds it failed to charge are already released, and the next sweep runs regardless.

That is also the remaining gap, and it is exact. The settlement is written after its hold has been released in memory, so a crash between the two loses that tree's spend, as does a failed write. Bounding the loss to nothing needs durable run records, which is the next piece and which this note does not claim.

Two behaviors changed for existing callers. `RunScheduler.close` and `RunScheduler.sweep` return promises. And the default `share` — the whole allowance admission answered — now means a tenant can have exactly one root run open at a time; a deployment that wants concurrent trees passes an explicit share, which is what the composition test does.

## Alternatives considered

**Decrement the stored budget at settlement.** One field, no new package. It loses the grant after the first run, so no quota report can be produced, and it makes a mid-period grant change undefined.

**Charge the tenant at reservation and refund the remainder at settlement.** It is the ledger's model and fails closed on a crash, which is the safer direction. It also makes consumption non-monotonic, and a refund lost to a crash silently eats a tenant's quota for good. Holding the reservation while the run is open achieves the same bound without a write that can be lost in the wrong direction.

**Fold each `charge` into the tenant as it happens.** It would keep consumption current instead of lagging by one tree, and it double-counts: the run's reservation is already held out of the tenant's remainder, so its spend would be subtracted twice while it is open.

**Put the record in `dsh-run-budget`.** That package is the arithmetic of one delegation tree, and a tenant is not a run in it. Keeping the tenant record separate lets the ledger stay a value with no notion of who owns it.
