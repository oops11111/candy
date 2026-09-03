# Agent Note: Provider accounts are tenant records with write-only credentials

Status: implemented

English | [中文](2026-09-03-provider-account-management.zh.md)

## Problem

[R4 of the multi-tenant runtime plan](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) needs users to manage DeepSeek API, Claude CLI, and Codex CLI accounts from the shared Harness Web surface. The inherited Harness credentials seam is intentionally provider-neutral and process-local: it stores records by credential reference, not by Candy tenant, provider account, default account, revocation state, or control-plane ownership. Reusing it directly as the user-visible account API would let client-selected references stand in for account authority.

## Decision

`@deepseek-ai/dsh-provider-accounts` owns the control-plane account record that Web APIs will expose. It stores metadata keyed by `ProviderAccountId`, checks every operation against `userId`, seals secrets with `dsh-credential-vault`, and returns only `ProviderAccountView`, which contains no credential material, encrypted payload, key version, path, or provider response body.

Creation is the only operation that accepts a plaintext secret. Validation opens the credential only inside the operation and hands it to a provider-supplied validator; the result is scrubbed to a bounded diagnostic before it can be returned. Listing, selecting a default, validating, revoking, and deleting all resolve the stored record first and report another user's id as `not-found`, so account ids cannot be used as a tenant-enumeration oracle.

Each user has at most one default account per provider. Creating the first active account for a provider makes it default; explicit default selection clears the older default for that same user and provider; revocation and deletion remove default status and promote another active account when one exists.

## Consequences

R4 now has the backend account lifecycle it needs before a Web controller exists. The remaining Web work is thinner: authenticate the user, call these functions through a durable store, and project the existing Harness settings UI onto the returned views.

A deleted account's id is refused forever, not merely while nothing has claimed it: `createProviderAccount` checked only whether the existing row was undeleted, so a caller could recreate an account under a deleted id and silently overwrite the very record deletion promises to retain — undetected because no test exercised that path, only the two branches a plain duplicate-id check needs. The check now refuses any existing row, deleted or not.

The package is deliberately not a validator registry or Web service. Provider probes remain provider-specific, because DeepSeek API keys, Claude CLI homes, and Codex CLI homes do not share one validation protocol. The package's validator port exists so those probes can be plugged in without letting their raw diagnostics, tokens, paths, or environment values become part of the account API.

## Alternatives considered

**Use the inherited credentials settings API as the account list.** Rejected: credential references are not tenant-owned provider accounts, and they do not encode ownership, provider kind, default selection, revocation, or deletion.

**Store provider diagnostics with the account.** Rejected: raw diagnostics can contain endpoint details, token echoes, filesystem paths, or another tenant's metadata. The account layer stores only `validatedAt`; operators can record richer diagnostics through a separate redacted audit trail.

**Delete account records physically.** Rejected for the control-plane core. Soft deletion keeps enough metadata for audit while hiding deleted accounts from user-facing lists, and it is what lets `createProviderAccount` refuse to reuse a deleted id — a physically deleted row leaves nothing to check against, and a fresh account could silently take over a stranger's retained history.
