# Agent Note: A provider that quotes its key back

Status: implemented

English | [中文](2026-09-04-a-provider-quoting-its-key-back.zh.md)

## Problem

[Candy Runtime Boundaries](../../../../docs/candy-runtime-boundaries.md) says a provider process's stdout, stderr, exit status, structured output and diagnostic text "are parsed through bounded, redacted adapters". The Claude CLI route was neither. Bounding it is [its own note](2026-09-04-a-piped-stream-is-the-callers-to-bound.md); this is the other half.

A terminal `result` frame's `result` text becomes the failure message verbatim. Driving the adapter with a frame reading `authentication failed for sk-ant-…` produced a finish chunk carrying that string unchanged, so a CLI that quoted its credential back — in an authentication error, or any diagnostic that echoes its environment — would put the tenant's key in the session log and in front of the model.

The shared adapter contract suite already asserts that a failing run emits no chunk containing the secret, and `dsh-llm-claude-cli` runs it. That assertion passed because the recorded fixture does not contain the key, not because anything removed it. A test that holds by fixture rather than by mechanism keeps passing until the day the provider's text changes, and then fails in production rather than in CI.

## Decision

The adapter substitutes the injected credential out of the failure text it emits. It is the only place that can: it holds the key, and `dsh-claude-cli-protocol` translates frames without knowing the secret.

Only diagnostic text is rewritten — the failure's message and code. Model output is the tenant's own content, and a silent rewrite would corrupt a legitimate answer about the shape of a key. The substitution is a `split`/`join` on the literal secret rather than a pattern, so no key needs escaping and nothing else is matched by accident.

No guard for an empty key. `claudeCliEnvironment` refuses one while building the spawn spec, which happens before any chunk exists, so the unreachable branch would be untestable rather than defensive.

## Consequences

The contract suite's redaction assertion now holds by mechanism on this route. A provider diagnostic that quotes the key reaches the caller with `[redacted]` in its place, and the rest of the message intact, which is what an operator needs to diagnose the failure.

## Alternatives considered

**Redact in `dsh-claude-cli-protocol`, beside `mapFinish`.** That package translates wire frames and is deliberately ignorant of the credential; handing it the secret to scrub would widen what a pure translator knows in order to save one wrapper in the adapter.

**Redact every chunk, model text included.** It closes a path that is not a cross-tenant leak — the tenant's own key in the tenant's own transcript — at the cost of corrupting legitimate output and scanning every delta.

**Rely on the contract suite and change nothing.** The suite is what surfaced the question, and it was passing. Leaving a security assertion resting on a fixture's content is the failure mode this note exists to remove.
