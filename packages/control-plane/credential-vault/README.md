---
description: "Tenant-bound credential envelopes for Candy: AES-256-GCM sealing, keyring rotation, revocation by destruction, redacted reads, and an audit record on every operation."
kind: "package-library"
---

# @deepseek-ai/dsh-credential-vault

English | [中文](README.zh.md)

## Summary

`dsh-credential-vault` holds a tenant's provider-account secret at rest. `sealCredential` encrypts it with AES-256-GCM under the keyring's current key; `openCredential` returns it only to a caller naming the tenant and account it was sealed for; `rewrapCredential` moves it onto a new key; `revokeCredential` destroys it. Every operation also returns a `CredentialAuditEvent`, so a caller cannot obtain a secret without also obtaining the record of having done so, and `redactCredential` gives the metadata view that is safe to log or return. This is a plain module with no Cordis service and no storage: the keyring is a parameter its caller owns, and where envelopes are written is the caller's decision. It is separate from the harness's own `dsh-credentials` seam, which addresses records by `scope/id` with no tenant dimension and stores them unencrypted.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Sealing and opening a secret

```ts
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import {
  openCredential, sealCredential,
  type CredentialBinding, type CredentialKeyring,
} from '@deepseek-ai/dsh-credential-vault'

declare const keyring: CredentialKeyring
declare const apiKey: Uint8Array

const binding: CredentialBinding = {
  userId: UserId('user-1'),
  accountId: ProviderAccountId('account-1'),
}

const { envelope, audit } = sealCredential(apiKey, binding, keyring, Date.now())
const opened = openCredential(envelope, binding, keyring, Date.now())

export const secret = opened.opened ? opened.secret : undefined
export const records = [audit, opened.audit]
```

`envelope` is durable and safe to store as JSON. It carries no plaintext, but it is not safe to log — pass it through `redactCredential` first. A read that fails names one of `revoked`, `unknown-key`, `binding-mismatch`, `unsupported-version`, or `corrupt`; every one of them denies the secret.

### Rotating a key

Add a key to the keyring, make it current, rewrap every envelope, then stop retaining the old version:

```ts
import { rewrapCredential } from '@deepseek-ai/dsh-credential-vault'
import type { CredentialBinding, CredentialEnvelope, CredentialKeyring } from '@deepseek-ai/dsh-credential-vault'

declare const stored: CredentialEnvelope
declare const binding: CredentialBinding
declare const rotated: CredentialKeyring

const moved = rewrapCredential(stored, binding, rotated, Date.now())

export const next = moved.rewrapped ? moved.envelope : undefined
```

A rewrapped envelope keeps its original `sealedAt` and records `rewrappedAt`. An envelope that is never rewrapped becomes permanently unopenable once its version leaves the keyring, which is what retiring a key is for.

### Revoking a secret

`revokeCredential` empties the nonce, ciphertext, and authentication tag rather than setting a flag an opener has to honor. The secret is gone: no key recovers it, and a caller that ignores the `revoked` rejection still has nothing to decrypt. The record itself stays so its metadata remains auditable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Envelope, binding, keyring, and audit types plus `sealCredential`, `openCredential`, `rewrapCredential`, `revokeCredential`, and `redactCredential` |
| — | No runtime invariant companion is published; this pure module owns no event stream or mutable runtime data; its sealing algebra is enforced by unit tests. |

### What keeps a secret with its tenant

Two mechanisms, and they catch different attacks. `openCredential` first compares the envelope's recorded `userId` and `accountId` against the binding the caller names, which denies an envelope sitting in the wrong record while its stored fields still name its real owner (`binding-mismatch`). Those fields also enter the additional authenticated data, which denies an envelope that was moved *and* had its stored fields rewritten to match its new record (`corrupt`) — a rewrite the comparison cannot see, because by then every stored field agrees with the attacker's own binding.

The additional authenticated data is derived from the caller's binding rather than from the envelope's fields. Those two are equal on every path that reaches decryption, because the comparison above runs first, so the choice changes no behavior this package's tests can observe. It exists so that a future change reordering or dropping that comparison still fails closed. Do not "simplify" it to read the envelope.

Fields entering the additional authenticated data are length-prefixed, so no value can forge a field boundary by containing the separator — control-plane ids are opaque strings this package does not constrain.

### Why revocation destroys rather than flags

A revoked flag is only as good as the opener that honors it, and the ciphertext survives in every backup taken before the flag was set. Destroying the ciphertext makes revocation a property of the record rather than of the code reading it.

### Why the keyring is a parameter

Where keys come from — a file, an environment variable, a key-management service — is a deployment decision with no consumer in this repository yet. Taking the keyring as an argument keeps the mechanism testable and lets the eventual owner choose, at the cost of this package being unable to tell a rotated key from a compromised one.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the architecture this vault serves and the identifiers it binds to.

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — the accepted trust boundaries, including credential theft and tenant confusion as abuse cases this package must keep closed.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the proposed R1–R6 delivery plan; this package is R1's encrypted-credential-storage bullet.
- [`dsh-control-plane`](../control-plane/README.md) — the `UserId` and `ProviderAccountId` a binding is made of.
- [`dsh-credentials`](../../credentials/credentials/README.md) — the harness's own credential seam, which this package does not replace.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **The keyring is a parameter, not a managed secret** — key generation, storage, and distribution belong to the deployment. This package validates only that each key is 32 bytes; it cannot tell a rotated key from a compromised one, and it neither schedules rotation nor knows which envelopes still need rewrapping.
- **Audit records are returned, never persisted** — every operation hands its `CredentialAuditEvent` back to the caller, who owns the tenant-partitioned, append-only store the boundary page requires. Nothing here durably records that a secret was read.
- **No plaintext lifetime control** — `openCredential` returns a `Uint8Array` the caller owns. JavaScript offers no reliable way to zero it, so a decrypted secret stays readable in the heap until it is collected.
- **Envelopes are not validated as untrusted JSON** — the functions take a typed `CredentialEnvelope`. A caller reading envelopes back from disk or a database owns parsing and validating that record before passing it in; malformed fields surface as `corrupt` rather than as a parse error naming the bad field.
- **No Cordis service and no storage** — nothing here registers on a `Context` or decides where envelopes live; both belong to the control-plane runtime that R1 has not built.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
