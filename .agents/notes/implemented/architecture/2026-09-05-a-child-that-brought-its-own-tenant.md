# Agent Note: A child that brought its own tenant

Status: implemented

English | [中文](2026-09-05-a-child-that-brought-its-own-tenant.zh.md)

## Problem

The boundaries page's sixth runtime contract says a child agent inherits a subset of the parent run's account, workspace, tool, token, time, and concurrency grants, and that child creation cannot widen any grant. Tokens, time and concurrency were enforced. The account was not, and neither was the tenant.

A probe against the booted runtime showed what that costs. A child run whose claims named a different tenant and a different account started, opened *that* tenant's credential, spent five hundred tokens — and the tenant billed for them was the parent's. The child's tenant was billed nothing.

Each part was doing its own job correctly. `dsh-run-ledger` funds a child out of its parent's record and settles its spend back into it. `dsh-credential-vault` opens whichever credential the claims name, refusing only a mismatch between the claims and the envelope. Neither knows the other's subject, and nothing between them compared the two.

Reachability is bounded: the identity is inside the assertion's signature, so this needs the control plane to mint such a child. That makes it the same class as the session conflict — a control-plane error the runtime should refuse rather than absorb, and absorbing it moves one tenant's money to another's work with no record on either side.

## Decision

`admitRun` gains a `findParentIdentity` port and refuses a child whose tenant or account differs from its parent's, at a `lineage` stage.

The check runs before the budget. A child that is not a subset of its parent should not consult an allowance it may not draw on, and like the session check it precedes the nonce so nothing single-use is burned on a conflict the caller did not cause.

The port takes the parent's run id rather than the claims naming it, because it is asked only about a run that has a parent — a signature that cannot be called for a root is better than one that has to check.

A parent this deployment does not know answers `undefined` and is left alone. A parent with no record is a parent with no allowance, which the budget lookup already reports; inventing a lineage refusal there would hide the real reason.

The rule is narrowed to what a runtime can decide. Tenant and account are decidable, because the parent held exactly one of each and neither of a pair is a subset of the other. The workspace grant is not: a child working in a narrower workspace is legitimate, nothing models containment, and refusing every difference would block the legitimate case along with the illegitimate one. That gap is stated rather than papered over.

## Consequences

A child that widens its parent's grant is refused where it is minted, before a hold is taken and before its credential is opened. The durable run record carries the account it was admitted for, so the check reads the parent's identity from the one place that survives a restart.

The domain version moves 3 to 4: a version 3 run record cannot say which account a child of it may name.

## Alternatives considered

**Compare against the parent's ledger record.** It is in memory and already read for the budget, and it holds no identity — the ledger deliberately knows runs and allowances, not tenants. Adding identity to it would give the arithmetic a subject it does not need.

**Refuse a differing workspace grant too.** It closes the third grant named in the contract, and it refuses the legitimate narrowing case with no way to tell the two apart. A containment model would make it decidable; there is none.

**Let the vault catch it.** It already refuses an envelope whose tenant differs from the claims — and here the claims and the envelope agree, because the child truthfully names its own tenant. The mismatch is between the child and its parent, which no single part can see.
