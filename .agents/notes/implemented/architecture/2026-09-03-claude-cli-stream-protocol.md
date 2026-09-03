# Agent Note: The Claude CLI's stream protocol, as measured rather than assumed

Status: implemented

English | [中文](2026-09-03-claude-cli-stream-protocol.zh.md)

## Problem

R2 of the [multi-tenant CLI agent runtime plan](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) needs the Claude CLI to serve a harness model request. The plan's choice was a direct parser over the Agent SDK: spawn the CLI with `--output-format stream-json` and translate its output into `StreamChunk`s. This note records what the CLI actually does, because three of its behaviors are the opposite of the reasonable assumption, and a parser written from the reasonable assumption would have been wrong in ways that pass their own tests.

The CLI was available at version 2.1.259, so every claim here comes from running it or from the `@anthropic-ai/claude-agent-sdk` 0.3.241 declarations it ships with. Both fixtures in `dsh-claude-cli-protocol` are real recorded runs.

## Decision

`@deepseek-ai/dsh-claude-cli-protocol` owns the protocol and nothing else: frame decoding, translation into the harness `StreamChunk` vocabulary, and composition of one isolated invocation. It spawns no process, so the whole protocol is testable against recorded output without a credential, a network, or a child process. The `LlmAdapter` that runs the CLI is a separate package and a later change.

### The terminal frame reports success on a wholly failed run

A run whose every request failed with HTTP 401 ends with `subtype: "success"`, alongside `is_error: true`, `api_error_status: 401`, and `terminal_reason: "api_error"`. Reading `subtype` — the obvious field, and the one the SDK's own type names as the success/error discriminant — would report an authentication failure as a successful empty turn. `mapFinish` therefore never reads it. The `auth-failure.jsonl` fixture is that run, and a test asserts both that the frame says `success` and that the translation says error, so the two cannot drift apart unnoticed.

### The CLI's `assistant` frames must be ignored, not read

Content arrives twice: once as `stream_event` frames carrying verbatim Messages API streaming events, and again as whole `assistant` messages. Reading both doubles every block. Worse, on a failed run the CLI synthesizes an `assistant` frame under `model: "<synthetic>"` whose content is the failure text — for the recorded run, `"Authentication error · This may be a temporary network issue, please try again"`. A parser that reads `assistant` frames puts transport failures into the transcript as model turns, and every later request then replays them as history. Only `stream_event` frames are read for content.

### Only `--bare` confines a run to the injected credential

Without it, the CLI authenticates with whatever ambient login the host has. The first recorded run did exactly that: `ANTHROPIC_API_KEY` was unset, the CLI used the host's OAuth session, and its init frame reported `apiKeySource: "none"`. In the multi-tenant runtime this is the confused-deputy failure the [boundaries doc](../../../../docs/candy-runtime-boundaries.md) forbids — one tenant's request billed to the host. With `--bare` and an injected key the same frame reports `apiKeySource: "ANTHROPIC_API_KEY"`, which is why `isCredentialIsolated` reads that field: the CLI states which credential it used, so the runtime can verify rather than assume.

`--bare` governs authentication but not routing. An ambient `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, or `ANTHROPIC_BASE_URL` sends the run to an endpoint that authenticates with the host's own cloud credentials and ignores the tenant key entirely. `SCRUBBED_ROUTING_VARIABLES` tombstones each of the names the shipped CLI reads; the flag and the tombstones together are what make the injected key the only reachable credential, and neither alone is sufficient.

### Frames are an open set, and the decoder is strict about exactly one thing

The stream multiplexes `active_goal`, `autocompact_state`, `rate_limit_event`, several `system` subtypes, and much else onto the same lines; the SDK declares 38 message members and documents the set as open. Unknown frame tags, unmodelled content-block types, and unrecognized delta types therefore produce no chunks rather than failing a run. The single strict rule is that a *complete* stdout line must be a JSON object, because anything else means the decoder is not reading what it believes it is. An unterminated final line — what killing the CLI produces — is discarded instead, since a truncated object is not a frame that can be honestly reported.

### Token counts map straight across

The CLI's counts are already disjoint: `input_tokens` excludes both `cache_read_input_tokens` and `cache_creation_input_tokens`. That is the harness `TokenUsage` convention, so `mapUsage` maps rather than subtracts — the opposite of `dsh-llm-deepseek`, whose provider folds cache hits into the prompt count.

## Consequences

The R2 adapter can be written against a protocol that is tested, so its own tests can be about process lifetime, cancellation, and cleanup rather than about parsing. Two costs are accepted. The package is pinned to one CLI version: the open frame union absorbs additions, but a renamed field this package acts on would surface as translation silently seeing no content, which only re-recording the fixtures would catch. And cost is dropped — the terminal frame carries `total_cost_usd` and per-model totals that include the CLI's own auxiliary calls (a recorded two-token request also billed a `claude-haiku-4-5` call), which `TokenUsage` has no field for, so a tenant's bill is not reconstructable from translated chunks alone.

One measurement is worth carrying into R3: an unconstrained run on a developer machine billed 8273 cache-creation tokens of discovered `CLAUDE.md` project context to answer a two-token prompt. `--bare` and `--setting-sources ""` are what keep a tenant from paying for whatever happens to sit in the runtime's working directory.

## Alternatives considered

**The Agent SDK, as `dsh-subagent-claude-code` uses it.** That package already drives the real CLI through `@anthropic-ai/claude-agent-sdk`, and reusing it would have avoided writing a parser. It was rejected for this seam because the SDK supplies an agent loop, and the `dsh-llm` seam needs a model call: the harness owns tool execution, history, and retry, so an adapter that delegates the loop would own two loops. The SDK's declarations were used as documentation, which is where the frame vocabulary here comes from.

**Trusting the SDK's types as the specification.** They describe the union accurately but not its behavior; nothing in them says that `subtype` is `"success"` on a failed run, that `assistant` frames duplicate streamed content, or that `apiKeySource` reports `"none"` without `--bare`. Each of those came from running the CLI, which is why the fixtures are recordings rather than hand-written samples.
