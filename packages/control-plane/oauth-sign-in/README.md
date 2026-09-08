---
description: "Provider-neutral OAuth PKCE callback completion and Candy authorization mapping."
kind: "package-library"
---

# @deepseek-ai/dsh-oauth-sign-in

English | [中文](README.zh.md)

## Summary

`dsh-oauth-sign-in` consumes one durable PKCE attempt, delegates authorization-code exchange and identity verification to a deployment-selected provider, maps the verified issuer/subject through a Candy-owned directory, and creates a revocable user session. Callback fields never select a Candy user or role.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Implement `OAuthCodeProvider` for the configured issuer and `OAuthIdentityDirectory` for the deployment's enrolled users. Pass both to `completeOAuthSignIn`; invalid state, issuer mismatch, blank verified subject, and unenrolled identity return no session. Exchange failures remain failures so the HTTP owner can report provider unavailability without treating it as an unauthenticated callback.

<a id="understand-the-implementation"></a>
## Understand the implementation

The PKCE attempt is consumed before code exchange. The provider receives only the callback code and server-retained verifier/redirect URI. Its returned issuer must equal both its configured issuer and the transaction issuer before the directory sees the identity. Only the directory returns `UserId` and `ControlPlaneRole`.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-control-plane-store`](../control-plane-store/README.md) owns PKCE attempts and revocable user sessions.
- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) owns browser and control-plane trust rules.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No provider implementation** — the deployment must choose an OAuth issuer and implement its discovery, token exchange, and identity-token validation.
- **No HTTP routes or cookies** — the Web owner still must register start/callback/logout routes and apply secure cookie, cache, referrer, and CSRF response policy.
- **No automatic enrollment** — an unknown external identity is denied. `dsh-control-plane-store` supplies durable exact-once enrollment and directory resolution, while an authenticated provisioning interface remains unbuilt.

<a id="dev-note"></a>
## Dev Note

None.
