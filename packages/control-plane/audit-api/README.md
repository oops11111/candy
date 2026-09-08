# @deepseek-ai/dsh-audit-api

English | [中文](README.zh.md)

Administrator-only `GET /api/candy/audits` returns the signed-in administrator's tenant window and this runtime's unattributed window. `completeHistory: false` and `retention` explicitly state that records beyond retention are gone; this route is not an archive.

No runtime invariant companion is published; this plugin owns no mutable runtime state, and its role boundary and bounded response are covered by its API tests.
