---
description: "Serves a provider route on the LLM seam by running the Claude CLI as a model endpoint, one process per model call, under one tenant's credential."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-cli

English | [中文](README.zh.md)

## Summary

`dsh-llm-claude-cli` registers a `dsh-llm` provider route that answers model calls by running the Claude CLI. One `stream()` call is one CLI process. The package owns that process's lifetime and nothing about the protocol: [`dsh-claude-cli-protocol`](../claude-cli-protocol/README.md) decides what the invocation says and what its output means, so what lives here is spawning, reading stdout, classifying an exit, and guaranteeing exactly one terminal chunk however the process ends.

The route is deliberately narrow. The CLI is a one-shot prompt surface, not a stateless chat endpoint, and this package refuses what it cannot express rather than dropping it — see [What this route accepts](#use-this-package).

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

### Composing the route

```yml
- id: llm-claude-cli
  name: '@deepseek-ai/dsh-llm-claude-cli'
  config:
    cwd: /srv/candy/work
    home: /srv/candy/pools/9f2c…
    apiKeyEnv: CANDY_TENANT_KEY
```

`home` is the run's [runtime pool root](../../control-plane/runtime-pool/README.md), and `apiKeyEnv` names the variable the credential is read from at load. A route with no credential to inject fails the composition rather than registering and failing later.

### What this route accepts

One user turn of text, a system prompt, a model id, and a reasoning effort. Everything else is refused with `UNSUPPORTED_REQUEST` naming the one thing that stopped the run:

| Request carries | Outcome |
|---|---|
| One user message, text blocks only | Runs |
| `system`, `model`, `reasoningEffort` (`low`…`max`) | Runs; each maps to a CLI flag |
| More than one message | Refused — the CLI replays no assistant history |
| A non-text block | Refused — the positional prompt carries text only |
| `tools` | Refused — the CLI accepts no caller-supplied schemas |
| `maxTokens`, `temperature`, `stop` | Refused — the CLI has no flag for them |

Refusal is the point. Each of these has no CLI expression, and silently dropping one would change what the model was asked without the caller ever seeing it. The refusal happens at the `stream()` call, before anything spawns.

### Per-tenant instances, not per-request identity

`ClaudeCliAdapter` carries one tenant's home and credential on the instance. A multi-tenant runtime constructs one adapter per runtime pool; it does not load this plugin once and vary identity per request. There is no parameter on `stream()` through which one tenant's request could reach another's credential.

```ts
import { ClaudeCliAdapter } from '@deepseek-ai/dsh-llm-claude-cli'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

declare const run: AdmittedRun
declare const subprocess: SubprocessRuntime

export const adapter = new ClaudeCliAdapter({
  executable: 'claude',
  cwd: run.poolRoot,
  isolation: { home: run.poolRoot, apiKey: Buffer.from(run.secret).toString('utf8') },
  graceMs: 5_000,
  spawn: spec => subprocess.spawn(spec),
  requireCredentialIsolation: true,
})
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/request.ts`](src/request.ts) | `projectRequest`: one harness request onto one invocation, or a named refusal |
| [`src/adapter.ts`](src/adapter.ts) | `ClaudeCliAdapter`: process lifetime, stdout reading, exit classification |
| [`src/index.ts`](src/index.ts) | The plugin, its `Config`, and `resolveAdapterOptions` |
| — | No runtime invariant companion is published; the seam's own `dsh-llm/invariant` already checks the chunk grammar around every provider stream, and this package owns no other independently observable relation. |

### Why history is refused rather than flattened

The CLI's `--input-format stream-json` accepts only user messages, and each one it accepts starts its own turn with its own terminal frame — a recorded two-message input produced two `result` frames. It therefore replays no assistant history and cannot serve one model call. The alternative, rendering the conversation into the prompt as text, means inventing a transcript format this repository has no evidence for; getting it wrong degrades model output silently, and nothing in the harness would show it. The decision waits for a consumer that needs it.

### Exactly one terminal chunk, three ways to get there

The CLI's terminal frame ends a normal run. When stdout closes without one, the run was cancelled or the process died, and those are settled differently. Cancellation is read from the caller's signal alone and never from the process: the subprocess seam has only *started* the termination ladder, so a child ignoring `SIGTERM` would otherwise hold the run open for the whole grace period after the caller already gave up. Only a run nobody cancelled waits for exit facts, which then name the code or signal.

A run cut short still reports the counts it did send — the translator keeps the last `message_delta` usage precisely so a killed process is accounted for rather than silently free.

### The isolation check is enforced here, not merely reported

`dsh-claude-cli-protocol` can say whether the CLI authenticated with the injected key; only this package owns a run to fail. With `requireCredentialIsolation` (the default), an init frame naming another credential source throws mid-stream, so a run that reached the host's own login stops instead of completing and billing someone who never asked for it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-claude-cli-protocol`](../claude-cli-protocol/README.md) — what the invocation says and what its output means, and the three measured CLI behaviors this adapter depends on.
- [`dsh-llm`](../llm/README.md) — the `LlmAdapter` contract and the `StreamChunk` protocol.
- [The Claude CLI's stream protocol, as measured](../../../.agents/notes/implemented/architecture/2026-09-03-claude-cli-stream-protocol.md) — why the protocol is parsed directly rather than through the Agent SDK.
- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.md) — the confused-deputy rule the per-instance isolation enforces.

-----

<a id="model-experience"></a>
## Model Experience

### The caller's texts, passed through to the CLI

#### What the model sees

The request's single user turn becomes the CLI's positional prompt, and `options.system` becomes its `--system-prompt` value; both are passed through verbatim, joined from their text blocks in order. Omitting the system prompt leaves the CLI's own built-in agent prompt in force, so the model receives Claude Code's instructions rather than the harness's — a route that means to replace them must send one. This package writes no prompt text of its own, and adds no wrapper, prefix, or separator around the caller's.

#### Token effect

Zero direct effect: the request's tokens are exactly the caller's two texts. The package-owned effects are both reductions. Refusing a conversation means this route never sends history at all, so its requests do not grow across turns. And the invocation the protocol package builds keeps the CLI from loading ambient project context, which an unconstrained run does read from the working directory.

#### KV Cache effect

Independent per call. Each `stream()` is a fresh process and a fresh CLI session, so no prefix is carried between requests and none of this package's choices can invalidate a reusable one. The provider may still cache server-side across identical prefixes; that is outside this route's contract.

### The assistant content this route records

#### What the model sees

Nothing on this turn; it is what a later turn would replay, if a later turn could — which for this route it cannot, since a conversation is refused. Within one call the chunks are the model's own output, because the protocol package reads only the CLI's streaming events and drops the synthetic frames that carry failure text as assistant content.

#### Token effect

Zero direct effect on this turn, and no retained effect across turns: a refused conversation means nothing recorded here is ever sent back to the model by this route.

#### KV Cache effect

Independent. Blocks are appended to the caller's session log in stream order, and a run this route finishes as an error or an abort contributes no content blocks at all, so a failure never lands in a transcript another request would carry.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **The agent loop cannot use this route** — the loop sends conversation history and tool schemas on every request, and both are refused. The route serves one-shot calls, which is the shape of the seam's own auxiliary purposes (`compaction`, `session-title`). Serving the loop needs the history and tool decisions below, in that order.
- **No tool round trip** — the CLI has no flag that accepts caller-supplied tool schemas; reaching them would mean exposing the harness's tools through an MCP server, which this package does not build. Tool-call blocks in CLI output are still translated, so the gap is inbound only.
- **Cost arrives only at the end, and only as one number** — the usage chunk carries the CLI's `total_cost_usd` as `costMicroUsd`, so a run that dies before its terminal frame reports no cost however much it spent, and the per-model breakdown is dropped. `maxBudgetUsd` still caps a run independently of what is reported.
- **No retry classification** — every failure maps to `CLI_EXIT` or the protocol package's `terminal_reason`, and no route-owned retry policy is declared, so `dsh-llm-retry` treats these failures with its defaults. The CLI also retries internally before reporting, which is invisible to that policy.
- **`resolveModel` validates nothing** — the CLI publishes no catalogue and accepts both aliases and exact ids, so any model id is reported as resolvable and a wrong one surfaces as a CLI failure rather than a routing error.
- **One tenant per instance, by construction** — this is the isolation property, but it means a deployment serving many tenants owns constructing and disposing one adapter per pool; nothing here manages that lifecycle.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The composition test's fixture was recorded without `--bare`, so it reports an ambient credential and the test opts out of `requireCredentialIsolation` to exercise output. Recording an isolated *successful* run needs a real API key, which the machine that produced these fixtures did not have — it had an OAuth session, which `--bare` deliberately ignores. A fixture recorded with both would let that test keep the shipped default.
- Whether a refused request should be a thrown `LlmError` or a terminal `error` finish is worth revisiting if a caller appears that would rather route around this provider than fail; today throwing is right, because a silently degraded request is worse than a loud one.

</details>
