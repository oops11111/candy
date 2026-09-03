---
title: 提供方账户
description: "Candy 的租户自有提供方账户记录，包含加密凭据、默认选择、验证、撤销与删除。"
kind: "package-library"
---

# 提供方账户

[English](README.md) | 中文

## 概述

`dsh-provider-accounts` 是 Candy 的控制面账户管理器。它保存提供方账户元数据，用 `dsh-credential-vault` 封装凭据，并只向调用方返回不含密钥的视图。

账户归 `userId` 所有。列表、默认选择、验证、撤销与删除都会在触碰凭据之前检查所有权。属于其他用户的账户 id 会表现为 `not-found`，因此 API 表面不能被用来枚举其他租户的元数据。

不发布运行时不变量伴生模块；本模块不拥有事件流或可变运行时数据，其所有权、默认选择与清理规则由单元测试保障。

## 目录

- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **这里还不是 Web controller** —— 本包暴露部署方 store 端口和纯账户操作。R4 仍需 Harness Web settings controller，把已认证请求映射到这些函数，并在桌面与移动视口上验证同一套路由。
- **验证由提供方实现** —— 本包会限制并清理验证结果，但 DeepSeek API、Claude CLI 与 Codex CLI 的探测仍需要各自的提供方实现。

<a id="dev-note"></a>
## 开发备注

- [提供方账户是带写入式凭据的租户记录](../../../.agents/notes/implemented/architecture/2026-09-03-provider-account-management.zh.md)
