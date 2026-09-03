---
description: "Minting and admission for the short-lived, audience-bound execution assertion the Candy control plane issues per run and the Candy runtime checks before scheduling work."
kind: "package-library"
---

# @deepseek-ai/dsh-execution-assertion

English | [中文](README.zh.md)

## Summary

`dsh-execution-assertion` owns the credential that authorizes one Candy run: the control plane mints a signed, short-lived assertion naming the tenant, device, provider account, workspace grant, conversation, session, and run, and the Candy runtime admits it before scheduling any work. `admitExecutionAssertion` is the only way to obtain that identity, and the expectation it takes names deployment facts alone — issuer, audience, maximum lifetime — with no field through which a caller could supply a tenant or account. Identity therefore leaves this package only after an HMAC check passes, which is how the boundary rule "never accept a client-selected tenant" is enforced in the operation that makes the decision instead of by convention at each call site. The package is a plain module with no Cordis service and no storage; the signing key is a parameter its caller owns.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Minting an assertion in the control plane

```ts
import {
  ConversationId, DeviceId, ProviderAccountId, RunId, UserId, WorkspaceGrantId,
} from '@deepseek-ai/dsh-control-plane'
import { mintExecutionAssertion } from '@deepseek-ai/dsh-execution-assertion'
import { SessionId } from '@deepseek-ai/dsh-session'

declare const secret: Uint8Array
declare const nonce: string
declare const now: number

export const token = mintExecutionAssertion({
  issuer: 'candy-control-plane',
  audience: 'candy-runtime-debian-1',
  userId: UserId('user-1'),
  deviceId: DeviceId('device-1'),
  accountId: ProviderAccountId('account-1'),
  provider: 'deepseek-api',
  workspaceGrantId: WorkspaceGrantId('grant-1'),
  conversationId: ConversationId('conversation-1'),
  sessionId: SessionId('session-1'),
  runId: RunId('run-1'),
  parentRunId: undefined,
  nonce,
  issuedAt: now,
  expiresAt: now + 60_000,
}, secret)
```

The caller supplies every claim: this package signs the control plane's decision and derives no identity of its own. `provider` is signed rather than named by the request because a provider account is provider-specific — pairing one with another provider would place the run in a pool naming a combination the control plane never made. The secret must be at least 32 random bytes, matching what `dsh-client-connection` stores for its browser sessions; a shorter key throws rather than signing weakly.

### Admitting an assertion in the runtime

```ts
import {
  admitExecutionAssertion, type ExecutionAssertionClaims, type ExecutionAssertionRejection,
} from '@deepseek-ai/dsh-execution-assertion'

declare const token: string
declare const secret: Uint8Array
declare const deny: (rejection: ExecutionAssertionRejection) => void
declare const schedule: (claims: ExecutionAssertionClaims) => void

const admission = admitExecutionAssertion(token, secret, {
  issuer: 'candy-control-plane',
  audience: 'candy-runtime-debian-1',
  maxLifetimeMs: 60_000,
}, Date.now())

if (admission.admitted) schedule(admission.claims)
else deny(admission.rejection)
```

Checks run in order: token structure, version, signature, claim shape, issuer, audience, lifetime, then the clock. The signature is verified before any claim is read, so a forged payload never reaches a comparison. `rejection` is a closed set of reasons for operator diagnostics — `malformed`, `unsupported-version`, `signature`, `issuer`, `audience`, `not-yet-valid`, `expired`, `lifetime` — and every one of them denies the run.

The current time is a parameter rather than a read of the process clock, so a scheduler that already has a decision timestamp admits against that instant and tests need no clock control.

`maxLifetimeMs` must be a positive safe integer, and `admitExecutionAssertion` throws a `RangeError` rather than admit against a ceiling it cannot enforce: a `NaN` ceiling — what `Number(...)` returns for an unset environment variable — makes every lifetime comparison false and admits whatever span an assertion claims, while a zero or negative ceiling denies every run under `lifetime`, a rejection that names the issuer's span rather than the misconfigured runtime. Neither failure is visible in an admission result, so both are refused at the call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The token is `v1.<base64url payload>.<base64url HMAC-SHA256>`, the format `dsh-client-connection`'s browser-session cookie already uses in this repository.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Claim and expectation types, the rejection set, `mintExecutionAssertion`, and `admitExecutionAssertion` |
| — | No runtime invariant companion is published; this pure module owns no event stream or mutable runtime data; its admission algebra is enforced by unit tests. |

### What the signature covers

The HMAC is computed over the received payload text, so admission never re-serializes a decoded object: JSON key order, whitespace, and duplicate-key handling cannot change what was verified. Payload and signature must both be canonical base64url — text that re-encodes to something else carried padding, an alphabet, or trailing bits a minted token never has, and is rejected as malformed. Signature comparison is length-checked and then constant-time.

### Why identity cannot be supplied by a caller

`ExecutionAssertionExpectation` names only `issuer`, `audience`, and `maxLifetimeMs`. It has no user, device, account, workspace-grant, conversation, session, or run field, so there is no parameter through which a request could assert whose run this is; the admitted claims are the only source. A future field on that type that named a tenant would reopen the confused-deputy path this package closes.

### Why the payload is validated even though TypeScript describes it

The token arrives from another process, so its decoded payload is a wire boundary, not a typed same-process value. Every claim is checked for presence and type, ids must be non-empty strings, and timestamps must be non-negative safe integers; anything else is malformed.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the architecture this credential enforces and the prior art its format follows.

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — the accepted trust boundaries, including the rule that Candy rejects client-supplied tenant and account fields.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the proposed R1–R6 delivery plan; this package is R1's execution-assertion bullet.
- [`dsh-control-plane`](../control-plane/README.md) — the branded ids every claim in this package carries.
- [Browser launch-token authentication](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md) — the in-repository HMAC bearer whose token format and secret size this package follows.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog; each names work a later part of the delivery plan owns.

- **Admission does not consume the nonce** — the nonce is bound into the signature and returned, but single-use enforcement needs a durable replay store scoped to a tenant, which the scheduler owns and which does not exist yet. Until that store exists, an assertion can be replayed within its lifetime by anyone who captures it, and only the short lifetime and audience binding limit that window.
- **The signing key is a parameter, not a managed secret** — key storage, rotation, and revocation are the credential-vault bullet of R1. This package validates only that a key is at least 32 bytes; it cannot tell a rotated key from a compromised one.
- **One shared symmetric key per issuer/audience pair** — HMAC means the admitting runtime can also mint. Splitting minting from admission with asymmetric signatures would require a key-distribution design that no consumer needs yet.
- **No transport, header, or request binding** — the assertion authorizes a run's identity; it does not bind to a specific HTTP request, body, or connection, so the caller owns replay-across-requests concerns alongside the nonce store.
- **No Cordis service** — nothing here registers on a `Context`; it is imported directly, like `dsh-brand`.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
