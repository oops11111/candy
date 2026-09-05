# Agent Note: A run that ended and kept spending

Status: implemented

English | [中文](2026-09-05-a-run-that-ended-and-kept-spending.zh.md)

## Problem

Metering finds a run by the session a request was assembled for: no run for that session means the request is not this runtime's to charge, and it passes through. That is right for a session this runtime never had a run for. It is wrong for one whose run has ended.

A settlement deletes the run record. A lease can expire under an agent that is still working — that is the case the lease exists for — and the sweep settles the run while the agent goes on. Its next request finds no record, looks like a request from somewhere else, and reaches the provider unmetered. A probe against the booted runtime confirmed it: the call after the sweep came back `{ kind: 'stop' }`, with nothing charged. The run cut off for outliving its lease then ran for free.

## Decision

The scheduler remembers the sessions whose runs it settled, and refuses their calls.

The memory is in the process rather than on the medium, and that is the substance rather than an economy. It must outlive the run — the record is gone by then — and it need not outlive the process, because the agent that could still make the call lives in this process too and goes with it. A restart that loses the memory has already lost the agent.

It is capped by `endedSessionMemory`, oldest evicted first, so a long-lived runtime holds a bounded set. An evicted session's calls pass through again: the cap bounds what the runtime holds, and a session old enough to be evicted is one whose agent has almost certainly gone with its run. That is stated rather than left as a surprise.

A new run on a previously ended session clears it, so a session the control plane reuses is metered again rather than refused forever.

## Consequences

The three cases a request can be in are now distinct: never ours, ours and open, ours and ended. Only the middle one is charged, and only the first passes through.

What this does not do is stop the agent. The scheduler holds no agent and no process; refusing its model calls is the whole of what this layer can do, and a provider process already launched keeps running until whoever launched it reaps it.

## Alternatives considered

**Keep the settled run record instead of deleting it.** The lookup would find it and refuse without a second structure. Recovery re-drives every record carrying a settled figure, and the exactly-once markers only cover the most recent settlement per funder, so records that outlive their settlement would be re-charged at the next boot. Deleting is what makes recovery sound.

**Dispose the agent driving the session.** It removes the caller rather than refusing it, and it is what "a run drives a session" should eventually mean. `close` can be called from inside the agent's own driver chain, and disposing an owning fiber from within it is the hazard the initiator scope note already documents. It needs the orchestration join and a composition test with a real loop; refusing the call needs neither.

**Refuse any request whose session has no open run.** One rule instead of three cases, and it makes this runtime the authority over every model call in the process — including a deployment's own non-Candy work, and a session belonging to another runtime sharing the medium.
