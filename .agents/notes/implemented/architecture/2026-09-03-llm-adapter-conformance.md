# Agent Note: One conformance suite for provider adapters, and the leak it found

Status: implemented

English | [中文](2026-09-03-llm-adapter-conformance.zh.md)

## Problem

[R2 of the multi-tenant runtime plan](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) asks for one provider contract suite covering success, malformed output, timeout, quota, cancellation, crash, and secret leaks. Part of that was already enforced: `dsh-llm/invariant` wraps every registered provider stream and checks the chunk grammar — block pairing, one usage, one terminal finish, nothing after it. What no gate covered was the behavior a grammar cannot express. Does a cancelled run settle? Does an abandoned one release the process it spawned or the socket it opened? Can the credential an adapter holds reach a caller through an error message?

Those properties were each adapter's private business, which meant they were each adapter's private assumption. Nothing made a new adapter state them, and nothing checked an existing one still held them.

## Decision

`@deepseek-ai/dsh-llm-adapter-contract` states them once, as a suite an adapter's own spec file runs against itself. It ships eight cases: exactly one terminal chunk on a normal run, a terminal chunk on a failing one, settlement when cancelled before and during a run, release of an abandoned run, and no verbatim credential in any chunk, reported failure, or thrown error. Every adapter on the seam runs it — `dsh-llm-deepseek` and `dsh-llm-pi-ai` over HTTP, `dsh-llm-claude-cli` over a spawned process — which is what makes it a shared contract rather than one adapter's private tests written three times.

### It runs at the seam, not at the adapter

Every stream a subject supplies comes from `LlmRuntime.stream()`, never from the adapter's own `stream()`. This was a correction, not the original design: the first version drove adapters directly and failed five of eight cases against `dsh-llm-deepseek`. Reading the runtime settled it — `adapterFailureChunk` turns an adapter throw into a terminal `error` or `aborted` finish, so the one-terminal-chunk guarantee belongs to the runtime. DeepSeek throws; the Claude CLI adapter yields a finish; both are conforming, and only the seam sees them as equivalent. A suite pointed at raw adapters would have failed conforming code while testing a contract no caller relies on.

### It found a real leak

Running the abandonment case against `dsh-llm-claude-cli` failed: a consumer that stopped reading left the CLI process running. The adapter's generator held no `finally`, so closing it part-way through destroyed stdout and reaped nothing. The fix tracks whether the generator completed its own protocol and terminates the process tree when it did not — precise rather than unconditional, so a run that finished normally is not sent a signal it does not need. This is the process-tree cleanup R2 asks for, and it was absent until a shared suite asked for it.

### Release is polled, and that distinction was earned

The same case then failed against `dsh-llm-deepseek`, which looked like a second leak and was not. That adapter aborts its consumer signal in a `finally`; the socket simply closes on a later tick, while the suite asserted immediately. Release is now polled to a deadline — prompt release stays fast, and an adapter that never releases fails rather than hangs. The episode is the reason the suite's own tests exist: a timing assumption inside a conformance suite reports defects that are not there.

### The suite tests itself

A conformance suite that cannot fail is worse than none, because it reports confidence it has not earned. Its spec drives it with deliberately non-conforming subjects — a run that never finishes, one that finishes twice, an adapter that never releases, and the secret placed in a chunk, in a reported failure, in a thrown error, and in an error with no stack — and asserts which case rejects each. The Claude CLI fix was also checked by reverting it and confirming that exactly the abandonment case fails.

### The leak search walks everything, not the message

A credential reaches a caller through whichever field its adapter did not think about, so the search flattens each value completely: an error's message, name, stack and `cause` chain, and every property of every nested object, with a cycle guard. `secret` must be the exact value the adapter was constructed with; a suite given a placeholder passes while proving nothing, which the interface documentation says in those words.

## Consequences

Every adapter on the seam now asserts these properties on every run of the suite. `dsh-llm-pi-ai` was the last to join and passed all eight cases unchanged, which is the outcome a shared contract wants: the suite states properties an adapter written without it already had, rather than codifying whatever the adapter written alongside it happened to do. Its subject cost one addition to that package's mock server — holding a response open instead of ending it — because the abandonment case is the one scenario no ordinary provider stand-in scripts.

Three of the plan's named fixtures — timeout, quota, crash — collapse into one case. Each of them reaches an adapter as a failed run, and the suite asserts what an adapter must do with a failure rather than how it was caused. An adapter that distinguishes them owes its own tests for the distinction. Malformed output is likewise absent here: it is a parsing concern each adapter owns against its own wire format, and `dsh-claude-cli-protocol` already covers it for the CLI.

The leak search finds a credential only where it appears verbatim; one that arrived encoded, hashed, or truncated passes. That is the common case of a value passed through, not an adversarial encoder, and the README says so rather than implying stronger coverage.

## Alternatives considered

**Extending `dsh-llm/invariant` instead.** It already wraps every provider stream, so cancellation and release could in principle be checked there. Rejected because an invariant companion observes production streams and can only report what a live run happens to do; it cannot cancel a run, abandon one, or arrange a failure. These properties need a test that *causes* the situation, which is a suite, not an observer.

**Leaving each adapter to test its own lifecycle.** This is what the repository did, and it is why the Claude CLI leak existed. Private tests encode private assumptions: nothing made the property explicit, so nothing noticed its absence.

**Asserting release synchronously.** Simpler, and wrong: it would have failed `dsh-llm-deepseek` for a socket that closes correctly one tick later. Polling to a deadline is what lets one suite cover both a terminated process and a closed connection.
