# One DeepSeek run crosses the real control plane

English | [中文](2026-09-09-one-deepseek-run-crosses-the-real-control-plane.zh.md)

The Candy bundle now carries one keyless integration proof from an authenticated Candy user session through a tenant-owned `deepseek-api` account, a real DSH session, execution-assertion admission, replayed model output, and Candy's live run ledger. The provider reports 42 billed tokens and 900 micro-USD; the scheduler records both against that tenant before the terminal chunk reaches the caller. Revoking the account then makes the same session's next request end with `CREDENTIAL_REVOKED` before replay receives a second call.

This is deliberately a bundle test, not a new runtime adapter. `dsh-session` still owns sessions, `dsh-llm-replay` still owns deterministic provider output, and the inherited LLM waterfall still owns dispatch. Candy contributes only its real session authentication, encrypted account record, grant, assertion, authorization, metering, and revocation boundaries.

The test's replay secret is synthetic and never reaches a provider. A live DeepSeek credential remains deployment input, not repository data. The mutation control changed the replayed input count from 30 to 31 and the accounting assertion failed with 43 instead of 42; the fixture was restored before commit.
