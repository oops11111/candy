# Agent Note: A link where a pool root goes

Status: implemented

English | [中文](2026-09-04-a-link-where-a-pool-root-goes.zh.md)

## Problem

`openRuntimePool` tolerated `EEXIST` so a second run could join a pool an earlier one made, then applied `0o700` with an explicit `chmod`. `chmod` follows a symlink.

So an entry planted where a pool root goes was accepted as that pool: the mode change landed on the link's target, and the call returned the path as though it had made a fresh private directory. That path becomes the provider process's `HOME` and working directory, so the tenant's credential is written inside it. Run against the built package, a symlink to another directory came back accepted, with the target's mode silently changed from 755 to 700.

The dangerous target is another tenant's pool root. It is owned by the same account this runtime runs as, so the `chmod` succeeds where it would fail with `EPERM` against a stranger's directory — the one case with no incidental defence is exactly the cross-tenant redirect this package exists to prevent.

[docs/defensive-patterns.md](../../../../docs/defensive-patterns.md) names this pattern twice, under unlinking link-shaped paths and under predictable paths inviting symlink races. Pool roots are maximally predictable by design: the name is a digest of the tenant, provider and account, and it has to be, because a second run finds its pool by recomputing it.

## Decision

What already exists in the pool's place must be a real directory. `lstat` describes the entry itself rather than what it points at, so a symlink is seen; anything that is not a directory is refused by name.

The check goes after the create rather than before it. A check first would be a race — the entry can change between the look and the `mkdir` — while `mkdir` either wins the creation outright or reports `EEXIST`, and the `lstat` then describes whatever was actually there.

The refusal is an `Error` rather than the `RangeError` this function throws for its arguments. A caller passed nothing wrong; the filesystem holds something that is not this pool.

## Consequences

A planted link fails the run instead of redirecting it, and its target keeps its permissions.

The package's known limitation about the pool base is narrower and more accurate than it was. A base another account can write to still defeats it in one case — a real directory that account creates and this runtime owns, indistinguishable from one an earlier run left — but a link or any non-directory is refused, and a directory owned by someone else fails the mode change with `EPERM`.

## Alternatives considered

**`lstat` before the `mkdir`.** It reads the state it does not then hold: an attacker can replace the entry between the check and the create. Checking after the create narrows the window to what `mkdir` itself resolved.

**Unlink a link and carry on, as the defensive-patterns page does for temp paths.** A stale temp file is this package's to clean up; a link inside a deployment's pool base is not, and quietly deleting it destroys evidence of the attempt while leaving the deployment's real problem — a writable base — in place.

**Resolve the path with `realpath` and check containment instead.** It answers a different question, and it accepts a link that happens to stay inside the base. Two tenants' pool roots are both inside the base, so containment does not separate them.
