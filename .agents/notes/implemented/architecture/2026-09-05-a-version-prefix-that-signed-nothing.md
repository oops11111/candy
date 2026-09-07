# Agent Note: A version prefix that signed nothing

Status: implemented

English | [中文](2026-09-05-a-version-prefix-that-signed-nothing.zh.md)

## Problem

An execution assertion is `v1.<payload>.<signature>`, and the prefix carried a stated guarantee: a future claim-set change mints `v2` rather than reinterpreting `v1`.

The signature covered the payload alone. A probe minted a token and recomputed the HMAC two ways:

`{"signatureMatchesPayloadOnly":true,"signatureMatchesVersionAndPayload":false}`

So the prefix was unauthenticated text in front of a signed blob. A signature over the payload alone verifies under any prefix, which means the guarantee the comment stated was not one the construction could make: once a `v2` claim set exists, a `v2` token relabelled `v1` verifies and is then decoded by the `v1` reader — the reinterpretation the version exists to prevent.

There is no `v2` today, so nothing is exploitable now. What is wrong now is that a security contract was written down and not enforced, in the module whose whole job is to decide whose run this is.

## Decision

The MAC covers `${version}.${payload}`. Minting signs the version it stamps, and admission verifies against the version it received, so a reader for a later claim set checks a signature that its own prefix is part of.

The separator is the one the token already uses. Both segments are base64url, so it cannot appear inside either, and no length prefix is needed to keep the boundary unforgeable.

The token format changes, which the pre-release stance permits: a token minted by an older build no longer verifies, and the assertions this signs live for a minute.

## Consequences

The version prefix now means what its comment says. A test pins it directly: a token whose signature covers the payload without its version is refused with `signature`, not admitted.

The negative control is not surgical, and that is worth stating. The test helper builds tokens the way the module does, so reverting the construction fails every helper-built case as well as the binding test. The binding test is the one that isolates the property.

`dsh-client-connection`'s browser-session cookie uses the same `v1.<body>.<signature>` format — this module borrowed it — and signs the body alone. That package is outside this plan, with its own consumers and threat model, so it is recorded here rather than changed alongside.

## Alternatives considered

**Leave it until `v2` exists.** The rule against building for a hypothetical applies to abstractions and options, not to a MAC that already fails to cover a field a reader acts on. The cost is one string concatenation, and the moment a `v2` is written is the moment the old tokens are already in flight.

**Drop the version prefix.** It would remove the false promise instead of keeping it, and leave nothing to distinguish claim sets when one changes — the migration would then have no marker at all.

**Length-prefix the segments.** The `runtime-pool` key does that because its fields are opaque strings that could contain the separator. These cannot: base64url has no `.`, so the boundary is already unforgeable.
