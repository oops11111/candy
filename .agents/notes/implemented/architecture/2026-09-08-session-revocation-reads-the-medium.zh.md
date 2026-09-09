# Agent Note: 会话撤销读取介质

Status: implemented

[English](2026-09-08-session-revocation-reads-the-medium.md) | 中文

## Problem

在一个 Candy 进程中撤销的浏览器会话，在共享同一数据库的另一个运行进程中仍然有效，直到该进程重启。退出登录因此依赖部署拓扑，而不是持久会话记录。

## Decision

浏览器认证改为异步，并在接受会话前从持久存储单元重新读取匹配记录。`KvUnit.readRecord` 与 `KvTable.getCurrent` 是通用 DSH 扩展点；SQLite 后端执行真实介质读取，domain 层校验该值并刷新本进程快照。

## Alternatives considered

**强制一个数据库只能运行一个进程。** 这会让撤销依赖部署拓扑，而且一次运维错误仍会成为认证绕过。

**广播进程本地失效通知。** 通知路径会引入投递与恢复语义，而持久记录已经是每个进程都能读取的权威来源。

## Boundary

Candy 负责会话有效性并消费存储扩展；DSH 继续负责存储后端与 domain 校验。灰度部署仍使用独立数据库，因为混合 schema 版本与运行时 audience 不安全；这条规则不再是旧会话的临时补救。

## Consequences

每个已认证 HTTP 请求会执行一次有索引的 SQLite 查询，成本有界，并能让所有共享数据库的运行进程看到撤销。双进程 Candy 组合证明第二个进程无需重启便会拒绝下一次请求。变异负控制把介质读取替换为内存 `get`，对应断言如期失败，恢复后重新通过。
