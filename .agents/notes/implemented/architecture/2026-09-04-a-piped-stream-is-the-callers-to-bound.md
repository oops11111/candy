# Agent Note: A piped stream is the caller's to bound

Status: implemented

English | [中文](2026-09-04-a-piped-stream-is-the-callers-to-bound.zh.md)

## Problem

[Candy Runtime Boundaries](../../../../docs/candy-runtime-boundaries.md) lists output limits among the things that block process escape. The Claude CLI route had none.

It spawns with `stdout: 'pipe'`, which the subprocess seam documents as exposing "the raw `Readable` for the caller's protocol decoding" — the caller decodes it and therefore bounds it. This route decoded and did not bound. Every byte read was accumulated: into `ClaudeCliLineDecoder`'s partial line while one was open, and into a content block once its frames parsed. The other subprocess route in the repository already does this properly — `dsh-bash-local` has a validated `maxOutputBytes` with a 64 000 default — so one of two routes running a child's output was bounded and configurable and the other was neither.

Nothing else on this route bounds response length either. The CLI has no output-token flag, so `projectRequest` refuses `maxTokens` rather than passing it on. A run's output was limited only by what the provider chose to emit, on a runtime shared with other tenants.

## Decision

`maxOutputBytes` bounds the stdout one run may write, as a validated `Config` field defaulting to 16 MiB and a required field on `ClaudeCliAdapterOptions` and `ClaudeCliDeployment`. Making it required rather than optional is what closed the second half of the hole: the binding that composes this adapter for a tenant compiled without it, and an absent ceiling compares false against every byte count, so the bound would have been silently off on exactly the multi-tenant path it exists for.

Bytes, not code units. `stdout.setEncoding('utf8')` yields strings, so `chunk.length` counts UTF-16 units and a ceiling read that way admits up to four times what it promised to hold.

Exceeding it terminates the process and fails the run rather than truncating. Truncation is right for a tool result a model reads, which is why `dsh-bash-local` keeps a tail; it is wrong for a protocol stream, where a half-written frame does not parse and a response cut short would otherwise be delivered as though it were complete. The terminate is explicit because this generator returns normally on that path, so `runProcess` treats the run as completed and reaps nothing.

The default has evidence rather than a round number's appeal. Recorded runs of this CLI frame a short text turn in 8 KB of stdout with a 2.2 KB largest line. The only term that grows is the response text, carried once in the `result` frame and again across the `stream_event` deltas, so stdout runs to roughly twice the text plus JSON escaping — a maximal single response stays under about a megabyte. 16 MiB leaves better than an order of magnitude of headroom and still bounds a runaway.

## Consequences

A composition that names no ceiling gets one. A deployment that knows its own sets it from `cordis.yml`, and the control-plane binding carries it as a host fact beside the executable and the termination grace.

A run that trips the ceiling ends with a `finish` chunk carrying `OUTPUT_LIMIT`, which is an ordinary adapter failure: the seam's one-terminal-chunk guarantee holds, and a run that had already finished before the overflow keeps the terminal chunk it produced.

## Alternatives considered

**Bound `ClaudeCliLineDecoder`'s partial buffer instead.** It is the narrower fix and misses the case that matters as much: a million well-formed small frames never grow the partial line and still exhaust the runtime. Counting what is read covers both, in one place.

**Collect stdout through the seam's `SubprocessCollect` mode.** That mode buffers boundedly and hands back offsets, which suits a caller reading a result after the fact. This route decodes a stream as it arrives, and the mode keeps a tail on overflow — the wrong half of a protocol stream to keep.

**Truncate and finish the run normally.** It would deliver a partial response as a complete one. The failure is the honest outcome, and the contract suite already covers what an adapter owes a failed run.
