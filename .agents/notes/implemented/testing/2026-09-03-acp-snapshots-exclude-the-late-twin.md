# Agent Note: A transcript cannot pin an event nothing ordered

Status: implemented

English | [中文](2026-09-03-acp-snapshots-exclude-the-late-twin.zh.md)

## Problem

Six to seven of the eight ACP snapshot scenarios failed, and which ones varied between runs: six in a full `test:snapshot`, seven when the ACP corpus ran alone. Every failure was one extra line, a `session/update` carrying `config_option_update`, that no committed `stdout.expected.jsonl` contained.

Instrumenting `LlmRuntime.emitAdaptersUpdated` and `AcpSession.topologyChanged` named the cause exactly. `llm-deepseek` registers its adapter during apply, before any client request. `llm-pi-ai` — mounted dormant by the base profile — finishes applying roughly nine hundred milliseconds later, and its `registerConfigurableProviders` publishes `llm/adapters-updated` when it does. By then the client's `session/new` has created a session, so ACP's `llm/adapters-updated` listener notifies it.

Two facts make this unpinnable rather than merely unrecorded. The notification's payload is the option set that same session's `session/new` response already returned, so it carries nothing the client did not have. And its arrival is ordered against nothing in the exchange: whether it appears before the `session/new` response, after it, or not at all depends on whether boot finishes before the scenario ends.

## Decision

The ACP snapshot base patch disables `llm-pi-ai`. The comment beside the entry says why, and every ACP scenario inherits it, since `snapshots/acp/escalation-approved/cordis.yml` is the base patch the suite applies to all of them.

That leaves these scenarios asserting the ACP protocol surface over one adapter's routes, which is what they already assert: every expected `configOptions` payload in the corpus lists `deepseek-official` routes and nothing else, so the dormant twin contributed no coverage before it was disabled.

### The notification is correct, and that is the point

ACP topology may change at any time and `config_option_update` is the protocol's mechanism for saying so; a client is required to handle one. Nothing here is a defect being suppressed. What a committed transcript cannot do is fix the line position of an event that no request caused, and no test-side wait can order it against a response it races.

### What was deliberately not changed

Making `AcpSession.topologyChanged` skip a notification whose option set matches the one it last published would remove the race at the source, and it is the guard `llm-pi-ai` already applies to its own registration and directory swaps. It is a product behavior change — a notification a client receives today would stop arriving — so it is recorded here rather than made as part of a test fix.

Making the ACP server refuse requests until its plugin graph has applied would also remove it, and it is the larger finding: a client that connects immediately can read a `listConfigurableProviders()` that is still filling in. That is boot semantics for every ACP client, not a snapshot concern.

## Consequences

The ACP corpus is deterministic: fifteen tests pass on three consecutive runs and in the full suite. The one remaining `test:snapshot` failure is unrelated and environmental — a host with no bubblewrap and no Landlock-enforcing kernel refuses to run the sandboxed `bash` tool, so the SDK `bash-tool` scenario records a `SANDBOX_UNAVAILABLE` result instead of command output.

The suite no longer boots the shipped ACP profile unmodified. It never did — the same base patch already pins `llm-deepseek`'s model list, the sandbox mode, and the approval policy — but the gap between the composition under test and the one that ships is one entry wider, and a scenario that needs two adapter families registered must undo this entry and accept that it cannot compare an ordered transcript.

## Alternatives considered

**Re-recording the expected transcripts with the notification present.** This is what a stale recording would need, and the diagnosis is what rules it out: the event is racy, not merely new, so a recording blesses whichever side of the race the recording run took. The variance between a full run and an isolated one is the evidence.

**Adding a `waitForConfigOptions` input step.** The harness's wait vocabulary is condition-based rather than timed, so this fits its style, and it would make the notification reliably present. It would not fix the line position: the notification races the `session/new` response, and a step that runs after that response cannot order the two.

**Filtering the notification in the snapshot normalizer.** Rejected: a normalizer that drops a notification kind hides every future regression in that kind, and this corpus exists to catch exactly those.
