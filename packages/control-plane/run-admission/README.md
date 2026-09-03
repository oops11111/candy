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

An admitted run carries the verified claims, the opened credential, the pool key, the pool's directory, and the allowance it may spend. A denial names the stage that produced it — `assertion`, `budget`, `replay`, or `credential` — so an operator can tell a forged token from a revoked account without the caller learning anything it could retry against. Every stage past `assertion` also carries the verified claims, so a caller can say which tenant, account, and run was refused; a replayed nonce is this call's clearest attack signal, and one reported without a tenant records that something happened rather than what. The `assertion` stage carries none, because it denied the token before any claim was verified and the unverified payload is the caller-supplied identity this control plane refuses to repeat. Both outcomes carry `audits`: no path discards a record the vault produced.

### Supplying the policy

`RunAdmissionPolicy` holds this runtime's expectation, its assertion secret, the vault keyring, the pool base directory, and three ports the deployment satisfies:

```ts
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'

declare const partial: Omit<RunAdmissionPolicy, 'findBudget' | 'spendNonce' | 'findCredential'>
declare const store: {
  budgetFor: (userId: string) => Promise<undefined>
  parentRemaining: (parentRunId: string) => Promise<undefined>
  markSpent: (nonce: string, expiresAt: number) => Promise<boolean>
  envelopeFor: (userId: string, accountId: string) => Promise<undefined>
}

export const policy: RunAdmissionPolicy = {
  ...partial,
  findBudget: claims => claims.parentRunId === undefined
    ? store.budgetFor(claims.userId)
    : store.parentRemaining(claims.parentRunId),
  spendNonce: claims => store.markSpent(claims.nonce, claims.expiresAt),
  findCredential: claims => store.envelopeFor(claims.userId, claims.accountId),
}
```

`spendNonce` returns true only the first time it sees a nonce. `findBudget` returning `undefined` denies the run: a tenant the store does not know is not a tenant with unlimited budget, and a deployment that means unmetered says so with an explicit large allowance. None of the three ports exists in this repository, which is why all three are parameters: a run cannot start until the deployment has answered budget, replay, and credential lookup.

`findBudget` answers the allowance the run is started against, which is not the same lookup for every run. A child run — one whose claims carry a `parentRunId` — is started against its PARENT's remaining allowance, read from a [`dsh-run-ledger`](../run-ledger/README.md). Answering the tenant's budget for a child makes this check meaningless: a tenant with plenty left can have an exhausted parent, and the child is then refused only when its share is reserved, one step after its single-use nonce was spent and its credential opened.

The check is "has this run anything at all to spend", not a promise a particular child request will fit. A parent with one token left admits a child that `RunLedger.openChild` then refuses, which is what remains of checking an allowance before its size is known.

The budget is read before the nonce is spent. An exhausted budget is the one denial here a caller can fix and retry — top up, present the same still-valid assertion — so burning its single-use token would turn a recoverable refusal into a round trip to the control plane. The nonce is still spent before the credential, because it serializes concurrent duplicates so two copies of one token cannot both reach a secret.

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

The assertion is verified first, so nothing downstream ever sees an unauthenticated claim — a token this runtime does not admit is denied before any port is called. The budget is read second: it is the one denial a caller can fix and retry, so it must not burn the nonce, and it touches no secret. The nonce is spent third, serializing concurrent duplicates so two copies of one token cannot both reach the credential. The credential is opened fourth, under the binding the claims carry. The pool is resolved last, because it needs no secret.

### Why identity cannot be substituted across the composition

Each part refuses a caller-named tenant on its own, and composing them could still have reintroduced the hole: a scheduler that opened a credential for a tenant the request named, using an assertion that authenticated a different one, would satisfy every part while defeating all of them. `RunRequest` carries only a token, and the credential binding and pool identity are both read from the admitted claims, so that pairing cannot be expressed.

The `provider` in those claims is signed for the same reason. A provider account is provider-specific, so pairing one with another provider would place a run in a pool naming a combination the control plane never made.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the parts this call composes and the architecture it serves.

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — the accepted trust boundaries, including the confused-deputy rule this composition keeps closed end to end.
- [`dsh-execution-assertion`](../execution-assertion/README.md) — the token this call verifies first.
- [`dsh-credential-vault`](../credential-vault/README.md) — the envelope it opens under the admitted binding.
- [`dsh-runtime-pool`](../runtime-pool/README.md) — the key and directory it resolves last.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Admission ends at a decision, not an invocation** — the call returns what a provider process needs; spawning it, injecting the secret, bounding its output, and cancelling it belong to the R2 adapters.
- **Audit records are returned, not persisted** — every outcome carries the vault records the attempt produced, and the caller owns the tenant-partitioned store the boundaries page requires. Nothing here writes, retains, or orders them.
- **Only vault operations are audited** — a refusal that never reached the vault (an unadmitted token, a spent nonce, an account with no stored credential) carries an empty trail, because no credential was touched. A caller that must record those refusals logs the rejection itself, which names the tenant for every stage past `assertion`.
- **Nonce spending is not transactional with the run** — a nonce is spent before the credential is read, so a run denied at the credential step has already consumed its assertion. That is the safe direction, and it means a client must mint a new assertion rather than retry the same one after fixing an account.
- **Quotas, concurrency, and parent-subset grants are not checked** — those belong to the scheduler and to R3's orchestration; this call admits one run's identity and resources, not its budget.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
