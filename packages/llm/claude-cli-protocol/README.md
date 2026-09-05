---
description: "Claude CLI stream-json frame decoding, StreamChunk translation, and the argument vector and environment that confine one run to one tenant's credential."
kind: "package-library"
---

# @deepseek-ai/dsh-claude-cli-protocol

English | [中文](README.zh.md)

## Summary

`dsh-claude-cli-protocol` is what the Claude CLI's `--output-format stream-json` output means and what an invocation of it must say. It decodes the CLI's line-delimited stdout, translates the frames into the harness [`StreamChunk`](../llm/README.md) vocabulary, and composes the argument vector and environment overlay that make one run a plain streaming model endpoint spending exactly one tenant's key. It spawns nothing: the adapter that runs the CLI supplies the process, so everything here is testable against recorded output with no credential, no network, and no child process.

The behavior was derived from `claude` 2.1.259 and the `@anthropic-ai/claude-agent-sdk` declarations shipped with it, not from documentation, and both test fixtures are real recorded runs. Three of the findings are load-bearing and none is guessable; they are described under [Understand the implementation](#understand-the-implementation).

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

### Reading one run's output

```ts
import { ClaudeCliFrameTranslator, ClaudeCliLineDecoder } from '@deepseek-ai/dsh-claude-cli-protocol'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

declare const stdout: AsyncIterable<string>

export async function* run(): AsyncIterable<StreamChunk> {
  const decoder = new ClaudeCliLineDecoder()
  const translator = new ClaudeCliFrameTranslator()
  for await (const chunk of stdout) {
    for (const frame of decoder.push(chunk)) yield* translator.translate(frame)
  }
  for (const frame of decoder.flush()) yield* translator.translate(frame)
}
```

Both objects hold per-run state, so each serves exactly one process. A run whose CLI exits without its terminal frame is closed by `translator.end(reason)`, which reports the counts the run did send and then the finish the caller classified from the exit itself.

### Composing one isolated invocation

```ts
import { claudeCliArguments, claudeCliEnvironment } from '@deepseek-ai/dsh-claude-cli-protocol'

export const spec = {
  argv: ['claude', ...claudeCliArguments({ prompt: 'summarize this', model: 'claude-opus-5' })],
  env: claudeCliEnvironment({ home: '/srv/candy/pools/abc', apiKey: 'sk-ant-tenant' }),
}
```

`home` is the run's [runtime pool root](../../control-plane/runtime-pool/README.md); the CLI derives its per-user state directory from it, so it is what separates one tenant's provider state from another's. The environment is a [`dsh-subprocess`](../../subprocess/subprocess/README.md) overlay: the two explicit strings survive that seam's parent scrub, and every other entry is a tombstone.

### Confirming the run spent the right credential

```ts
import { isCredentialIsolated } from '@deepseek-ai/dsh-claude-cli-protocol'
import type { WireFrame } from '@deepseek-ai/dsh-claude-cli-protocol'

declare const frame: WireFrame

export const verdict = isCredentialIsolated(frame)
```

The CLI announces which credential it authenticated with in its `system`/`init` frame. `true` means the injected tenant key; `false` means it found another one; `undefined` means this frame is not the announcement. A caller that treats `false` as fatal fails a misconfigured run before it bills anyone, rather than after.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/lines.ts`](src/lines.ts) | `ClaudeCliLineDecoder` and `ClaudeCliProtocolError`: stdout text to frames |
| [`src/frames.ts`](src/frames.ts) | `ClaudeCliFrameTranslator`, `mapUsage`, `mapFinish`: frames to `StreamChunk`s |
| [`src/launch.ts`](src/launch.ts) | `claudeCliArguments`, `claudeCliEnvironment`, `isCredentialIsolated`, `SCRUBBED_ROUTING_VARIABLES`, `SCRUBBED_STATE_VARIABLES` |
| [`src/types.ts`](src/types.ts) | The subset of the CLI's frame union this package acts on |
| — | No runtime invariant companion is published; this pure module owns no event stream or mutable runtime data, and its translation is enforced by unit tests over recorded runs. |

### The terminal frame reports success on a wholly failed run

A run whose every request failed authentication still ends with `subtype: "success"`. `mapFinish` therefore never reads `subtype`; `is_error` separates a completed turn from a failed one, and `api_error_status` and `terminal_reason` describe it. The `auth-failure.jsonl` fixture is that exact run, and a test asserts both that the frame says `success` and that the translation says error, so the two cannot drift apart silently.

### The CLI's `assistant` frames are ignored on purpose

They arrive alongside the `stream_event` deltas that already delivered the same content, so reading both would emit every block twice. On a failed run the CLI also synthesizes one whose content is the failure message, under `model: "<synthetic>"` — reading it would put a transport failure into the transcript as something the model said. Only `stream_event` frames, which carry verbatim Messages API streaming events, are read for content.

### Only `--bare` confines the run to the injected credential

Without it the CLI falls back to whatever ambient login the host has. A recorded run on a developer machine did exactly that, authenticating through the host's OAuth session and reporting `apiKeySource: "none"` — in a multi-tenant runtime, one tenant's request billed to the host. `--bare` restricts Anthropic authentication to `ANTHROPIC_API_KEY`, which is why it is not optional here.

`--bare` does not govern *which provider* the CLI talks to, so it is not sufficient alone. An ambient `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `ANTHROPIC_BASE_URL` redirects the run to an endpoint authenticated with the host's own cloud credentials, ignoring the tenant key entirely. `SCRUBBED_ROUTING_VARIABLES` tombstones each one; together with `--bare` the injected key becomes the only credential the run can reach.

### A pinned `HOME` is isolation only while nothing names a directory outside it

`claudeCliEnvironment` separates two tenants by giving each child its own `HOME`, which the caller sets to that tenant's runtime pool root. That separation is indirect: it holds because the child's configuration, caches, and account state are located *relative to* `HOME`. A variable that names one of those directories outright breaks the derivation without touching `HOME`, so the environment still reads as isolated. `CLAUDE_CONFIG_DIR` relocates the CLI's own configuration and account state, and the XDG base directories name cache, config, data, and state roots. A server started from an operator's shell — or from another agent that exports one — would hand every tenant the same directory to read and write.

`SCRUBBED_STATE_VARIABLES` tombstones them. The list covers the standard state-directory variables rather than only the ones a particular CLI version is known to read, because the two mistakes are not symmetric: a tombstoned name the CLI ignores changes nothing, since the fallback is the location under the pinned `HOME` that was wanted anyway, while a name left off the list is a directory two tenants share.

### Frame handling is open by default

The CLI multiplexes session bookkeeping, rate-limit reports, hook and task activity, and status onto the same stream, and its own declarations describe that union as an open set. Unknown frame tags, unmodelled content-block types, and unrecognized delta types therefore yield no chunks instead of failing the run. The one thing that does fail is a *complete* stdout line that is not a JSON object, because that means the decoder is not reading what it believes it is; an unterminated final line, which is what killing the CLI produces, is discarded instead.

### Token counts are mapped, not adjusted

The CLI reports counts that are already disjoint — `input_tokens` excludes both cache figures — which is the harness `TokenUsage` convention, so `mapUsage` maps them straight across. This is the opposite of [`dsh-llm-deepseek`](../llm-deepseek/README.md), whose provider folds cache hits into the prompt count and which must subtract them back out.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-llm`](../llm/README.md) — the `StreamChunk` protocol this package translates into, and the adapter contract its consumer implements.
- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — the confused-deputy rule the launch composition enforces at the process boundary.
- [`dsh-runtime-pool`](../../control-plane/runtime-pool/README.md) — where a run's `home` comes from.
- [`dsh-credential-vault`](../../control-plane/credential-vault/README.md) — where its `apiKey` comes from.
- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) — the R1–R6 delivery plan; this package is the protocol half of R2's Claude CLI adapter.

-----

<a id="model-experience"></a>
## Model Experience

### The caller's prompt text, passed through to the CLI

#### What the model sees

`claudeCliArguments` passes a caller's `systemPrompt` verbatim as the CLI's `--system-prompt` value, which replaces the CLI's own built-in agent prompt for that run. Omitting it leaves that built-in prompt in force, so the model receives Claude Code's agent instructions rather than the harness's. This package writes no prompt text of its own and does not wrap, prefix, or truncate what it is given; the caller assembling the request owns every word.

#### Token effect

Zero direct effect. The request's prompt tokens are exactly the caller's `systemPrompt` plus the positional prompt, both passed through unchanged. The one package-owned effect is a reduction: `--bare` and `--setting-sources ""` keep the CLI from prepending ambient project context, which an unconstrained run does load — a recorded two-token request on a developer machine still billed 8273 cache-creation tokens of discovered `CLAUDE.md` context.

#### KV Cache effect

Prefix-stable across runs that pass the same `systemPrompt`, because the argument vector is composed deterministically from the caller's values with no timestamp, path, or identifier of this package's own. Two package-owned choices can invalidate reuse: changing `systemPrompt` between runs replaces the cached prefix, and omitting it hands the run the CLI's built-in prompt, which this package neither pins nor versions and which a CLI upgrade may change under an unchanged caller.

### The assistant content translated back from the CLI

#### What the model sees

Nothing on this path reaches the model on this turn; it is what a *later* turn replays. The translator emits only content the CLI delivered as Messages API `stream_event` frames, so the assistant text, reasoning, and tool calls recorded in the session log are the model's own output. The CLI's synthetic `assistant` frames are dropped, which is what keeps a transport failure — an authentication error's `"Authentication error · This may be a temporary network issue, please try again"` — out of the transcript and therefore out of every subsequent request's history.

#### Token effect

Zero direct effect on this turn. Retained: every emitted block enters the session log and is replayed as history on later turns. The dropped synthetic frames are the package's one token saving on those later turns, and dropping them is correctness rather than economy.

#### KV Cache effect

Append-only. Translated blocks are appended to the conversation in stream order and never rewritten, so a later turn's prefix stays reusable. A run this package finishes as an error contributes no content blocks at all, leaving the prior prefix untouched rather than extending it with a failure the model would then have to read.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **No process** — nothing here spawns, cancels, or reaps the CLI. The package supplies what an adapter needs to read and say; running the CLI, projecting a harness request onto its single positional prompt, and honoring `options.signal` belong to [`dsh-llm-claude-cli`](../llm-claude-cli/README.md), which consumes it.
- **A single prompt, not a conversation** — `claudeCliArguments` composes one positional prompt. Replaying a multi-turn harness history needs the CLI's `--input-format stream-json`, whose input message format this package does not model.
- **No tool round trip** — tool-call blocks are translated, but the invocation is composed with `--tools ""` because the harness executes tools itself. Returning a tool result to the CLI is part of the conversation gap above.
- **Only the invocation total is carried, not its breakdown** — `total_cost_usd` reaches `TokenUsage.costMicroUsd`, but the terminal frame's per-model `modelUsage` totals are dropped. A tenant's bill is reconstructable; which model earned which part of it is not.
- **The isolation verdict is reported, not enforced** — `isCredentialIsolated` reads the CLI's announcement; nothing here fails a run whose answer is `false`, because this package never owns the process to fail.
- **Pinned to one CLI version** — the fixtures and the frame vocabulary come from `claude` 2.1.259. The frame union is open, so a newer CLI adding frames is handled; one that renames a field this package acts on is not, and would surface as a translation that silently stops seeing content.
- **Re-recording the fixtures needs a live CLI and a key** — both are real recorded runs, so refreshing them is a manual step: run the flags `claudeCliArguments` builds, then normalize session ids, uuids, host paths and account telemetry, and empty the payloads of ignored frames. `text-turn.jsonl` is deliberately recorded *without* `--bare`, so it pins the un-isolated `apiKeySource` this package exists to detect; re-recording it with `--bare` would silently retire that coverage.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Whether the isolation verdict should be a hard precondition the adapter enforces, or a fact it logs, is undecided; it depends on whether a deployment can legitimately run this CLI against a non-`ANTHROPIC_API_KEY` credential.
- The CLI's `system`/`api_retry` frames expose its internal retry attempts and their statuses. They are ignored today, but they are the only place a caller could see a run being retried behind `dsh-llm-retry`'s back.

</details>
