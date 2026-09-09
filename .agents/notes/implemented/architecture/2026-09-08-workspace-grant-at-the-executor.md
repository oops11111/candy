# Agent Note: Workspace grants at the executor

Status: implemented

English | [中文](2026-09-08-workspace-grant-at-the-executor.zh.md)

## Problem

Run admission resolved a workspace grant and checked its tenant, device, revocation, and inheritance before spending the assertion nonce. Nothing used the grant's roots or mode when an inherited filesystem or shell operation ran. A valid run could therefore use a path outside its grant, keep using a grant after revocation, or write while the grant was read-only.

The missing decision could not be made on the Debian control plane. Roots are paths on the issuing device, and only that device can resolve casing, symbolic links, junctions, aliases, and missing suffixes with the filesystem semantics the operation will use.

## Decision

`dsh-sandbox` declares an optional `ctx.workspaceAuthority` service used by its enforcing filesystem and shell Consumers. `dsh-workspace-grant-execution` supplies that service for Candy. It resolves the unique open run at each tool dispatch and places only the run's tenant, device, and grant identifiers in asynchronous execution context.

The filesystem executor re-reads the grant immediately before each read or mutation. It resolves existing ancestors with native realpath semantics, requires the target under one current root, and refuses writes under `read-only`. The shell executors re-read the grant before foreground execution, require the workdir under a current root, and narrow the existing sandbox mode to the grant ceiling. Background start uses the grant resolved for that same tool dispatch because the inherited `start` operation is synchronous.

The outer tool listener establishes identity but is not enforcement. The inherited executors call the authority at the operation that touches the filesystem or starts the process. A direct or alternate tool path through those providers reaches the same check.

## Consequences

A revoked or narrowed record affects the next executor operation in the current dispatch. A link or junction that resolves outside a granted root is an outside path. A child run receives the same grant id as its parent, and admission still refuses a hand-minted child that names another one; executor enforcement therefore cannot widen the parent grant.

Candy does not gain a second filesystem, shell, sandbox, or Windows transport. It contributes authorization to the existing DSH capability implementations. Compositions without `dsh-workspace-grant-execution` retain the admission check but do not gain local root enforcement.

The generated capability and Cordis catalogs classify `ctx.workspaceAuthority` as a `dsh-sandbox` seam, `dsh-workspace-grant-execution` as its Candy implementation, and the inherited filesystem and shell packages as its consumers. This makes the ownership boundary fail closed when service declarations change.

The process sandbox's read visibility remains platform-owned. This change constrains the process workdir and file-effect mode without parsing shell source, because a command parser would be a bypassable second shell policy. A stronger process read boundary requires a platform sandbox that can enforce it while still starting the runtime.

## Alternatives considered

**Check tool names and arguments in `tools/pre-execute`.** Rejected because direct filesystem consumers, composite tools, and shell syntax can bypass argument inspection. The decision belongs in the provider performing the operation.

**Put canonical paths in the execution assertion.** Rejected because Debian cannot resolve Windows filesystem identity, and a signed string does not prove what a junction or alias names when the operation runs.

**Build Candy-specific file and shell operations.** Rejected because DSH already owns those capabilities and their Windows implementations. The generic authority service lets Candy add its tenant decision without duplicating them.

## Verification

The package test drives the real `dsh-fs-sandbox` provider and covers granted access, cross-tenant and cross-device records, read-only denial, revocation during a dispatch, unknown sessions, outside paths, and a symbolic-link or Windows-junction escape. Its mutation control disables the read-only check and makes that denial test fail before restoring the implementation.
