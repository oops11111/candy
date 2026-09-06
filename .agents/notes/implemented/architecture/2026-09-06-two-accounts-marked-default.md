# Agent Note: Two accounts marked default

Status: implemented

English | [中文](2026-09-06-two-accounts-marked-default.zh.md)

## Problem

Revoking or deleting a provider account promoted a replacement default unconditionally, without asking whether the tenant still had one. A probe gave a tenant three accounts, left the first as its default, and revoked one of the other two:

`before ["a:true","b:false","c:false"] → after ["a:true","b:false","c:true"]`

Two accounts marked default for one tenant and one provider. Whoever resolves "the tenant's default account" then gets an arbitrary one of them, and a tenant's work is billed to an account it did not choose. The invariant is the one the neighbouring test is named for: one default per user and provider.

## Decision

A replacement is promoted only when the tenant has no account for that provider that can still authorize work. A default the tenant still has is the tenant's choice and stays.

The usability rule is `isProviderAccountUsable`, which is now used at all three sites that spell it — this one was a third that an earlier extraction missed.

## Consequences

Revoking or deleting a non-default account leaves the tenant's default where the tenant put it.

Getting the test right took a second pass worth recording. The first negative control passed: removing the guard changed nothing, because the rewrite also replaced "the first usable non-default account" with "the first usable account", and the first usable account *is* the existing default whenever the default happens to be the oldest. The case that separates them is a tenant that selected a later account. With that test added, the control fails as it should.

That is the second time in this work that a mechanism looked load-bearing and was not distinguished by its own tests. The check is cheap: revert the mechanism, and disbelieve any test that still passes.

## Alternatives considered

**Promote only when the removed account was the default.** It is the narrower rule and it reads as the obvious one, but it repairs nothing: a store that already holds two defaults keeps them, and this function is the only place that could notice.

**Refuse to remove the last usable account.** It keeps a tenant from having no default at all, which is a different question — and it would deny an operation a tenant is entitled to perform.

**Enforce the invariant in the store.** A write that rejects a second default would catch every path rather than this one. The store holds accounts as opaque records for `dsh-provider-accounts` to rule on, and moving the rule there would put provider-account semantics in a persistence layer that has none.
