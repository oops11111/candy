# Agent Note: The session was the join

Status: implemented

English | [中文](2026-09-05-the-session-was-the-join.zh.md)

## Problem

`RunScheduler.meter` bounded a run's model calls, and nothing called it. Wiring it in seemed to need a run id on a model request, and `GenerateOptions` carries no Candy concept — adding one would let a single consumer dictate a contract the whole `dsh-llm` seam shares. Three earlier notes deferred the wiring on that reasoning, calling it the attribution the seam has no notion of.

It has one. `GenerateOptions.sessionId` is stamped by the loop on every assembled request, and an execution assertion already names the session its run drives. `dsh-session-checkpoint-policy` had been selecting its own streams by exactly that field for as long as it has existed.

## Decision

A run's durable record names its session, and the scheduler registers one `llm/stream` listener that meters a request against the run whose session it names.

The record is where the mapping lives because it is where a run's identity already lives, and because a lookup that survives a restart cannot be an in-memory index. `runsOfSession` on the store is the whole of it.

A request with no session, or one naming no run this runtime has open, passes through untouched. It is not this runtime's to charge: a title generation for a session nobody admitted, a deployment that also runs non-Candy work, a second runtime's session.

A session two open runs both claim is refused, with a terminal `error` finish. The control plane minted two runs for one session, and charging whichever the lookup found first is a misbilling nobody would ever notice — the only failure here that a tenant cannot detect. Stopping the call is the visible one.

## Consequences

An agent driven on a run's session is metered without anyone threading a run id through anything: `ctx.llm.stream(request)` is charged to the run, refused when that run has nothing left, and cut when the call outruns its wall time. The composition test drives a real request through the real `LlmRuntime` waterfall against a registered adapter, so the path is the product's, not a stand-in for it.

The listener is registered on the service's own context and goes with it: the disposal test mounts the scheduler on its own fiber, disposes it, and observes the next request pass through uncharged.

What this does not do is attribute work that has no session. A run that spends outside a session of its own — a launched provider process, a tool that calls out — is not reached by this, and the launch-audit record the boundaries page asks for still has no producer.

## Alternatives considered

**Put a `runId` on `GenerateOptions`.** The direct route, and it makes an inherited seam carry a concept only Candy has. Every other adapter and consumer would see a field that means nothing to them.

**Scope the listener to the agent's context.** `AgentFactory`'s `setup` composes an agent's scoped world and would be the natural home. The waterfall dispatches against the `LlmRuntime` itself, so a scoped listener would receive every stream in the process anyway — the scoping would be decorative, and the `sessionId` check is what actually selects.

**Charge the first run found when a session is ambiguous.** It keeps the call working. It also bills a tenant for another tree's work with no signal anywhere, which is the outcome the whole tenant boundary exists to prevent.

**Wait for something that composes an agent from an admitted run.** That component still does not exist, and this needs it not to: the harness loop already stamps the session, so the enforcement is in place for whoever builds it.
