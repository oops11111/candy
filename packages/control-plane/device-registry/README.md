---
description: "The device a Candy assertion names: a tenant issues a single-use pairing code, a host exchanges it once for an identity bound to that tenant for life, and the tenant can withdraw the binding."
kind: "package-library"
---

# @deepseek-ai/dsh-device-registry

English | [中文](README.zh.md)

## Summary

An execution assertion has always carried a `DeviceId`, and a [workspace grant](../workspace-grant/README.md) has always named the device its roots are spelled for. Nothing issued a device. The id named a record that did not exist anywhere in the repository, so no step could say which person a host acted for or whether it still acted for them at all.

This package holds that record. A tenant issues a pairing code from an authenticated session, reads it onto the host, and the host exchanges it — once — for a device identity bound to that tenant. The binding is fixed for the device's life: there is no operation that moves one, because a host that should serve a different person is a different device, paired with its own code and holding its own token.

Transport is deliberately not here. How a host reaches the deployment, keeps a socket open, or runs a tool is inherited Harness behaviour. What this package decides is which tenant a device belongs to and whether it still belongs to them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Issuing a code and exchanging it

```ts
import { consumePairingCode, issuePairingCode } from '@deepseek-ai/dsh-device-registry'
import type { DeviceRegistryStore } from '@deepseek-ai/dsh-device-registry'
import type { DeviceId, UserId } from '@deepseek-ai/dsh-control-plane'

declare const store: DeviceRegistryStore
declare const userId: UserId
declare const code: string
declare const deviceId: DeviceId
declare const token: string

await issuePairingCode(store, { userId, label: 'Studio desktop', code, expiresAt: Date.now() + 900_000 }, Date.now())

// On the host, with the code a person carried across:
const { device } = await consumePairingCode(store, { code, deviceId, token }, Date.now())
export const boundTo = device.userId
```

The code, the device id and the token are all minted by the caller. How much entropy each carries and which alphabet a code is readable in are the transport's decisions, and only digests reach the durable record.

A code is refused as `pairing-code-unknown` when nothing resolves it, `pairing-code-expired` when it outlived its window, and `pairing-code-consumed` when a host already exchanged it — including a host that lost a concurrent race for the same code.

### Reading a token back, and taking it away

`authenticateDevice` identifies the device presenting a token and reports `unknown` or `revoked` when none is identified. Answer a presenter the same for both; the distinction is for the audit record, where an operator needs to see a revoked host still trying.

`revokeDevice` withdraws a binding and keeps the record. `admitDevice` is the assertion-time rule, the same shape [`admitWorkspaceGrant`](../workspace-grant/README.md) takes: `not-found`, `revoked`, or `tenant-mismatch`.

### Storing one

`DeviceRegistryStore` is the port a deployment satisfies; [`dsh-control-plane-store`](../control-plane-store/README.md) implements it over SQLite. One member of the port is not an ordinary read or write: `claimPairingCode` must mark a code consumed and check its expiry in a single step no concurrent caller can interleave with.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

| Path | Responsibility |
| --- | --- |
| [`src/index.ts`](src/index.ts) | The device and pairing-code records, the storage port, and every operation over them |
| — | No runtime invariant companion is published; this pure module owns no event stream or mutable runtime data, and its rules are enforced by unit tests. |

### Why a pairing code is claimed before the device is written

The claim comes first, so a failure between the two burns the code rather than leaving it usable. That is the safe direction. A tenant reissues a code they never got to use, while a code that outlived a partial exchange would pair a second host under an invitation the first one already answered.

The same reasoning is why the claim, not the read above it, decides. Two hosts reading one outstanding code both find it outstanding; the read is there only to say which of the three refusals this is, and a claim that fails after a successful read is reported as a consumed code.

### Why the record survives its own consumption

A consumed code names the device it produced, which is how an operator reading the trail tells which pairing a device came from. Refusing it a second time is then a fact the record states rather than the absence of a record.

### Why a device is never deleted

The id is named by assertions and workspace grants that outlive it. A deleted record would make a withdrawn device read as one that was never paired, and every check that resolves the id would answer `not-found` where the truth is `revoked`.

### Why a typed code is normalized

A code is read off one screen and typed into another, so the two spellings differ in ways that carry no information: case, the separators that make it readable, and the whitespace typing adds. Removing all of them before the digest is taken is what makes what a tenant is shown and what a host sends digest identically.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan; this package is the registration half of R5's Windows Harness Host binding.
- [`dsh-workspace-grant`](../workspace-grant/README.md) — the other record an assertion names, and the device whose roots it is spelled for.
- [`dsh-control-plane`](../control-plane/README.md) — the `DeviceId` and `UserId` brands this registry is written in.
- [`dsh-control-plane-store`](../control-plane-store/README.md) — the durable implementation of the storage port.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **Nothing checks a device outside run admission** — [`dsh-run-admission`](../run-admission/README.md) resolves the device an assertion names through `findDevice` and applies `admitDevice`, so a revoked binding stops the next run. No other operation consults the record: a run already admitted keeps its credential and allowance until it settles, and no transport refuses a device token mid-connection.
- **Nothing expires a spent code** — consumed and expired records stay on the medium. A deployment that issues codes continuously grows that table until an eviction sweep exists, as [`ControlPlaneStore.evictNonces`](../control-plane-store/README.md) provides for replay nonces.
- **A device holds one token for life** — there is no rotation. Replacing a compromised token means revoking the device and pairing the host again under a new id.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly, like [`dsh-workspace-grant`](../workspace-grant/README.md).

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
