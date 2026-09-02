---
description: "control-plane 包组映射：所有 Candy 租户感知包共用的品牌化 id 与运行谱系记录。"
kind: "package-group"
---

# packages/control-plane

[English](README.md) | 中文

## 概述

control-plane 组为每个未来的 Candy 租户感知包提供一套共享且互不可替换的词汇，命名控制平面唯一拥有权威的实体：`UserId`、`DeviceId`、`ProviderAccountId`、`WorkspaceGrantId`、`ConversationId`，以及记录某次运行父级的 `RunLineage`。`SessionId` 直接复用 [`dsh-session`](../core/session/README.zh.md) 中已有的定义，本组从不重新定义它。本组目前有两个包——一套身份词汇，以及携带它的按运行凭据——且没有正在运行的 Cordis 服务，因为 [已接受的运行时边界页面](../../docs/candy-runtime-boundaries.zh.md) 与 [提议的多租户运行时计划](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) 所描述的控制平面 OAuth、设备配对和加密凭据保险库尚未落地。本页是本组的映射；包 README 负责细节。

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

<a id="related-documentation"></a>
## 相关文档

- [Candy 运行时边界](../../docs/candy-runtime-boundaries.zh.md)——本组 id 所要命名的、已接受的信任边界与滥用场景。
- [多租户 CLI 代理运行时](../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)——本组首个包所开启的提议交付计划（R1）。
- [core session 子系统](../core/README.zh.md)——`SessionId` 的拥有者；本组的 id 引用它但从不重新定义它。

<a id="dev-note"></a>
## 开发备注

无。
