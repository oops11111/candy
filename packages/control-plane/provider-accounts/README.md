---
title: Provider accounts
description: "Tenant-owned provider account records for Candy, with encrypted credentials, default selection, validation, revocation, and deletion."
kind: "package-library"
---

# Provider accounts

English | [中文](README.zh.md)

## Summary

`dsh-provider-accounts` is Candy's control-plane account manager. It stores provider account metadata, seals credentials with `dsh-credential-vault`, and returns only secret-free views to callers.

Accounts are owned by `userId`. Listing, default selection, validation, revocation, and deletion all check ownership before touching the credential. An account id owned by another user is reported as `not-found`, so the API surface cannot be used to enumerate another tenant's metadata.

No runtime invariant companion is published; this module owns no event stream or mutable runtime data, and its ownership, default-selection, and scrubbing rules are enforced by unit tests.

## Table of Contents

- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **This is not yet a Web controller** — the package exposes a deployment store port and pure account operations. R4 still needs the Harness Web settings controller that maps authenticated requests onto these functions and verifies the same routes on desktop and mobile viewports.
- **Validation is provider-supplied** — this package bounds and scrubs the validation result, but the DeepSeek API, Claude CLI, and Codex CLI probes still need provider-specific implementations.

<a id="dev-note"></a>
## Dev Note

- [Provider accounts are tenant records with write-only credentials](../../../.agents/notes/implemented/architecture/2026-09-03-provider-account-management.md)
