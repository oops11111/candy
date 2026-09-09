# Agent Note: 一次运行实际使用的路由

Status: implemented

[English](2026-09-09-the-route-a-run-actually-used.md) | 中文

## Problem

Candy 已在最终适配器边界强制执行每个租户的 provider/model 白名单，并审计拒绝，但成功的模型调用没有留下它所用路由的记录。准入只知道账户的 provider，而 Harness 路由中间件仍可在派发之前选出另一个最终模型。因此重建一次运行时，只能看到它开始、花费资源并结算，却不知道是哪一组 provider/model 产生了这些花费。

## Decision

`RunScheduler` 仍是审计所有者，并复用它已有的前置 `llm/stream` 监听器。它先调用下游 waterfall，让 Harness 路由中间件完成对 `GenerateOptions` 的修改，再在计量流被拉入适配器之前记录最终得到的 provider/model 组合。不能唯一解析到一次 Candy 运行的调用仍然不归 Candy 审计或计量。

记录使用 `event: 'routed'`、`action: 'select'` 与 `outcome: 'ok'`，并带有明确的 `provider` 和 `model` 字段。这两个字段参与重复折叠，因此同一次运行对同一路由的重复调用可以折叠，路由变化则保持分离。持久控制平面声明升到版本 10，因为版本 9 的踪迹无法回答一次成功调用使用了哪条路由。

审计写入失败会被记录到日志，不会把一次模型调用替换成审计失败。记录会在提供方迭代之前尝试，因此消费方不会在审计路径完成之前收到提供方输出。

## Consequences

保留期内的审计窗口可以把一次运行选中的路由与其终态用量关联起来，而无需重复实现 Harness 的模型发现、选择、回退或适配器注册。该记录描述尝试派发时选中的组合；之后的适配器或授权失败仍由它自己的终止流结果或拒绝记录体现。

调度器的所属组合测试把初始请求路由到另一组 provider/model，并在租户踪迹中只观察最终组合。存储测试会把 provider 或 model 不同的记录保持分离。若变异为记录 waterfall 之前的组合，路由测试会失败。

## Alternatives considered

**在准入时记录账户 provider。** 被否决，因为它无法标识模型，并且早于 Harness 路由中间件，所以不是调用实际尝试派发的路由。

**在 `dsh-tenant-route-policy` 内记录成功路由。** 被否决，因为 LLM guard 会在 prepared-call 能力查找之前运行一次，并在最终派发时再次运行。在那里记录会把一次 prepared call 计算两次，也会让 Candy 策略插件拥有通用路由观察职责。

**增加另一个路由器或适配器包装。** 被否决，因为 Harness 已经拥有路由选择与适配器。Candy 需要的是审计观察，而不是平行的路由机制。
