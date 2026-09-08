# @deepseek-ai/dsh-audit-api

[English](README.md) | 中文

仅管理员可调用的 `GET /api/candy/audits` 返回当前管理员的租户窗口及本运行时的未归属窗口。`completeHistory: false` 与 `retention` 明确说明超出保留上限的记录已经消失；本路由不是归档。

不发布运行时 invariant companion；此插件不持有可变运行时状态，其角色边界和有界响应由 API 测试覆盖。
