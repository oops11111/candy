---
description: "Shared lifecycle and secret-handling contract suite that dsh-llm adapters run against themselves, for adapter authors proving cancellation, cleanup, and credential containment."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-adapter-contract

English | [中文](README.zh.md)

## Summary

`dsh-llm-adapter-contract` is the part of the `dsh-llm` adapter contract that a type signature cannot state and [`dsh-llm/invariant`](../../llm/llm/README.md) cannot see. That validator already enforces the chunk grammar around every registered provider stream — block pairing, one usage, one terminal finish, nothing after it. This suite covers the rest: whether a cancelled run settles, whether an abandoned run releases what it started, and whether the credential an adapter holds can reach a caller through the chunks, errors, or diagnostics it produces.

An adapter package calls `testLlmAdapterContract` from its own spec file and supplies the runs its test infrastructure can script. The suite assumes nothing about transport, so the same eight cases run against an HTTP provider and a spawned CLI.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```ts
import { testLlmAdapterContract } from '@deepseek-ai/dsh-llm-adapter-contract'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

declare const SECRET: string
declare function viaSeam(script: 'ok' | 'fail' | 'open'): AsyncIterable<StreamChunk>
declare function releasedSoFar(): boolean

testLlmAdapterContract({
  name: 'MyAdapter',
  secret: SECRET,
  run: () => viaSeam('ok'),
  failingRun: () => viaSeam('fail'),
  openRun: () => ({ chunks: viaSeam('open'), released: releasedSoFar }),
}, { describe, it, expect })
```

### Every stream must come from the seam

`run`, `failingRun`, and `openRun` return what `LlmRuntime.stream()` produces, never the adapter's own `stream()`. This is load-bearing rather than stylistic: the guarantee of exactly one terminal chunk belongs to the runtime, which turns an adapter throw into a terminal `error` or `aborted` finish. An adapter may legitimately throw instead of yielding a finish — `dsh-llm-deepseek` does — so a suite pointed at a raw adapter would fail conforming adapters while testing a contract no caller relies on.

### What each run must be

| Run | What the provider does |
|---|---|
| `run` | Produces content and finishes normally; honors `signal` when the suite supplies one |
| `failingRun` | Fails after the adapter committed — a rejected credential, an exhausted quota, a crash |
| `openRun` | Produces at least one chunk, then stops without finishing, standing in for a live process or connection |

`secret` must be the exact credential the adapter was constructed with. The suite searches every chunk, message, and nested error property for that string; given a placeholder it would pass while proving nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `testLlmAdapterContract`, the subject and harness interfaces, and the leak search |
| — | No runtime invariant companion is published; the package is test-only infrastructure that registers nothing and owns no runtime relation. |

### Why release is polled rather than asserted

Releasing an abandoned run is not always synchronous. Terminating a process tree is; closing a socket completes on a later tick. A suite that asserted immediately after the consumer stopped reading would fail a conforming HTTP adapter, so the observation is polled to a deadline — fast when release is prompt, and a failure rather than a hang when it never comes.

### Why the leak search walks more than the message

A credential reaches a caller through whichever field its adapter did not think about. The search therefore flattens each value completely: an error's message, name, stack, and `cause` chain, and every property of every nested object, with a cycle guard. A search of `error.message` alone would miss a provider error that echoed the request.

### The suite tests itself

A conformance suite that cannot fail is worse than none, because it reports confidence it has not earned. Its own spec drives it with deliberately non-conforming subjects — a run that never finishes, one that finishes twice, an adapter that never releases, and a secret placed in a chunk, a reported failure, a thrown error, and an error with no stack — and asserts which case rejects each.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-llm`](../../llm/llm/README.md) — the `LlmAdapter` contract, the `StreamChunk` protocol, and the runtime that normalizes an adapter throw.
- [`dsh-llm-deepseek`](../../llm/llm-deepseek/README.md) and [`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.md) — the two adapters that run this suite, over HTTP and over a spawned process.
- [Provider adapter conformance](../../../.agents/notes/implemented/architecture/2026-09-03-llm-adapter-conformance.md) — why these properties live in a shared suite and what running it found.

-----

<a id="model-experience"></a>
## Model Experience

None, as this test-only suite sends no request to a provider model; it observes chunks the adapter under test already produced.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **The subject supplies its own scenarios** — the suite cannot make a provider fail or hang, so an adapter whose test infrastructure cannot script those runs cannot be covered. Both current subjects script them at the transport (a mock HTTP server, a scripted process handle).
- **A leak is found only where the secret appears verbatim** — a credential that reached a caller encoded, hashed, or truncated passes the search. The check is for the common case of a value passed through, not for an adversarial encoder.
- **Timeout, quota, and crash are one case, not three** — the plan's fixture list names them separately, but every one of them reaches the adapter as a failed run, and the suite asserts what the adapter must do with a failure rather than how it was caused. An adapter that distinguishes them owes its own tests for the distinction.
- **Nothing checks the chunk grammar** — that is `dsh-llm/invariant`'s job around registered streams, and duplicating it here would put the same rule in two places.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The harness parameter exists because the suite is a library, not a spec file, and vitest's globals are not available to it. If a repo-wide test-globals decision ever lands, the parameter could go.
- `dsh-llm-pi-ai` is a third adapter on this seam and does not yet run the suite; adding it needs a scripted failing and open run against its own gateway stand-in.

</details>
