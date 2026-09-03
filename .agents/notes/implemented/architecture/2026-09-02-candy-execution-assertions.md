# Agent Note: Candy execution assertions

Status: implemented

English | [中文](2026-09-02-candy-execution-assertions.zh.md)

## Problem

[Candy Runtime Boundaries](../../../../docs/candy-runtime-boundaries.md) requires the Candy runtime to validate a control-plane assertion's issuer, audience, expiry, tenant, account, session, device, workspace grant, and nonce before scheduling work, and to ignore or reject any tenant or account a client names in the request itself. Without one owned mechanism, each future scheduling path would re-derive that check, and the confused-deputy rule would live in whichever call site happened to remember it. The [control-plane identifiers](2026-09-02-candy-control-plane-identifiers.md) named the entities but carried no way to prove who a run belongs to.

## Decision

`@deepseek-ai/dsh-execution-assertion` (`packages/control-plane/execution-assertion`) mints and admits the per-run credential. `mintExecutionAssertion(claims, secret)` signs the control plane's decision; `admitExecutionAssertion(token, secret, expectation, now)` returns either the verified claims or one of a closed set of rejections — `malformed`, `unsupported-version`, `signature`, `issuer`, `audience`, `not-yet-valid`, `expired`, `lifetime`.

**The confused-deputy rule is enforced by the parameter list.** `ExecutionAssertionExpectation` names only `issuer`, `audience`, and `maxLifetimeMs`. It has no user, device, account, workspace-grant, conversation, session, or run field, so there is no parameter through which a caller can assert whose run this is; identity leaves the module only inside admitted claims, after the signature check. This is the rule enforced in the operation that makes the decision rather than by a facade a direct caller could bypass.

**Format follows in-repository prior art.** The token is `v1.<base64url payload>.<base64url HMAC-SHA256>`, the shape and 32-byte minimum secret [`dsh-client-connection`'s browser-session cookie](2026-08-24-browser-token-authentication.md) already uses. The MAC covers the received payload text, so admission never re-serializes a decoded object and JSON key order cannot change what was signed. Payload and signature must both be canonical base64url; both are decoded by round-trip comparison, and signature comparison is length-checked and then constant-time. The signature is verified before any claim is read.

The decoded payload is treated as a wire boundary, not a typed same-process value: every claim is checked for presence and type, ids must be non-empty strings, and timestamps must be non-negative safe integers. `now` is a parameter rather than a `Date.now()` read, so a scheduler admits against the timestamp it already holds and tests need no clock control.

The package takes the signing key as a parameter and owns nothing durable. It has no Cordis service, no credential-provider dependency, and no replay store.

## Alternatives considered

**Validate claims and leave authenticity to a later verifier.** This was the smaller change, and it was rejected: a claim validator whose safety depends on a verifier that does not exist yet is a half-mechanism, and a doc comment saying "verify first" is not enforcement when a direct caller can skip it. Signing and admission ship together so the module cannot be used in an unauthenticated way.

**Use a JWT library.** JWTs would bring a parser, an algorithm-negotiation field, and a specification's worth of options this credential does not need, and `alg`-confusion handling would become ours to audit. The repository already made this call once for browser sessions; following that prior art keeps one token shape to review rather than two, and the dependency would delete roughly forty lines while adding a much larger attack surface.

**Asymmetric signatures so the runtime cannot mint.** A stronger split, and the honest reason it lost is that key distribution — who holds the private key, how it rotates, how a runtime learns the public key — is unbuilt control-plane work with no current consumer. HMAC matches the trust arrangement that exists today: one control plane and its own runtimes. The limitation is recorded in the package README.

**Enforce the nonce here with an in-module replay set.** Rejected because single-use enforcement needs durable, tenant-partitioned state with expiry, which is scheduler-owned. An in-memory set inside a pure module would silently fail across processes and restarts while looking like a replay defense.

**Put this in `dsh-control-plane` beside the ids.** Rejected: the ids package advertises a dependency-free vocabulary, and folding a crypto and wire-format mechanism into it would give one package two reasons to change and force `node:crypto` on every id consumer.

## Consequences

A Candy scheduling path now has one call that turns a token into a run's identity, and no call that accepts identity from a request. Rejections are separated for operator diagnostics but every one denies the run, so a caller cannot retry into a weaker check. Unit coverage pins each rejection, tampering with a claim while keeping the original signature, a token signed by another key, exact-boundary lifetimes, and the last admissible millisecond.

Two properties the boundary page attributes to assertions are not delivered here, and both are recorded in the package README: admission does not consume the nonce, so an assertion can be replayed within its lifetime until a scheduler-owned replay store exists, and the signing key is an unmanaged parameter until the credential-vault work lands. Because the scheme is symmetric, an admitting runtime can also mint; that is acceptable while one control plane owns its own runtimes and must be revisited before a runtime is operated by anyone the control plane does not trust to issue.
