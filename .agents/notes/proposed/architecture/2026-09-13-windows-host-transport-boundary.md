# Agent Note: Windows host transport boundary

Status: proposed

English | [中文](2026-09-13-windows-host-transport-boundary.zh.md)

## Problem

Candy has durable user and device bindings, but no transport endpoint consumes those bindings while a Windows Harness Host connects or reconnects. Adding a second WebSocket or duplicating Remote Gateway would violate the project boundary.

## Proposal

Extend the existing DSH Remote transport with a host-authentication seam. Candy supplies a short-lived, audience-bound device assertion; DSH presents it during connection establishment and reconnect, then exposes only the already-registered Remote capabilities.

## Candy responsibility

Candy mints and revokes assertions, binds each assertion to one tenant and device, and returns uniform unauthorized responses. It must never receive filesystem paths, tool payloads, shell output, or bearer tokens in audit records. A revoked device must fail the next handshake and reconnect.

## DSH responsibility

DSH owns the socket, retry state, capability registry, framing, bounded output, and Windows filesystem or process execution. The seam must accept an opaque assertion callback without adding tenant concepts to Remote calls. It must not cache a successful identity past the assertion lifetime.

## Acceptance criteria

- A paired host connects through the existing Remote Gateway and every call remains attributable to the bound tenant and device.
- Missing, malformed, expired, cross-tenant, and revoked assertions all fail before a capability executes.
- Reconnect re-authenticates instead of reusing an expired identity; network failures remain distinguishable from revocation.
- No second WebSocket protocol, file-operation API, or Candy-owned Windows executor is introduced.

## Risks

If the inherited transport cannot insert an authentication handshake, Candy cannot safely emulate one above it. The deployment must then disable remote Windows work rather than accept an unauthenticated host or share a long-lived token.

## Alternatives considered

- Put the bearer token in every Remote call. Rejected because it duplicates authorization and leaks credentials into capability payloads.
- Add a Candy WebSocket proxy. Rejected because it creates a second transport and repeats DSH Gateway behavior.

## Explicit non-goals

This note does not implement Remote Gateway, WebSocket framing, Windows file operations, PowerShell, sandboxing, Agent or Skills execution, or a second Web/mobile surface.
