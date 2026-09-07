# Agent Note: A conversation stdin could not carry

Status: implemented

English | [中文](2026-09-06-a-conversation-stdin-could-not-carry.zh.md)

## Problem

`dsh-llm-claude-cli` refuses any request carrying more than one message, and that refusal is the only thing keeping the Claude CLI route off the agent loop, which sends history on every request. The refusal rested on one recorded observation — a two-message input produced two `result` frames — and on an assumption stated as fact in three places: that `--input-format stream-json` "accepts only user messages". Nobody had fed it an assistant message.

That mattered because the assumption pointed at a fix. If the CLI rejected assistant messages, a future maintainer would find out by trying. If it accepted them, the route was one small change away from serving the loop.

## Decision

The input was measured. A run of `claude` 2.1.263 was fed a user message, an assistant message, and a second user message on stdin, and the recording is now `injected-history.jsonl` in `dsh-claude-cli-protocol`. History stays refused, on evidence rather than on assumption.

What the run shows:

- **Two sessions, two terminal frames.** Each user message opened its own `system`/`init` and finished with its own `result`. The first was billed 3889 input and 76 output tokens for a turn whose only purpose was to be context.
- **The assistant message was accepted and dropped.** No frame carries its text, and no frame reports it as rejected. The CLI read the line and discarded it.
- **The caller would receive the wrong answer.** `ClaudeCliFrameTranslator` settles on the first terminal frame — correctly, since the seam admits exactly one terminal chunk per stream. Replaying the recording yields the reply to the conversation's *first* message. The reply to its last message, `"Teal."`, is the answer the caller asked for, was paid for, and never sees.

So flattening history onto this input is worse than losing it. It answers a different question, at the price of one billed model call per prior turn, and every part of that is silent.

The remaining route to history is rendering the conversation into the prompt as text, which is the transcript format [`packages/AGENTS.md`](../../../../packages/AGENTS.md) requires evidence for and this repository has none for. Nothing measured here supplies it: the CLI accepts arbitrary prompt text, so every candidate format "works", and the difference between them is model output quality that no gate in the harness observes.

## Consequences

The agent loop still cannot use this route, and the reason is now a recording with four tests over it rather than a sentence. A maintainer who reaches for `--input-format stream-json` finds the measurement before spending a turn on it.

The negative control is the translator's own latch: unlatching `ClaudeCliFrameTranslator.translate` makes the fourth test fail and leaves the other twelve passing, so the test pins the merge behavior rather than the fixture's mere presence.

The fixture is the first recorded run in this package that is not a single turn, which makes it also the only coverage of what the decoder does across a session boundary mid-stream: nothing, correctly — the second `init` frame produces no chunk.

## Alternatives considered

**Write the CLI's own session transcript and `--resume` it.** The CLI persists a session as JSONL under `HOME`, and a recorded one is a format with evidence rather than an invention. It was rejected on reading that recording: `parentUuid` chains, `promptId`, thinking-block signatures, and `queue-operation`, `atis-latch`, `ai-title` and `last-prompt` records, none documented and all version-specific. Forging it is the same silent failure as inventing a text format, with more surface. It also requires session persistence, which the invocation disables so that one tenant's run leaves nothing in the pool for the next.

**Refuse assistant messages louder.** Nothing to make louder: the request is already refused at `stream()` before anything spawns, and the CLI's own silence is what the fixture records.

**Leave the README claim as it was.** "Accepts only user messages" is a claim about validation, and the CLI performs none. A maintainer acting on it would expect an error and get a wrong answer.
