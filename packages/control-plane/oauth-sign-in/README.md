---
description: "Provider-neutral OAuth PKCE callback completion and Candy authorization mapping."
kind: "package-library"
---

# @deepseek-ai/dsh-oauth-sign-in

English | [中文](README.zh.md)

## Summary

`dsh-oauth-sign-in` consumes one durable PKCE attempt, delegates authorization-code exchange and identity verification to a deployment-selected provider, maps the verified issuer/subject through a Candy-owned directory, and creates a revocable user session. It also registers the public Host routes that start and complete login, reads and revokes sessions through host-only secure session/CSRF cookies, and never accepts user or role fields from the browser.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Implement `OAuthCodeProvider` for the configured issuer and `OAuthIdentityDirectory` for the deployment's enrolled users. Pass both to `completeOAuthSignIn`; invalid state, issuer mismatch, blank verified subject, and unenrolled identity return no session. Exchange failures remain failures so the HTTP owner can report provider unavailability without treating it as an unauthenticated callback.

For the browser surface, implement `OAuthWebProvider.authorizationUrl` and call `registerOAuthHttpRoutes` with the real Host `WebServer`, `ControlPlaneStore`, and a fixed `publicOrigin`. The registrar owns four exact paths: `GET /auth/oauth/start`, `GET /auth/oauth/callback`, `GET /auth/session`, and `POST /auth/logout`. It returns one disposer that removes all four registrations.

<a id="understand-the-implementation"></a>
## Understand the implementation

The PKCE attempt is consumed before code exchange. The provider receives only the callback code and server-retained verifier/redirect URI. Its returned issuer must equal both its configured issuer and the transaction issuer before the directory sees the identity. Only the directory returns `UserId` and `ControlPlaneRole`.

`oauthSessionCookies` writes the bearer as `__Host-candy-session` with `Secure`, `HttpOnly`, `Path=/`, and `SameSite=Lax`; the independent readable `__Host-candy-csrf` uses `Secure`, `Path=/`, and `SameSite=Strict`. `authenticateOAuthHttpRequest` obtains identity only from the active bearer record and additionally requires the CSRF cookie, matching request header, and stored CSRF digest for every method except GET, HEAD, and OPTIONS.

The route registrar pins every request to the configured public authority instead of trusting an arbitrary `Host`. Start creates the state and S256 challenge in the durable store, then verifies that the provider's authorization URL retained the exact state, challenge, challenge method, and callback URI. Callback responses consume state before exchange, set both cookies, and redirect only to a configured same-origin path. Session responses expose only Candy user id, role, and expiry. Logout requires the exact public `Origin`, the double-submit CSRF proof, and server-side revocation. All paths emit no-store, no-referrer, no-sniff, and restrictive CSP headers; malformed input and provider failures receive bounded generic responses.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-control-plane-store`](../control-plane-store/README.md) owns PKCE attempts and revocable user sessions.
- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) owns browser and control-plane trust rules.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No provider implementation** — the deployment must choose an OAuth issuer and implement its discovery, token exchange, and identity-token validation.
- **No deployment composition** — the package supplies all four route registrations, but the shipped Web profile does not mount them until a concrete `OAuthWebProvider` and public origin are configured.
- **No automatic enrollment** — an unknown external identity is denied. `dsh-control-plane-store` supplies durable exact-once enrollment and directory resolution, while an authenticated provisioning interface remains unbuilt.

<a id="dev-note"></a>
## Dev Note

None.
