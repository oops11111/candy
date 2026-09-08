---
description: "挂载在已认证的 Candy 管理信封上的六个提供方账户操作:租户是会话的那一个,凭据只进不出,而别的租户的账户回答得与一个不存在的账户一样。"
kind: "package-reference"
---

# @deepseek-ai/dsh-provider-account-api

[English](README.md) | 中文

## 概述

这里没有任何领域逻辑。[`dsh-provider-accounts`](../provider-accounts/README.zh.md) 早已能创建、列出、为其选定默认、验证、吊销与删除一个账户,而它的每一个操作都接收租户,并拒绝那个租户并不拥有的 id。

本插件补上的是传输层:哪个路径、哪种方法、哪个最低角色、一次领域拒绝如何成为一个状态码,以及 —— 这一层的要点 —— 那些操作收到的租户,是 [`dsh-control-plane-api`](../control-plane-api/README.zh.md) 从会话推导出来的那一个,而绝不是请求携带的那一个。

凭据只进不出。存储持有的是一个密封信封,`ProviderAccountView` 没有承载密钥的字段,而这里的每一次回复都由那个视图构建。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 组合它

```yaml
- id: provider-credential-checks
  name: '@deepseek-ai/dsh-provider-credential-checks'
- id: provider-account-api
  name: '@deepseek-ai/dsh-provider-account-api'
  config:
    publicOrigin: 'https://candy.example'
    credentialKeyVersion: '2026-09-a'
    credentialKeyEnv: 'CANDY_CREDENTIAL_KEY'
```

`credentialKeyVersion` 与它背后那把密钥,必须与 [`dsh-run-scheduler`](../run-scheduler/README.zh.md) 用来打开的是同一套,否则在这里密封的凭据,那个必须使用它的运行时打不开。两者都经由同一个 `assembleKeyring` 组装自己的密钥环。

### 那些操作

| 路径 | 方法 | 效果 |
| --- | --- | --- |
| `/api/candy/provider-accounts` | `GET` | 这个租户拥有的每一个账户 |
| `/api/candy/provider-accounts/create` | `POST` | 创建一个并密封其凭据 |
| `/api/candy/provider-accounts/validate` | `POST` | 询问提供方,已存储的凭据是否仍然有效 |
| `/api/candy/provider-accounts/default` | `POST` | 把某一个设为该提供方的默认 |
| `/api/candy/provider-accounts/revoke` | `POST` | 吊销其凭据,记录仍可读 |
| `/api/candy/provider-accounts/delete` | `POST` | 删除它,并让它的 id 保持被占用 |

除列表外的每一个操作都接收 `{ "id": "…" }`。创建接收 `{ "provider", "label", "secret", "isDefault"? }`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 角色 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 插件配置、请求检查、六条路由,以及审计接线 |
| [`src/types.ts`](src/types.ts) | 路由路径与请求形状 |
| — | 不发布运行时不变量伴生模块;本插件不拥有事件流或可变运行时数据,其行为由一个带两个租户的真实 Loader/Host 测试证明。 |

### 为什么账户 id 在这里铸造

一个由调用方挑选的 id 可能与另一个租户的相撞,而领域会以 `account-already-exists` 拒绝一次相撞 —— 那就报告了另一个租户的账户存在。铸造消除了这个问题。

### 为什么请求里的 id 选不了租户

它与会话的 `UserId` 一起抵达 `dsh-provider-accounts`,而那个操作对该租户并不拥有的 id 回答 `not-found` —— 与一个从未签发过的 id 得到的答案相同。信封把 `not-found` 映射为不带细节的 `404`,因此调用方无法靠两者之差确认一个 id。

### 这一层验证什么,又转发什么

提供方必须是 Candy 支持的那三个之一,密钥必须是不超过 [`MAX_SECRET_LENGTH`](src/index.ts) 的非空字符串,而 `isDefault` 若存在则必须是布尔。这些是传输层的事实:密钥会抵达一次密封操作,而没有别的东西会为它设界。

标签的规则属于 `dsh-provider-accounts`,这里是转发而不是重复 —— 这一层只确立它是一个字符串。重复那条规则,就是两个地方要改而只会记得改一个。

### 为什么审计连成功也记录

一个在排查某个被吊销账户的运维人员,需要看到是谁吊销的,而不只是那些失败的尝试。保险库自己的密封与打开记录,与 API 的记录一起抵达同一条租户踪迹。两次写入都不能让它们所描述的操作失败:踪迹是"发生过什么"的记录,不是它的前置条件。

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-control-plane-api`](../control-plane-api/README.zh.md) —— 推导租户并拥有失败词汇的那个信封。
- [`dsh-provider-accounts`](../provider-accounts/README.zh.md) —— 那六个领域操作,以及 `not-found` 背后的归属规则。
- [`dsh-provider-credential-checks`](../provider-credential-checks/README.zh.md) —— 提供方集成回答一份凭据是否可用的地方。
- [六个早已存在的操作](../../../.agents/notes/implemented/architecture/2026-09-08-six-operations-that-already-existed.zh.md) —— 这一层补上了什么,又刻意没有补什么。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前的包约束,不是任务待办。

- **在有集成组合进来之前,验证一律回答 `unsupported-provider`** —— 还没有任何东西注册凭据检查,因此 `validate` 作为一条路由是成功的,而它回答的是没有提供方可问。
- **没有管理员视图** —— 每一个操作作用于发起者自己的账户。管理员管理另一个租户的账户,在这里没有任何界面。
- **没有密钥轮换界面** —— `assembleKeyring` 保留旧版本以便已密封的凭据仍能打开,但把每一个信封重新包装到当前密钥上,并未暴露出来。
- **没有分页** —— 一个租户的账户整份作答。数量由运维人员配置多少来界定,而不是由本 API。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>
