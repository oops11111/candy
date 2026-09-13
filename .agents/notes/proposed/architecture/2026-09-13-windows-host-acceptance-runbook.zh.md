# Agent Note: Windows 主机验收运行手册

Status: proposed

[English](2026-09-13-windows-host-acceptance-runbook.md) | 中文

## Problem

R5 剩余验收依赖真实 Windows Harness Host 和可访问的 Debian 控制面。仅靠容器测试无法证明重连认证、Windows junction 行为或 Remote 边界上的设备撤销。

## Proposal

真实 Windows Host 和 Debian 部署可用后，按本文顺序执行并作为发布门禁。

## Preconditions

- Debian 部署通过 HTTPS 运行 Candy 控制面，并使用稳定的公开 origin。
- Windows Host 运行 DSH 提供的主机 profile，可通过 TLS 访问该 origin。
- 测试租户、设备、工作区和提供方账户不包含生产密钥。
- 已启用 DSH 现有 Remote Gateway 和 Windows 插件；Candy 不新增第二套传输。

## Verification sequence

1. 将一个 Windows Host 配对到租户 A，验证绑定并建立 Remote 连接。
2. 在明确授权的工作区中执行读、写、Shell 和目录选择操作；只记录操作元数据。
3. 尝试遍历、符号链接、junction、长路径和跨工作区操作；每项都必须在 DSH 执行器修改文件前被拒绝。
4. 从 Candy 控制面撤销设备，然后确认下一次调用和重连都以未授权失败。
5. 将第二台主机配对到租户 B，确认两台主机无法看到对方的工作区、账户、会话或审计记录。
6. 中断网络并让继承的重连流程运行；断言过期后必须重新认证。

## Evidence and failure rules

记录请求状态、设备 id、租户 id、操作类别和时间戳，但绝不记录路径、令牌、凭据、提示词或命令输出。撤销后仍执行能力、出现跨租户响应，或重连绕过断言校验，均为发布阻塞项。缺少 Windows 或 Debian 环境代表测试未执行，不得算通过。

## Acceptance criteria

六个验证步骤都得到预期的授权和隔离结果，且证据不包含秘密。

## Risks

如果 DSH 没有传输认证接缝，本文无法弥补；此时必须继续关闭远程 Windows 工作。

## Alternatives considered

- 把容器测试当作 Windows 行为证明。拒绝，因为它无法执行 Windows ACL、junction 或主机重连语义。
- 增加 Candy 专用测试传输。拒绝，因为这会重复 DSH Remote 行为。

## Explicit non-goals

本文不实现 Remote Gateway、WebSocket 帧协议、Windows 文件或 Shell 执行、沙箱，也不实现第二套 Web/手机端。
