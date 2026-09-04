# Agent Note: 多租户 CLI agent 运行时

Status: proposed

[English](2026-09-02-multi-tenant-cli-agent-runtime.md) | 中文

## Problem

Candy 需要通过桌面与手机浏览器以及 Windows Host 服务多个用户，同时在 Debian 服务器上运行 coding agent（编程智能体）。继承的 Harness 提供 agent loop（智能体循环）、插件、会话、响应式 Web 服务、主题与品牌插件以及 Windows 本地文件系统能力，但没有定义租户身份、相互隔离的提供方账户、远程 Windows 所有权或控制平面约定。

产品必须通过 CLI（命令行界面）运行 Claude 和 Codex，并通过 API 运行 DeepSeek。系统可以复用 CLI 安装或 worker 基础设施，但绝不能复用用户凭据、主目录、进程环境、会话、工作区授权或事件流。

## Proposal

保留 Harness agent loop 作为 Candy 的执行核心，并围绕其现有扩展点增加租户感知服务。控制平面负责身份验证、设备所有权、持久元数据、加密凭据和策略。每个 agent 任务在 Debian 上的身份隔离运行时中执行。在 Windows 上运行 Harness Host，并复用其文件系统、目录选择、PowerShell、Git、沙箱、Remote、响应式 Web、主题和品牌 slot 插件。Candy 在这些能力外围增加租户绑定和远程路由，而不替换它们。

桌面与手机浏览器使用相同的 Harness Web 服务。Candy 不交付独立手机应用、UI 框架、调色板或主题选择器。产品身份使用现有品牌 slot，外观继续使用 Harness 主题插件。

此设计不使用 Claude Agent SDK。Claude CLI 和 Codex CLI 是子进程提供方；DeepSeek 是 API 提供方。提供方适配器必须发出统一的生命周期事件，同时保留提供方原生诊断信息。

## Target architecture

```mermaid
flowchart LR
    subgraph Clients
        WEB[Harness responsive Web]
        WIN[Windows Harness Host]
    end

    subgraph ControlPlane[Control plane]
        AUTH[User OAuth and sessions]
        DEVICE[Device pairing and grants]
        VAULT[Encrypted account vault]
        META[Workspace and conversation metadata]
        GATEWAY[HTTPS and WebSocket gateway]
    end

    subgraph CandyRuntime[Candy runtime on Debian]
        POLICY[Tenant policy and scheduler]
        EVENTS[Session event log]
        POOL[Identity-scoped runtime pool]
        ROUTER[Provider and agent router]
        CLAUDE[Claude CLI adapter]
        CODEX[Codex CLI adapter]
        DEEPSEEK[DeepSeek API adapter]
        TOOLS[Permissioned tool gateway]
    end

    WEB --> GATEWAY
    WIN --> GATEWAY
    GATEWAY --> AUTH
    GATEWAY --> DEVICE
    GATEWAY --> META
    AUTH --> POLICY
    VAULT --> POLICY
    META --> POLICY
    POLICY --> POOL
    POLICY --> ROUTER
    ROUTER --> CLAUDE
    ROUTER --> CODEX
    ROUTER --> DEEPSEEK
    ROUTER --> TOOLS
    ROUTER --> EVENTS
    TOOLS <-->|scoped RPC| WIN
    EVENTS -->|authorized replay| GATEWAY
```

控制平面是 `userId`、`deviceId`、`accountId`、工作区授权和会话成员关系的权威来源。Candy 只从通过身份验证的控制平面断言中接受这些值，绝不从客户端选择的请求字段中接受这些值。

运行时池键为 `userId + provider + accountId`。worker 可以共享不可变 CLI 二进制文件、包缓存和调度基础设施。不同池键之间不得共享凭据文件、可写主目录、环境覆盖、进程树、会话存储或工作区挂载。

## Runtime contracts

1. 控制平面为每次运行签发短期且绑定受众的执行断言。Candy 在调度任务前验证签发者、受众、有效期、租户、账户、会话、设备、工作区授权和 nonce。
2. 每次 CLI 调用获得隔离主目录、最小环境、受限工作目录、取消句柄、输出限制和审计上下文。秘密只注入该次调用，不写入共享仓库或事件日志。
3. 提供方适配器统一开始、文本、推理、工具请求、工具结果、用量、完成、取消和失败事件。它保留经过脱敏的提供方原生诊断信息以便排错。
4. Windows 操作要求已配对设备在线，并且授权必须指定工作区和允许的操作类别。配套程序解析规范路径并拒绝越过授权范围的路径遍历。
5. 会话事件仅追加并按租户分区。系统在每次回放、订阅、导出和删除请求中依据会话成员关系授权。
6. 子 agent 继承父运行的账户、工作区、工具、token、时间和并发授权的子集。创建子 agent 不能扩大任何授权。

## Delivery plan

| Task | Outcome | Depends on | Exit evidence |
|---|---|---|---|
| R0 | fork 边界和威胁模型 | 无 | 架构说明获批，滥用场景由测试或具名后续任务覆盖 |
| R1 | 租户、提供方账户、凭据和授权模型 | R0 | 跨租户访问测试快速失败，凭据记录已加密 |
| R2 | DeepSeek API、Claude CLI 和 Codex CLI 适配器 | R1 | 流式传输、取消、错误和用量的约定测试通过 |
| R3 | 多 agent 编排 | R2 | 父子授权、预算、取消和审计测试通过 |
| R4 | Harness Web 和提供方账户配置 | R1, R2 | 桌面与手机浏览器使用同一响应式服务，用户只能管理自己的账户 |
| R5 | Windows Harness Host 租户绑定 | R1, R3 | 已注册 Host 操作复用 Harness 插件并通过租户、路径与权限测试 |
| R6 | 迁移、端到端验证和发布 | R2, R3, R4, R5 | 分阶段发布满足安全、恢复、延迟和回滚门禁 |

### R0 — Boundary and threat model

R0 已交付为 [Candy 运行时边界](../../../../docs/candy-runtime-boundaries.zh.md)，后续每一项任务都对它负责。

- [x] 记录继承的 Harness 能力以及归 Candy 所有的控制平面职责 —— 见其 *Inherited Harness Capabilities* 与 *Candy-Owned Control Plane* 两节，其中包括这条规则：Candy 附着到既有的 Harness 边界上，而不是分叉出一份平行实现。
- [x] 建模凭据窃取、租户混淆、路径遍历、事件泄漏、进程逃逸、重放和 confused-deputy 威胁 —— 其 *Abuse Cases* 一节为每一种威胁各写了一段。
- [x] 定义浏览器、手机客户端、控制平面、Candy 运行时、提供方进程和 Windows 配套程序的信任边界 —— 见其 *Trust Boundaries* 一节。
- [x] 为后续任务增加架构决策和滥用场景评审门禁 —— 其 *Review Requirements* 一节为 R1 到 R6 每一项任务各写了一条，而上面的交付表承载对应的退出证据。R1 的门禁已满足：`dsh-run-admission` 的测试集证明跨租户读取快速失败、已吊销账户无法开启新工作，`redactCredential` 负责脱敏读取，而每一个身份声明都被证明位于断言的 MAC 之内，而不只是租户 —— 一个被移到签名之外的声明，会让只测一个声明的用例继续通过，同时变得可伪造。

### R1 — Tenant and account foundation

- [x] 为用户、设备、提供方账户、工作区授权、对话、会话、运行和子运行定义稳定标识符及 schema([`dsh-control-plane`](../../implemented/architecture/2026-09-02-candy-control-plane-identifiers.zh.md))。
- [x] 实现带版本封装、密钥轮换、脱敏读取、撤销和审计事件的加密凭据存储（[`dsh-credential-vault`](../../implemented/architecture/2026-09-02-candy-credential-vault.zh.md)）；审计记录会被返回，持久化它们的存储仍未构建。
- [x] 实现短期执行断言，并拒绝客户端提供的租户或账户覆盖值（[`dsh-execution-assertion`](../../implemented/architecture/2026-09-02-candy-execution-assertions.zh.md)） —— 而 nonce 所隐含的那个重放存储已经构建（[一个步骤决定一个 nonce](../../implemented/architecture/2026-09-03-one-step-decides-a-nonce.zh.md)）：`admitRun` 要求一个 `spendNonce` 端口，并且从不重试一个已消费的 nonce，因此那个端口就是防护的全部，而它所诱使写出的实现 —— 先查这个 nonce，再插入它 —— 会把被重放令牌的两份副本都准入。`RunReplayStore` 在一个同步步骤里做决定，恰好在断言仍可被准入期间持有记录，并按租户为键，使一个租户无法通过抢先消费某个值来拒绝另一个租户的运行。它服务于一个进程；运行多于一个进程的部署需要一个持久化存储，而那份契约现在是写下来的，不再靠推断。
- [x] 按池键隔离运行时主目录、进程所有权、事件日志、包含私有内容的缓存、配额和清理（[`dsh-runtime-pool`](../../implemented/architecture/2026-09-02-candy-runtime-pool-partitioning.zh.md)）；键与每个池的根目录已被推导，而一次 Claude CLI 运行现在按构造就被放进它的池里 —— [`dsh-claude-cli-binding`](../../implemented/architecture/2026-09-03-admitted-run-to-claude-cli-launch.zh.md) 从被准入的运行里读出进程的主目录、工作目录、凭据与花费上限，因此没有任何调用方会把一个租户的目录与另一个租户的密钥配在一起。创建目录现在也已归属：`openRuntimePool` 用一个被施加而非被请求的模式把池根目录设为私有，并拒绝凭空造出部署从未准备过的池基目录（[池根目录是被设为私有的](../../implemented/architecture/2026-09-03-a-pool-root-is-made-private.zh.md)）—— 每个调用方手写的那个 `mkdir` 会让一个已经存在的根目录保留它原有的权限，而那个根目录正是租户凭据被写入的地方。强制配额与清理仍属于尚未构建的池运行时，池基目录自身的权限也是。

### R2 — Provider adapters

适配器实现的是继承而来的 `dsh-llm` seam，而不是 Candy 自有的 seam。`LlmAdapter` 是提供方基类，`StreamChunk` 已经承载块开始、文本、推理、工具调用增量、用量与一次终止 finish，而 `dsh-llm/invariant` 会在每条提供方流周围强制执行该语法。Candy 只向该 seam 增加提供方，不定义第二套生命周期词汇。

- [x] 实现 DeepSeek API 适配器，覆盖流式传输、工具调用、用量、重试分类、取消和脱敏错误——已作为 `dsh-llm-deepseek`（`DeepSeekAdapter`）继承而来，`dsh-llm-pi-ai` 是同一 seam 的第二个实现。
- [x] 实现 Claude CLI 适配器，具备隔离的 home、非交互输入、结构化输出解析、取消与进程树清理（[`dsh-claude-cli-protocol`](../../implemented/architecture/2026-09-03-claude-cli-stream-protocol.zh.md) 与 [`dsh-llm-claude-cli`](../../implemented/architecture/2026-09-03-claude-cli-llm-adapter.zh.md)）。Candy 自行解析 `--output-format stream-json`，而不复用 `dsh-subagent-claude-code` 所走的 Agent SDK 路径，因为该 SDK 提供的是一个智能体循环，而这条缝隙需要的是一次模型调用。这条路由的窄是决定的结果而非遗漏：它服务一次性文本调用，并逐项具名拒绝对话、工具模式，以及 CLI 没有对应开关的每一个生成控制项。它的输出也是有界且脱敏的（[一条被 pipe 出来的流，由调用方来界定](../../implemented/architecture/2026-09-04-a-piped-stream-is-the-callers-to-bound.zh.md)、[一个把自己密钥引述回来的提供方](../../implemented/architecture/2026-09-04-a-provider-quoting-its-key-back.zh.md)）：缝隙把一条 `'pipe'` 流交给它的解码器，因此除了这条路由没有别的东西能界定它，而边界页面要求提供方输出经由一个有界、脱敏的适配器抵达调用方。约定套件的脱敏断言此前之所以通过，是因为录制到的 fixture 里没有密钥，而不是因为有什么东西把它去掉了。因此智能体循环目前还不能使用它 —— 补上这一点需要适配器笔记中记录为待决的多轮与工具决定。
- [ ] 使用相同的隔离和生命周期保证实现 Codex CLI 适配器。受阻于录制真实输出，而不是受阻于设计。对 `codex` 0.153.0 实测到的事实：`codex exec --json` 把 JSONL 写到 stdout；提示词是位置参数，且必须关闭 stdin，否则命令会一直等它；隔离手段是 `CODEX_HOME` 加上 `--ephemeral`、`--ignore-user-config`、`-s read-only`、`-C <dir>` 与 `--skip-git-repo-check`；没有系统提示词开关，也没有接受调用方工具模式的开关。观察到的帧是 `{"type":"thread.started","thread_id"}`、`{"type":"turn.started"}`、`{"type":"error","message"}` 与 `{"type":"item.completed","item":{"id","type","message"}}` —— 一个 thread/turn/item 模型，与 Claude CLI 的 Messages API 事件不同。内容帧、完成帧与用量帧始终没有到达：本环境的出网策略拒绝 `api.openai.com`，因此任何运行都过不了建连这一步，`developers.openai.com` 同样被封，而 npm 包只分发一个启动器、不含任何 schema。仅凭这些帧名就写出翻译器，正是 Claude CLI 那项工作所避免的猜测 —— 在那里有三处行为与合理假设相反。它需要在一台有出网和密钥的主机上录制一次运行。
- [x] 构建统一的提供方约定测试套件，覆盖成功、畸形输出、超时、配额、取消、崩溃和秘密泄漏 fixture（测试前置数据）（[`dsh-llm-adapter-contract`](../../implemented/architecture/2026-09-03-llm-adapter-conformance.zh.md)）。它跑在缝隙上，因为「恰好一个终止 chunk」的保证属于 `LlmRuntime` 而不属于适配器，且这条缝隙上的每一个适配器都运行它 —— `dsh-llm-deepseek`、`dsh-llm-pi-ai` 与 `dsh-llm-claude-cli`。运行它发现并修复了一个真实的进程泄漏：一个停止读取的消费方会让 CLI 继续运行。超时、配额与崩溃合并为一个失败运行用例，因为套件断言的是适配器面对一次失败该做什么，而不是它由什么引起；畸形输出仍归各适配器自己的线格式解析器。

### R3 — Multi-agent orchestration

- [ ] 为显式选择、能力匹配和允许的回退增加 agent 注册表和路由策略。注册表这一半是继承来的：[`dsh-agent-presets`](../../../../packages/preset/agent-presets) 已经能列出部署方或用户配置的每一个组合式 agent 预设、在某个预设无法启动会话时报告原因，并让一次会话显式选择其中之一；而 [`dsh-subagent`](../../../../packages/subagent/subagent) 的 `tool-subagent` 已经携带一份 `ModelSelectionPolicy` 白名单，并在委派子运行之前通过实时的 LLM 注册表解析一次显式的 provider/model 覆盖。能力匹配与回退目前还没有真正的第二个选项可供匹配或回退：[`dsh-llm-claude-cli`](../../../../packages/llm/llm-claude-cli) 按名拒绝对话、工具 schema 与非文本内容，因此它今天还无法服务主 agent 循环，而 Codex CLI 还没有适配器 —— 现在建一套路由策略，等于拿唯一可用的那条路由去和它自己比较，而这不是一个测试能把它同「什么都不做」区分开的策略。真正属于 Candy 要加的部分 —— 把一个租户限制在一个原本共享的预设名册或路由白名单的子集之内 —— 需要本次发布尚未构建的调度器，因为那才是一个租户的会话与它的 Candy 身份相遇的地方。
- [ ] 增加父子运行记录以及父级子集授权、深度、并发、token、时间和成本预算。深度与授权是继承来的，不是 Candy 要建的：`dsh-subagent` 已经拒绝超过 `maxDepth` 的子运行，并把被委派子运行的沙箱模式与审批策略钉在父运行上。预算这一半已经完成（[`dsh-run-budget`](../../implemented/architecture/2026-09-03-run-budget-delegation.zh.md)）：子运行的 token、挂钟时间、金额与并发在预留时就从父运行扣除，因此超额委派是不可能的，而不是可被发现的；未花完的余额在结算时归还。并发度是在整棵树上守恒，而不是只在其中一层守恒（[并发度在整棵树上守恒](../../implemented/architecture/2026-09-04-concurrency-is-conserved-across-a-tree.zh.md)）：一个子运行让父运行付出的，是它自己占的那一个名额，加上它可以转手让出的每一个名额，因为按每个子运行只收一个名额，会让一份「四」的授予在深度五时催生 1364 个存活运行，而那不是边界页面所陈述的父集规则。已耗尽的运行在门口就被拒绝：`admitRun` 通过一个必填的 `findBudget` 端口读取一次运行据以启动的那份额度，在消费 nonce 或打开凭据之前就拒绝（[没有任何人查询过的预算](../../implemented/architecture/2026-09-03-admission-enforces-the-budget.zh.md)）。对子运行来说，那份额度是它父运行的剩余量，从账本里读出，因此已耗尽的父运行会在子运行的断言仍然有效时把它拦下，而不是在它的 nonce 已经没了之后。金额在唯一报告它的那条路由上被量出来：Claude CLI 的 `total_cost_usd` 现在抵达 `TokenUsage.costMicroUsd`（[提供方已经开出的那张账单](../../implemented/architecture/2026-09-03-provider-reported-cost.zh.md)），因此租户的花费是一项被记录的事实，而不是调用方维护的一张价目表。运行记录已经建好（[`dsh-run-ledger`](../../implemented/architecture/2026-09-03-run-ledger-settles-exactly.zh.md)）：它持有每一次开启中的运行被给了什么、还剩什么，会随根一起关闭整个子树，并按租约释放被遗弃的占用 —— 而且是精确的而非估算的，因为每一次计费都经过它。剩下的是持久性：这些记录是纯数据而没有任何东西存储它们，因此一次重启会丢掉每一次开启中的运行；也没有任何东西驱动那个到期时钟。
- [ ] 向子运行、提供方进程、工具和事件流传播取消，并验证进程已完全清理。提供方进程这一半已被验证：取消或放弃一次被绑定的 Claude CLI 运行，会把 CLI 以及它启动的那个进程一并回收，这是对着真实 pid 检验的，而不是对着脚本化的句柄（见 [`dsh-claude-cli-binding`](../../implemented/architecture/2026-09-03-admitted-run-to-claude-cli-launch.zh.md)）。子运行、工具与事件流是从 `dsh-subagent` 与工具缝隙继承来的，尚未通过一次 Candy 运行验证。
- [ ] 在租户范围的审计轨迹中记录路由、委派、工具授权、用量和最终状态。已从记录本已存在、却正在丢失的那一处入手：`admitRun` 只在成功时返回保险库的审计，并丢弃了 `openCredential` 在失败分支上产生的记录，丢掉的正是保险库已检测到的跨租户访问尝试。现在每一种准入结果都携带 `audits`（[被拒绝的运行正是审计轨迹的用途所在](../../implemented/architecture/2026-09-03-run-admission-audits-every-outcome.zh.md)），并且 assertion 之后的每一次拒绝现在都会点名它拒绝的租户、账户与运行（[一次谁也没点名的拒绝不算记录](../../implemented/architecture/2026-09-03-a-denial-names-who.zh.md)）—— 被重放的 nonce 是准入能观察到的最清晰的攻击信号，而它此前被报告出来时不带任何调用方可以记录的身份。这个面依然只有保险库的操作那么宽 —— 路由、委派、工具授权、用量与最终状态需要本次发布尚未构建的调度与编排 —— 并且不持久化这些记录；按租户分区的存储仍归调用方。

### R4 — Harness Web and account configuration

- [x] 增加提供方账户列表、创建、验证、默认选择、撤销和删除 API，并执行所有权检查（[`dsh-provider-accounts`](../../implemented/architecture/2026-09-03-provider-account-management.zh.md)）；Web controller 与各提供方验证探测仍未构建。
- [ ] 扩展现有 Harness Web 设置以管理 DeepSeek API 密钥以及服务器端 Claude CLI 和 Codex CLI 登录状态；在桌面和手机视口尺寸下验证相同路由。
- [ ] 复用 Harness 主题和品牌 slot 插件；移除 Candy 专用调色板、主题选择器、重复布局或独立手机界面。
- [ ] 提供安全诊断，但不返回 token、凭据路径、原始环境值或其他租户的元数据。

### R5 — Windows Harness Host tenant binding

- [ ] 把每个 Windows Harness Host 注册到一个用户和设备，并将其现有 Remote 能力绑定到短期 Candy 断言。Remote 这一层是存在的（`dsh-api-gateway` 承载类型化调用，`dsh-api-remotes` 决定暴露什么），但*被注册的宿主*并不存在：`host/` 是本机 web GUI 的那一半 —— HTTP 服务器、SPA 服务器、目录选择器、插件清单 —— 没有「一台由 server URL 寻址的机器」这个概念；而 harness 唯一的身份是 `dsh-anonymous-user-id`，一个按安装生成、且刻意不标识用户的 UUID。因此这一条要先把远程宿主这个概念建出来，才谈得上把任何东西绑上去；而它需要 R1 的控制平面作为服务运行，而不是本次发布交付的那些库。
- [ ] 在显式工作区根目录和操作类别授权之后，复用 `fs-local`、目录选择、PowerShell、Windows ACL 沙箱和 API Gateway 插件。这五个都已存在：[`dsh-fs-local`](../../../../packages/fs/fs-local)、带原生/浏览/自适应三种后端的 [`dsh-directory-picker`](../../../../packages/host/directory-picker)、连同其沙箱与持久化工具的 [`dsh-pwsh-local`](../../../../packages/shell/pwsh-local)、[`dsh-sandbox-windows-acl`](../../../../packages/sandbox/sandbox-windows-acl)，以及 [`dsh-api-gateway`](../../../../packages/api/gateway)。ACL 沙箱是其中最难的一块，而它已经是真实实现：受限令牌把写入限制在工作区与一个私有 temp 目录内，每个 Win32 调用都被检查，因此子进程绝不会以不受限的方式启动；它报告 `partial`，因为该令牌必须保留 Everyone 才能完成初始化，而 NTFS 硬链接会让一个文件对象跨路径别名。没有 Git 插件可供复用：仓库里只有 `dsh-webhook-github`，一个无关的 webhook 入口，因此 git 与其他命令一样，经由 bash 与 pwsh 工具抵达工作区。
- [ ] 增加服务器 URL、配对、连接状态、撤销、离线检测、重连、幂等、输出限制和批准状态，但不定义第二套文件操作协议。
- [ ] 在 Windows 上测试租户路由、Unicode 与长路径、分支发现、并发编辑、设备撤销、重连、junction 或符号链接逃逸和恶意路径输入。

### R6 — Migration and release

- [ ] 增加从 ClauGod 概念到 Candy 的配置和元数据迁移，但不导入 Claude SDK 凭据或会话。
- [ ] 为每个提供方、多租户、多账户、子 agent、Windows 工作区和重连回放运行端到端场景。
- [ ] 在功能开关后发布，并配置按提供方 canary 测试、资源仪表盘、安全告警、备份和经过验证的回滚流程。
- [ ] 仅在迁移验证后移除过时的 Claude SDK 路径，并发布运维和用户恢复指南。

## Alternatives considered

**继续构建自定义 agent loop。** 这种方案保留完整控制权，但会重复建设 Harness 的插件、会话、工具和事件基础。团队需要先花更多时间重建基础设施，之后才能改进租户隔离和提供方支持。

**使用 Claude Agent SDK 作为服务器运行时。** 这种方案让 Claude 成为架构中心，并削弱与 Codex CLI 和 DeepSeek 的对等性。它也与把 Claude 和 Codex 标准化为 CLI 子进程提供方的要求冲突。

**在用户之间共享一个已登录的 CLI 主目录。** 这种方案可以减少登录操作，但会使凭据归属、撤销、审计和数据隔离不可靠。Candy 允许共享不可变安装，但不允许共享已认证状态。

**构建独立手机客户端和 Candy 配色系统。** 这种方案会重复 Harness 的响应式 Web 界面与主题注册表，增加视觉偏移，并形成两条客户端发布路径。Candy 改为组合现有 Web、主题和品牌 slot 插件。

## Acceptance criteria

1. 两个并发租户可以使用相同的提供方和仓库名称，但不共享凭据、可写主目录、进程、会话事件、工作区授权或包含私有内容的缓存。
2. Claude CLI、Codex CLI 和 DeepSeek API 通过同一套生命周期约定测试，包括取消和提供方失败。
3. 子 agent 不能超过父运行的账户、工作区、工具、token、时间或并发授权。
4. 已撤销的账户、设备或工作区授权立即阻止新任务，并防止未经授权的回放或重连。
5. Windows 操作无法逃出显式授权的规范工作区根目录，并且可以归因于一个用户、设备、会话和运行。
6. 桌面与手机浏览器使用相同的响应式 Harness Web 路由，可以重连并回放获授权的会话状态，而不能直接访问提供方凭据。
7. 运维人员可以检测、遏制和审计跨租户尝试、遗留进程、配额违规和提供方故障，而无需读取用户秘密。

## Risks

CLI 输出和身份验证格式可能在没有稳定机器约定的情况下变化。适配器需要版本探测、严格解析器、兼容性 fixture 和快速失败行为。

如果所有 worker 共享一个操作系统身份，子进程隔离会弱于完整的主机边界。经过测量和威胁评审后，生产部署可能需要按租户分配操作系统用户或采用更强沙箱。

Windows RPC 把攻击面扩展到本地文件和命令执行。窄范围授权、敏感类别的本地确认、规范路径检查、签名消息和撤销都是发布阻塞条件。

控制平面与 Candy 的身份或授权语义可能发生偏移。带版本的断言 schema、兼容窗口、约定测试和协调发布必须使两侧保持一致。
