# Agent Note: A scope a stream could not carry

Status: implemented

English | [中文](2026-09-06-a-scope-a-stream-could-not-carry.zh.md)

## Problem

`dsh-subprocess` announces every managed child it starts, and knows nothing about tenants. Candy has the tenants and no way to reach them from a launch: a provider process is started deep inside an adapter, with no session and no run of its own to name. Attribution was the half the launch record was still missing.

What a launch does have is a place in the call that started it, and the scheduler already resolves the run for every metered call. The obvious mechanism is `AsyncLocalStorage`, the same one `ctx.agents.withInitiator` uses to carry an initiating Agent through a driver chain.

## Decision

The scheduler enters a run scope around **each pull** of a metered stream, and a `subprocess/launched` listener reads it.

Around each pull, not around the stream. An async generator's body runs when its consumer asks for a chunk, in the consumer's context rather than the one the generator was created in. A probe outside the repository confirmed it before any of this was designed on top:

`{"generator":["at-first-yield:none","after-await:none"],"promise":"async-fn:RUN-2"}`

A scope wrapped around stream creation reaches none of the body. A plain async function keeps it, which is why the mistake is easy to make from experience with promises. Re-entering around each `next()` reaches the body and the nested work between pulls.

A launch outside any metered call is dropped. The harness's own bash, pwsh and language-server children belong to no tenant, and filing them would push a tenant's own records out of a trail bounded per subject — the displacement that folding was added to stop.

## Consequences

The launch record has the attribution it was built for, and the boundaries page's audit record per launched provider process exists end to end for the runs this runtime meters.

The negative control is the whole point of this note: scoping stream creation instead of each pull leaves the test failing with zero records. The wrong version boots, streams, charges and settles correctly — it just silently attributes nothing.

Three narrow paths are pinned as well: a spawn that failed carries `spawn-failed`, a launch whose run the store no longer holds is dropped rather than filed against a tenant it cannot name, and a trail that cannot take the record does not fail the call it describes.

The other two things this join was expected to unlock — closing a revoked account's live runs, and disposing the agent when a run settles — are not here. Both need the run's lifetime rather than one call's, and this scope covers a call.

## Alternatives considered

**Pass the run through `GenerateOptions`.** It would make the inherited LLM seam carry a Candy concept, which the session join was specifically shaped to avoid.

**Give the subprocess seam a tenant field.** The seam would then hold a notion it cannot fill in for its own callers, and every spawner would have to supply something true.

**Attribute by process tree.** A provider process is a child of this runtime, so its ancestry is knowable. It answers a different question — which OS process — and needs a tree walk per launch to answer the one actually asked.
