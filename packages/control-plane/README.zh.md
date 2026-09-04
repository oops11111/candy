---
description: "control-plane 包组映射：所有 Candy 租户感知包共用的品牌化 id 与运行谱系记录。"
kind: "package-group"
---

# packages/control-plane

[English](README.md) | 中文

## 概述

control-plane 组为每个未来的 Candy 租户感知包提供一套共享且互不可替换的词汇，命名控制平面唯一拥有权威的实体：`UserId`、`DeviceId`、`ProviderAccountId`、`WorkspaceGrantId`、`ConversationId`，以及记录某次运行父级的 `RunLineage`。`SessionId` 直接复用 [`dsh-session`](../core/session/README.zh.md) 中已有的定义，本组从不重新定义它。本组目前有九个包——一套身份词汇、携带它的按运行凭据、保管租户提供方密钥的保险库、拥有用户可见提供方账户元数据的账户管理器、委派树预算、结算被遗弃占用的实时运行账本、为运行时状态分区的池键、组合运行授权的准入调用，以及把被准入的运行变成受限 Claude CLI 启动的绑定——且没有正在运行的 Cordis 服务，因为 [已接受的运行时边界页面](../../docs/candy-runtime-boundaries.zh.md) 与 [提议的多租户运行时计划](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) 所描述的控制平面 OAuth、设备配对和持久账户存储尚未落地。本页是本组的映射；包 README 负责细节。

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
| [`credential-vault`](credential-vault/README.zh.md) | 封装租户的提供方账户密钥、轮换其密钥、吊销它,并记录每一次访问 |
| [`provider-accounts`](provider-accounts/README.zh.md) | 拥有租户提供方账户元数据、加密凭据生命周期、默认选择与不含密钥的账户视图 |
| [`run-budget`](run-budget/README.zh.md) | 通过让每个子运行的额度从父运行那里扣除，为委派树的 token、时间、金额与并发设界 |
| [`run-ledger`](run-ledger/README.zh.md) | 记录每次开启中的运行持有什么、花掉了什么，并精确而非估算地结算被遗弃的占用 |
| [`run-replay`](run-replay/README.zh.md) | 以一个不可分割的步骤把断言的 nonce 记为已消费，并恰好在该断言仍可被准入期间保留它 |
| [`run-start`](run-start/README.zh.md) | 按既定顺序准入、拨款并放置一次运行，并在放置被拒时把父运行的占用还回去 |
| [`control-plane-store`](control-plane-store/README.zh.md) | 持久保存提供方账户与租户额度，回答准入所要求的凭据与预算查找 |
| [`runtime-pool`](runtime-pool/README.zh.md) | 推导隔离键,以及租户的提供方运行时所拥有的那一个目录 |
| [`run-admission`](run-admission/README.zh.md) | 唯一的调度调用:断言、nonce、凭据与池一并解析 |
| [`claude-cli-binding`](claude-cli-binding/README.zh.md) | 把一次被准入的运行变成将其限制在该租户之内的 Claude CLI 启动事实 |

<a id="related-documentation"></a>
## 相关文档

- [Candy 控制平面](../../docs/subsystems/candy-control-plane.zh.md)——这些包如何组合成一次运行、部署方必须提供什么，以及为什么这个顺序就是契约。
- [Candy 运行时边界](../../docs/candy-runtime-boundaries.zh.md)——本组 id 所要命名的、已接受的信任边界与滥用场景。
- [多租户 CLI 代理运行时](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)——本组首个包所开启的提议交付计划（R1）。
- [core session 子系统](../core/README.zh.md)——`SessionId` 的拥有者；本组的 id 引用它但从不重新定义它。

<a id="dev-note"></a>
## 开发备注

无。
