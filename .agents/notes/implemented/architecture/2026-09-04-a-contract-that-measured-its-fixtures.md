# Agent Note: A contract that measured its fixtures

Status: implemented

English | [中文](2026-09-04-a-contract-that-measured-its-fixtures.zh.md)

## Problem

The shared adapter contract suite asserts that a failing run emits no chunk carrying the adapter's credential, and all three adapters on the `dsh-llm` seam run it. Every one passed.

None of them was redacting anything. Each `failingRun` is scripted from a well-behaved provider — `Authentication Fails`, `Incorrect API key provided`, a recorded CLI auth failure — and none of those texts contains a key. The assertion was measuring the fixture, not the adapter, and it would have kept passing until a provider changed its error text, at which point the credential reaches a session log in production rather than a failure in CI.

Fixing the Claude CLI route alone would have left the same hole in the other two. The property belongs to the seam: every adapter holds a credential, every adapter turns provider text into a failure, and the failure goes to the same places.

## Decision

`LlmAdapterContractSubject` gains a required `leakingRun`: a failing run whose provider quotes the credential back in its own output. The same assertion then measures the adapter. Adding it to the three adapters failed two of them immediately — `dsh-llm-deepseek` forwarded a rejected-credential body into both the failure message and its cause, and `dsh-llm-pi-ai` forwarded the SDK's text unchanged.

`redactApiKey` and `redactChunkApiKey` are exported from `dsh-llm` as plain functions, the way `dsh-subprocess` exports `scrubbedParentEnv`: one definition every adapter shares rather than a copy per adapter. The adapter is the only place that can apply it, because it alone holds the credential and the provider's words at the same moment — a failure that has left the adapter no longer says which secret it was made with.

The match is on the literal key rather than a pattern. A pattern would need every provider's key shape and would still miss the one it did not know. An empty key is refused rather than searched for, because splitting on it would rebuild the text around the placeholder.

Only failure text is rewritten. Model output is the caller's own content, and a silent rewrite would corrupt a legitimate answer that happens to discuss a key.

## Consequences

Three adapters remove a quoted credential, and a fourth cannot be added to the seam without answering the same case — `verify-llm-adapter-contract` fails a package that implements `LlmAdapter` without running the suite, so that is enforced rather than remembered. Its exemption list carries one entry, for the keyless replay adapter that reaches no provider.

Reverting any one of the three fixes fails exactly its own contract case, so each adapter's redaction is pinned independently rather than by the suite as a whole.

## Alternatives considered

**Redact in `LlmRuntime.stream()`, where every adapter's chunks already converge.** The runtime never learns the credential — resolving it is the adapter's, and handing the secret up so the runtime could scrub it would put the credential in one more place to leak from.

**Match a credential-shaped pattern instead of the literal key.** It is what `dsh-subprocess` does for environment names, and it is right there because the names are guessable and the values are not available. Here the exact value is in hand, so matching it needs no heuristic and cannot miss a key shape nobody enumerated.

**Fix the adapters and leave the suite alone.** The suite is what made the gap visible and what keeps it closed for adapters not yet written. Leaving a security assertion resting on fixture content is the defect, not the individual leaks it hid.
