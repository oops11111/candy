# Agent Note: 审计窗口有了入口

Status: implemented

[English](2026-09-09-the-audit-window-has-a-door.md) | 中文

## Problem

Candy 已保留租户与运行时审计记录，但运维人员没有经过认证的读取界面。暴露这些记录还可能让人误以为有界窗口是完整归档，或在 DSH 之外建立第二套管理界面。

## Decision

Candy 通过 `GET /api/candy/audits` 暴露保留期内的租户与运行时审计窗口。继承的管理信封从 OAuth 会话派生身份，并且只允许管理员进入。响应携带 `retention` 与 `completeHistory: false`，绝不会暗示已被有界存储挤出的记录还能翻页取回。

DSH 设置框架在 Provider 账户页之外提供独立的 `candy-audit` section。它复用既有导航、渲染器、本地化、响应式布局和主题，不建立第二套 Web 界面。

## Alternatives considered

**把审计记录放入 Provider 账户页。** 这会把仅限运维人员的跨运行时事项混入租户账户管理，使两者的授权边界更难区分。

**建立 Candy 专属管理应用。** 这会重复实现项目边界明确归于 DSH 的 Web 界面、响应式布局、设置框架和主题。

**把窗口表现为可分页历史。** 超出保留上限的记录已不在控制平面存储中，因此分页会承诺实现无法提供的数据。

## Consequences

管理员可以通过既有 Web 设置框架查看两个有界窗口，而普通成员会收到 403。运维人员必须把响应视为当前诊断窗口，而不是持久合规存储。API 测试覆盖角色边界和有界响应。
