---
description: "The Candy provider that binds one admitted run's durable workspace grant to inherited filesystem and shell execution."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-grant-execution

English | [中文](README.zh.md)

## Summary

This package supplies `ctx.workspaceAuthority`, the Candy-owned provider for the generic authority point declared by `dsh-sandbox`. It resolves the open Candy run for each tool dispatch, re-reads its workspace grant, and lets the inherited filesystem and shell sandbox providers enforce the result at their own operation boundary. It does not define tools, file operations, shell syntax, remote transport, or a second sandbox.

## Use this package

Mount it beside `dsh-control-plane-store`, `dsh-run-scheduler`, and the existing sandboxed filesystem and shell providers. A tool dispatch without an open Candy run is denied before its body starts. Agentless calls remain governed by the deployment sandbox because they carry no tenant identity this provider may infer.

For filesystem operations, the executor revalidates the grant immediately before each read or mutation and resolves containment with the host filesystem. Unknown, revoked, cross-tenant, cross-device, symlink, junction, and outside-root paths fail closed. A `read-only` grant rejects mutations.

For shell operations, the executor revalidates the grant and constrains the existing per-call sandbox policy. The process workdir must resolve under a granted root, and a requested mode cannot exceed the grant's mode. The inherited platform sandbox remains responsible for enforcing the resulting process policy.

## Understand the implementation

`WorkspaceGrantExecution.enter` obtains the unique open run through `RunScheduler.runOfSession` and places only its tenant, device, and grant identifiers in asynchronous execution context. It does not retain roots or revocation state. `authorizePath` and `authorizePolicy` read the current grant again, so a revocation or narrowing affects the next executor operation rather than only the next run.

The filesystem backend checks canonical target paths. Existing ancestors are resolved with native realpath semantics before containment, which makes a symbolic link or Windows junction leading outside the grant fail as an outside path. A missing suffix stays attached to its resolved deepest existing ancestor.

## Further Exploration

No runtime invariant companion is published; this package keeps only async call identity, while every durable grant decision is re-read and covered at the executor boundary by integration tests.

- [`dsh-workspace-grant`](../workspace-grant/README.md) — durable grant records and admission-time identity checks.
- [`dsh-fs-sandbox`](../../fs/fs-sandbox/README.md) — filesystem executor enforcement.
- [`dsh-sandbox`](../../sandbox/sandbox/README.md) — shared process-policy vocabulary and authority service definition.
- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — the two-stage workspace authorization requirement.

## Known Limitations and Deferred Work

- Agentless operations have no Candy run identity and therefore use only the ordinary deployment sandbox.
- The workspace grant constrains the shell sandbox's mode and workdir. Read visibility inside a platform process remains the platform sandbox's contract; this package does not parse commands or create a second shell protocol.
- Cross-process visibility of grant changes depends on the control-plane store's medium-refresh behavior.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
