# Agent Note: Candy run admission

Status: implemented

English | [中文](2026-09-02-candy-run-admission.zh.md)

## Problem

R1 produced four packages — [identifiers](2026-09-02-candy-control-plane-identifiers.md), [execution assertions](2026-09-02-candy-execution-assertions.md), the [credential vault](2026-09-02-candy-credential-vault.md), and [runtime-pool partitioning](2026-09-02-candy-runtime-pool-partitioning.md) — each tested alone and none with a consumer. Their fit was an assumption, and the confused-deputy rule they each enforce is exactly the kind of property that survives every part and still fails at the seam: a scheduler that opened a credential for the tenant a *request* named, using an assertion that authenticated a different one, would satisfy all four while defeating all four.

## Decision

`@deepseek-ai/dsh-run-admission` (`packages/control-plane/run-admission`) is the one call a scheduler makes. `admitRun` verifies the assertion, spends its nonce, opens the credential, and resolves the pool, returning an `AdmittedRun` or a `RunRejection` tagged with the stage that denied it.

**`RunRequest` carries a token and nothing else.** No tenant, account, provider, or pool field exists on it, and the credential binding and pool identity are both read from the admitted claims. The pairing that would defeat the composition cannot be expressed, which is the same enforcement-by-parameter-list the assertion package uses, extended across the seam.

**The order is the contract.** The assertion is verified before either port is called, so no unauthenticated claim reaches a store. The nonce is spent before the credential is read, so a replayed token cannot drive repeated credential reads. The pool resolves last because it needs no secret.

**The two gaps R1 documented became required parameters.** `spendNonce` and `findCredential` are ports on `RunAdmissionPolicy`. Neither store exists in this repository, and making them parameters means a run cannot start until the deployment has answered replay and credential lookup — the nonce gap the assertion package recorded is now a thing a caller must supply rather than a thing a caller might forget.

## What integrating found

The composition did not typecheck. `ExecutionAssertionClaims` carried no provider, but the pool key is `userId + provider + accountId`, so composing the two would have required the *caller* to name the provider — the client-selected value the boundaries page forbids, and one the control plane already knows because a provider account is provider-specific.

Two changes followed. `provider` joined the signed claim set, admitted against the closed provider set on decode like any other wire field. And `ProviderKind` moved from `dsh-runtime-pool` to `dsh-control-plane`, because an account, an assertion, and a pool all name it, and a union of string literals costs that package none of the dependency-freedom it advertises. The [pool note](2026-09-02-candy-runtime-pool-partitioning.md) placed it in the pool package; that placement is superseded here, and both package READMEs now point at the new home.

Extending the signed claim set without minting `v2` is deliberate: nothing has persisted a v1 token, and the repository's pre-release stance prefers a correct claim set to a compatibility shim.

## Alternatives considered

**Let the request name the provider.** The smaller change, and it reopens the confused-deputy path the assertion package exists to close: a caller could pair a valid assertion for a DeepSeek account with `claude-cli` and land the run in a pool naming a combination the control plane never made. Signing it costs one field.

**Keep `ProviderKind` in `dsh-runtime-pool` and have the assertion depend on that package.** This preserves the earlier placement but makes the assertion package depend on pool-key derivation to describe a run, which is backwards: the assertion is upstream of the pool.

**Compose in each scheduling path instead of one call.** Every path would repeat the order, and the first one to get it wrong — reading a credential before verifying, or before spending the nonce — would do so silently. One call makes the order reviewable in a single place.

**Collect audit records into a sink port too.** Rejected for now: the vault already returns its record and the caller owns the store, so a third port would add a parameter without adding an obligation the type system enforces. It is named as a limitation instead.

That reasoning held, but the limitation as first written did not: it said a denial returns no audit record at all, and treated that as a boundary rather than a defect. `openCredential` returns a record on its failing branch as well as its succeeding one, and this module discarded the failing one — losing precisely the cross-tenant access attempt the vault had just detected. Every outcome now carries `audits` ([run-admission audits every outcome](2026-09-03-run-admission-audits-every-outcome.md)).

## Consequences

The four R1 packages now have a consumer, and their fit is a test rather than an assumption: unit coverage pins a token becoming a credential and a pool, the provider deciding which pool, two providers separating for one tenant and account, a denial before any store is touched, a replayed token on second use, the nonce being spent before the credential is read, a missing credential, a revoked credential, another tenant's envelope, and an envelope relabelled to match the caller.

Admission still ends at a decision. Spawning the provider process, injecting the secret, bounding output, and cancelling belong to R2, and quotas, concurrency, and parent-subset grants belong to R3 — recorded in the package README so the boundary is not mistaken for enforcement. Spending the nonce before opening the credential means a run denied at the credential step has consumed its assertion; that is the safe direction, and it makes a client mint a new assertion rather than retry a spent one.
