---
description: "Provider-neutral OAuth PKCE callback completion and Candy authorization mapping."
kind: "package-library"
---

# @deepseek-ai/dsh-oauth-sign-in

English | [中文](README.zh.md)

## Summary

`dsh-oauth-sign-in` consumes one durable PKCE attempt, delegates authorization-code exchange and identity verification to a deployment-selected provider, maps the verified issuer/subject through a Candy-owned directory, and creates a revocable user session. It also serializes host-only secure session/CSRF cookies and authenticates HTTP requests without accepting user or role fields from the browser.

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

`oauthSessionCookies` writes the bearer as `__Host-candy-session` with `Secure`, `HttpOnly`, `Path=/`, and `SameSite=Lax`; the independent readable `__Host-candy-csrf` uses `Secure`, `Path=/`, and `SameSite=Strict`. `authenticateOAuthHttpRequest` obtains identity only from the active bearer record and additionally requires the CSRF cookie, matching request header, and stored CSRF digest for every method except GET, HEAD, and OPTIONS.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-control-plane-store`](../control-plane-store/README.md) owns PKCE attempts and revocable user sessions.
- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) owns browser and control-plane trust rules.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No provider implementation** — the deployment must choose an OAuth issuer and implement its discovery, token exchange, and identity-token validation.
- **No HTTP route registration** — the Web owner still must register start/callback/logout routes, pass their exact headers into these helpers, and apply no-store, referrer, origin, body, and response limits.
- **No automatic enrollment** — an unknown external identity is denied. `dsh-control-plane-store` supplies durable exact-once enrollment and directory resolution, while an authenticated provisioning interface remains unbuilt.

<a id="dev-note"></a>
## Dev Note

None.
