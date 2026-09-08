---
description: "Mounts Candy browser sign-in on the Harness Host web server from a deployment's own OIDC facts, and enrolls the first administrator offline so a correctly configured deployment does not refuse everybody."
kind: "package-reference"
---

# @deepseek-ai/dsh-oauth-sign-in-web

English | [中文](README.zh.md)

## Summary

Everything this plugin composes already existed as a library. [`dsh-oauth-sign-in`](../oauth-sign-in/README.md) owns the PKCE callback, the session cookies and the four browser routes; `createOidcUserInfoProvider` owns ID Token verification; [`dsh-control-plane-store`](../control-plane-store/README.md) owns the durable attempts, sessions and identity directory; [`dsh-host-webserver`](../../host/webserver/README.md) owns the socket. What did not exist was a composition: every one of those was reachable only from a test, so no deployment could sign a person in.

It also enrolls the first administrator, because the identity directory is the other half of the same problem. Sign-in resolves a verified issuer and subject through the directory, and an empty directory resolves nobody — a correctly configured deployment would refuse every person who signed in, including the operator who has to enroll the rest. There is deliberately no self-service path to that first seat: it is a fact an operator states offline, by exact issuer and subject.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Composing it

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '0.0.0.0'
    port: 8787
- id: control-plane-store
  name: '@deepseek-ai/dsh-control-plane-store'
- id: oauth-sign-in-web
  name: '@deepseek-ai/dsh-oauth-sign-in-web'
  config:
    publicOrigin: 'https://candy.example'
    issuer: 'https://identity.example'
    authorizationEndpoint: 'https://identity.example/authorize'
    tokenEndpoint: 'https://identity.example/token'
    userInfoEndpoint: 'https://identity.example/userinfo'
    clientId: 'candy-debian'
    jwksPath: '/etc/candy/oidc-jwks.json'
    clientSecretEnv: 'CANDY_OIDC_CLIENT_SECRET'
```

The four routes it mounts are `dsh-oauth-sign-in`'s: `/auth/oauth/start`, `/auth/oauth/callback`, `/auth/session` and `/auth/logout`. Every one is pinned to the exact `publicOrigin` authority.

### Enrolling the first administrator

```yaml
    bootstrapAdministratorSubject: '8f1c2a54-0b7e-4f2d-9a31-6b0f2c7d4e58'
    bootstrapAdministratorUserId: 'user-alice'
```

Both keys or neither: half of the pair fails the load, because it would enroll nobody while reading as if it had. The subject is the provider's `sub` claim rather than an email or a name, since those are re-assignable at most providers and a re-assignable identity is an administrator seat that can be inherited.

Re-stating the same fact on a redeploy changes nothing. Stating a different user, or the same user at a lower role, fails the load and records a `refused` / `administrator-bootstrap` / `already-enrolled` entry in that tenant's audit trail — the store writes nothing on a conflict, so the trail is where the attempt survives at all.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The plugin config, the JWKS read, the administrator enrollment, and the client-secret loader |
| — | No runtime invariant companion is published; this plugin owns no event stream or mutable runtime data, and its composition is proved by a real Loader/Host test. |

### Why the key set is a file path

The JSON Web Key Set is this deployment's trust anchor for every ID Token, and no discovery request is made for it: an endpoint that can hand a server new signing keys can hand it forged ones. A path keeps a key blob out of a configuration file read for other reasons, and it makes rotation an operator action on one file.

**Rotation.** Publish the new key beside the old one in the file — a set may hold several, and `kid` selects — reload the plugin, and remove the old key once the provider has stopped signing with it. Reloading the entry re-reads the file, so no restart is involved. A file that cannot be read, is not JSON, or holds no key fails the load rather than mounting sign-in that verifies nothing.

### Why the client secret is read per exchange

The credential seam's own rule is that a consumer re-resolves at each operation and never caches across operations; that is what lets a rotated secret reach the next sign-in without a restart. `clientSecretLoader` reads the credential service when a deployment composes one and the process environment when it does not, and fails loudly rather than exchanging a code with a blank secret. The value is never logged and never leaves the token request.

### Why the enrollment is not a route

An administrator seat established over HTTP is a seat the first arrival can claim. This one is configuration an operator writes on the server, verified against the exact issuer this deployment already trusts, and applied before any route is mounted.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — why management identity must come from an OAuth-backed server session rather than a Host token.
- [`dsh-oauth-sign-in`](../oauth-sign-in/README.md) — the routes, cookies and callback this plugin mounts.
- [`dsh-control-plane-store`](../control-plane-store/README.md) — the durable attempts, sessions and identity directory behind them.
- [Sign-in that no deployment could reach](../../../.agents/notes/implemented/architecture/2026-09-08-sign-in-that-no-deployment-could-reach.md) — why the composition and the first seat are one plugin.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **No OIDC discovery** — every endpoint and the key set are configured. A provider that moves an endpoint or rotates a key needs the file and the configuration updated, per the rotation note above.
- **One provider per deployment** — a single issuer is configured, so a deployment that federates two identity providers has no way to state the second.
- **Enrollment is bootstrap only** — this plugin creates one seat from configuration. Enrolling anyone else, changing a role, or removing an identity has no surface yet; those belong to the authenticated management API.
- **Nothing revokes a session here** — the store can revoke one and the logout route uses it, but no operator surface reaches it.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
