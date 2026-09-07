# Agent Note: A settlement that a crash could lose

Status: implemented

English | [中文](2026-09-04-a-settlement-that-a-crash-could-lose.zh.md)

## Problem

`RunLedger` held every live run in memory, and the scheduler settled a run by closing it there and then writing the charge to the medium. Two things followed from that order.

A restart lost every open run. Whatever a tenant's runs had consumed since their last settlement went with them, and the allowance those runs were holding came back in full — a runtime restarted under load handed each tenant its whole grant back, along with the concurrency slots the previous slice had just made meaningful.

And a settlement could be lost while the process stayed up. The close happened first and could not fail; the write happened second and could. When it rejected, the hold was already released and the record it would have charged was already gone, so nothing could retry. The previous slice's note and the package README both named this exactly, and named durable run records as what would close it.

## Decision

The charge is computed before anything moves, written down, applied, and only then is the run forgotten.

`RunLedger.settlementOf` reports what closing a run would charge and which descendants it covers, without changing anything. It is not a second implementation of the settlement arithmetic — `settle` calls the same recursion and then deletes what it named — so a caller that writes the previewed figure down writes exactly what the close will apply. `RunLedger.restore` installs records the ledger did not open, deliberately without re-running the checks that created them: a parent that has since spent most of its allowance no longer has room to reserve a child it already funded, so replaying `openChild` would refuse records that are correct.

`ControlPlaneStore` holds one record per live run, in the domain that already held accounts and allowances. The record carries the ledger's own accounting, the tenant the tree is charged to, the runtime that opened it, and the settled figure once that has been written.

A settlement is two writes the medium cannot make one: charge whoever funded the run, then forget the run. Both funders — a tenant's allowance for a root, the parent's run record for a child — therefore carry the id of the settlement they last absorbed, written by the same atomic update as the charge. A repeat of that id is a no-op, so a restarting runtime re-drives an interrupted settlement without knowing how far it got. The two markers are the same mechanism one level apart, which is what a tenant being the root every tree hangs from should look like.

That guarantee holds only while no two settlements interleave — two of them leave the id of the later one, and a crash would then charge the earlier one twice — so every write to a run record queues on one chain in the scheduler.

A restart settles rather than resumes. A record this runtime wrote is a run it was driving and the process that drove it is gone, so `Service.init` finishes every interrupted settlement, restores what is left, and closes each restored root. Recovery reads its own runtime's records only, by an audience stamp on each one, because two runtimes sharing a medium would otherwise settle each other's live runs.

The tenant a run belongs to moved onto its durable record and the in-memory map that held it is gone. It was a second copy of a fact a restart does not have, and every reader — settlement, recovery, and the tenant-remainder lookup — now reads the one that survives.

## Consequences

A restart charges each tenant what its runs consumed and starts with a clean ledger. A rejected settlement write leaves the run open in both places, so its lease brings the next sweep back to try again; the composition test drives exactly that, failing the write, observing the run still open and the tenant uncharged, then restoring the medium and watching the next sweep settle it.

`RunScheduler.charge` is asynchronous now: a spend that is not written down is a spend a restart loses, so it reaches the run's record before the call resolves. `start` writes the run's record too, and closes the ledger entry it just opened when that write fails — a run this runtime cannot record is one a restart would forget while its provider kept spending.

The domain version moves 1 to 2. A version 1 allowance is discarded because it cannot say which settlement it already absorbed, and a run record recovered beside it could be charged twice.

What this does not do: it does not survive a corrupt store. Records that do not form complete trees fail the boot rather than being dropped, because a hold against a parent that does not exist is one nothing can settle, and there is no repair path. It also serializes every run-record write in the runtime, so a slow medium serializes charges across unrelated tenants.

## Alternatives considered

**Keep settling in memory first and retry the write.** A retry queue is more machinery than the marker and still loses the charge on a crash, because the queue is in memory too. Writing first needs no queue: the medium holds the intent.

**Make the run record the ledger.** Every charge would then be a durable read-modify-write, and `remaining` — which admission calls on every child — would be derived from the medium. The ledger is the accounting authority precisely because it is cheap and synchronous; the record is what survives, and keeping the two roles apart is why `settlementOf` and `restore` are enough.

**Keep a settled record forever and derive a tenant's consumption from it.** Idempotent by construction, with no marker at all, and unbounded: one record per run for the life of the deployment. The marker is two optional fields.

**Restore open runs and let their leases expire.** It needs no settlement at boot, and holds each tenant's allowance for a lease interval after a restart for runs that are definitively over. Settling on the way up is both more accurate and prompt.

**Give the child settlement no durable step.** A child's charge reaches its tenant through its root either way, so the child path could write nothing. It cannot: once a parent's credited spend is persisted by a later charge, a child record still present would be counted a second time. The `absorbed` marker is what makes the two orders agree.
