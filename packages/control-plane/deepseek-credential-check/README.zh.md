---
description: "注册到 Candy Provider 账户校验接缝中的脱敏 DeepSeek API 凭据检查。"
kind: "package-reference"
---

# @deepseek-ai/dsh-deepseek-credential-check

[English](README.md) | 中文

## 概述

本 Provider 集成在继承的 `dsh-provider-credential-checks` 注册表中注册 `deepseek-api`。它调用需要认证的 `/models` 端点，只返回 `valid`、`invalid-credential` 或 `provider-unavailable`；端点、请求与响应体、密钥路径和秘密都不会进入校验结果。

Candy bundle 可通过 `DEEPSEEK_BASE_URL` 配置可信部署端点，默认使用 DeepSeek 公共 API。真实测试使用 `DEEPSEEK_API_KEY`，缺少时自动跳过。
