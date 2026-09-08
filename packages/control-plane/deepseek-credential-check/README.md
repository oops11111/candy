---
description: "The redacted DeepSeek API credential check registered into Candy's provider-account validation seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-credential-check

English | [中文](README.zh.md)

## Summary

This provider integration registers `deepseek-api` in the inherited `dsh-provider-credential-checks` registry. It calls the authenticated `/models` endpoint and returns only `valid`, `invalid-credential`, or `provider-unavailable`; endpoint, request and response bodies, key paths, and secrets never enter the validation result.

`DEEPSEEK_BASE_URL` may configure a trusted deployment endpoint through the Candy bundle. The public DeepSeek API is the default. A live test uses `DEEPSEEK_API_KEY` and skips when it is absent.

No runtime invariant companion is published; this stateless provider check is bounded by the existing registry and its redaction and disposal behavior are covered by tests.
