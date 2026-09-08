# Agent Note: OIDC identity ends at two matching subjects

Status: implemented

English | [中文](2026-09-08-oidc-userinfo-provider.zh.md)

## Problem

The OAuth orchestration deliberately accepted a provider interface rather than guessing an issuer, but no implementation could yet turn a real authorization code into a verified identity. A minimal adapter that trusted the token endpoint or UserInfo alone would make the new route operational while leaving the identity boundary assumed.

## Decision

`createOidcUserInfoProvider` implements Authorization Code + PKCE against fixed HTTPS endpoints and deployment-supplied JWKs. It verifies the ID Token's asymmetric signature, issuer, audience, expiry, issued-at, nonce, and authorized party before calling UserInfo. The UserInfo subject must exactly equal the verified ID Token subject; an optional UserInfo issuer must equal the configured issuer. Only that pair becomes `OAuthIdentity`.

Token and UserInfo calls forbid redirects, impose independent deadlines and byte ceilings, require JSON objects, and never include provider bodies or credentials in errors. A confidential-client secret comes from a loader called only during exchange and is sent with OAuth HTTP Basic encoding; a public PKCE client sends its client id in the form body.

Trusted metadata and JWKs remain deployment inputs. Automatic discovery and remote-key refresh would add a second network trust and cache lifecycle to login; those belong to the deployment composition that chooses its issuer and rotation policy.

## Alternatives considered

**Use UserInfo without verifying an ID Token.** Rejected because OpenID Connect explicitly requires the two subjects to match to prevent token substitution.

**Accept every JOSE algorithm supported by the key.** Rejected because authentication policy must not expand when a library or JWK changes. The adapter accepts only configured members of its asymmetric allowlist.

**Fetch discovery and JWKs inside each login.** Rejected because a provider outage or metadata redirect would become an unbounded authentication-policy update. The adapter is deterministic over trusted deployment inputs.

## Consequences

Candy now has a concrete standards-based provider without binding product identity to one vendor. Key rotation requires reloading a new verified JWK set, and the shipped Web profile still needs an issuer-specific composition plus initial enrollment. Tests use real ES256 signing and cover nonce, audience, authorized-party, subject-substitution, client authentication, response limits, HTTPS-only endpoints, and redirect refusal; a real issuer canary remains R6 work.
