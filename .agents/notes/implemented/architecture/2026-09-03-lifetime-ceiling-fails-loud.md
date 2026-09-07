# Agent Note: An unenforceable lifetime ceiling is refused, not applied

Status: implemented

English | [中文](2026-09-03-lifetime-ceiling-fails-loud.zh.md)

## Problem

`admitExecutionAssertion` takes two values from the deployment: the HMAC secret and `ExecutionAssertionExpectation.maxLifetimeMs`. It validated one of them. The secret has always thrown a `RangeError` below 32 bytes. The lifetime ceiling went straight into `claims.expiresAt - claims.issuedAt > expectation.maxLifetimeMs` with nothing checked.

A ceiling of `NaN` makes that comparison false for every span, so the ceiling stops bounding anything and an assertion minted with a year of life is admitted. `NaN` is not an exotic value here: it is what `Number(...)` returns for an environment variable a deployment forgot to set, and `dsh-run-admission` passes the expectation through to this call unread. The runtime keeps admitting runs and reports nothing, so the only symptom is that short-lived credentials stopped being short-lived.

A zero or negative ceiling is the mirror failure and just as quiet. Every assertion is denied under the `lifetime` rejection, whose documented meaning is that the issuer's issued-to-expiry span was too long. An operator reading a runtime that denies every run under `lifetime` is being pointed at the control plane, which minted nothing wrong.

## Decision

`admitExecutionAssertion` admits its ceiling the way it already admits its secret: `maxLifetimeMs` must be a positive safe integer, and anything else throws a `RangeError` naming the value before the token is parsed.

Refusing is the only outcome that carries the fact. The admission result cannot: it is a verified claim set or one of a closed set of rejections that describe the assertion, and none of them describes the runtime's own configuration. Choosing a default ceiling instead would be worse — a deployment that meant thirty seconds and typed nothing would silently get whatever this package picked, which is the unsupported default `packages/AGENTS.md` forbids.

This is a wire-and-config check, not a typed same-process one. `maxLifetimeMs: number` cannot express positive, integral, or finite, so the static interface does not require what the comparison needs.

## Consequences

A deployment whose lifetime ceiling is missing or malformed now fails on its first admission with a message naming `maxLifetimeMs`, rather than running without a lifetime bound or denying every run under a rejection that blames its peer.

Callers gain a documented `@throws`. `dsh-run-admission` is the only current caller and forwards a deployment-supplied expectation, so the throw surfaces at the same place its secret-length throw already does.

## Alternatives considered

**Return a new `configuration` rejection.** It would put a runtime fault into a set whose every member denies one specific run for something the assertion did. A caller that logs rejections per run would record thousands of them and never learn that one number is wrong.

**Clamp a non-positive ceiling to a minimum and treat `NaN` as zero.** Both invent a policy the deployment did not state, and the `NaN` half converts a total loss of the lifetime bound into a total denial without telling anyone either was configured.

**Validate at the type, with a branded `PositiveMilliseconds`.** The expectation is built by whatever assembles the runtime's configuration, which is not yet written; a brand would move the check to a boundary that does not exist while leaving this call trusting its input.
