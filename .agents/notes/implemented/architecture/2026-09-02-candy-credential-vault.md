# Agent Note: Candy credential vault

Status: implemented

English | [中文](2026-09-02-candy-credential-vault.zh.md)

## Problem

Candy holds each tenant's provider-account secrets — a DeepSeek API key, a Claude or Codex CLI login — and [Candy Runtime Boundaries](../../../../docs/candy-runtime-boundaries.md) names credential theft and tenant confusion as abuse cases that must stay closed: encrypted envelopes, redacted reads, per-invocation injection, and revocation that blocks new work immediately. The harness's own `dsh-credentials` seam cannot carry this. It addresses records as `scope/id` with no tenant dimension, and its local provider writes them unencrypted to `$DSH_HOME/.credentials.yaml`, which is appropriate for one operating-system user's own harness and wrong for many tenants' secrets on a shared server.

## Decision

`@deepseek-ai/dsh-credential-vault` (`packages/control-plane/credential-vault`) seals a secret as AES-256-GCM ciphertext in a versioned `CredentialEnvelope`, and exposes `sealCredential`, `openCredential`, `rewrapCredential`, `revokeCredential`, and `redactCredential`. It has no Cordis service and no storage; the keyring is a parameter, matching how `dsh-execution-assertion` takes its signing secret.

**Two mechanisms keep a secret with its tenant, and they catch different attacks.** `openCredential` compares the envelope's recorded `userId` and `accountId` against the `CredentialBinding` the caller names, denying an envelope that sits in the wrong record with its stored fields intact. Those fields also enter the GCM additional authenticated data, denying an envelope that was moved *and* had its stored fields rewritten to match its new record — a rewrite the comparison cannot see, because by then every stored field agrees with the attacker's binding. Fields entering the additional data are length-prefixed so no opaque id can forge a field boundary.

The additional data is derived from the caller's binding rather than from the envelope's fields. A negative-control run proved the two are indistinguishable through the public API: the comparison runs first, so on every path that reaches decryption the envelope's fields already equal the binding. The choice is therefore defense in depth against a later change that reorders or drops the comparison, not a behavior any test here observes. Both the module documentation and the package README say so, and say not to simplify it away.

**Revocation destroys rather than flags.** `revokeCredential` empties the nonce, ciphertext, and authentication tag. A flag is only as good as the opener honoring it, and the ciphertext would survive in every backup taken before the flag was written; destroying it makes revocation a property of the record rather than of the code reading it. The record is kept so its metadata stays auditable, and a second revocation preserves the first `revokedAt`.

**Rotation is keyring-driven.** `CredentialKeyring` names a current version and retains every version still needed to open envelopes not yet rewrapped. Rotation is: add a key, make it current, rewrap, then stop retaining the old version — after which an un-rewrapped envelope is permanently `unknown-key`. A rewrap keeps the original `sealedAt` and records `rewrappedAt`.

**Every operation returns a `CredentialAuditEvent` beside its result**, so a caller cannot obtain a secret without also obtaining the record of having done so. The vault produces audit records; it does not persist them.

## Alternatives considered

**Extend `dsh-credentials` with encryption instead of adding a package.** Rejected because the seam's key space has no tenant, so cross-tenant isolation could not be expressed in it, and because encrypting every harness credential record would change behavior for the browser-session secret and provider keys that deliberately live in a readable file the operator owns.

**Store a revoked flag and keep the ciphertext.** Rejected: it makes revocation depend on every future opener honoring the flag, and leaves the secret recoverable from any backup predating it. Destroying the ciphertext costs the ability to un-revoke, which is not a capability the boundary page wants.

**Wrap a per-record data key with the keyring key (full envelope encryption).** The extra indirection buys cheap rekeying — rewrapping only the small wrapped key rather than the whole secret. Rejected for now because provider secrets are small enough that rewrapping the ciphertext is not a cost worth a second key layer, and the indirection would need its own format and failure modes.

**Take a key-management service handle rather than raw key bytes.** Rejected as having no consumer: no deployment target is chosen, and the interface would be invented rather than derived. The keyring parameter keeps that choice open.

**Validate envelopes as untrusted JSON inside the vault.** Rejected because the vault has no reader: whoever loads envelopes from a store owns parsing them, and duplicating that here would guess at a persistence format R1 has not built. Malformed fields still fail closed as `corrupt`.

## Consequences

Candy can hold, rotate, and destroy tenant secrets with cross-tenant reads failing closed, which is the encryption half of R1's exit evidence. Unit coverage pins the moved-envelope case, a retired key, a wrong key of the same version, a flipped ciphertext byte, non-canonical fields, both binding mismatches, revocation denying later reads, and redaction carrying no sealed material.

Three properties the boundary page attributes to credential handling are not delivered here and are recorded in the package README. Audit records are returned rather than persisted, so nothing durably records a read until a tenant-partitioned store exists. Key storage, distribution, and rotation scheduling belong to the deployment; the vault validates only that a key is 32 bytes and cannot tell a rotated key from a compromised one. And `openCredential` returns a `Uint8Array` that JavaScript cannot reliably zero, so a decrypted secret stays readable in the heap until collected — per-invocation injection into a provider process, which the boundary page also requires, has to bound that exposure at the process boundary instead.
