# Agent Note: One step decides a nonce

Status: implemented

English | [中文](2026-09-03-one-step-decides-a-nonce.zh.md)

## Problem

`dsh-execution-assertion` binds a nonce into the signature and returns it without consuming it, on purpose: it owns nothing durable. `dsh-run-admission` requires a `spendNonce` port and never retries a nonce reported as spent. Between them, the port is the whole of Candy's replay protection, and no implementation of it existed — every caller in the repository supplied a test fake.

Leaving it to each deployment is not neutral, because the obvious implementation is wrong. The port returns a promise, so it invites "look the nonce up, then insert it". Two concurrent admissions of one token each observe the nonce as fresh before either records it, and both reach the credential. That is the exact failure the port exists to prevent, and it is invisible in any test that presents the token twice in sequence.

Two more choices are easy to get wrong and cost nothing to get right. Retention on a fixed timer, rather than on the assertion's own expiry, either forgets a nonce while its assertion is still admissible — reopening replay inside the window the nonce closes — or keeps records that can no longer deny anything. And a store keyed by the nonce alone lets one tenant deny another's run by spending a value first.

## Decision

`RunReplayStore.spend(claims, now)` reads and writes in one synchronous step and returns whether the nonce was fresh. A caller wraps it in the promise the port returns; the contract is that nothing may `await` between asking and recording. A durable implementation preserves this with one statement — an insert that fails on a uniqueness conflict, whose affected-row count is the answer — not with a read followed by a write.

A record is held while its assertion is still admissible and treated as absent after. That bound is the assertion's, not a policy: `admitExecutionAssertion` refuses an expired assertion before admission reaches this store, and both refuse at the same millisecond, so a record stops counting exactly when it stops being needed.

The key is the tenant and the nonce, length-prefixed so no pair of values can forge the boundary between them. Partitioning weakens nothing, because a replayed token carries the tenant its signature binds and recomputes the same key.

`evict` is separate from `spend` and changes no decision. It reclaims memory, and it is a call rather than a timer for the reason `RunLedger.expire` is: the store owns no clock, and a caller that drives one drives both.

## Consequences

A single-process deployment has a correct replay store. A deployment running more than one runtime process still needs a durable one, and now has the three obligations written down rather than inferred.

The store has no size cap, and that is deliberate: both answers to a full store are wrong. Forgetting a record reopens replay; refusing a fresh nonce denies a legitimate run. The count is bounded by what was admitted within one maximum assertion lifetime, which a deployment sizes from its own issue rate.

## Alternatives considered

**Build it on `storage-domain` and the SQLite backend.** That is the shape a real deployment needs, and it is a Cordis plugin with a real-composition test, a schema, and a migration. It is also the wrong first step: the durable version has to satisfy a contract, and the contract is what was missing. Writing the substrate first would have produced a persistent store with the same test-then-write defect.

**Fold the store into `dsh-run-admission` as a default.** Then a deployment that supplies nothing silently gets in-process replay protection while running four processes. The port being required is what makes a deployment answer the question; a default answers it wrongly and quietly.

**Give `spend` an explicit lock or queue.** There is nothing to serialize: the decision is already indivisible because it does not yield. A lock would add a failure mode — a holder that never releases — to protect a step that cannot interleave.
