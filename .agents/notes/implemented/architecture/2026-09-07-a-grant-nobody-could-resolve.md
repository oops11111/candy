# Agent Note: A grant nobody could resolve

Status: implemented

English | [中文](2026-09-07-a-grant-nobody-could-resolve.zh.md)

## Problem

`WorkspaceGrantId` was a branded string and nothing else. Grepping the repository for it found the brand's own definition, the claim on `ExecutionAssertionClaims`, the field on `DurableRunRecord` that carries it, and the converters that brand and unbrand it on the way to storage — and no reader. `dsh-run-admission` did not mention it once.

So a run named whatever workspace grant it liked and no step looked. Admission refused a child that named another tenant or another account, because a parent held exactly one of each and the mismatch is decidable; the workspace grant was left out with a stated reason — "narrowing one is legitimate and no containment model exists to tell it from widening" — which was true about *comparing roots* and had quietly become the reason for checking nothing at all. Not the tenant on the grant, not the device, not whether it had been revoked, not whether it existed.

That is the widest of the three grants a child inherits. Tenant and account decide whose money is spent; the workspace grant decides which files the process can reach. A delegated child could name a grant belonging to another tenant, or one an operator had revoked an hour ago, and be admitted with it.

## Decision

The grant is a durable record, and admission resolves it before spending the nonce.

`dsh-workspace-grant` holds what the id resolves to: the tenant and device it was issued to, the roots that device granted, the file-effect ceiling as a `SandboxMode` — the vocabulary `dsh-sandbox` already owns and `dsh-subagent` already pins a child to — the grant's own revision, and its revocation. `admitWorkspaceGrant` decides whether a run may hold it, and `dsh-control-plane-store` stores it in the control-plane domain, at version 6.

A child must name its parent's grant **exactly**. Equality is the subset rule at its strongest: a child that cannot name another grant cannot widen its roots or raise its mode, so over-granting is impossible rather than detectable — the shape `dsh-run-budget` already takes for tokens and concurrency. `RunScheduler.startChildRun` already copies the parent's grant id into the assertion it mints, so this refuses hand-minted children and nothing the delegation path produces.

**Path containment is deliberately not in this package.** A grant's roots are spelled for the device that issued them, and deciding whether a path lies under one is that device's filesystem semantics — casing, junctions, symbolic links, 8.3 aliases. A control plane on Debian comparing strings against a Windows host's roots would be approximating a boundary it cannot see, and approximating a containment check is how escapes happen. What is decided here is identity and inheritance, which are the same on every host. The roots travel on `AdmittedRun.workspace` so the device that owns them can enforce them where the file operation happens.

The refusal is ordered beside the lineage check and before the nonce. Both answer the same kind of question — what may this run hold, given what its parent held — and both are recoverable: reissuing a grant is the fix, and burning the single-use token would make the refusal permanent for an assertion that is still valid.

The record carries a `version` because an assertion names only an id. A run admitted before an operator narrowed a grant and one admitted after are indistinguishable by id alone, so admission records the version it read on the admitted run; the filesystem-side check compares against it rather than silently honouring whatever the run was given.

A revocation is a stored `revokedAt`, not a delete. A deleted record reads as a grant that was never issued, which is a different fact from one that was withdrawn, and the refusal an operator reads should say which.

## Consequences

Every run now proves its filesystem authority the way it already proved its tenant and account. Five refusals exist that did not: an id nothing resolves, a revoked grant, another tenant's, another device's, and a child naming any grant but its parent's. A deployment must issue a grant before any run starts — there is no implicit one, and a store that holds none admits nothing.

The check is a lookup per run start, on the same store the credential and budget already come from, and it is not on the per-call path.

What it does not do is stop a run from writing outside its roots. Admission decides that a run may hold a grant; nothing yet reads `roots` at a file operation, and no filesystem seam consults the record. Link escape, junctions and long paths are that check's acceptance criteria, not this one's, and they belong on the device the grant names.

Nothing issues a grant either. A deployment writes records through `saveGrant` by hand: there is no pairing flow, no operator surface, and no lifecycle that creates one when a device is registered.

Nine unit cases pin the rule and two pin the usability predicate; six real-composition cases pin the refusals against a real SQLite-backed store and a booted scheduler, including a child that names a `danger-full-access` grant over `/` while its parent holds a narrow one, and a refusal that leaves the same assertion usable once the grant is reinstated. A store case pins that a grant and its revocation survive a restart. Removing the check from `admitRun` fails six of them.

## Alternatives considered

**Compare the child's roots against the parent's.** The obvious reading of "a subset of its parent's grants", and rejected: it is exactly the cross-host path arithmetic that cannot be done correctly from the control plane. `dsh-fs-sandbox` has a real containment check — `isPathUnder`, with filesystem-identity fallback for casing and 8.3 aliases — and the reason it is correct is that it runs on the filesystem it is deciding about. Reimplementing a string-only version here would be a check that passes on Debian and is wrong about Windows.

**Model narrowing now, with a `derivedFrom` link between grants.** Attractive and probably where this goes, but rejected as speculative: nothing in this repository issues a narrowed child grant, so the derivation would have no writer and its subset rule no test that distinguishes it from equality. When a consumer needs one, the derived record is created by the issuing device — which can check containment — and this rule accepts it.

**Put the record in `dsh-control-plane` beside the id.** Rejected: that package is the zero-dependency identity vocabulary, and the grant's mode is `SandboxMode`. Adding a `dsh-sandbox` edge there would pull the sandbox package into everything that touches a branded id.

**Check the grant after the budget, keeping the existing order.** Rejected: a run with no filesystem authority should not consult an allowance it cannot use, and the two inheritance checks read from the same parent lookup. Ordering them together is also what let `findParentIdentity` be called once instead of twice.
