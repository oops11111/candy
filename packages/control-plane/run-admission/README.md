---
description: "The Candy scheduling path from an execution assertion to an admitted run: assertion, nonce, credential, and runtime pool resolved in one call."
kind: "package-library"
---

# @deepseek-ai/dsh-run-admission

English | [中文](README.zh.md)

## Summary

`dsh-run-admission` is the one call a Candy scheduler makes before it starts work. `admitRun` verifies the execution assertion, spends its nonce, opens the provider credential the assertion names, and resolves the runtime pool that credential may run in — returning either everything a provider invocation needs or the step that denied it. It exists so the order of those checks is a contract rather than something each scheduling path remembers, and so identity flows from the verified token to the credential and the directory with no parameter a caller could substitute. `RunRequest` carries a token and nothing else.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Admitting a run

```ts
import { admitRun, type RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'

declare const policy: RunAdmissionPolicy
declare const token: string

const admission = await admitRun({ token }, policy, Date.now())

export const outcome = admission.admitted
  ? { pool: admission.run.poolRoot, claims: admission.run.claims }
  : admission.rejection
```

An admitted run carries the verified claims, the opened credential, the pool key, the pool's directory, the allowance it may spend, and the workspace grant it holds. A denial names the stage that produced it — `assertion`, `lineage`, `device`, `workspace`, `budget`, `session`, `replay`, or `credential` — so an operator can tell a forged token from a revoked account without the caller learning anything it could retry against. Every stage past `assertion` also carries the verified claims, so a caller can say which tenant, account, and run was refused; a replayed nonce is this call's clearest attack signal, and one reported without a tenant records that something happened rather than what. The `assertion` stage carries none, because it denied the token before any claim was verified and the unverified payload is the caller-supplied identity this control plane refuses to repeat. Both outcomes carry `audits`: no path discards a record the vault produced.

### Supplying the policy

`RunAdmissionPolicy` holds this runtime's expectation, its assertion secret, the vault keyring, the pool base directory, and six ports the deployment satisfies:

```ts
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import { RunReplayStore } from '@deepseek-ai/dsh-run-replay'

declare const partial: Omit<
  RunAdmissionPolicy,
  'findBudget' | 'findParentIdentity' | 'findDevice' | 'findWorkspaceGrant' | 'findSessionRun' | 'spendNonce' | 'findCredential'
>
declare const store: {
  budgetFor: (userId: string) => Promise<undefined>
  parentRemaining: (parentRunId: string) => Promise<undefined>
  envelopeFor: (userId: string, accountId: string) => Promise<undefined>
  runDriving: (sessionId: string) => Promise<undefined>
  runIdentity: (runId: string) => Promise<undefined>
  deviceFor: (deviceId: string) => Promise<undefined>
  grantFor: (grantId: string) => Promise<undefined>
}

const replay = new RunReplayStore()

export const policy: RunAdmissionPolicy = {
  ...partial,
  findBudget: claims => claims.parentRunId === undefined
    ? store.budgetFor(claims.userId)
    : store.parentRemaining(claims.parentRunId),
  findParentIdentity: parentRunId => store.runIdentity(parentRunId),
  findDevice: deviceId => store.deviceFor(deviceId),
  findWorkspaceGrant: grantId => store.grantFor(grantId),
  findSessionRun: claims => store.runDriving(claims.sessionId),
  spendNonce: claims => Promise.resolve(replay.spend(claims, Date.now())),
  findCredential: claims => store.envelopeFor(claims.userId, claims.accountId),
}
```

`spendNonce` returns true only the first time it sees a nonce, and this call never retries one reported as spent, so that port is the whole of replay protection. [`dsh-run-replay`](../run-replay/README.md) satisfies it for one process; a deployment running more than one runtime process needs a durable store that keeps the same three obligations — one indivisible decision, retention bounded by the assertion, and a record keyed by tenant as well as nonce.

`findBudget` returning `undefined` denies the run: a tenant the store does not know is not a tenant with unlimited budget, and a deployment that means unmetered says so with an explicit large allowance. Neither it nor `findCredential` has an implementation in this repository, which is why they stay parameters: a run cannot start until the deployment has answered lineage, device, workspace grant, budget, session, replay, and credential lookup.

`findParentIdentity` reports the tenant, account and workspace grant the parent run was admitted for, and is asked only about a run that has a parent. A child naming another tenant or another account is refused: the parent held exactly one of each, and neither of a pair is a subset of the other. The grant it reports is also the only one a child may name.

`findDevice` turns the device id an assertion carries into a record. Returning `undefined` denies the run: a device the store does not hold was never paired.

`findWorkspaceGrant` turns the grant id an assertion carries into a record. Returning `undefined` denies the run: a grant the store does not hold is not authority with no bound.

`findSessionRun` returns the run already driving the session the claims name, or `undefined` when the session is free. A model request carries the session it was assembled for and nothing else that could identify a run, so two runs on one session is spend nobody can attribute; refusing the second here stops the conflict where it is created.

`findBudget` answers the allowance the run is started against, which is not the same lookup for every run. A child run — one whose claims carry a `parentRunId` — is started against its PARENT's remaining allowance, read from a [`dsh-run-ledger`](../run-ledger/README.md). Answering the tenant's budget for a child makes this check meaningless: a tenant with plenty left can have an exhausted parent, and the child is then refused only when its share is reserved, one step after its single-use nonce was spent and its credential opened.

The check is "has this run anything at all to spend", not a promise a particular child request will fit. A parent with one token left admits a child that `RunLedger.openChild` then refuses, which is what remains of checking an allowance before its size is known.

The budget and the session are read before the nonce is spent. Both are denials a caller can fix and retry — top up, or wait for the session's run to settle, then present the same still-valid assertion — so burning a single-use token on either would turn a recoverable refusal into a round trip to the control plane. The nonce is still spent before the credential, because it serializes concurrent duplicates so two copies of one token cannot both reach a secret.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `RunRequest`, `RunAdmissionPolicy`, `AdmittedRun`, `RunRejection`, and `admitRun` |
| — | No runtime invariant companion is published; this module owns no event stream or mutable runtime data; its admission order is enforced by unit tests. |

### The order is the contract

The assertion is verified first, so nothing downstream ever sees an unauthenticated claim — a token this runtime does not admit is denied before any port is called. A child's lineage is checked next, because a child that is not a subset of its parent should not consult an allowance it may not draw on, and its device and workspace grant are resolved beside it — the other two authorities a run claims by naming rather than by proving, the device first because the grant is spelled for it. The budget is read fourth and the session fifth: both are denials a caller can fix and retry, so neither may burn the nonce, and neither touches a secret. The nonce is spent sixth, serializing concurrent duplicates so two copies of one token cannot both reach the credential. The credential is opened seventh, under the binding the claims carry. The pool is resolved last, because it needs no secret.

### Why a child may not name another tenant or account

`dsh-run-ledger` funds a child out of its parent's record and settles its spend back into it, and `dsh-credential-vault` opens whichever credential the claims name. Neither knows the other's subject. A child of one tenant under a parent of another therefore runs on the child's credential while its spend settles into the parent's tree: the parent's tenant funds work it never authorized, and the child's tenant is billed nothing. A booted runtime confirmed exactly that before this check existed.

The rule is the one the boundaries page states — a child inherits a subset of its parent's grants and may not widen any. Tenant and account are decidable because the parent held exactly one of each, and the workspace grant is decidable for the same reason, through `findWorkspaceGrant`.

### Why a run's device is resolved here

An assertion carries a `DeviceId`, and until this stage existed nothing resolved it. A run named whatever device it liked, and the workspace grant's own device check compared that claim against the grant's — two unverified strings agreeing with each other. `findDevice` turns the id into a record and [`dsh-device-registry`](../device-registry/README.md) decides whether the run may act as it, refusing an id nothing resolves, a revoked binding, and another tenant's device.

It is also what makes a revocation act immediately. An assertion stays valid for its whole lifetime, so without a record a tenant who revoked a host would keep serving its runs until that lifetime ran out. The record is the authority and the token only names it, so the next run stops.

The refusal is before the nonce for the reason the grant's is: a host paired again presents the same still-valid assertion, and a burned nonce would make a recoverable refusal permanent.

### Why a run's workspace grant is resolved here

An assertion carries a `WorkspaceGrantId` and nothing else about the filesystem, so until the id resolved to a record it was a claim nothing checked: a run named whatever grant it liked. `findWorkspaceGrant` turns it into a record, and [`dsh-workspace-grant`](../workspace-grant/README.md) decides whether the run may hold it — refusing an id nothing resolves, a revoked grant, another tenant's or another device's, and a child naming any grant but its parent's.

What this step does not do is decide whether a path lies under the grant's roots. Those roots are spelled for the device that issued them, and resolving a path against them is that device's filesystem semantics; a control plane on another host comparing strings would be approximating a boundary it cannot see. The roots travel on the admitted run so the device that owns them can enforce them where the file operation happens.

### Why one session may be driven by only one run

A model request carries the session it was assembled for and nothing else that could identify a run, so a session driven by two runs at once is spend nobody can attribute. `findSessionRun` refuses the second run where the conflict is created. Leaving it to whatever reads the mapping later means both runs open and hold their allowances, and every model call in that session is refused one at a time — and a tenant minted onto another tenant's session would stop that tenant's work rather than being stopped itself.

A child run is not exempt. It needs a session of its own for the same reason its parent does, which makes one-session-per-run a requirement on the control plane that mints the assertions rather than a convention.

### Why identity cannot be substituted across the composition

Each part refuses a caller-named tenant on its own, and composing them could still have reintroduced the hole: a scheduler that opened a credential for a tenant the request named, using an assertion that authenticated a different one, would satisfy every part while defeating all of them. `RunRequest` carries only a token, and the credential binding and pool identity are both read from the admitted claims, so that pairing cannot be expressed.

The `provider` in those claims is signed for the same reason. A provider account is provider-specific, so pairing one with another provider would place a run in a pool naming a combination the control plane never made.

### Why the credential does not serialize

Logging an admitted run is the first thing an operator does with one, and the run carries the tenant's decrypted provider key. A plain object put that key in the log a byte at a time: `JSON.stringify` of a successful start outcome contained the whole of it.

`secret` is therefore non-enumerable, and the run has a `toJSON` that replaces it with `[redacted]`. The two cover different callers: `JSON.stringify` uses `toJSON`, while `console.log`, `util.inspect`, and every structured logger that walks own properties ignore it and would print the key from a plain property. Reading `run.secret` is unaffected, which is what a caller launching the provider does.

The pool root stays readable. It is a path derived from a digest rather than a secret, an operator asking which pool a run landed in has a real question, and anyone who can read that directory on the host already has more than the path.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the parts this call composes and the architecture it serves.

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — the accepted trust boundaries, including the confused-deputy rule this composition keeps closed end to end.
- [`dsh-execution-assertion`](../execution-assertion/README.md) — the token this call verifies first.
- [`dsh-credential-vault`](../credential-vault/README.md) — the envelope it opens under the admitted binding.
- [`dsh-workspace-grant`](../workspace-grant/README.md) — the record a grant id resolves to, and the rule this call applies to it.
- [`dsh-runtime-pool`](../runtime-pool/README.md) — the key and directory it resolves last.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Admission ends at a decision, not an invocation** — the call returns what a provider process needs; spawning it, injecting the secret, bounding its output, and cancelling it belong to the R2 adapters.
- **Audit records are returned, not persisted** — every outcome carries the vault records the attempt produced, and the caller owns the tenant-partitioned store the boundaries page requires. Nothing here writes, retains, or orders them.
- **Only vault operations are audited** — a refusal that never reached the vault (an unadmitted token, a spent nonce, an account with no stored credential) carries an empty trail, because no credential was touched. A caller that must record those refusals logs the rejection itself, which names the tenant for every stage past `assertion`.
- **Nonce spending is not transactional with the run** — a nonce is spent before the credential is read, so a run denied at the credential step has already consumed its assertion. That is the safe direction, and it means a client must mint a new assertion rather than retry the same one after fixing an account.
- **The grant's roots are resolved, not enforced** — this call decides that a run may hold a grant. Whether a given path lies under one of its roots is the issuing device's filesystem semantics, and nothing here reads `roots`; the admitted run carries them for the check that happens where the file operation does.
- **The session check is only as wide as its port** — `findSessionRun` answers from whatever the deployment gives it, so two runtimes that do not share a view of open runs cannot refuse each other's conflicts. `dsh-run-scheduler` answers from its own runtime's records and says so.
- **Quotas, concurrency, and parent-subset grants are not checked** — those belong to the scheduler and to R3's orchestration; this call admits one run's identity and resources, not its budget.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
