# Agent Note: One DeepSeek run crosses the real control plane

Status: implemented

English | [中文](2026-09-09-one-deepseek-run-crosses-the-real-control-plane.zh.md)

## Problem

Candy's authentication, provider accounts, execution admission, metering, and revocation each had focused proofs, but no test demonstrated that the real control-plane composition preserved all of those boundaries across one provider lifecycle.

## Decision

The Candy bundle carries one keyless integration proof from an authenticated Candy user session through a tenant-owned `deepseek-api` account, a real DSH session, execution-assertion admission, replayed model output, and Candy's live run ledger. The provider reports 42 billed tokens and 900 micro-USD; the scheduler records both against that tenant before the terminal chunk reaches the caller. Revoking the account then makes the same session's next request end with `CREDENTIAL_REVOKED` before replay receives a second call.

This is a bundle test, not a new runtime adapter. `dsh-session` owns sessions, `dsh-llm-replay` owns deterministic provider output, and the inherited LLM waterfall owns dispatch. Candy contributes only its real session authentication, encrypted account record, grant, assertion, authorization, metering, and revocation boundaries.

## Alternatives considered

**Call the live DeepSeek API in the default suite.** That would make the control-plane proof depend on network access, spend, and a production secret rather than the behavior Candy owns.

**Add another Candy model adapter.** DSH already owns provider dispatch and replay, so another adapter would duplicate an inherited extension point and cross the project boundary.

**Keep only isolated package tests.** Those tests cannot prove that bundle wiring preserves tenant attribution and rejects the next call after revocation.

## Consequences

The bundle now proves the complete control-plane chain without a real provider key. The replay secret is synthetic and never reaches a provider; a live DeepSeek credential remains deployment input. The mutation control changed the replayed input count from 30 to 31 and the accounting assertion failed with 43 instead of 42, then the fixture was restored.
