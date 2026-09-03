# Agent Note: Run budgets across a delegation tree

Status: implemented

English | [中文](2026-09-03-run-budget-delegation.zh.md)

## Problem

[R3 of the multi-tenant runtime plan](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.md) asks for parent-child run records carrying parent-subset grants plus depth, concurrency, token, time, and cost budgets. Reading what the harness already does narrowed that considerably, and left one gap that nothing covered.

`dsh-subagent` already caps delegation depth: `delegationDepthOf` resolves a child's depth from its parent and `SubagentDepthError` refuses one past `maxDepth`. It already stamps lineage, and `captureDelegatedPolicyOverrides` pins a delegated child's sandbox mode to its parent's explicit override and its approval policy to `'never'` — a parent-subset grant in the sense R3 means. So depth and grants are inherited, not Candy's to build.

What no package covered is spend. A grep for cost accounting across every `packages/*/*/src` found nothing: no money type, no token allowance, no concurrency budget. Depth alone does not bound a tree — depth 3 with ten children at each level is a thousand runs, each free to consume a tenant's tokens, time, and money until something external notices.

## Decision

`@deepseek-ai/dsh-run-budget` owns the budget half and nothing else. It is pure arithmetic over four dimensions — tokens, wall milliseconds, integer micro-USD, and live child slots — with four operations: reserve a child's allowance out of its parent's, settle the unused remainder back, charge a run for what it consumed, and ask whether anything is left.

### The reservation is subtracted, not checked

A parent's allowance is reduced when a child starts, and `reserveChild` returns that reduced parent as a value the caller must adopt. The alternative — checking the request against the parent and letting both keep their own numbers — passes every single-child test and fails the case that matters: a parent with 1000 tokens can approve ten children of 700 each, because each check sees the full 1000. Subtraction makes over-delegation impossible rather than detectable, and a test asserts exactly that a second child cannot take tokens the first already holds.

### Money is integer micro-USD

A budget compared or decremented in floating point drifts, and a spend limit that drifts is not a limit. Micro-USD gives four decimal places of a cent in safe-integer range, which is finer than any provider prices at.

### Child slots are held, not spent

`children` behaves unlike the other three: reserving takes a slot, settling returns it, while tokens, milliseconds and money are gone for good. That is why `RunSpend` has no `children` field — a caller able to "spend" concurrency would destroy the capacity it is supposed to release. The concurrency a child may itself delegate is its own to hold and is not drawn from the parent's slots; only the one slot the child occupies is, so a parent with one slot left can still start a child permitted five grandchildren.

### An overspend is not credited back

`settleChild` returns `max(0, reserved - spent)`. A child that consumed more than it reserved has already cost the tenant that money, and crediting the difference would invent budget for the parent to spend a second time. Overspend is prevented during the run by `chargeRun` — which is the reason a run is charged as it goes rather than reconciled at the end — and a refused charge deducts nothing, so a caller that stops on a denial never finds its budget partly spent by the charge it rejected.

### Requests are refused, never shrunk

Every denial names the one insufficient dimension and changes nothing. Clamping a request to what remains would start a child under a budget its caller never chose; a subagent that stops mid-task because it was quietly given a fifth of what it asked for is harder to diagnose than one refused outright. This matches how `dsh-run-admission` and `dsh-llm-claude-cli` already report refusals.

### Malformed budgets throw; exhausted ones return a denial

A negative, fractional, or unsafe-integer budget is a storage or arithmetic defect rather than an exhausted run, and the two must not reach a caller through the same channel. Exhaustion is a value to route on; a malformed budget is a `RangeError` naming the argument and field, because continuing with it produces limits that do not hold. This is the same split `admitRun` makes between deployment errors and denied runs.

## Consequences

R3's second bullet is now depth (inherited), grants (inherited), and budgets (here), which is a smaller remaining scope than the bullet implied. The scheduler that persists a run's remaining allowance and refuses to start an exhausted run is still unbuilt, and this module deliberately does not reach for it: it is arithmetic over values a caller holds, with no store, no clock, and no service.

Two consequences are worth stating because they bind other work. `wallMs` is charged by the caller, so a run that never charges its elapsed time is never stopped for exceeding it. And `costMicroUsd` is enforceable only if something computes cost — `TokenUsage` carries none, and `dsh-llm-claude-cli` drops the CLI's own `total_cost_usd` for exactly that reason, so today a caller must price tokens itself. Both are recorded as limitations rather than implied as working.

A reservation is also not a lease: nothing expires an unsettled one, so a child lost without settling holds its parent's allowance until a caller reconciles it. That needs the durable run records R3 owns.

## Alternatives considered

**Checking a request against the parent without subtracting.** Simpler, and unsound for the reason above: every check independently sees the parent's full allowance, so a parent can approve arbitrarily many children that each fit.

**Charging only at the end of a run.** Fewer operations, but it makes the limit advisory — the tokens are already spent by the time the total is known. Charging as the run goes is what lets a denial stop it while the budget still holds.

**Folding budgets into `dsh-subagent` beside the depth cap.** That is where depth lives, and it would put the two caps together. Rejected because a budget is not specific to in-process subagent delegation: a scheduler bounding a tenant's provider processes needs the same arithmetic without the subagent seam, and the harness package would then own a Candy control-plane concern.

**Floating-point dollars.** Rejected on drift, which is not a hypothetical for a value decremented thousands of times across a delegation tree.
