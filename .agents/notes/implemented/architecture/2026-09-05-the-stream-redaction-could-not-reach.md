# Agent Note: The stream redaction could not reach

Status: implemented

English | [中文](2026-09-05-the-stream-redaction-could-not-reach.zh.md)

## Problem

`dsh-llm`'s `redactApiKey` exists because provider diagnostics quote the request that failed, and that request carried the credential — so an error body naming the rejected key "puts it wherever the adapter's failure goes: a session log, an operator's console, a model's transcript". The Claude CLI adapter applies it to every chunk it yields.

It spawned the CLI with `stderr: 'inherit'`. That hands the child the parent's own descriptor, so the adapter never sees a byte of that stream and cannot rewrite it. A probe ran a CLI through the real subprocess service with a tenant key injected and a diagnostic that quotes it back; the vitest process's own stderr carried:

`claude: request rejected: invalid x-api-key: sk-ant-PROBESECRET-do-not-log`

The identical text arriving on stdout would have been redacted. The stream with no mitigation at all was the one that goes straight to the operator's console — which is the place the redaction module names first.

## Decision

The adapter collects stderr under `maxStderrBytes` instead of inheriting it, and configures no spill file, so one tenant's diagnostics stay in that run's own memory rather than in a shared temp directory. Collect mode keeps the tail on overflow, which is what a diagnostic needs and the opposite of the stdout ceiling: a diagnostic ends with what failed, and a protocol stream cannot survive a gap anywhere.

The tail is not thrown away. A run whose process dies without a terminal frame has no other account of itself, so the tail joins that failure's message — and leaves through the redaction every chunk already passes, rather than through a second copy of it. A run that finishes, is cancelled, or trips the stdout ceiling already says why, and its stderr is dropped.

## Consequences

The credential can no longer leave this adapter unredacted by any path it owns, and a run that dies now says what the CLI said on the way out instead of only naming an exit code.

Two negative controls, each failing exactly two tests: restoring `inherit` fails the disposition assertions in the unit suite and in the composed Loader; passing an empty tail fails the diagnostic and the redaction assertions.

An operator watching the CLI's warnings on the host's own stream no longer sees them for a run that finished. That is recorded as a limitation rather than solved: routing them to a logger needs a consumer that reads one.

## Alternatives considered

**Pipe stderr and redact it in the adapter.** It closes the leak equally well and costs a second reader, its own drain, and a second bound to enforce. Collect mode is the seam's own answer to "hold a bounded tail of a stream I will read later", and the failure text it feeds is already redacted.

**Keep `inherit` and trust the CLI.** The redaction module refuses that reasoning for stdout — the key is in the failing request, so any component that echoes a request echoes the key — and the CLI's stderr is less constrained than its protocol stream, not more.

**Give the tail to every failure.** A cancelled run and one that trips the stdout ceiling already carry a precise cause, and appending an unrelated warning to it would make the message worse. Only the process that died without saying why has nothing else to offer.
