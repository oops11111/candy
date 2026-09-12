# Agent Note: 有配对码却没有命令

Status: implemented

[English](2026-09-13-a-code-with-no-command.md) | 中文

## 问题

`dsh-device-binding.pair` 已能安全兑换并保存配对码，但它只是服务方法。Windows 运维人员没有可调用它的已发布进程入口。把另一个解析器挂进 Web profile 会与该应用的命令语法冲突，而把配对加入启动器会让启动器承担 Candy 领域行为。

## 决策

发布独立、仅启动时加载的 `candy-host` profile。其命令解析器接受 `pair --server --code`、`status` 和 `release`；runner 把每个操作委托给既有 `dsh-device-binding` 服务后退出。完整配置树只包含本地凭据提供方、设备绑定、解析器和 runner。

配对输出绝不包含配对码或设备令牌，配对码通过解析器的进程内服务传递，而不经过 Loader 配置。意外错误不会被转换为字符串，因为网络库可能在错误中包含请求体。该 profile 明确不启动 Agent、Web 表层、文件或 Shell 能力、Gateway、WebSocket、重试计划或重连状态。

## 考虑过的替代方案

- 向 Web profile 添加 Candy 参数。拒绝，因为两个应用解析器会争用同一份不可变 argv，而且 Windows Host 配对不属于浏览器服务器的启动职责。
- 添加 `dsh pair` 启动器命令。拒绝，因为启动器拥有 profile 选择和插件管理，而不拥有租户／设备领域操作。
- 使用设备令牌调用浏览器到 Host 的 Gateway。拒绝，因为该传输方向相反，不能让 Debian 使用 Windows 能力。

## 后果

运维人员现在可以通过已发布命令完成、查看并明确释放本地绑定，打包后的 CLI 也能直接解析该 profile，无需手动安装插件。远程主机传输仍未构建：下一段传输工作必须是 DSH 能力，并在真正的连接边界消费此绑定，而不是建立第二套 Candy WebSocket。
