# Agent Note: The Codex frames nobody had seen

Status: implemented

English | [中文](2026-09-10-the-codex-frames-nobody-had-seen.zh.md)

## Problem

R2's remaining provider is a Codex CLI `LlmAdapter`, and it was blocked on not knowing the protocol. The stated blocker was a machine with OpenAI API access and a logged-in Codex CLI, with the rule that the parser waits for real recordings because a protocol guessed from a few frame names is a parser that works on the examples and nothing else.

Two things about that were worth checking before accepting it. The Codex CLI 0.149.1 binary is already a dependency of `dsh-subagent-codex` and runs in this environment, and that package already drives it against a scripted local Responses server with passing real-product tests. So the CLI's *own* framing was reachable without any OpenAI account; what was genuinely unreachable was only what an upstream account produces.

What `dsh-subagent-codex/src/wire.ts` knows is also narrower than an adapter needs. It handles the thread and turn lifecycle, `item/completed`, approvals and interrupts, because a subagent needs a final answer. An adapter needs streaming text, token usage, failure and cancellation, and none of those was recorded anywhere.

## Decision

Record the four cases from the real binary, assert the frame vocabulary verbatim, and leave the parser unwritten.

`packages/subagent/subagent-codex/tests/recorded-protocol.spec.ts` launches the real `codex app-server --stdio` through the package's own fixed wrapper argv and the package's own Responses fixture, captures every JSON-RPC line it writes, and pins what a future adapter will read. Four findings came out of it, and three of them contradict where a reader would have looked:

**Streaming text is `item/agentMessage/delta`.** `item/completed` repeats the whole answer afterwards, so a parser written against completion alone produces no stream at all.

**Token usage is its own notification.** `thread/tokenUsage/updated` carries `totalTokens`, `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`, `modelContextWindow`, and a `total`-versus-`last` split. None of it is on `turn/completed`, where the Claude CLI's analogue lives. `cacheWriteInputTokens` and the total/last distinction are not derivable from the harness vocabulary.

**No frame carries a cost.** The Claude CLI reports `total_cost_usd`; Codex reports nothing equivalent, so an adapter that wants cost computes it from tokens and a price table or reports its absence. The recording asserts no frame matches cost or USD, so a later CLI that adds one fails the case rather than being silently ignored.

**A cancelled turn is a status, not an error.** `turn/interrupt` requires the turn id as well as the thread's, and what it produces is `turn/completed` with `status: 'interrupted'` and `error: null`. A failed turn is reported twice instead, as an `error` notification carrying `codexErrorInfo.responseTooManyFailedAttempts.httpStatusCode` and again on the turn.

Two spellings were corrected by the binary during recording rather than by reading: the sandbox values in a `thread/start` request are kebab-case (`read-only`, `workspace-write`, `danger-full-access`) while the thread echoes them back camel-cased, and an app-server that resolves an ambient proxy reaches for `chatgpt.com` instead of the loopback fixture, which is why the harness clears every proxy variable.

## Alternatives considered

**Write the adapter now from the frame names in `wire.ts`.** Rejected, and the recording shows why: the two frames an adapter most needs, the text delta and the usage notification, are not in `wire.ts` at all, and usage is not where the Claude CLI's position would suggest.

**Wait for a machine with OpenAI access before recording anything.** Rejected once the binary turned out to run here. Most of the protocol is the CLI's own framing, which the real binary emits against any Responses endpoint, and recording it now shrinks the blocker to the part that genuinely needs an account.

**Record by hand-rolling a Responses server.** Rejected after trying it: the package's fixture already streams text, function calls, errors and a held response, and its environment handling is the reason the real tests reach loopback at all. The hand-rolled attempt reached `chatgpt.com` and was denied.

**Create an empty `dsh-codex-cli-protocol` package to hold the fixtures.** Rejected. A package with fixtures and no parser has no current owner, and the recordings belong where the real binary is already exercised; the adapter's package is created when the adapter is.

## Consequences

The blocker is smaller and named. A Codex adapter can now be written against recorded frames for streaming text, usage, failure and cancellation, and a protocol change in a later CLI fails this spec before it reaches an adapter.

What still needs a logged-in account is three things, and no more. `account/rateLimits/updated` arrives with every field null without one, so real limit windows, plan type and spend-control state are unrecorded. Real upstream rejections — an invalid key, an exhausted quota — may carry `codexErrorInfo` variants other than the one a 429 from a fixture produces. And whether real usage figures differ in kind, rather than in value, from a fixture's is unverified.

The cost finding is the one that changes design rather than evidence. `AdmittedRun` accounting and `dsh-run-metering` charge micro-USD, and a Codex run cannot report what it cost. Deciding between a price table, a provider-reported-only policy, and charging tokens instead is R2 work that this recording makes visible rather than work it completes.

This adds a real-binary test to the suite. It spawns the app-server four times and takes about forty seconds, which is the same cost the package's existing real-product spec already pays.

## Verification

`packages/subagent/subagent-codex/tests/recorded-protocol.spec.ts` passes against `@openai/codex` 0.149.1 in this environment: the streaming delta and its order against `item/completed`, the usage notification's exact field names with the absence of usage on `turn/completed` and the absence of any cost field, the double-reported failure with its HTTP status, and the interrupted turn's status.

Two mutation controls establish that the assertions bind to the recording rather than restate it: renaming `cacheWriteInputTokens` to a plausible alternative and renaming the delta method to `item/agentMessage/chunk` each fail their case before the spec is restored.
