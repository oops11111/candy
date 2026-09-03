---
description: "The single-use record behind an execution assertion's nonce, so two copies of one token cannot both start a run."
kind: "package-library"
---

# @deepseek-ai/dsh-run-replay

English | [中文](README.zh.md)

## Summary

An execution assertion carries a nonce and [`dsh-execution-assertion`](../execution-assertion/README.md) deliberately does not consume it: the signature binds it, and remembering it is somebody else's job. [`dsh-run-admission`](../run-admission/README.md) is where that job lands — it requires a `spendNonce` port and never retries a nonce reported as spent, which makes that port the whole of Candy's replay protection.

This package is that port's in-process implementation, and the statement of what any implementation owes. Three things decide whether a replay store works, and each is easy to get wrong: the decision must be one indivisible step, retention must be bounded by the assertion rather than by a timer, and the record must be partitioned by tenant.

Nothing here persists anything, and nothing here holds a clock.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Satisfying the `spendNonce` port

```ts
import { RunReplayStore } from '@deepseek-ai/dsh-run-replay'
import type { ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'

const replay = new RunReplayStore()

export const spendNonce = (claims: ExecutionAssertionClaims): Promise<boolean> =>
  Promise.resolve(replay.spend(claims, Date.now()))
```

`spend` returns true when the nonce had not been seen, which admits the run, and false when it had, which denies it. The current time is a parameter rather than a read of the process clock, so a scheduler that already has a decision timestamp admits against that instant and tests need no clock control.

### Reclaiming what can no longer deny anything

```ts
import { RunReplayStore } from '@deepseek-ai/dsh-run-replay'

declare const replay: RunReplayStore

export const dropped = replay.evict(Date.now())
```

`evict` changes no decision — `spend` already treats an expired record as absent — so a deployment that never calls it denies exactly the same runs and only holds more of them. It is a call rather than a timer for the reason `RunLedger.expire` is: the store owns no clock, and a caller that drives one drives both.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The key derivation and `RunReplayStore` |
| — | No runtime invariant companion is published; this module owns no event stream, and the one relation it holds is checked by unit tests. |

### Why the decision must be one step

`spend` reads and writes without an intervening `await`. The port returns a promise, so the tempting implementation is "look the nonce up, then insert it" — and a store written that way admits *both* copies of a replayed token, because each observes the nonce as fresh before either records it. The tests pass thirty-two concurrent copies of one token through the port and require exactly one to be admitted.

A durable implementation preserves this with one statement, not two: an insert that fails on a uniqueness conflict, whose affected-row count is the answer. A read followed by a write is the same defect at a longer distance.

### Why retention is bounded by the assertion

A nonce is held while its assertion is still admissible and forgotten after. Forgetting sooner reopens replay inside the assertion's own lifetime, which is exactly the window the nonce exists to close. Holding longer keeps a record that can no longer deny anything, because `admitExecutionAssertion` refuses the assertion on its own before admission reaches this store.

The two boundaries line up on the same millisecond: that call denies at the expiry instant, and a record stops counting at the expiry instant.

### Why the record is partitioned by tenant

The key is the tenant and the nonce, length-prefixed so no pair of values can forge the boundary between them — both are opaque strings this package does not constrain, and `('ab', 'c')` must not collide with `('a', 'bc')`.

Partitioning weakens nothing: a replayed token always carries the tenant its signature binds, so the same key is recomputed. What it prevents is one tenant denying another's run by spending a nonce value first.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-execution-assertion`](../execution-assertion/README.md) — where the nonce is signed, and where an expired assertion is refused before it reaches this store.
- [`dsh-run-admission`](../run-admission/README.md) — the `spendNonce` port, and why the nonce is spent after the budget is read and before the credential is opened.
- [Candy control plane](../../../docs/subsystems/candy-control-plane.md) — the composition order this store sits in.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan; this package is R1's replay store.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These are current package constraints, not a task backlog.

- **One process, not a deployment** — the record lives in memory for the life of the instance. Two runtime processes sharing a control plane each admit a copy of the same token, and a restart forgets every unexpired nonce. A deployment that runs more than one process needs a durable store, and this package's contract is what that store must satisfy.
- **Nothing drives the clock** — `evict` is a call, not a timer. A deployment that never calls it denies the same runs and holds more records.
- **Size is bounded only by the issue rate** — the count is what was admitted within one maximum assertion lifetime. There is no cap, because both answers to a full store are wrong: forgetting a record reopens replay, and refusing a fresh nonce denies a legitimate run.
- **No Cordis service** — nothing here registers on a `Context`; it is constructed directly.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
