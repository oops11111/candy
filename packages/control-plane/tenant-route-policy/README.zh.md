---
description: "Candy 策略插件：为一次受管 LLM 调用背后的租户授权精确的 provider/model 路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tenant-route-policy

[English](README.md) | 中文

## 概述

`dsh-tenant-route-policy` 通过最终适配器边界上的 `LlmRuntime.guard()` 为 Candy 受管会话强制执行精确的 provider/model 授权。模型发现、模型选择与适配器仍由 DeepSeek Harness 拥有；本包只通过 [`dsh-run-scheduler`](../run-scheduler/README.zh.md) 解析请求会话，从 [`dsh-control-plane-store`](../control-plane-store/README.zh.md) 读取持久授权，并回答 Candy 专属的授权问题。没有存储策略的受管租户默认被拒绝。没有 session 的请求，或无法唯一解析到 Candy 运行的 session，仍遵循普通 Harness 行为。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本策略与 `dsh-llm`、`dsh-run-scheduler`、`dsh-control-plane-store` 一同加载：

```yaml
- name: '@deepseek-ai/dsh-tenant-route-policy'
```

通过控制平面权威设置完整白名单：

```ts
await ctx.controlPlaneStore.setTenantModelRoutes(userId, [
  { provider: 'claude-cli', model: 'sonnet' },
  { provider: 'codex-cli', model: 'gpt-5.6-sol' },
])
```

两个字段都是区分大小写的精确 id。被允许的组合会进入正常的 Harness waterfall 与适配器。该受管租户的任何其他组合都会先被持久审计为 `refused/route/TENANT_ROUTE_NOT_ALLOWED`，随后返回唯一一个终止 `error` 帧，错误码为 `TENANT_ROUTE_NOT_ALLOWED`；适配器不会被调用。存储的空列表与缺少租户策略都表示拒绝。替换记录会在该运行时的下一次调用生效，并能跨重启保留。

-----

<a id="understand-the-implementation"></a>
## 理解实现

本插件注册一个 `LlmRuntime.guard()`。携带 session 的 prepared call 会在适配器准备前调用它；最终分发会在路由中间件选出最终组合后再次调用。守卫读取 session id，通过 `RunScheduler.tenantOf` 获取实时租户，再核对该租户当前存储的组合。因此直接模型选择、preset 切换和后续路由改写都无法绕过它或触发未授权的 provider 预检。未关联 Candy 运行的调用会直接通过，因为 Candy 没有可施加其上的租户授权。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 持久策略查找、精确组合核对与终止拒绝 |
| [`tests/policy.spec.ts`](tests/policy.spec.ts) | 固定允许、拒绝、动态更新、封闭默认、非受管与跨租户行为 |

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 持久存储 API 已存在，但还没有经过认证的运维 Web/API 界面公开它。
- 本包授权一条已请求路由，不选择 fallback。安全的跨 provider fallback 还需要第二个 provider 账户的授权，以及一条可被区分的可用路由。

-----

<a id="dev-note"></a>
### 开发备注

为何把它实现为 `llm/stream` 上的 Candy 策略插件，而不向通用 Harness 模型注册表加入租户概念，见 [最后一道门上的路由](../../../.agents/notes/implemented/architecture/2026-09-07-the-route-at-the-last-door.zh.md)。
