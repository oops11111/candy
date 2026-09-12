# Agent Note: A token no route accepted

Status: implemented

English | [中文](2026-09-12-a-token-no-route-accepted.zh.md)

## Problem

Device pairing returned a 256-bit token and the host binding stored it, but no server route accepted that token. Revoking a device affected run admission only after some other authority had already minted an assertion. A host could neither prove its stored binding still stood nor distinguish revocation from the absence of any authentication protocol.

The inherited Remote Gateway owns WebSocket transport, reconnect, and offline state. Adding another connection state machine in Candy would duplicate that ownership without making the token authoritative.

## Decision

`dsh-device-api` exposes `GET /api/candy/devices/authenticate`. A host presents the device token in the `Authorization: Bearer` header. A live token returns only its `deviceId` and `userId`; an absent, malformed, unknown, or revoked token receives the same empty `401`. The route never returns or logs a token. A revoked token retains its device record inside `authenticateDevice`, allowing the tenant audit to record the withdrawn host without revealing that distinction to the caller.

`dsh-device-binding.verify` performs one request to that endpoint and confirms that the reply names the exact tenant and device stored locally. It returns false only when no local binding exists or the server returns `401`. Network failures remain errors for the inherited connection owner, and unexpected statuses or mismatched identities are protocol errors. Verification never releases or replaces the stored binding.

This is an authentication protocol, not transport integration. The Remote Gateway still does not present the token when opening or recovering a WebSocket; that remains the next R5 integration slice.

## Alternatives considered

**Authenticate inside API Gateway.** Rejected for this slice because Gateway is the DSH-owned transport used by compositions with no Candy identity. Changing its universal browser cookie rule before a registered-host carrier exists would mix device and browser authority and make every existing remote endpoint part of the migration.

**Delete the local binding on `401`.** Rejected because revocation and deliberate local release are different operations. Automatic deletion would also make a transient proxy that rewrites responses capable of changing which tenant the machine may serve next.

**Treat every non-200 response as revocation.** Rejected because a deployment error is not an authorization decision. Only the endpoint's documented `401` denies the credential; connection and server failures remain observable failures.

## Consequences

A paired host now has a redacted, auditable way to test whether its token remains valid, and a tenant's revocation is visible across Candy processes on the next verification. Unknown and revoked credentials remain indistinguishable on the wire.

The host still needs a pairing client that exchanges a code and calls `bind`, and the DSH Remote Gateway still needs a Candy-owned integration that verifies the binding at connection or reconnect without replacing its retry and offline machinery.
