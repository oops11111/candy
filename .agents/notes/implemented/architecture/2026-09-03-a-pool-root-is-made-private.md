# Agent Note: A pool root is made private, not asked to be

Status: implemented

English | [中文](2026-09-03-a-pool-root-is-made-private.zh.md)

## Problem

`dsh-runtime-pool` derived a pool's directory and stopped there, and its README said so: paths are derived, never created. Creating them was left to "the runtime that manages pools", which does not exist yet. So every caller that actually launched a provider process created the directory itself, and four process tests in `dsh-claude-cli-binding` had grown the same line, with a comment naming the gap: a launch into a directory nobody made fails at spawn.

The line they had all written was wrong in the same way. `mkdir(root, { recursive: true, mode: 0o700 })` applies a mode only to a directory it creates. A pool root that already exists — left by an earlier run, made by an operator, created under a different umask — keeps whatever permissions it has, and `mkdir` succeeds silently. The pool root is the provider's authenticated home, so the next run writes the tenant's API key into a directory another local account may be able to read. Nothing reported it, because nothing failed.

`recursive: true` was the second half. It invented every missing ancestor, so a mistyped pool base produced a working pool under a path nobody provisioned, with whatever permissions those ancestors implied. The fixtures depended on exactly that: none of them had ever created its own pool base, and adding the guard is what revealed it.

The repository already knew the correct shape. `dsh-attachment-local` and `dsh-fs-local` both pair the `mkdir` with an explicit `chmod` for this reason. The pool root, which holds a credential, did not.

## Decision

`openRuntimePool(base, key)` creates one pool root and makes it `0o700`, applying the mode with a `chmod` after the create so it is true of the directory returned rather than only of a directory the call happened to create. Opening an existing pool is how a second run joins it, so the call is idempotent and keeps what the pool holds.

The base is never created. A pool base that does not exist means the deployment never provisioned its storage, and a missing base now throws instead of being invented.

The base's own permissions are not checked, and that is a limitation rather than an oversight. A base another local account can write to lets that account create or replace a pool root before this package sees it, and no mode set afterwards recovers from that. Checking it would mean reading POSIX mode bits, which do not describe Windows access control at all — that platform's answer is `dsh-sandbox-windows-acl`. Refusing on a value this package cannot interpret on every platform it runs on would be a check that means one thing on Linux and nothing on Windows, so the obligation is documented and left with the deployment.

`runtimePoolRoot` stays a pure derivation. A control plane on Linux resolves a Windows host's pool root without creating anything, and that caller must not be made to touch a filesystem.

## Consequences

The four hand-rolled copies are gone; the process tests call the same function a deployment would, so what they prove about tenant isolation is a property of shipped code.

A deployment must provision its pool base. That is a new failure at first use, and it is the intended one: it names the base, which is what an operator has to fix.

## Alternatives considered

**Keep the mode on `mkdir` and drop the `chmod`.** That is the code every caller had already written and the exact hole: the mode never reaches a directory that already exists, which is the case that matters, because a pool root that already exists is one a previous run put a credential in.

**Verify the mode with a `stat` and refuse a wrong one.** Refusing leaves the deployment with a broken pool and a message, where correcting it leaves a working private pool. There is nothing here two observers could disagree about, so there is no divergence for a check to catch.

**Create the base as well, with `recursive: true`.** It is what the fixtures relied on, and it converts a mistyped path into a silently working one. The cost of failing loudly is one error the first time a deployment runs; the cost of the alternative is a tenant's home under a path nobody meant.
