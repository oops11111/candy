# Agent Note: A backup nobody had taken

Status: implemented

English | [中文](2026-09-11-a-backup-nobody-had-taken.zh.md)

## Problem

The Debian deployment page told an operator how to back up the control plane and nobody had ever run it.

Two things were wrong with what it said. It told them to run `sudo -u candy sqlite3 ... ".backup ..."`, and nothing in the install steps installs the `sqlite3` package — so an operator following the page verbatim reaches `command not found` at the moment they most need a backup. And it justified the advice with "a copy taken mid-write is a file that opens and is missing rows", which understates what actually happens: the SQLite backend runs WAL by default, so commits live in the `-wal` file until a checkpoint folds them in, and a `cp` of the database alone on a young database is a file with no tables in it at all.

The restore half was equally unexercised. The page tells an operator to put the file back and start the service, and nothing had ever booted the runtime over a restored database to find out whether it answers.

R6 asks for a rollback drill. A documented procedure nobody has performed is the thing a drill exists to catch.

## Decision

Ship a backup tool the deployment already has what to run, and perform the drill as a test.

`packages/bundle/candy-app/deploy/candy-backup.mjs` takes the online backup through `node:sqlite`'s `backup()`. The service is a Node process and the storage backend is `node:sqlite`, so the copy is made by the same library and the same runtime that own the database, and the `sqlite3` package stops being an unlisted prerequisite. Two properties beyond copying pages are deliberate: the destination is written under a temporary name in its own directory and renamed only once the copy finishes, so an interrupted backup leaves no file that looks complete; and the source is opened read-only, so a mistyped path is an error rather than a newly created empty database that would restore over a real one.

`packages/bundle/candy-app/tests/rollback-drill.spec.ts` performs the drill. It boots the store over a real SQLite file, starts writers that do not stop — each one a queued read-modify-write through the real store — takes the backup while they run, then disposes everything, copies the backup into place, and boots again over the restore. What the restore has to answer is not that the file opens: it is that the accounts are all there and that a sealed credential still opens under the same keyring, which is the difference between readable and usable.

The WAL finding is pinned rather than described. One case writes twenty-four accounts, copies the database file alone, takes an online backup at the same moment, and asserts the online copy holds all twenty-four while the file copy holds fewer. On a database that young the file copy holds none, and the assertion is the inequality rather than zero, because a checkpoint that happened to land would make zero wrong without making the advice wrong.

Both documentation pages now name the tool, state why it needs nothing extra, and say plainly what copying the file loses.

## Alternatives considered

**Add `sqlite3` to the install steps.** Rejected. It adds a package whose version is unrelated to the one the service writes with, and a backup taken by a different SQLite than the writer is a thing to reason about during an incident. The runtime already carries the capability.

**Keep `cp` and document a checkpoint first.** Rejected: it turns one command into a sequence with a window, and the window is exactly when an operator is under pressure. `PRAGMA wal_checkpoint` also has to be run against the live database by something holding a connection, which is the online backup's job anyway.

**Assert that a mid-write `cp` is corrupt.** Rejected as a flaky claim. Whether a racing copy lands corrupt depends on timing. The WAL fact is deterministic — uncheckpointed commits are simply not in the file — so that is what the case pins.

**Write the tool in TypeScript beside the other repo scripts.** Rejected because the operator's machine may be an unpacked build rather than a checkout with `tsx` installed. A `.mjs` run by the service's own Node needs no build step and no dev dependency, which is the precedent `subprocess-local`'s spawn helper already sets.

**Take the backup from inside the running service on a timer.** Rejected for this slice. Where backups are stored, how long they are kept and when they run are the deployment's decisions, not the runtime's, and a service that writes its own backups needs somewhere to put them that this page does not yet specify.

## Consequences

An operator can take a consistent backup with what the install already put on the machine, and the restore path is one that has been executed rather than written down. The drill runs in CI with the rest of the bundle suite, so a change that breaks restore — a schema version bump that the store refuses to open, a backend that stops answering after a restore — fails there rather than during a rollback.

The page's own claim is now weaker in one place and stronger in another: it no longer says a file copy is merely missing rows, and it no longer implies `sqlite3` is available.

What this does not do is cover the rest of the R6 bullet. There is no feature flag, no provider canary, no resource monitoring, and no security alerting; the drill proves the database half of a rollback and says nothing about rolling back the `/opt/candy` tree, which the page still handles by keeping the previous one. The credential-key caveat already on the page remains the one thing a restore must not roll back blindly, and nothing enforces that.

## Verification

`packages/bundle/candy-app/tests/rollback-drill.spec.ts` passes: a backup taken during continuous writes holds a point-in-time subset of what was written, a restore of it boots and answers with every account it captured and a credential that still opens, a file copy under WAL holds strictly fewer accounts than the online backup taken beside it, an absent source is an error that writes no destination, and no arguments reports usage.

Two mutation controls establish that the tool's own properties are load-bearing: replacing the online backup with `copyFileSync` fails two cases, and opening the source writable instead of read-only fails the absent-source case before the implementation is restored.
