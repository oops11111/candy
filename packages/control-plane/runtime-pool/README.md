---
description: "The Candy runtime-pool key and the one directory a pool owns: a collision-free, traversal-safe root per tenant, provider, and provider account."
kind: "package-library"
---

# @deepseek-ai/dsh-runtime-pool

English | [中文](README.zh.md)

## Summary

`dsh-runtime-pool` answers one question the same way for every later package: which runtime state may be shared, and where does a pool's private state live. `runtimePoolKey` turns a tenant, provider, and provider account into one isolation key, and `runtimePoolRoot` turns that key into the single directory the pool owns. The key is a lowercase hex digest rather than the triple's text, so two tenants can never land in one directory and no opaque id can traverse out of the base. This is a plain module with no Cordis service and no filesystem access: it derives paths, and the runtime that creates, populates, and removes them owns doing so.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Deriving a pool's key and directory

```ts
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import { runtimePoolKey, runtimePoolRoot } from '@deepseek-ai/dsh-runtime-pool'

const key = runtimePoolKey({
  userId: UserId('user-1'),
  provider: 'claude-cli',
  accountId: ProviderAccountId('account-1'),
})

export const root = runtimePoolRoot('/srv/candy/pools', key)
```

`provider` is a `ProviderKind` from [`dsh-control-plane`](../control-plane/README.md): one of `deepseek-api`, `claude-cli`, or `codex-cli`, a closed set because the delivery plan names exactly those three. It lives there rather than here because an account, an assertion, and a pool all name it. The base must be absolute in POSIX or Win32 syntax, and the base's own syntax decides how the path is joined — a control plane on Linux resolves a Windows host's pool root, where this platform's `path.join` would produce the other separator. A base absolute in neither syntax throws rather than being resolved against a working directory.

### Creating a pool's directory

```ts
import { openRuntimePool, runtimePoolKey } from '@deepseek-ai/dsh-runtime-pool'
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'

const pool = runtimePoolKey({
  userId: UserId('user-1'),
  provider: 'claude-cli',
  accountId: ProviderAccountId('account-1'),
})

export const home = await openRuntimePool('/srv/candy/pools', pool)
```

The permissions are applied, not requested. `mkdir` sets a mode only on a directory it creates, so a pool root left behind by an earlier run, an operator, or a different umask keeps whatever permissions it already had, and the next run writes the tenant's provider credential into it. The explicit change afterwards is what makes `0o700` true of the directory the call returns rather than only of a directory it happened to create.

The base is never created. A pool base that does not exist means the deployment never provisioned its storage, and inventing the whole tree under a mistyped path with whatever permissions its ancestors imply hides that instead of reporting it, so a missing base throws. Provisioning the base and deciding who may write inside it stay with the deployment: no pool can be private to its tenant if another local account can create directories beside it.

Opening a pool that already exists is how a second run joins it, so the call is idempotent and keeps what the pool holds.

### What belongs under the root, and what does not

Everything private to one pool goes under its root: the authenticated provider home, writable provider config, environment overlays, private caches, and session state. Immutable CLI binaries and shared package caches stay outside it — those are what pools are allowed to share.

### Reading a key back from storage

```ts
import { parseRuntimePoolKey } from '@deepseek-ai/dsh-runtime-pool'

declare const stored: string

const key = parseRuntimePoolKey(stored)
export const usable = key === undefined ? 'reject the record' : key
```

A stored key arrives as ordinary text, so it is checked against the grammar a mint produces before it becomes a `RuntimePoolKey` again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `RuntimePoolIdentity`, `RuntimePoolKey`, `runtimePoolKey`, `parseRuntimePoolKey`, and `runtimePoolRoot` |
| — | No runtime invariant companion is published; this pure module owns no event stream or mutable runtime data; its key algebra is enforced by unit tests. |

### Why the key is a digest and not the triple

Tenant and account ids are opaque strings this repository does not constrain. Spelled into a path directly, one could traverse out of the base with `../`, exceed a platform path limit, or — on a case-insensitive filesystem — fold two tenants whose ids differ only in case onto one directory, which is a cross-tenant leak that no later check would notice. A 64-character lowercase hex digest has none of those properties.

The digest's inputs are length-prefixed, so no two distinct triples can collide by shifting a boundary between fields: `('ab', 'c')` and `('a', 'bc')` digest differently.

### Why there is no free-form key constructor

`RuntimePoolKey` can only be obtained from `runtimePoolKey`, which mints it, or `parseRuntimePoolKey`, which checks the grammar first. Because no constructor admits arbitrary text, `runtimePoolRoot` cannot be handed a key that escapes its base — the containment is a property of the type rather than a check every call site has to repeat.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the isolation rule this package implements and the ids it keys on.

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — what pools may and may not share, and the process-escape and path-traversal abuse cases this containment closes.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the proposed R1–R6 delivery plan; this package is R1's pool-key partitioning bullet.
- [`dsh-control-plane`](../control-plane/README.md) — the `UserId` and `ProviderAccountId` a pool identity is made of.
- [`dsh-credential-vault`](../credential-vault/README.md) — the secrets a pool's provider process authenticates with, which are never shared across pools.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Pools are created, never removed** — `openRuntimePool` creates one pool root and makes it private; ownership, quota, and cleanup on pool retirement belong to the runtime that manages pools. `runtimePoolRoot` remains a pure derivation for a caller that only needs the path.
- **The pool base's own permissions are not checked** — a base another local account can write to lets that account create or replace a pool root before this package ever sees it, and no mode this call sets afterwards recovers from that. Provisioning the base privately is the deployment's, and on Windows it is `dsh-sandbox-windows-acl`'s, since POSIX mode bits do not describe that platform's access control.
- **No quota, process, or event-log enforcement** — the boundaries page also partitions quotas, process ownership, and event logs by pool key. This package supplies the key those partitions share; enforcing them needs the scheduler and session store that R1 has not built.
- **No environment overlay** — which variables a pool's provider process receives, including where its home points, is provider-specific and belongs to the R2 adapters.
- **A subdirectory layout is deliberately absent** — the package names one root per pool and leaves its interior to the owner, so a taxonomy is not invented before a consumer needs one.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly, like `dsh-brand`.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
