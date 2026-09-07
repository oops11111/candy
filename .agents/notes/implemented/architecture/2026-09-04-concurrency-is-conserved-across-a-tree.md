# Agent Note: Concurrency is conserved across a tree, like every other dimension

Status: implemented

English | [中文](2026-09-04-concurrency-is-conserved-across-a-tree.zh.md)

## Problem

[Candy Runtime Boundaries](../../../../docs/candy-runtime-boundaries.md) says a child run may use "only the account, workspace, tool, token, time, cost, and concurrency authority that the parent run already had", and runtime contract 6 of the delivery plan repeats it. `reserveChild` did not hold that for the last of those.

It charged a parent one slot per child and nothing for the slots that child could hand down. Three dimensions were therefore conserved across a delegation tree — the whole tree cannot outspend its root's tokens, milliseconds, or money — and the fourth was conserved at one level only. Run against the shipped code, a root granted `children: 4` seeds four children each granted four of their own, and their children again: 1364 runs live at depth five, from a grant that reads as four. No level had paid for the ones below it.

That is a real resource, not a bookkeeping quirk. Each live run is a provider process with a home directory, an environment, and file descriptors on a runtime shared with other tenants, and the requested child budget is reachable from a delegation the model asks for.

The old rule was recorded rather than accidental: this package's README stated it, a test pinned it, and [the delegation note](2026-09-03-run-budget-delegation.md) explained it. The reasoning was that concurrency is a capacity that returns rather than a quantity that is consumed, which is true and does not imply the grant a child hands down should be free.

## Decision

A child costs its parent one slot for itself plus every slot it may delegate. `children` therefore counts the runs that may be live anywhere in a subtree, not just at its top level, and a root's grant bounds the whole tree.

`RunLedger` derives a parent's remaining allowance the same way, taking `1 + child.reserved.children` out for each open child, and returns all of it when that child closes. Both halves are pinned independently: reverting either one alone fails a test the other does not cover.

The special case in `reserveChild` disappeared with the change. Charging `request.children + 1` puts concurrency through the same shortfall check as the other three dimensions, so the separate "does the parent have a slot at all" branch is gone and the fourth dimension is no longer exceptional.

## Consequences

A grant now reads as a subtree size. A deployment expressing "four children that may each delegate two" asks for twelve, not four. That is a real change in what the number means, and it is the meaning that lets a deployment reason about how many provider processes one run can be responsible for.

Spend conservation is untouched: it already held, and it holds identically.

## Alternatives considered

**Amend the boundaries document instead, to say concurrency is bounded per delegation level.** It would have kept the code and the tests, and it was a coherent position — depth is capped by `dsh-subagent`, and spend is conserved, so a wide tree cannot outspend its root. It was rejected because the number would still not bound anything a deployment cares about: process count is what exhausts a shared runtime, and a cap that reads as four while permitting thirteen hundred is worse than no cap, because it looks like one.

**Bound total concurrent processes per tenant in the scheduler instead.** A tenant-wide quota is a different and also useful control, but it does not make a child's grant a subset of its parent's, and it defers the contradiction to a component this release has not built.

**Check the child's grant against the parent's without subtracting it.** This is the same unsoundness [the delegation note](2026-09-03-run-budget-delegation.md) rejected for tokens: every check independently sees the parent's full allowance, so a parent could approve arbitrarily many children that each fit.
