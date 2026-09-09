# Agent Note: Tenant state is not a system CLI login

Status: implemented

English | [中文](2026-09-09-tenant-state-is-not-a-system-cli-login.zh.md)

## Problem

The account page listed Claude CLI and Codex CLI accounts but gave no summary of whether the current tenant had a usable credential. Reading `claude auth status`, `codex login status`, or either tool's default home would answer a different question: whether the Unix service user had authenticated an ambient CLI. In a multi-tenant process that answer belongs to no Candy tenant and could make one user's session appear available to another.

The server already returns the current tenant's secret-free account roster through an authenticated route. Each record says which provider it belongs to, whether it is revoked, and which usable account is the default. That is the login state Candy owns.

## Decision

The existing Harness Account section derives three states for Claude CLI and Codex CLI from that roster: configured when a usable account exists, credential revoked when only revoked records exist, and not configured when no record exists. The configured state names the tenant's own account label. It does not expose a credential, path, environment variable, endpoint, or another tenant's metadata.

The page explicitly says the summary is not a live CLI check. Candy does not spawn an authentication command, inspect the service user's CLI home, or reuse its cookies and tokens. Provider-specific live validation remains an extension of `dsh-provider-credential-checks`; only DeepSeek has one because it offers the ordinary HTTP check this deployment implements.

The summary occupies the existing settings section and uses only inherited theme tokens and responsive layout. Candy adds no settings shell, mobile application, theme, or CLI login flow.

## Consequences

An operator and tenant can distinguish an absent CLI account from an intentionally revoked one without treating the host's ambient login as authority. The summary updates whenever the authenticated roster is re-read after account creation, default selection, revocation, or deletion.

The component cases pin all three states and the warning against shared CLI authentication. The Web scenario mounts the shipped browser plugin through the Loader, reads the same account route at a 1680px desktop viewport and a 390px phone viewport, and checks that the CLI summary remains visible without horizontal overflow. A mutation that treated revoked records as active makes the state case fail.

This does not prove that a CLI executable is installed or that a stored CLI credential can authenticate. Claude and Codex continue to answer `unsupported-provider` from credential validation until a provider-specific, redacted check is registered. Runtime-route availability is a deployment concern and must not be inferred from an account record.

## Alternatives considered

**Run each CLI's native status command.** Rejected: without first binding the command to the tenant's isolated pool and credential, it reads the service user's ambient state and crosses the ownership boundary the page exists to show.

**Call every stored CLI credential configured and ready.** Rejected: a revoked record is not usable, and an account record does not prove that a deployment mounted the corresponding runtime route or installed its executable.

**Build a separate CLI settings page or mobile view.** Rejected: the Harness settings section and responsive panel already provide the required extension point and viewport behavior.
