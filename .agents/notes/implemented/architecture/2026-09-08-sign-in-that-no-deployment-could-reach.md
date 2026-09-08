# Agent Note: Sign-in that no deployment could reach

Status: implemented

English | [中文](2026-09-08-sign-in-that-no-deployment-could-reach.zh.md)

## Problem

Candy's browser sign-in was complete and unreachable. `dsh-oauth-sign-in` owned the PKCE callback, the four routes, the session and CSRF cookies and the exact-origin pinning; `createOidcUserInfoProvider` verified an ID Token against a pinned key set; `ControlPlaneStore` held the attempts, the sessions and the identity directory; `dsh-host-webserver` held the socket. Across the whole repository `registerOAuthHttpRoutes`, `createOidcUserInfoProvider` and `enrollOAuthIdentity` had call sites only in their own tests. Nothing composed them, so no deployment could sign a person in.

The directory made it worse than a missing wiring job. Sign-in resolves a verified issuer and subject through `ControlPlaneStore.resolve`, and an empty directory resolves nobody. A deployment that composed the routes correctly and started would refuse every person who arrived — including the operator who has to enroll everyone else. The composition and the first seat are one problem: either alone leaves a server that cannot admit its first user.

## Decision

`dsh-oauth-sign-in-web` is the deployment face: it states the provider facts, mounts the routes on `ctx.webServer`, and enrolls the configured administrator before any route exists.

**The key set is a file path, not inline keys and not discovery.** It is the trust anchor for every ID Token, and an endpoint that can hand a server new signing keys can hand it forged ones. A path also keeps a key blob out of a configuration file read for other reasons, and makes rotation one operator action: publish the new key beside the old one (`kid` selects), reload the entry, drop the old key once the provider stops signing with it. Reloading re-reads the file, so a rotation is not a restart. Unreadable, non-JSON, or empty fails the load.

**The client secret is resolved per exchange, through the credential seam with an environment fallback.** The seam's own rule is that consumers re-resolve at each operation and never cache, which is what lets a rotated secret reach the next sign-in. A deployment that injects the secret as an environment variable composes no credential provider, so `ctx.get('credentials')` is the optional read and `process.env` answers when nothing does. A blank value fails loudly rather than exchanging a code without authentication.

**The administrator is configuration, not a route.** A seat established over HTTP is a seat the first arrival can claim. This one is two configured strings — the provider's exact `sub` and the Candy user it signs in as — applied at load against the issuer this deployment already trusts. The `sub` claim rather than an email or a name, because those are re-assignable at most providers and a re-assignable identity is an inheritable administrator seat.

Three states, and the third is what the rule exists for. Unenrolled is created. Already enrolled as this same user and role is the idempotent case — a redeploy, a restart, a second boot — and changes nothing. Enrolled as anyone else, or as the same person at a lower role, fails the load and files `refused` / `administrator-bootstrap` / `already-enrolled` against that tenant. `enrollOAuthIdentity` writes nothing on a conflict, so without the record the attempt would leave no trace at all; the same-person-lower-role case is the one that matters most, because silently raising it would promote a member by editing a file nobody reviews as an authorization grant.

Both bootstrap keys or neither: half of the pair fails the load, because it would enroll nobody while reading as though it had.

## Consequences

A `cordis.yml` now produces a server a person can sign in to. Eighteen tests pin it, twelve of them against a Loader-booted composition of the real storage stack, the real durable store, the real `dsh-host-webserver` and this plugin, asserted over HTTP against the listening port — `node:http` rather than `fetch`, because the routes are pinned to the exact public authority through the `Host` header and `fetch` forbids setting it, so every case would otherwise be refused for a reason no assertion is about.

Nothing else changed. No route, cookie, verification step or store operation moved into this package; it holds configuration, one file read, one enrollment decision and one secret loader.

What it does not do: there is no discovery, so a provider that moves an endpoint needs configuration updated; one issuer per deployment, so federating two providers has no expression; and enrollment is bootstrap only — adding a second person, changing a role, or removing an identity has no surface, and neither does revoking a session an operator wants gone. Those belong to the authenticated management API, which is the next step and does not exist yet.

Mutation checks confirm the tests carry the rules: accepting any existing enrollment as idempotent fails the conflict case, and accepting an empty key set fails the trust-anchor case.

## Alternatives considered

**Fetch the key set from the provider's `jwks_uri` at load, or run full OIDC discovery.** Rejected for this step: discovery makes the provider's metadata endpoint able to redirect verification at a server that has already started, and it turns a boot into a network dependency. The configured path is the narrower trust relationship, and the rotation procedure it needs is a documented operator action rather than an implicit one.

**Resolve the client secret once at load and capture it.** Simpler, and rejected: it silently breaks the credential seam's re-resolution rule, so a rotated secret would keep failing exchanges until someone restarted the process — with no signal saying why.

**Expose a first-run enrollment route, gated by a one-time token.** Rejected: it puts an administrator seat on the network, and the token becomes a second secret to distribute and revoke. Configuration the operator already writes on that server costs nothing extra and cannot be raced.

**Put the bootstrap in a separate plugin from the route mount.** Rejected: they are one fact — whether this deployment can admit anybody — and splitting them makes it possible to compose a server that mounts sign-in and refuses everyone, which is exactly the state this note exists to remove.
