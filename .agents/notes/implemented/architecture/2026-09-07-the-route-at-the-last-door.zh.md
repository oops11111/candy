# Agent Note：最后一道门上的路由

状态：已实现

[English](2026-09-07-the-route-at-the-last-door.md) | 中文

## 问题

DeepSeek Harness 已经能够发现模型、选择显式 provider/model 组合，并为子代理携带 `ModelSelectionPolicy`。Candy 的 preset 守卫也限制了租户可选择的 agent 组合。但这些判断都没有为真实模型调用背后的租户授权最终路由。直接模型覆盖、另一个 `llm.stream` 调用方或未来的选择界面，因此仍可能触及该进程注册的任何共享适配器。

把租户字段放进通用模型注册表并不会补上已有功能，反而会让可复用的 Harness 子系统依赖 Candy 的运行身份。从 preset 推断权限也会混淆两种不同授权：agent 组合不等于 provider 账户或模型权益。

## 决策

`dsh-llm` 现在公开一个通用、单调的 `LlmRuntime.guard()` 扩展点。携带 session 的 `prepareCall()` 会在适配器准备前运行守卫；最终分发会在 `llm/stream` 路由中间件选出 provider/model 组合后再次运行。任何守卫都可以拒绝；没有守卫能强制允许另一守卫已经拒绝的路由。agent loop 会把自身 session 传进准备阶段，因此未授权的受管路由连适配器能力预检都不能发起。

`dsh-tenant-route-policy` 是 Candy 专属消费方。对于携带 session 的请求，它通过 `RunScheduler.tenantOf` 解析租户，并要求 `ControlPlaneStore` 中该租户的持久白名单存在区分大小写的精确 provider/model 组合。没有存储策略的受管租户会被拒绝，显式存储的空列表同样如此。拒绝发生在适配器选择之前，并表现为带 `TENANT_ROUTE_NOT_ALLOWED` 的终止流错误。

没有 session 的请求，或 session 无法唯一解析到 Candy 运行的请求，会直接通过。这保留了既有边界：Candy 可以限制自己准入的工作，但不宣称拥有无关 Harness 调用的授权权威。

## 后果

每一条进程内模型调用路径都共享同一个租户路由判断，包括直接选择，以及未来的 preset 或 UI 变化。一个租户无法继承另一个租户的路由。通用 Harness 注册表、发现界面与适配器保持不变；Harness 只增加不携带租户概念的通用最终守卫 seam。

受管租户采用封闭策略，因此运维者必须为每个应当运行的租户持久保存一条记录。`setTenantModelRoutes` 会替换完整策略，保留空的全拒绝记录，拒绝空白字段与重复组合；该运行时的下一次调用就会读取替换结果，且记录能跨重启保留。新增独立的 `tenant_routes` 表不会提升控制平面域版本，也不会使已有版本 8 记录失效。拒绝会在返回前等待 `RunScheduler.recordRouteRefusal()`，留下按租户归档的 `refused` 记录，其中 `action: 'route'`，outcome 为策略 code。

这还没有提供经过认证的运维 Web/API 界面，也没有让共享同一 SQLite 数据库的多个长驻进程实时收到失效通知。这些是本地持久权威之上的分发问题，并不构成退回静态部署配置的理由。

本决策不会凭空制造 fallback。有效 fallback 必须存在能服务该请求的第二条路由；跨 provider 时还必须拥有第二个 provider 账户的授权。本次改动提供路由策略的白名单一半；选择以及经过账户授权的 fallback 仍是独立工作。

## 考虑过的替代方案

**让 Harness 模型注册表支持租户。** 拒绝，因为发现与适配器所有权已经是通用能力，而 Candy 运行不属于它们的契约。

**从选中的 preset 推导路由权限。** 拒绝，因为调用方可以不经过 preset 直接访问 `llm.stream`，而且 preset 授权不等于 provider 凭据授权。

**只守卫 agent 请求构造器。** 拒绝，因为直接 LLM 消费方与后续路由中间件都可能绕过更早的构造期检查。

**自动 fallback 到任意允许路由。** 延期，因为仅仅允许一个名字并不能证明其能力，也不能证明对第二个 provider 账户拥有授权。

**把白名单保留在插件配置里。** 在第一批强制执行完成后被否决，因为修改或撤销一份租户授权需要重启部署，而且它不会作为控制平面状态保留下来。持久记录让“缺失”与“显式全拒绝”都没有歧义，同时不需要让通用 Harness 注册表理解租户。
