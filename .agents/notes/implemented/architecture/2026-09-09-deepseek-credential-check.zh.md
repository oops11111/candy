---
title: DeepSeek 凭据校验通过注册表表达
status: implemented
date: 2026-09-09
---

# DeepSeek 凭据校验通过注册表表达

[English](2026-09-09-deepseek-credential-check.md) | 中文

Candy 不会让账户 API 理解 Provider 协议。一个小型 Provider 集成在既有凭据检查注册表中注册 `deepseek-api`，并探测 DeepSeek 的认证模型目录。结果刻意保持封闭：认证失败表示凭据无效，传输及其他 HTTP 失败表示 Provider 不可用，任何端点、正文或由秘密派生的细节都不会返回。

确定性测试覆盖 HTTP 分类与脱敏契约。真实 e2e 只从环境读取 `DEEPSEEK_API_KEY`，缺少时自动跳过。变异负控制关闭成功响应分支后，200 用例如期失败，随后已恢复。
