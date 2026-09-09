---
description: "The administrator-only Candy API and inherited settings entry for reading bounded tenant and runtime audit windows."
kind: "package-reference"
---

# @deepseek-ai/dsh-audit-api

English | [中文](README.zh.md)

## Summary

Administrator-only `GET /api/candy/audits` returns the signed-in administrator's tenant window and this runtime's unattributed window. `completeHistory: false` and `retention` explicitly state that records beyond retention are gone; this route is not an archive.

No runtime invariant companion is published; this plugin owns no mutable runtime state, and its role boundary and bounded response are covered by its API tests.

## Table of Contents

- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Dev Note

- [The audit window has a door](../../../.agents/notes/implemented/architecture/2026-09-09-the-audit-window-has-a-door.md)

## Model Experience

### Administrator audit reads

#### What the model sees

Nothing. `GET /api/candy/audits` and its settings section expose operational records only to an authenticated administrator.

#### Token effect

None; the operation adds no prompt or tool content.

#### KV Cache effect

None; no provider request is assembled or changed.

## Known Limitations and Deferred Work

- The response is a bounded current window, not an archive or pagination API.
- Runtime records without a tenant identity remain in the separate runtime window.
