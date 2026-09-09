---
description: "注册到 Candy Provider 账户校验接缝中的脱敏 DeepSeek API 凭据检查。"
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-credential-check

[English](README.md) | 中文

## 概述

本 Provider 集成在继承的 `dsh-provider-credential-checks` 注册表中注册 `deepseek-api`。它调用需要认证的 `/models` 端点，只返回 `valid`、`invalid-credential` 或 `provider-unavailable`；端点、请求与响应体、密钥路径和秘密都不会进入校验结果。

Candy bundle 使用 DeepSeek 公共 API 端点。真实测试使用 `DEEPSEEK_API_KEY`，缺少时自动跳过。

不发布运行时 invariant companion；该无状态 Provider 检查受既有注册表约束，其脱敏和释放行为由测试覆盖。

## 目录

- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="dev-note"></a>
## 开发备注

- [DeepSeek 凭据检查](../../../.agents/notes/implemented/architecture/2026-09-09-deepseek-credential-check.zh.md)

<a id="model-experience"></a>
## 模型体验

### Provider 账户校验

#### 模型看到什么

什么也看不到。`/models` 凭据探测属于控制面操作，秘密和响应都留在 Agent 上下文之外。

#### Token 影响

无；校验不增加提示词或工具内容。

#### KV Cache 影响

无；该检查独立于模型推理调用 Provider 目录。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 只注册 `deepseek-api`，因为它有稳定且需要认证的 HTTP 探测；CLI 账户健康状态仍归各自 CLI 集成负责。
- Provider 故障和网络失败刻意共用脱敏后的 `provider-unavailable` 结果。
