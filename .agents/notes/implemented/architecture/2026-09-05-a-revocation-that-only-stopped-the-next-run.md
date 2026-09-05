# Agent Note: A revocation that only stopped the next run

Status: implemented

English | [中文](2026-09-05-a-revocation-that-only-stopped-the-next-run.zh.md)

## Problem

The delivery plan asks that a revoked account block new work immediately. `revokeProviderAccount` destroys the credential envelope, so the next admission cannot open it, and a probe confirmed the revocation itself is real.

The same probe then made one model call on a session whose run was already open, and got `{"last":{"reason":{"kind":"stop"}},"revokedAt":true,"spent":{"tokens":42,"costMicroUsd":900}}`.

A run opens its credential once, at admission, and holds the opened key for as long as it lives. Destroying the stored envelope reaches nothing already authenticated with it. Everything that ran per call — the session lookup, the budget, the wall clock — asked about the run, and nothing asked whether the account behind it still existed. So a compromised account kept spending its tenant's allowance for as long as its run kept making calls.

## Decision

`meterRequest` reads the run's account record on every call and refuses with `CREDENTIAL_REVOKED` when it is revoked, deleted, or gone. The refusal happens before the provider is reached, so nothing is charged.

The rule for "may still authorize work" is `dsh-provider-accounts`' to state, and it already stated it twice inline; it is now one exported `isProviderAccountUsable` that both original callers use.

The read is synchronous, which is what a waterfall listener can do. `ControlPlaneStore.find` stays async because it is the port `dsh-provider-accounts` consumes and another backend need not answer from memory; `accountOf` is the metering path's own reader and returns the record without the sealed credential beside it, which this decision has no business touching.

## Consequences

Revocation now stops work already under way, not only the next admission.

The run stays open until it settles or its lease expires, so a revocation stops the spending without releasing the hold. Closing the runs an account funded would release it sooner and is a larger change: it needs revocation to reach this runtime as an event rather than as a store write, which is also what a revocation performed by another process would need.

The negative control — removing the check — fails exactly the one test asserting the refusal, and not the one asserting that another tenant's revocation leaves this run metering normally.

## Alternatives considered

**Close the runs at revocation.** Enforcing a decision in the operation that makes it is the repository's rule, and it is the right end state. `dsh-provider-accounts` is a set of functions over a store and knows nothing of runs, ledgers or schedulers, so this needs a seam that does not exist yet; a per-call read needs none and fails closed rather than depending on a notification arriving.

**Check at the vault instead.** Admission already refuses a revoked account there. The gap is precisely the run that never returns to the vault, so the check has to live where the call is, not where the credential was opened.

**Terminate the provider process.** It would end the leak faster than the next call, and it belongs with the run's lifecycle rather than with one waterfall listener — the same missing seam as closing the run.
