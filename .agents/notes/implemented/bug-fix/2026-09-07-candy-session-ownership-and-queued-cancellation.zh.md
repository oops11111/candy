# Agent Note: Candy session ownership and queued cancellation

Status: implemented

[English](2026-09-07-candy-session-ownership-and-queued-cancellation.md) | 中文

## Problem

淘汰一个已结束会话的记录，会让它的下一次请求绕过计量。在迭代器的首次读取等待另一次调用时关闭它，仍可能在前序调用结束后启动已取消的数据源。

## Decision

现有控制平面存储域独立于运行结算保留会话归属。准入在写入运行记录之前写入归属。受管会话没有有效运行时，计量拒绝其请求，包括缓存淘汰或重启之后。这取代了[先前记录](../architecture/2026-09-05-a-run-that-ended-and-kept-spending.zh.md)中的纯缓存决策。

现有的每运行队列在等待前后检查释放状态。已关闭的排队迭代器直接返回结束，不启动数据源，后续调用仍可继续。

## Alternatives considered

**仅在内存中保留所有已结束会话。** 这消除了淘汰，但重启仍会丢失分类。

**拒绝所有非受管 DSH 会话。** 这会阻止同一组合中的普通 DSH 工作。持久化 Candy 归属可区分两者。

**替换 DSH 取消或存储实现。** 缺陷位于 Candy 的队列和分类逻辑；现有存储域与流机制已经提供所需操作。

## Consequences

归属存储随准入会话数量增长，不会自动过期。按照现有预发布策略，存储域版本 7 拒绝旧记录；本次变更不部署或迁移生产数据。生产转换需要单独验证。

Loader 组合回归覆盖排队等待中关闭、后续调用、缓存淘汰和重启。这些是无需密钥的存储及流检查，不是真实提供方或 Windows ACL 验收证据。录制会话场景尚待补齐。
