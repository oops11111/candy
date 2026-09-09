# Agent Note: DeepSeek 凭据校验通过注册表表达

Status: implemented

[English](2026-09-09-deepseek-credential-check.md) | 中文

## Problem

Provider 凭据检查注册表没有任何实现，因此即使 DeepSeek 提供普通 HTTP API，账户界面仍返回 `unsupported-provider`。让账户 API 理解 Provider 协议会把租户账户管理与各个 Provider 耦合。

## Decision

Candy 保持账户 API 与 Provider 无关。一个小型 Provider 集成在既有凭据检查注册表中注册 `deepseek-api`，并探测 DeepSeek 的认证模型目录。结果刻意保持封闭：认证失败表示凭据无效，传输及其他 HTTP 失败表示 Provider 不可用，任何端点、正文或由秘密派生的细节都不会返回。

## Alternatives considered

**在账户 API 中实现协议。** 这会把租户账户边界与 Provider 特定传输耦合，并让每个新 Provider 都修改中央账户逻辑。

**返回原始 Provider 诊断。** 端点、正文及由秘密派生的错误细节可能向调用方和日志泄露部署配置或凭据材料。

**在同一包中探测 CLI Provider。** CLI 登录状态归各自继承的 CLI 集成负责，并不存在与 DeepSeek 模型目录等价的通用 HTTP 检查。

## Consequences

确定性测试覆盖 HTTP 分类与脱敏契约。真实 e2e 只从环境读取 `DEEPSEEK_API_KEY`，缺少时自动跳过。变异负控制关闭成功响应分支后，200 用例如期失败，随后已恢复。
