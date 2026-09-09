---
description: "供管理员读取有界租户与运行时审计窗口的 Candy API 和继承设置入口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-audit-api

[English](README.md) | 中文

## 概述

仅管理员可调用的 `GET /api/candy/audits` 返回当前管理员的租户窗口及本运行时的未归属窗口。`completeHistory: false` 与 `retention` 明确说明超出保留上限的记录已经消失；本路由不是归档。

不发布运行时 invariant companion；此插件不持有可变运行时状态，其角色边界和有界响应由 API 测试覆盖。

## 目录

- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="dev-note"></a>
## 开发备注

- [审计窗口有了入口](../../../.agents/notes/implemented/architecture/2026-09-09-the-audit-window-has-a-door.zh.md)

<a id="model-experience"></a>
## 模型体验

### 管理员审计读取

#### 模型看到什么

什么也看不到。`GET /api/candy/audits` 及其设置区只向通过认证的管理员显示运维记录。

#### Token 影响

无；该操作不增加提示词或工具内容。

#### KV Cache 影响

无；不会组装或更改 Provider 请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 响应是有界的当前窗口，不是归档或分页 API。
- 没有租户身份的运行时记录保留在独立的运行时窗口中。
