# Agent Note: Windows 主机传输边界

Status: proposed

[English](2026-09-13-windows-host-transport-boundary.md) | 中文

## Problem

Candy 已经有持久化的用户和设备绑定，但 Windows Harness Host 建立或恢复连接时还没有传输端消费这些绑定。新增第二套 WebSocket 或复制 Remote Gateway 都会违反项目边界。

## Proposal

在 DSH 现有 Remote 传输中增加主机认证接缝。Candy 提供短期、受受众约束的设备断言；DSH 在建立连接和重连时出示它，然后只暴露已有的 Remote 能力。

## Candy responsibility

Candy 签发和撤销断言，将每条断言绑定到一个租户和设备，并返回统一的未授权响应。它不得接收文件路径、工具载荷、Shell 输出，也不得把 Bearer 令牌写入审计记录。设备被撤销后，下一次握手和重连必须失败。

## DSH responsibility

DSH 负责套接字、重试状态、能力注册表、帧协议、有界输出以及 Windows 文件或进程执行。接缝只能接受不透明断言回调，不能把租户概念加入 Remote 调用。成功身份不得缓存到断言过期之后。

## Acceptance criteria

- 已配对主机通过现有 Remote Gateway 连接，所有调用仍可归属于绑定的租户和设备。
- 缺失、格式错误、过期、跨租户和已撤销断言都必须在能力执行前失败。
- 重连必须重新认证，不能复用过期身份；网络故障与撤销必须保持可区分。
- 不新增第二套 WebSocket 协议、文件操作 API 或 Candy 自有的 Windows 执行器。

## Risks

如果继承的传输无法插入认证握手，Candy 不能在其上方安全模拟。此时部署必须关闭远程 Windows 工作，而不能接受未认证主机或共享长期令牌。

## Alternatives considered

- 在每次 Remote 调用中携带 Bearer 令牌。拒绝，因为这会重复授权，并让凭据进入能力载荷。
- 增加 Candy WebSocket 代理。拒绝，因为这会创建第二套传输并重复 DSH Gateway 行为。

## Explicit non-goals

本文不实现 Remote Gateway、WebSocket 帧协议、Windows 文件操作、PowerShell、沙箱、Agent 或 Skills 执行，也不实现第二套 Web/手机端。
