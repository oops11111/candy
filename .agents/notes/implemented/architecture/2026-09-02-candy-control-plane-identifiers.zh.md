# Agent Note: Candy 控制平面标识符

Status: implemented

[English](2026-09-02-candy-control-plane-identifiers.md) | 中文

## Problem

[提议的多租户 CLI 代理运行时](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) 把 `userId`、`deviceId`、`accountId`、`workspaceGrantId`、`conversationId`、`sessionId` 与子运行谱系列为 Candy 控制平面唯一拥有权威的值——这一事实随后被 [Candy 运行时边界](../../../../docs/candy-runtime-boundaries.zh.md) 作为 R0 的一部分接受。仓库中此前没有任何地方把这些命名为类型:否则之后每一个控制平面包(租户/凭据模型、提供方适配器、编排授权检查、Web 账户 API,以及 Windows Harness Host 设备绑定)都会各自发明自己的 `string` 类型租户 id,或者从最先需要它的那个包里照抄一个。

## Decision

`@deepseek-ai/dsh-control-plane`(`packages/control-plane/control-plane`)在 `@deepseek-ai/dsh-brand` 之上为 `UserId`、`DeviceId`、`ProviderAccountId`、`WorkspaceGrantId` 与 `ConversationId` 打上品牌,采用与 `dsh-session` 的 `SessionId`、`dsh-workspace` 的 `WorkspaceId` 相同的"同名构造函数"模式。`SessionId` 没有被重新定义:它已经存在于 `dsh-session` 中,命名的是 Harness 会话日志,而控制平面只是按租户对其分区,并不完全拥有它。`ConversationId` 与 `SessionId` 保持区分,因为一个控制平面会话在其生命周期内可以拥有不止一个 Harness 会话(fork、resume)。

`RunLineage`(`{ runId: RunId, parentRunId: RunId | undefined }`)命名运行谱系。这里没有独立的 `ChildRunId`:边界页面把这项权威称为"子运行谱系",而不是第二个 id 空间,除了 `parentRunId` 之外没有任何东西能区分子运行与根运行的身份。`RunLineage` 只记录这条链——它并不执行准入子运行所需的父级子集授权检查(账户、工作区、工具、token、时间、并发),因为该检查需要的授权模型是 R1 后续条目与 R3 编排工作尚未构建的内容。

六个构造函数都不校验输入。目前还没有控制平面服务来定义它们可以校验的语法,现在发明一套只会是没有依据的猜测,而未来的签发方很可能不得不修改它。本包没有 Cordis 服务,也没有存储;它像 `dsh-brand` 一样被直接导入。

新的 `control-plane/` 包组携带一个 `GROUPS_WITHOUT_SUBSYSTEM_PAGE` 豁免(`scripts/verify-subsystem-pages.ts`),而不是一个 `docs/subsystems/` 页面:目前还没有正在运行的机制可以作为子系统来记录,而 `docs/candy-runtime-boundaries.md` 已经拥有已接受的架构。包 README 携带一个真实的 `## Known Limitations and Deferred Work` 小节——没有校验语法、没有凭据/授权/账户存储、没有运行时池键辅助函数(`userId + provider + accountId` 需要 R2 尚未定义的 `provider` 表示形式)、没有 Cordis 服务——并通过 `scripts/verify-package-readme-model-experience.ts` 中经审计的白名单省略了 `## Model Experience`,这与 `dsh-brand` 这个纯粹、与模型无关的 id 打品牌包的先例一致。

## Alternatives considered

**让未来每个控制平面包在首次需要某个租户 id 时各自打上品牌。** 这正是 `dsh-brand` 自己的 README 为那些只停留在单个包内的 id 推荐的模式。但在这里行不通,因为 `userId`、`deviceId`、`accountId` 从一开始就是跨包的:R1 的凭据保险库、R2 的提供方适配器(以 `userId + provider + accountId` 为键)、R3 的编排、R4 的 Web 账户 API、R5 的 Windows 设备绑定都引用同一批实体。让五个包各自独立地为 `UserId` 打品牌,只会把一个概念悄悄拆成五个互不兼容的类型。

**在 `RunId` 之外再加一个独立的 `ChildRunId` 品牌。** 予以拒绝,因为除了谱系链接之外,子运行的身份与根运行没有任何不同;第二个品牌只会重复 `RunId`,却不会增加任何真实约束,而且每个消费者都得在两个品牌之间做无意义的转换。

**现在就在 `RunLineage` 中建模完整的授权继承记录**(账户、工作区、工具、token、时间、并发)。推迟到 R3,由它拥有父级子集授权设计("Multi-agent orchestration",出自提议计划)。在这个设计存在之前就添加部分授权字段,要么会遗漏 R3 最终需要的字段,要么会发明一些将来不得不修改的占位字段。

**现在就写一份 `docs/subsystems/control-plane.md` 页面。** 与授权记录的理由相同,予以拒绝:目前还没有正在运行的机制,一份描述"没有服务支撑的类型"的子系统页面,会把边界页面已经接受的内容错误地呈现成新事物。

## Consequences

之后每个控制平面包都可以从同一个地方导入 `UserId`、`DeviceId`、`ProviderAccountId`、`WorkspaceGrantId`、`ConversationId`、`RunId` 与 `RunLineage`,而不必各自发明,TypeScript 也会拒绝把一种 id 传到期望另一种 id 的地方。本包保持无外部依赖(只依赖 `dsh-brand`),因此下游不会为尚未使用的基础设施付出代价。代价是它先于任何消费者落地:`dsh-control-plane` 能通过编译与测试,但在后续 R1 条目(租户/凭据模型)或 R2(提供方适配器)落地之前,还没有任何东西导入它。`GROUPS_WITHOUT_SUBSYSTEM_PAGE` 豁免与 id 构造函数缺失的校验,都已在包 README 中被点名为审阅触发点,因此下一个引入真实控制平面行为的 PR,应当要么把它们补全,要么扩展已记录的理由,而不是悄悄继续堆积没有依据的脚手架。
