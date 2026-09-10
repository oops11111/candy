# Agent Note: A revocation that waited for expiry

Status: implemented

English | [中文](2026-09-10-a-revocation-that-waited-for-expiry.zh.md)

## Problem

A tenant could revoke a device and the device kept working.

`dsh-device-registry` wrote `revokedAt` and the device API answered the tenant that the binding was withdrawn, but nothing on the run path read the record. `admitRun` verified the assertion, checked lineage, resolved the workspace grant, read the budget, spent the nonce and opened the credential, and at no point resolved the `deviceId` the assertion carried. So a host holding an assertion minted before the revocation kept starting runs until that assertion expired, and a host that had been re-minted a fresh one kept starting them indefinitely.

The workspace grant's own device check made this look safer than it was. `admitWorkspaceGrant` refuses a `device-mismatch`, but both sides of that comparison were unverified: the grant's `deviceId` came from a record, and the run's came from a claim nothing had resolved. A device that had never been paired, or one belonging to a tenant who had thrown the machine away, satisfied it as long as the grant named the same string.

## Decision

Admission resolves the device before the grant that is spelled for it.

`RunAdmissionPolicy` gains `findDevice`, the same shape `findWorkspaceGrant` has, and `admitRun` calls `admitDevice` with the tenant and device the verified claims name. An id nothing resolves, a revoked binding and another tenant's device each deny the run, tagged `stage: 'device'` and carrying the claims like every other stage past the assertion.

**The device comes first.** The grant's roots belong to a device, so checking the grant against an unresolved device claim compares a record to a string. Resolving the device first means the grant's own `device-mismatch` is a comparison between two records.

**It is before the nonce**, for the reason the grant check is: a host paired again presents the same still-valid assertion, and burning its single-use token would turn a refusal an operator can fix into a round trip to the control plane.

`RunScheduler` answers the port from `ControlPlaneStore.findDevice`. That is the whole wiring: the store already held the record, the scheduler already assembled the policy, and the missing piece was one line and the check it feeds.

## Alternatives considered

**Check the device where the workspace grant is checked, inside `admitWorkspaceGrant`.** Rejected. A run with no filesystem authority at all still acts as a device, and folding the two would make a deployment that issues no grant unable to check a device either. They are separate records with separate revocations.

**Shorten assertion lifetimes so a revocation takes effect sooner.** Rejected as the answer. It trades a bounded delay for more traffic to the control plane and still leaves a window; the record already exists, and reading it removes the window entirely.

**Have the device API delete the runs of a revoked device.** Rejected: it races. A run admitted between the revocation and the sweep is still a run, and the check at admission has no such gap.

**Leave `admitDevice` uncalled and check the token at the transport instead.** Rejected because no transport carries a device token yet, and because an assertion is what authorizes a run. Checking the device where the run is admitted is checking it where the decision is made.

## Consequences

A revocation now stops the next run. That is the behaviour the device record was built for, and it is pinned against a real booted scheduler: a run starts, the tenant revokes the host, and the next run is refused `device/revoked` with the same assertion secret and store.

Two refusals exist that did not. A run naming a device the store never paired is denied rather than admitted, and a run acting as another tenant's device is denied at the device rather than incidentally at the grant.

**Every deployment must now pair a device before any run starts.** There is no implicit one, and a store holding none admits nothing. That is the same rule the workspace grant introduced, and it is why five test fixtures across the group changed: each provisioned a grant naming a device it never created. Two of them were also internally inconsistent — a second tenant's grant named the first tenant's device — which nothing could detect while no step resolved either.

What this does not do is reach a running operation. A run already admitted keeps its credential and its allowance until it settles; the check is at admission, and cancelling live work on revocation is a separate decision with a separate mechanism.

## Verification

`packages/control-plane/run-admission/tests/run-admission.spec.ts` covers the three rejections as a table and pins that a refused device leaves the nonce unspent, by presenting the same token again through a policy that admits it. `packages/control-plane/run-scheduler/tests/loader-composition.spec.ts` boots the real store and scheduler through the Loader and drives the headline case end to end: a run starts, the tenant revokes the device, and the next run is refused; an unpaired device and another tenant's device are refused there too.

Three mutation controls establish that the cases decide something: dropping the check, moving it after the nonce is spent, and admitting a device of whatever tenant the record names each fail at least two cases before the implementation is restored.
