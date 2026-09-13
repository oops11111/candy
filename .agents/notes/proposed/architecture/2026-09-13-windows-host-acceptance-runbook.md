# Agent Note: Windows Host acceptance runbook

Status: proposed

English | [中文](2026-09-13-windows-host-acceptance-runbook.zh.md)

## Problem

The remaining R5 acceptance criteria depend on a real Windows Harness Host and a reachable Debian control plane. Container-only tests cannot prove reconnect authentication, Windows junction behavior, or device revocation at the Remote boundary.

## Proposal

Use this sequence as the release gate once a real Windows Host and Debian deployment are available.

## Preconditions

- A Debian deployment runs the Candy control plane behind HTTPS with a stable public origin.
- A Windows Host runs the DSH-provided host profile and can reach that origin over TLS.
- Test tenants, devices, workspaces, and provider accounts contain no production secrets.
- The existing DSH Remote Gateway and Windows plugins are enabled; Candy does not add a second transport.

## Verification sequence

1. Pair one Windows Host to tenant A, verify the binding, and establish a Remote connection.
2. Execute read, write, shell, and directory-picker operations inside an explicitly granted workspace; record only operation metadata.
3. Attempt a traversal, symlink, junction, long-path, and cross-workspace operation; each must be rejected by the DSH executor before mutation.
4. Revoke the device from the Candy control plane, then verify the next call and reconnect both fail with unauthorized status.
5. Pair a second host to tenant B and confirm neither host can see the other tenant's workspace, account, session, or audit records.
6. Interrupt the network, let the inherited reconnect path run, and confirm re-authentication is required after assertion expiry.

## Evidence and failure rules

Capture request status, device id, tenant id, operation class, and timestamps, but never paths, tokens, credentials, prompts, or command output. Any capability executing after revocation, any cross-tenant response, or any reconnect that bypasses assertion verification is a release blocker. A missing Windows or Debian environment is an unexecuted test, not a pass.

## Acceptance criteria

All six verification steps produce the expected authorization and isolation results, with no secret-bearing evidence.

## Risks

The runbook cannot compensate for a missing DSH transport authentication seam; in that case remote Windows work remains disabled.

## Alternatives considered

- Treat container tests as proof of Windows behavior. Rejected because they cannot exercise Windows ACL, junction, or host reconnect semantics.
- Add a Candy-specific test transport. Rejected because it would duplicate DSH Remote behavior.

## Explicit non-goals

This runbook does not implement Remote Gateway, WebSocket framing, Windows file or shell execution, sandboxing, or a second Web/mobile surface.
