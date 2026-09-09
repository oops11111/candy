# Agent Note: The route a run actually used

Status: implemented

English | [中文](2026-09-09-the-route-a-run-actually-used.zh.md)

## Problem

Candy enforced each tenant's provider/model allowlist at the final adapter boundary and audited refusals, but a successful model call left no record of the route it used. Admission knew only the account's provider, while Harness routing middleware could still select a different final model before dispatch. Reconstructing a run therefore showed that it started, spent resources, and settled without saying which provider/model pair produced that spend.

## Decision

`RunScheduler` remains the audit owner and uses its existing prepended `llm/stream` listener. It calls the downstream waterfall first, allowing Harness routing middleware to finish mutating `GenerateOptions`, then records the resulting provider/model pair before the metered stream is pulled into the adapter. Calls without one uniquely resolved Candy run remain outside Candy auditing and metering.

The record uses `event: 'routed'`, `action: 'select'`, and `outcome: 'ok'`, with explicit `provider` and `model` fields. These fields participate in duplicate folding, so repeated calls on one run and route may fold while route changes remain distinct. The durable control-plane declaration advances to version 10 because a version 9 trail cannot answer which route a successful call used.

An audit write failure is logged and does not replace a model call with an audit failure. The record is attempted before provider iteration, so a consumer cannot receive provider output before the audit path has resolved.

## Consequences

The retained audit window can join a run's chosen route to its terminal usage without duplicating Harness model discovery, selection, fallback, or adapter registration. The record describes the pair selected for dispatch; a later adapter or authorization failure remains visible through its own terminal stream result or refusal record.

The scheduler's owning composition test routes an initial request to another provider/model pair and observes only the final pair in the tenant trail. Storage tests keep records with distinct provider or model values apart. A mutation that records the pre-waterfall pair makes the routing test fail.

## Alternatives considered

**Record the account provider at admission.** Rejected because it cannot identify the model and predates Harness routing middleware, so it is not the route the call actually attempts to dispatch.

**Record successful routes inside `dsh-tenant-route-policy`.** Rejected because an LLM guard runs once before prepared-call capability lookup and again at final dispatch. Recording there would count one prepared call twice and would make a Candy policy plugin own generic route observation.

**Add another router or adapter wrapper.** Rejected because Harness already owns route selection and adapters. Candy needs an audit observation, not a parallel routing mechanism.
