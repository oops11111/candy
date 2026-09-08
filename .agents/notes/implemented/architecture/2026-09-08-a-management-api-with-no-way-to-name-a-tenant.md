# Agent Note: A management API with no way to name a tenant

Status: implemented

English | [中文](2026-09-08-a-management-api-with-no-way-to-name-a-tenant.zh.md)

## Problem

Candy's management operations decide who owns a provider account, which routes a tenant may call, and which workspace a device granted. Each of them needs a tenant, and there were three places one could come from: a `userId` in a path or body, the Harness Host access token, or a browser session.

The first two are not identities. A path parameter is the caller's own claim. The Host token authorizes a process — it is what a launched app proves to reach its own carrier — and every session on that carrier shares it, so a token that establishes a tenant makes every user of the deployment that tenant. The boundaries page had already ruled both out and, with no third option built, concluded that "account, route-policy, device and workspace-grant mutation endpoints remain unavailable until that session authority exists".

That authority exists now. What did not exist was anything that would make it the *only* option: nothing stopped a route from reading `body.userId`, and each route would otherwise decide for itself what a missing record, another tenant's record, and a role refusal answer.

## Decision

One envelope, `registerApiRoute`, and an `Actor` with no constructor a caller can reach.

A handler is given the actor and the parsed body, and nothing else that could carry a tenant. The only way to hold an `Actor` is to have presented a session cookie the store authenticated, so a route that wanted to honour `body.userId` would have to invent its own lookup rather than merely forget a check.

**The order is the contract.** Origin first, so a request that does not address this deployment never reaches a session lookup. Method second, because a route that does not serve it has nothing to authenticate for. Session third — the only source of identity — with CSRF proved in the same call. Role fourth, so an authenticated person of insufficient role gets `403` and not `404`. Body last, bounded, and only for a caller already established as allowed to send one.

**A write must declare its origin.** `Host` is checked on every method and `Origin` additionally on writes, because a browser sends `Origin` on a cross-site write and an exact match is what separates this tenant's own page from a page that merely knows the URL. A write with no `Origin` is refused rather than assumed same-site. An absent session and a failed CSRF proof answer identically: saying which it was reports whether the cookie the caller holds is a live session.

**Another tenant's record is a missing record.** `notFound` is the only way a handler reports a record the actor may not have, and it is answered `404` with no detail. An error that separated "not yours" from "no such id" would confirm the id to whoever guessed it. A role refusal is the deliberate exception: the person is known and the route exists, so `403` tells them something true without confirming any record.

**Every reply is `no-store`,** with framing, sniffing and referrer denied alongside. Each of these is one tenant's data answered on one session; a shared cache or a restored back-forward page would hand it to whoever holds the browser next.

The body cap stops reading rather than closing the socket, and the refusal is answered before the unread remainder is dropped — destroying it first replaces a `413` with a hang-up the client cannot tell from a crash.

## Consequences

Step 3's endpoints, and every management route after them, declare a path, a method set, a least role, an action name and a handler. They cannot answer a status the envelope does not define, cannot report a cross-tenant record distinguishably, and cannot read a tenant from a request.

Twenty-two tests pin it, most against a real `node:http` server: identity comes from the session and the handler sees no other tenant; no session is `401` with the handler never run and nothing filed against a tenant; a member on an administrator route is `403`; a foreign `Host`, a foreign `Origin`, an absent `Origin`, a mismatched CSRF header and an absent one are each refused; an oversized body is `413` and unparseable JSON `400`; an empty write body is not malformed; a method the route does not serve is `405` before authentication; and `no-store` holds however a request ended. Four cases an HTTP client cannot produce — no `Host`, an invalid one, a repeated one, no method — call the handler directly. Mutation checks confirm the three that matter: dropping the `Origin` check, letting a member pass an administrator route, and answering `notFound` distinguishably each fail their own case and nothing else.

The envelope has no routes of its own, one role ladder with no per-operation grant, and no rate limiting — that belongs to the reverse proxy. The audit sink is a parameter, so a deployment that supplies none records nothing.

## Alternatives considered

**Let each route authenticate itself with `authenticateOAuthHttpRequest`.** The function already exists and returns the session, so a route could call it in three lines. Rejected: it makes every route responsible for the same six checks in the same order, and the failure modes are not symmetric — forgetting `Origin` on one write, or answering `403` where another route answers `404`, is invisible until someone reads both. Centralizing them means a new route gets them by construction.

**Let a handler write its own response.** More flexible, and rejected for the same reason: the status codes *are* the security surface here. A handler that can call `response.writeHead` can answer `403` for a record that should read as absent.

**Take the tenant from the path and check it against the session.** A common shape, and rejected: it makes the caller's claim part of the request at all, so the check can be forgotten, and it publishes tenant ids in URLs and logs for no benefit — the session already names exactly one tenant.

**Answer `403` for another tenant's record.** Honest-sounding, and rejected: `403` on a specific id confirms the id exists. The only safe answer is the one a never-issued id gets.
