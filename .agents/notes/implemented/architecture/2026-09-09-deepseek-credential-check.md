# Agent Note: DeepSeek credential validation speaks through the registry

Status: implemented

English | [中文](2026-09-09-deepseek-credential-check.zh.md)

## Problem

The provider credential-check registry had no implementation, so the account surface returned `unsupported-provider` even for DeepSeek's ordinary HTTP API. Teaching the account API provider protocols would couple tenant account management to each provider.

## Decision

Candy keeps the account API provider-neutral. A small provider integration registers `deepseek-api` in the existing credential-check registry and probes DeepSeek's authenticated model catalog. The result is deliberately closed: authentication failures are invalid credentials, transport and other HTTP failures are provider unavailable, and no endpoint, body, or secret-derived detail is returned.

## Alternatives considered

**Implement the protocol in the account API.** This would couple the tenant account boundary to provider-specific transport and make each new provider modify central account logic.

**Return raw provider diagnostics.** Endpoints, bodies, and secret-derived error details could disclose deployment configuration or credential material to callers and logs.

**Probe CLI providers in the same package.** CLI login state belongs to each inherited CLI integration and has no common HTTP check equivalent to DeepSeek's model catalog.

## Consequences

Deterministic tests cover the HTTP classification and redaction contract. A live e2e consumes `DEEPSEEK_API_KEY` only from the environment and skips when absent. The mutation negative control disabled the successful response branch and the 200 case failed before restoration.
