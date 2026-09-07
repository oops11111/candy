# Agent Note: Candy runtime-pool partitioning

Status: implemented

English | [中文](2026-09-02-candy-runtime-pool-partitioning.zh.md)

## Problem

[Candy Runtime Boundaries](../../../../docs/candy-runtime-boundaries.md) lets workers share immutable CLI binaries and package caches, and forbids sharing authenticated home directories, writable provider config, environment overlays, process trees, session stores, private caches, or workspace mounts across `userId + provider + accountId`. Nothing expressed that key, so every later package would have derived its own answer to "may these two runs share this directory", and the first one to spell a tenant id into a path would have opened a hole: tenant and account ids are opaque strings this repository does not constrain, and a path built from them can traverse out of its base with `../`, exceed a platform path limit, or — on a case-insensitive filesystem — fold two tenants whose ids differ only in case onto one directory.

## Decision

`@deepseek-ai/dsh-runtime-pool` (`packages/control-plane/runtime-pool`) owns the key and the directory. `runtimePoolKey` digests the identity triple into 64 lowercase hex characters; `runtimePoolRoot` places a pool directly under an absolute base, joining it in the base's own POSIX or Win32 syntax so a control plane resolves a pool root for a host whose separator is not its own. The digest's inputs are length-prefixed, so `('ab', 'c')` and `('a', 'bc')` cannot collide by shifting a field boundary, and hex has none of the traversal, length, or case-folding properties that make raw ids unsafe as path segments.

`RuntimePoolKey` has no free-form constructor. The only ways to hold one are `runtimePoolKey`, which mints it, and `parseRuntimePoolKey`, which checks the grammar before re-admitting a stored key. Containment is therefore a property of the type rather than a check each call site repeats: `runtimePoolRoot` cannot be handed a key that escapes its base. Unlike the opaque ids in `dsh-control-plane`, validating here is founded rather than invented, because the grammar is this package's own digest.

`ProviderKind` is the closed set `deepseek-api | claude-cli | codex-cli`. This reverses a limitation `dsh-control-plane`'s README recorded, which said inventing a provider representation would anticipate the R2 adapter design. That reasoning was too broad: the delivery plan names exactly these three providers, so the *kind* is derivable from accepted documentation, and it is separable from the adapter design — streaming, tool calls, cancellation, and error mapping remain entirely R2's. That README now points here instead.

Nothing in the package touches the filesystem. It derives paths; creating, populating, permissioning, and removing them belongs to the runtime that manages pools.

## Alternatives considered

**Spell the triple into the path, sanitizing the ids.** The obvious approach, and it needs a sanitizer that is simultaneously injective and filesystem-safe on every target. Percent-encoding `/` and `..` still leaves case folding and path-length limits, and any escaping scheme has to be proven collision-free for arbitrary Unicode. A digest gets all three properties without an argument about the escaping.

**Keep a readable directory name alongside the digest** (`<digest>-user-alice`). Better for an operator reading `ls`, and rejected because the readable half reintroduces exactly the traversal, length, and case problems the digest exists to avoid. An operator mapping a directory back to a tenant should read a record inside it, which the pool owner can write.

**Put the key in `dsh-control-plane` beside the ids.** Rejected: that package advertises a dependency-free identity vocabulary, and the key needs `node:crypto` and a `ProviderKind`, which would give one package two reasons to change.

**Also derive a subdirectory layout** (`home/`, `cache/`, `sessions/`). Tempting because the boundaries page enumerates what must be partitioned, but every name would be invented before a consumer needed it. The package names one root and leaves its interior to the owner.

**Enforce quotas, process ownership, and cleanup here.** These are the rest of the same delivery-plan bullet, and they need a scheduler, a session store, and filesystem ownership that R1 has not built. Supplying the key they will all partition by is the part that can be correct on its own.

## Consequences

Every later package now shares one answer to what a pool may share and where its private state lives, and two tenants cannot reach one directory even when their ids differ only in case or carry path syntax. Unit coverage pins stability, the hex grammar, separation by each of the three fields, the case and field-boundary collisions, an id carrying `../` reducing to plain hex, the stored-key grammar, and a root staying under its base.

This completes R1's four bullets, but the partitioning it delivers is derivation only: no directory is created, no quota is enforced, no process is placed, and no pool is ever cleaned up. Those remain with the runtime that manages pools, and are recorded in the package README so the gap is not mistaken for enforcement. The `ProviderKind` set is now a plan-level fact rather than a configuration value — a fourth provider is a delivery-plan change that touches this union, which is deliberate: adding one silently would give a pool key a meaning no accepted document names.
