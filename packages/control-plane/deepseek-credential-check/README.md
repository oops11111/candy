---
description: "The redacted DeepSeek API credential check registered into Candy's provider-account validation seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-credential-check

English | [中文](README.zh.md)

## Summary

This provider integration registers `deepseek-api` in the inherited `dsh-provider-credential-checks` registry. It calls the authenticated `/models` endpoint and returns only `valid`, `invalid-credential`, or `provider-unavailable`; endpoint, request and response bodies, key paths, and secrets never enter the validation result.

The Candy bundle uses the public DeepSeek API endpoint. A live test uses `DEEPSEEK_API_KEY` and skips when it is absent.

No runtime invariant companion is published; this stateless provider check is bounded by the existing registry and its redaction and disposal behavior are covered by tests.

## Table of Contents

- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Dev Note

- [DeepSeek credential check](../../../.agents/notes/implemented/architecture/2026-09-09-deepseek-credential-check.md)

## Model Experience

### Provider-account validation

#### What the model sees

Nothing. The `/models` credential probe is a control-plane operation, and its secret and response stay outside agent context.

#### Token effect

None; validation adds no prompt or tool content.

#### KV Cache effect

None; the check calls the provider catalog independently of model inference.

## Known Limitations and Deferred Work

- Only `deepseek-api` is registered because it has a stable authenticated HTTP probe; CLI account health remains owned by the respective CLI integration.
- A provider outage and a network failure intentionally share the redacted `provider-unavailable` result.
