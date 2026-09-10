# Agent Note: A device id nobody issued

Status: implemented

English | [中文](2026-09-10-a-device-id-nobody-issued.zh.md)

## Problem

`DeviceId` was a branded string with no record behind it. Every consumer named one and none resolved one: an execution assertion carries `deviceId`, a durable run record stores it, a workspace grant names the device its roots are spelled for and refuses a run from another — by comparing the grant's device against the assertion's, which is two unverified claims agreeing with each other. Nothing said the device existed, whose it was, or whether it still acted for them.

The same gap made the workspace grant's own device check weaker than it reads. `admitWorkspaceGrant` refuses a `device-mismatch`, but the id it trusts came out of an assertion, and the tenant that assertion names is the only thing the deployment had ever verified. A tenant could mint runs claiming any device string at all, including one belonging to a host that had been decommissioned, and every check downstream would agree with the claim.

Nor was there any way to bring a host into a deployment. The plan's R5 asks the Windows Harness Host to bind to one user and one device; the harness's only identity is `dsh-anonymous-user-id`, a per-installation UUID designed *not* to identify a person, and `host/` is the local web-GUI half with no notion of a machine reached over a network. There was no registration, no pairing, no revocation, and therefore nothing for a binding to be made against.

## Decision

A device is a durable record a tenant creates by pairing, and it belongs to that tenant for the record's whole life.

`dsh-device-registry` holds it: the tenant the device is bound to, an operator-supplied label, the digest of the token the host presents, when it was paired, and when the binding was withdrawn. There is deliberately no operation that moves a device between tenants. A host that should serve a different person is a different device, paired under that person's own code and holding its own token, and every later check reads the binding rather than a claim.

Pairing is where the one human step is. A tenant issues a short-lived, single-use code from an authenticated session, carries it to the host, and the host exchanges it once for its identity. Only digests are durable — of the code and of the token — so a copy of the record pairs nothing and authenticates nothing.

**The claim comes before the device is written.** A failure between the two burns the code rather than leaving it usable, which is the safe direction: a tenant reissues a code they never got to use, while a code that outlived a partial exchange would pair a second host under an invitation the first one already answered. For the same reason the claim, not the read above it, is what decides. Two hosts reading one outstanding code both find it outstanding; the read exists only to say which of the three refusals this is, and a claim that fails after a successful read is reported as a consumed code. That indivisibility is a stated obligation on the storage port — `claimPairingCode` must decide consumption and expiry in one step — not something the domain can arrange over an ordinary read and write.

A consumed code keeps its record and names the device it produced, so an operator can tell which pairing a device came from and a second refusal is a fact the record states rather than the absence of one. A revoked device keeps its record too: assertions and workspace grants name the id after the binding is gone, and a deleted record would make a withdrawn device read as one that was never paired.

`admitDevice` is the assertion-time rule, the same shape `admitWorkspaceGrant` takes and for the same reason — the record is the authority and the assertion only names it, so a device revoked after a token was minted is refused on that token's next use rather than at its expiry.

Transport stays where it is. How a host reaches the deployment, holds a socket open, picks a directory or runs a command is inherited Harness behaviour, and this package adds nothing to it. What it decides is which tenant a device belongs to and whether it still belongs to them.

## Alternatives considered

**Let a host register itself with the tenant's own credentials.** Rejected because the credential that reaches a host is the credential a host can lose. A pairing code is worth one device for fifteen minutes; a tenant's session cookie or provider key is worth everything they own, and carrying one onto a machine to make it a device puts it there permanently.

**Store the device token rather than its digest.** Rejected for the reason the browser session already stores a digest: the durable record is read by backups, replicas and operators, and a token in it authenticates as the device to every one of them. The token is returned once and is not recoverable.

**Let a tenant re-pair an existing device.** Rejected because the binding is what every later check reads. Moving a device between tenants would make an assertion minted a second ago name a device that now belongs to someone else, and every audit record about that device would be about two different machines. Pairing again produces a new id, which is what the facts already were.

**Mark a code consumed with a read and then a write.** Rejected because two hosts reading one outstanding code both find it outstanding, and both pair. The one-shot claim is an obligation on the storage port instead, where the medium can make it indivisible.

**Delete a revoked device or a spent code.** Rejected because assertions and workspace grants name the id after the binding is gone. A deleted record answers `not-found` where the truth is `revoked`, and a deleted code cannot say which device it produced.

## Verification

`packages/control-plane/device-registry/tests/device-registry.spec.ts` covers issue, normalization, the three exchange refusals, a concurrent exchange in which exactly one host pairs, a device write that fails after the claim, listing scoped to one tenant, revocation and its repeat, cross-tenant revocation, token authentication with revoked and unknown separated, and each admission rejection — at 100% of the package's statements, branches, functions and lines.

Four mutation controls establish that those cases decide something: dropping the expiry refusal, ignoring a lost claim, revoking without the tenant check, and moving the claim after the device write each fail at least one case before the implementation is restored.

## Consequences

A `DeviceId` now resolves to something. The workspace grant's device check compares an assertion's claim against a record a tenant created rather than against another claim, once admission resolves the device — which it does not yet.

That is the honest limit of this note. `admitDevice` exists and nothing on the run path calls it: `dsh-run-admission` still passes `deviceId` through unresolved, and a run naming an unpaired device is admitted exactly as it was before. The rule is written where the record is so the admission slice has one thing to call, not two things to agree on.

Three smaller gaps follow from the same slice being the first. Consumed and expired codes stay on the medium, so a deployment issuing codes continuously grows that table until a sweep exists like the one `evictNonces` gives replay nonces. A device holds one token for life, so replacing a compromised token means revoking the device and pairing the host again under a new id. And nothing yet issues a *workspace grant* when a device is paired, which was the other half of what the grant note said nobody did.
