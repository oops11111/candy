# Candy 运行时边界

[English](candy-runtime-boundaries.md) | 中文

## 概要

Candy 运行在 DeepSeek Harness 插件运行时之上，并围绕它增加租户感知的控制面。本页定义 Candy 继承哪些能力、Candy 自己负责哪些职责，以及每个多租户运行时改动必须保持关闭的滥用场景。

## 目录

- 继承的 Harness 能力
- Candy 自有控制面
- 信任边界
- 滥用场景
- 审查要求
- 开发备注

## 继承的 Harness 能力

Candy 保留 Harness 作为执行核心。Harness 拥有 Cordis 插件树、agent 循环、会话事件、提示词与工具组装、模型适配器接口、文件系统与子进程能力 seam、Web 服务、响应式客户端、设置 UI、品牌 slot、主题插件、Windows 目录选择、Windows PowerShell 执行、Windows ACL 沙箱集成、Git 操作、Remote 网关和会话重放机制。

Candy 不把这些能力 fork 成并行实现。需要文件、shell 执行、设置、会话历史、浏览器 UI 或远程 Windows 工作的 Candy 功能，必须接入现有 Harness package 或插件边界，除非所属 package 无法执行 Candy 租户规则。

## Candy 自有控制面

Candy 拥有用户身份、OAuth 会话、提供方账户记录、加密凭据、设备配对、工作区 grant、对话成员关系、运行时调度、租户配额、审计记录，以及签发执行 assertion 的 HTTPS/WebSocket 网关。

控制面是 `userId`、`deviceId`、`accountId`、`workspaceGrantId`、`conversationId`、`sessionId` 和子运行祖先关系的唯一权威。浏览器客户端、移动客户端、Windows host 和提供方适配器只能在已认证的控制面 assertion 中携带这些标识符。Candy 会拒绝试图在 assertion 外选择租户、账户、设备或工作区的请求字段。

提供方 CLI 可以共享不可变二进制、package 缓存和下载缓存。它们不得跨 `userId + provider + accountId` 共享已认证 home 目录、可写提供方配置、环境覆盖、进程树、会话存储、私有模型缓存或工作区挂载。

## 信任边界

浏览器和移动客户端是不受信任的呈现客户端。它们可以请求自己的状态并发送用户输入，但不能声明会话、提供方账户、设备、工作区或执行策略的所有权。

Windows Harness Host 是绑定到一个用户的配对设备。只有控制面把设备、工作区根、操作类别、过期时间和 nonce 绑定到请求后，它才能暴露本地 Harness 能力。Windows host 会在接触文件系统或 shell 前本地解析规范路径，并拒绝遍历、junction、symlink 和跨盘符逃逸。

Debian Candy 运行时是调度器和提供方进程 supervisor。它验证每个执行 assertion，创建按身份隔离的运行时 home，只为当前进程注入 secret，收集标准化提供方事件，并追加按租户分区的会话事件。

提供方进程启动后是不受信任的子进程。它们的 stdout、stderr、退出状态、结构化输出和诊断文本都通过有界且已脱敏的适配器解析。格式错误的提供方 stream 会使运行失败，但不会扩大 grant 或暴露 secret。

## 滥用场景

凭据窃取通过加密凭据 envelope、脱敏读取、逐次调用 secret 注入，以及对一个运行时池 key 私有的提供方 home 来阻断。

租户混淆通过控制面 assertion 阻断；调度前会检查 audience、过期时间、租户、账户、会话、设备、工作区 grant 和 nonce。客户端提供的租户或账户字段会被忽略或拒绝。

路径遍历通过规范工作区根、操作类别 grant、本地 Windows 路径解析，以及拒绝通过 symlink、junction、替代盘符、UNC 别名和大小写折叠技巧穿透来阻断。

事件泄漏通过按租户分区的会话存储，以及对重放、订阅、导出、删除、重连和后台 job 收集的授权检查来阻断。

进程逃逸通过按身份隔离的 home、最小环境、有界工作目录、子进程取消、进程树清理、输出限制，以及每个提供方或工具进程的审计记录来阻断。

重放攻击通过短生命周期 assertion、audience 绑定、nonce、过期检查，以及设备和工作区操作的幂等请求处理来阻断。

混淆代理攻击通过父级子集式子运行 grant 阻断。子运行只能使用父运行已经拥有的账户、工作区、工具、token、时间、成本和并发权限。

## 审查要求

R1 改动必须包含测试，证明跨租户读取 fail closed、凭据读取会脱敏、已撤销账户不能启动新工作，并且执行 assertion 会拒绝错误的 audience、过期时间、nonce、租户、账户、会话、设备和工作区 grant 值。

R2 提供方改动必须在 DeepSeek API、Claude CLI 和 Codex CLI 上运行同一套生命周期契约测试。该套件必须覆盖 streaming、工具调用、取消、格式错误输出、提供方崩溃、timeout、quota 失败、用量上报和 secret 脱敏。

R3 编排改动必须证明子运行继承父级 grant 的严格子集，取消会到达子运行和提供方进程，并且审计记录保留路由、委派、用量和终态，同时不暴露 secret。

R4 Web 改动必须在桌面和移动 viewport 尺寸下验证同一批路由。账户管理 API 必须证明 list、create、validate、select-default、revoke 和 delete 的所有权检查。

R5 Windows host 改动必须测试设备绑定、工作区根 grant、Unicode 和长路径、分支发现、并发编辑、撤销、重连、离线状态、恶意路径输入，以及 junction 或 symlink 逃逸尝试。

R6 发布改动必须验证从 ClauGod 时代元数据迁移到 Candy 元数据、提供方 canary、备份与恢复、回滚，以及针对跨租户尝试、孤儿进程、quota 违规和提供方故障的运维告警。

## 开发备注

本页是 Candy 多租户运行时工作的 R0 基线。后续任务落地时，应把宽泛清单项替换为 package 自有测试和 Agent Note。
