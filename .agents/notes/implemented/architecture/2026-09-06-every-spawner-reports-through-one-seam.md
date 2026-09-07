# Agent Note: Every spawner reports through one seam

Status: implemented

English | [中文](2026-09-06-every-spawner-reports-through-one-seam.zh.md)

## Problem

The boundaries page asks for an audit record per launched provider or tool process. No spawner in this repository emitted one — not the Claude CLI a Candy run launches, and not the harness's own bash, pwsh and language-server children either. The gap was a missing producer, not a missing consumer.

Adding the record to each spawner is the shape that guarantees the next spawner forgets. `dsh-subprocess` is the seam they all route through, and it declared `spawn` and `spawnTerminal` abstract, so it had no place of its own to report from.

## Decision

`spawn` and `spawnTerminal` are the seam's own methods now. They emit `subprocess/launched` and delegate to `spawnProcess` and `spawnTerminalSession`, which implementations override. A spawner cannot start a child without announcing it, because announcing is the half the spawner does not write.

The record names the executable, the working directory, the pid, and whether the child owns a terminal. It names neither the arguments nor the environment: a spawner's argv carries whatever the caller put there — a model prompt, a credential passed as a flag — and the environment is where credentials live. A record of a launch must not become the way either escapes.

A pid of `-1` is a spawn that failed. The seam returns a handle either way, so the record reports a launch that did not happen rather than being absent.

## Consequences

Every managed child in the repository is now observable from one listener, including the ones no Candy package launches.

Eight classes moved to the new method names: two production runtimes and six test stubs. The rename is what makes the record unforgettable, and it is the whole cost.

The negative control — dropping the emit — fails both new tests. One of them spawns a real process with a secret in its arguments and asserts the record does not contain it, so the payload's silence is pinned rather than described.

**Nothing consumes it yet, deliberately.** The obvious consumer is the Candy audit trail, and filing every launch there is wrong: the trail is bounded per subject, a busy runtime launches a child per tool call, and those records would displace the denied-assertion records that are the trail's sharpest signal — undoing the flood fix that folding just made. Attribution is also still missing: this seam has no notion of tenant or run, and a spawn has no session to join on. A consumer waits for the orchestration join, and for a decision about where high-volume records live that is not the same bounded window.

## Alternatives considered

**Emit from each implementation.** Two production runtimes is not many, and every future one is a chance to forget — which is how the repository arrived at no records at all.

**Record the arguments too.** An operator investigating a launch wants them, and they are the single most likely place for a credential or a user's prompt to be sitting. A consumer that has a reason and a safe destination can capture them at its own layer.

**Emit a session event instead.** Session events are for what a model can see, and reconstructability from the session log is their contract. A launch is a runtime observation with no model-visible half, so a plain context event is the honest kind.
