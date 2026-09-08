---
description: "The authenticated envelope every Candy management route is registered through: identity derived only from the session cookie, write protections, role guards, and a failure vocabulary that never distinguishes another tenant's record from a missing one."
kind: "package-library"
---

# @deepseek-ai/dsh-control-plane-api

English | [中文](README.zh.md)

## Summary

Candy's management operations decide who owns a provider account, which routes a tenant may call, and which workspace a device granted. None of those may be driven by anything a caller supplies. The Harness Host access token authorizes a process, not a person, and a `userId` in a path or a body is the caller's own claim.

This module is the one place an HTTP request becomes an [`Actor`](src/types.ts), and the only way to obtain one is to have presented a session cookie [`ControlPlaneStore`](../control-plane-store/README.md) authenticated. A handler receives the actor and the parsed body; it is given no way to read a tenant from anywhere else.

It also owns the failure vocabulary, because failures are where a management API leaks. A record belonging to another tenant answers exactly as a record that does not exist, and a refusal names the step without the token, code, key or provider response that produced it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Registering one route

```ts
import { registerApiRoute } from '@deepseek-ai/dsh-control-plane-api'
import type { ApiHost, ApiWebServer } from '@deepseek-ai/dsh-control-plane-api'

declare const server: ApiWebServer
declare const host: ApiHost
declare function accountsOf(userId: string): Promise<readonly { id: string }[]>

export const dispose = registerApiRoute(server, host, {
  path: '/api/candy/accounts',
  methods: ['GET'],
  role: 'member',
  action: 'accounts.list',
  handle: async actor => ({ kind: 'json', status: 200, body: await accountsOf(actor.userId) }),
})
```

`ApiHost` carries what every route shares: the exact `publicOrigin`, the session authority browser sign-in wrote, an `audit` sink, and an optional `log`.

### Answering

A handler returns one of `json`, `empty`, `notFound`, `forbidden`, or `invalid`. It never writes to the response and never chooses a status for a refusal, so every route reports the same thing the same way.

Return `notFound` for a record the actor may not have. It is answered `404` with no detail — indistinguishable from an id that was never issued.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The envelope, its checks in order, and the reply mapping |
| [`src/types.ts`](src/types.ts) | `Actor`, the rejection and result vocabularies, and the audit event |
| — | No runtime invariant companion is published; this module owns no event stream or mutable runtime data, and its refusals are proved by tests against a real server. |

### The order is the contract

The origin is checked first, so a request that does not address this deployment never reaches a session lookup. The method is checked next, because a route that does not serve it has nothing to authenticate for. The session is derived third — the only source of identity — with CSRF proved in the same step for a write. The role is checked fourth, so an authenticated person of insufficient role is told `403` rather than `404`. The body is read last, bounded, and only for a caller already established as allowed to send one.

### Why a write must declare its origin

`Host` is checked on every method; `Origin` additionally on writes. A browser sends `Origin` on a cross-site write, so an exact match is what separates this tenant's own page from a page that merely knows the URL. A write with no `Origin` at all is refused rather than assumed same-site.

The CSRF cookie and header are proved by [`dsh-oauth-sign-in`](../oauth-sign-in/README.md)'s own check, in the same call that authenticates the session. An absent session and a failed CSRF proof answer identically: telling a caller which of the two it was reports whether the cookie it holds is a live session.

### Why every reply is `no-store`

Each of these is one tenant's data answered on one session. A shared cache or a restored back-forward page would hand it to whoever holds the browser next. The same headers deny the JSON any ability to be framed, sniffed into another type, or to leak its path as a referrer.

### Why the body cap stops reading rather than closing the socket

An oversized body on an authenticated endpoint is a mistake or an attempt to exhaust the process, so reading stops at the cap. The refusal is answered first and the unread remainder dropped after: destroying the socket first would replace a `413` with a hang-up the client cannot tell from a crash.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — why management identity must come from an OAuth-backed server session.
- [`dsh-oauth-sign-in`](../oauth-sign-in/README.md) — the session and CSRF authority this envelope authenticates against.
- [`dsh-oauth-sign-in-web`](../oauth-sign-in-web/README.md) — the plugin that mounts sign-in and establishes the sessions these routes read.
- [A management API with no way to name a tenant](../../../.agents/notes/implemented/architecture/2026-09-08-a-management-api-with-no-way-to-name-a-tenant.md) — why the actor has no constructor a caller can reach.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No routes of its own** — this is the envelope. Every path, method and handler comes from a mounting plugin; nothing here is reachable until one registers something.
- **One role ladder** — `member` and `administrator`, where an administrator satisfies both. There is no per-operation grant, and no way to give one person one extra capability.
- **No rate limiting** — an authenticated caller may call as often as it likes. Bounding that belongs to the reverse proxy in front of the deployment.
- **The audit sink is a parameter** — this module decides what to record and the mounting plugin decides where. A deployment that supplies no sink records nothing.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
