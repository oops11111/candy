---
title: DeepSeek credential validation speaks through the registry
status: implemented
date: 2026-09-09
---

# DeepSeek credential validation speaks through the registry

English | [中文](2026-09-09-deepseek-credential-check.zh.md)

Candy does not teach the account API a provider protocol. A small provider integration registers `deepseek-api` in the existing credential-check registry and probes DeepSeek's authenticated model catalog. The result is deliberately closed: authentication failures are invalid credentials, transport and other HTTP failures are provider unavailable, and no endpoint, body, or secret-derived detail is returned.

Deterministic tests cover the HTTP classification and redaction contract. A live e2e consumes `DEEPSEEK_API_KEY` only from the environment and skips when absent. The mutation negative control disabled the successful response branch and the 200 case failed before restoration.
