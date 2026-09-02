# Candy Runtime Boundaries

English | [中文](candy-runtime-boundaries.zh.md)

## Summary

Candy runs on the DeepSeek Harness plugin runtime and adds a tenant-aware control plane around it. This page defines which capabilities Candy inherits, which responsibilities Candy owns, and which abuse cases every multi-tenant runtime change must keep closed.

## Table of Contents

- Inherited Harness Capabilities
- Candy-Owned Control Plane
- Trust Boundaries
- Abuse Cases
- Review Requirements
- Dev Note

## Inherited Harness Capabilities

Candy keeps Harness as the execution core. Harness owns the Cordis plugin tree, agent loop, session events, prompt and tool assembly, model adapter interface, filesystem and subprocess capability seams, Web service, responsive client, settings UI, brand slots, theme plugin, Windows directory picking, Windows PowerShell execution, Windows ACL sandbox integration, Git operations, Remote gateway, and session replay machinery.

Candy does not fork those capabilities into parallel implementations. A Candy feature that needs files, shell execution, settings, session history, browser UI, or remote Windows work must attach to the existing Harness package or plugin boundary unless the owning package cannot enforce the Candy tenant rule.

## Candy-Owned Control Plane

Candy owns user identity, OAuth sessions, provider account records, encrypted credentials, device pairing, workspace grants, conversation membership, runtime scheduling, tenant quotas, audit records, and the HTTPS/WebSocket gateway that issues execution assertions.

The control plane is the only authority for `userId`, `deviceId`, `accountId`, `workspaceGrantId`, `conversationId`, `sessionId`, and child-run ancestry. Browser clients, mobile clients, Windows hosts, and provider adapters may carry these identifiers only inside authenticated control-plane assertions. Candy rejects request fields that try to select a tenant, account, device, or workspace outside the assertion.

Provider CLIs may share immutable binaries, package caches, and download caches. They must not share authenticated home directories, writable provider config, environment overlays, process trees, session stores, private model caches, or workspace mounts across `userId + provider + accountId`.

## Trust Boundaries

The browser and mobile client are untrusted presentation clients. They can ask for their own state and send user input, but they cannot assert ownership of sessions, provider accounts, devices, workspaces, or execution policy.

The Windows Harness Host is a paired device for one user. It can expose local Harness capabilities only after the control plane binds the device, workspace root, operation class, expiry, and nonce to the request. The Windows host resolves canonical paths locally and denies traversal, junction, symlink, and drive-boundary escapes before it touches the filesystem or shell.

The Debian Candy runtime is a scheduler and provider-process supervisor. It validates each execution assertion, creates an identity-scoped runtime home, injects secrets only for the current process, collects normalized provider events, and appends tenant-partitioned session events.

Provider processes are untrusted subprocesses after launch. Their stdout, stderr, exit status, structured output, and diagnostic text are parsed through bounded, redacted adapters. A malformed provider stream fails the run without widening grants or exposing secrets.

## Abuse Cases

Credential theft is blocked by encrypted credential envelopes, redacted reads, per-invocation secret injection, and provider homes that are private to one runtime pool key.

Tenant confusion is blocked by control-plane assertions whose audience, expiry, tenant, account, session, device, workspace grant, and nonce are checked before scheduling. Client-supplied tenant or account fields are ignored or rejected.

Path traversal is blocked by canonical workspace roots, operation-class grants, local Windows path resolution, and denial of traversal through symlinks, junctions, alternate drives, UNC aliases, and case-folding tricks.

Event leakage is blocked by tenant-partitioned session stores and authorization checks on replay, subscription, export, deletion, reconnect, and background-job collection.

Process escape is blocked by identity-scoped homes, minimal environments, bounded working directories, subprocess cancellation, process-tree cleanup, output limits, and audit records for every launched provider or tool process.

Replay attacks are blocked by short-lived assertions, audience binding, nonces, expiry checks, and idempotent request handling for device and workspace operations.

Confused-deputy attacks are blocked by parent-subset child grants. A child run can use only the account, workspace, tool, token, time, cost, and concurrency authority that the parent run already had.

## Review Requirements

R1 changes must include tests that show cross-tenant reads fail closed, credential reads are redacted, revoked accounts cannot start new work, and execution assertions reject wrong audience, expiry, nonce, tenant, account, session, device, and workspace grant values.

R2 provider changes must run one lifecycle contract suite across DeepSeek API, Claude CLI, and Codex CLI. The suite must cover streaming, tool calls, cancellation, malformed output, provider crash, timeout, quota failure, usage reporting, and secret redaction.

R3 orchestration changes must prove that child runs inherit a strict subset of parent grants, cancellation reaches children and provider processes, and audit records preserve routing, delegation, usage, and terminal state without exposing secrets.

R4 Web changes must exercise the same routes at desktop and mobile viewport sizes. Account-management APIs must prove ownership checks for list, create, validate, select-default, revoke, and delete.

R5 Windows-host changes must test device binding, workspace root grants, Unicode and long paths, branch discovery, concurrent edits, revocation, reconnect, offline state, malicious path inputs, and junction or symlink escape attempts.

R6 release changes must verify migration from ClauGod-era metadata to Candy metadata, provider canaries, backup and restore, rollback, and operator alerts for cross-tenant attempts, orphaned processes, quota violations, and provider outages.

## Dev Note

This page is the R0 baseline for Candy's multi-tenant runtime work. Later tasks should replace broad checklist items with package-owned tests and Agent Notes as the implementations land.
