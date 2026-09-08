# Agent Note: An OIDC flow with no nonce

Status: implemented

English | [中文](2026-09-08-an-oidc-flow-with-no-nonce.zh.md)

## Problem

Candy's durable OAuth transaction bound the callback to state, PKCE verifier, issuer, and redirect URI, but it carried no OIDC nonce. A provider adapter could therefore validate an ID Token's signature and audience without proving that the token belonged to the browser authorization Candy had just started. Calling UserInfo alone would not repair that gap: OpenID Connect requires its subject to match the verified ID Token subject to prevent token substitution.

## Decision

`ControlPlaneStore.beginOAuthAttempt` now creates an independent 256-bit nonce beside state and the PKCE verifier. The nonce is durable, survives a restart, appears in the authorization URL, and returns only after the matching state is atomically consumed. `completeOAuthSignIn` passes it directly to the deployment verifier; it is never accepted from callback input.

The stored field is optional only for media compatibility. Consuming an older record with no nonce removes it and returns nothing, so a pre-change transaction fails closed. The control-plane domain stays at version 8 rather than discarding unrelated account, grant, run, and audit data for a record whose maximum lifetime is minutes.

## Alternatives considered

**Trust UserInfo without an ID Token.** Rejected because a bearer-token substitution can return a different subject unless it is compared with a verified ID Token.

**Use state as nonce.** Rejected because the two values protect different protocol boundaries and independent random values avoid turning one disclosure into both proofs.

**Bump the whole control-plane domain version.** Rejected because it would invalidate long-lived tenant data to remove only short-lived attempts; fail-closed optional decoding gives the same authentication safety without that loss.

## Consequences

A concrete OIDC adapter can now verify issuer, audience, signature, expiry, nonce, and the UserInfo/ID Token subject match. Existing in-flight attempts created before this change must restart login. SQLite restart coverage and the OAuth route suite prove nonce persistence, authorization URL binding, and provider-only delivery; a real provider canary remains outstanding.
