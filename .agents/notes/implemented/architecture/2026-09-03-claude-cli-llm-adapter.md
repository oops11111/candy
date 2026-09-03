# Agent Note: The Claude CLI as an LLM route, and what it refuses

Status: implemented

English | [中文](2026-09-03-claude-cli-llm-adapter.zh.md)

## Problem

[R2 of the multi-tenant runtime plan](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) needs the Claude CLI to serve the `dsh-llm` seam. The protocol was settled separately ([measured stream protocol](2026-09-03-claude-cli-stream-protocol.md)); what remained was the adapter — process lifetime, cancellation, cleanup — and one design question the protocol work exposed rather than answered.

That question is the gap between what the seam sends and what the CLI accepts. `GenerateOptions` carries a full conversation, a tool catalogue, and generation controls. The CLI's command line accepts one positional prompt, a system prompt, a model, and an effort level. Nothing bridges them, and the ways to pretend otherwise all fail quietly.

## Decision

`@deepseek-ai/dsh-llm-claude-cli` registers one route and refuses what it cannot express. One `stream()` call is one CLI process; the adapter owns that process and nothing about the protocol.

### History is refused, not flattened

Two options existed and both were rejected on evidence.

Feeding the conversation through `--input-format stream-json` does not work: the CLI accepts only user messages there, and a recorded two-message input produced **two turns with two terminal frames**. It is a session protocol, not history replay, and it cannot serve one model call.

Rendering the conversation into the prompt as text would work mechanically, and that is the trap. It means inventing a transcript format — some spelling of turn boundaries and roles — that this repository has no evidence for. `dsh-subagent-claude-code`, the only prior art for handing work to this CLI, refuses everything but a one-shot text task rather than inventing one. A wrong format degrades model output silently, with nothing in the harness to show it, which is exactly the case the [evidence rule](../../../../packages/AGENTS.md) covers: configurability does not justify an unsupported format. The decision waits for a consumer that needs it.

The consequence is stated plainly rather than papered over: the agent loop cannot use this route, because it sends history and tools on every request. The route serves one-shot calls — the shape of the seam's own `compaction` and `session-title` purposes.

### Every unexpressible option is refused by name

Tool schemas, `maxTokens`, `temperature`, and `stop` have no CLI flag. Each is refused with `UNSUPPORTED_REQUEST` naming the one thing that stopped the run, at the `stream()` call, before anything spawns. Silently dropping any of them would change what the model was asked without the caller seeing it. `reasoningEffort` is the option that *does* map: `--effort` accepts five levels, so the adapter exposes exactly those and refuses an effort id minted by another adapter rather than dropping it.

### Cancellation is settled from the signal, never from the process

When stdout closes without a terminal frame the run was cancelled or the process died. An early version awaited the process outcome in both cases; a test with a process whose `done` never settles caught it. The subprocess seam only *starts* the termination ladder, so a child ignoring `SIGTERM` would hold the run open for the whole grace period after the caller had already given up. Cancellation is now read from the caller's signal alone, and only an uncancelled run waits for exit facts.

A run cut short still reports the counts it sent. The translator retains the last `message_delta` usage precisely so a killed process is accounted for instead of appearing free.

### Isolation is enforced here because only here owns a run to fail

The protocol package can say whether the CLI authenticated with the injected key; it owns no process. With `requireCredentialIsolation` — the shipped default — an init frame naming another credential source throws mid-stream, so a run that reached the host's own login stops rather than completing and billing someone who never asked. A route configured with no credential fails the composition at load instead of registering and failing later.

### Identity lives on the instance, not in the request

`ClaudeCliAdapter` carries one tenant's home and credential. A multi-tenant runtime constructs one per runtime pool. There is no `stream()` parameter through which one tenant's request could name another's credential — the same confused-deputy closure `dsh-run-admission` makes for scheduling, applied at the process boundary.

## Consequences

The route is genuinely usable for one-shot calls and genuinely unusable for the loop, and the README says so in those words. Two costs follow. Cost accounting is terminal-only: the usage chunk carries the terminal frame's `total_cost_usd` as `costMicroUsd`, so a run that dies before that frame reports no cost however much it spent, and `maxBudgetUsd` caps a run independently of what is reported. And retry classification is absent: every failure maps to `CLI_EXIT` or the CLI's own `terminal_reason`, while the CLI additionally retries internally before reporting — invisible to `dsh-llm-retry`.

The composition test opts out of the isolation default, because the only fixture with model output was recorded without `--bare` and therefore reports an ambient credential. That is recorded as a Dev Note rather than hidden: recording an isolated successful run needs an API key, and the machine that produced these fixtures had only an OAuth session, which `--bare` deliberately ignores. The default itself is covered — a separate composition test asserts that it refuses exactly that fixture.

## Alternatives considered

**Keeping a CLI session per harness session** and sending only the newest turn. This would give real multi-turn behavior, and it was rejected because the CLI would then own the transcript. The harness rule is that anything reaching a model request must be reconstructable from the session log; a CLI-owned history diverges from that log with no way to detect it, and resuming a session is not a model call the seam can describe.

**Registering the adapter through the subagent seam**, as `dsh-subagent-claude-code` does. That seam already runs this CLI successfully, but it delegates an agent loop. The `dsh-llm` seam needs a model call, and an adapter that delegated a loop would leave the harness owning two.

**Accepting the unexpressible options silently.** Rejected for the reason the refusals exist: a request whose tool schemas or token cap were dropped still returns plausible output, so the failure would surface as unexplained model behavior rather than as an error.
