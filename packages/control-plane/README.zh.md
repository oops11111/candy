---
description: "control-plane 包组映射：所有 Candy 租户感知包共用的品牌化 id 与运行谱系记录。"
kind: "package-group"
---

# packages/control-plane

[English](README.md) | 中文

## 概述

control-plane 组提供共享且互不可替换的身份，以及使用这些身份的 Candy 自有授权、持久化、预算、路由和提供方启动组件。`SessionId` 直接复用 [`dsh-session`](../core/session/README.zh.md) 中已有的定义。包表是当前映射；[Candy 运行时边界](../../docs/candy-runtime-boundaries.zh.md) 规定安全职责划分，[多租户运行时计划](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) 记录尚未完成的交付工作。

上面的调度器描述沿用了最初的所有权简称。重放决定现在持久存在 `ControlPlaneStore` 中；调度器只拥有实时账本，并组合该持久 nonce 端口。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`control-plane`](control-plane/README.zh.md) | 品牌化的 `UserId`、`DeviceId`、`ProviderAccountId`、`WorkspaceGrantId`、`ConversationId`、`RunId`，以及 `RunLineage` 谱系记录 |
| [`execution-assertion`](execution-assertion/README.zh.md) | 签发并准入授权一次运行的带签名、短时效断言 |
| [`oauth-sign-in`](oauth-sign-in/README.zh.md) | 完成 PKCE 回调并把已验证身份映射为 Candy 授权 |
| [`control-plane-api`](control-plane-api/README.zh.md) | 每一条管理路由都经由的已认证信封:从会话推导身份、写操作防护、角色守卫,以及统一的失败作答 |
| [`oauth-sign-in-web`](oauth-sign-in-web/README.zh.md) | 把浏览器登录路由挂载到 Harness Host web 服务器上,并从配置登记第一位管理员 |
| [`credential-vault`](credential-vault/README.zh.md) | 封装租户的提供方账户密钥、轮换其密钥、吊销它,并记录每一次访问 |
| [`provider-accounts`](provider-accounts/README.zh.md) | 拥有租户提供方账户元数据、加密凭据生命周期、默认选择与不含密钥的账户视图 |
| [`run-budget`](run-budget/README.zh.md) | 通过让每个子运行的额度从父运行那里扣除，为委派树的 token、时间、金额与并发设界 |
| [`workspace-grant`](workspace-grant/README.zh.md) | 把断言所指名的工作区授权 id 解析成一次运行所持有的根目录与文件效应上限,并拒绝指名了任何其他授权的子代 |
| [`workspace-grant-execution`](workspace-grant-execution/README.zh.md) | 在继承的文件系统与 shell 执行器处重新校验持久授权，包括规范链接包含关系与撤销状态 |
| [`provider-credential-checks`](provider-credential-checks/README.zh.md) | 提供方集成用来说出一份已存储凭据是否仍然有效的注册表 |
| [`provider-account-api`](provider-account-api/README.zh.md) | 挂载在已认证管理信封上的六个提供方账户操作 |
| [`run-ledger`](run-ledger/README.zh.md) | 记录每次开启中的运行持有什么、花掉了什么，并精确而非估算地结算被遗弃的占用 |
| [`run-replay`](run-replay/README.zh.md) | 以一个不可分割的步骤把断言的 nonce 记为已消费，并恰好在该断言仍可被准入期间保留它 |
| [`tenant-allowance`](tenant-allowance/README.zh.md) | 把租户的授予额度与其已结算运行的消耗并排持有，使一份授予额度只为一个租户拨款，而不是为它启动的每一次运行拨款 |
| [`run-metering`](run-metering/README.zh.md) | 把一次提供方流按一次开启中的运行来计量，拒绝它负担不起的调用，并切断跑过其挂钟时间的调用 |
| [`run-start`](run-start/README.zh.md) | 按既定顺序准入、拨款并放置一次运行，并在放置被拒时把父运行的占用还回去 |
| [`control-plane-store`](control-plane-store/README.zh.md) | 持久保存提供方账户与租户额度，回答准入所要求的凭据与预算查找 |
| [`run-scheduler`](run-scheduler/README.zh.md) | 拥有一个运行时的账本与重放存储，从断言启动一次运行，并驱动释放被遗弃占用的那个时钟 |
| [`runtime-pool`](runtime-pool/README.zh.md) | 推导隔离键,以及租户的提供方运行时所拥有的那一个目录 |
| [`run-admission`](run-admission/README.zh.md) | 唯一的调度调用:断言、nonce、凭据与池一并解析 |
| [`claude-cli-binding`](claude-cli-binding/README.zh.md) | 把一次被准入的运行变成将其限制在该租户之内的 Claude CLI 启动事实 |
| [`claude-cli-route`](claude-cli-route/README.zh.md) | 一条按调用重新解析、指向驱动该请求所属会话之运行的 Claude CLI `dsh-llm` 路由,处置与该运行的结算绑定在一起 |
| [`tenant-preset-policy`](tenant-preset-policy/README.zh.md) | 把一个租户限制在一份原本共享的 `dsh-agent-presets` 名册的一个已配置子集内 |
| [`tenant-route-policy`](tenant-route-policy/README.zh.md) | 在适配器准备与最终分发前强制执行精确的按租户 provider/model 白名单 |
| [`run-delegation`](run-delegation/README.zh.md) | 在一个子代理受委派的进程内子会话存在之前，为其开启一次有资金的 Candy 运行，并在父运行无力资助时拒绝这次委派 |

<a id="related-documentation"></a>
## 相关文档

- [Candy 控制平面](../../docs/subsystems/candy-control-plane.zh.md)——这些包如何组合成一次运行、部署方必须提供什么，以及为什么这个顺序就是契约。
- [Candy 运行时边界](../../docs/candy-runtime-boundaries.zh.md)——本组 id 所要命名的、已接受的信任边界与滥用场景。
- [多租户 CLI 代理运行时](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)——本组首个包所开启的提议交付计划（R1）。
- [core session 子系统](../core/README.zh.md)——`SessionId` 的拥有者；本组的 id 引用它但从不重新定义它。

<a id="dev-note"></a>
## 开发备注

无。
