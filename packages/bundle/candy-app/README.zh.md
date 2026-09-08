---
description: "在 dsh 浏览器界面之上的 Candy 多租户部署层：控制面、按租户计费的调度器、登录、服务商账户与账户页，全部由环境变量配置。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-candy-app

[English](README.md) | 中文

## 概述

这一层把单用户的 dsh 浏览器界面变成一个 Candy 部署。它加入持久控制面、为每个租户准入并出资运行的调度器、OIDC 登录、六个服务商账户操作，以及管理它们的设置页——而它们背后的那个界面丝毫未变，那是 `dsh-web-app` 的。

每一个在不同安装之间不同的值都从环境读取，而不是写在这里。一个必需变量若未设置就解析为 `undefined`，读取它的那一行在加载时拒绝，因此配置错误的部署是启动失败，而不是带着一半配置启动。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `dsh-web-app` 之后应用这一层，并给进程下面这套环境。部署随即在同一个来源上回答登录、账户 API 和浏览器界面。

### 部署需要提供的环境

以下每一项都是必需的；缺任何一项，Candy 进程都拒绝启动。

| 变量 | 含义 |
| --- | --- |
| `CANDY_PUBLIC_ORIGIN` | 浏览器访问本部署的确切外部来源，含协议与主机名。`Host` 指向其他名字的请求会被拒绝。 |
| `CANDY_DATABASE_PATH` | 存放控制面的 SQLite 文件。其目录必须仅对服务用户可写。 |
| `CANDY_RUNTIME_POOL_BASE` | 每个租户运行时池根目录的创建位置；由部署方预先准备。 |
| `CANDY_CONTROL_PLANE_ISSUER` | 本运行时接受其执行断言的那个控制面。 |
| `CANDY_RUNTIME_AUDIENCE` | 本运行时自己的标识。部署若运行多个运行时，必须各给一个，否则一个会接受另一个的断言。 |
| `CANDY_CREDENTIAL_KEY` | 封存服务商凭据所用的密钥。**正好是该变量文本自身的 32 字节**——32 个字符，而不是某种编码下的 32 字节数据。 |
| `CANDY_CREDENTIAL_KEY_VERSION` | 该密钥登记在密钥环中的版本。每个已封存的信封都记着自己被封存时的版本。 |
| `CANDY_ASSERTION_SECRET` | 签发与校验执行断言所用的 HMAC 密钥；至少 32 字节文本。 |
| `CANDY_OIDC_ISSUER` | 身份提供方的 issuer 标识，与其公布的完全一致。 |
| `CANDY_OIDC_AUTHORIZATION_ENDPOINT` | 浏览器被送去登录的地址。 |
| `CANDY_OIDC_TOKEN_ENDPOINT` | 回调用授权码换取令牌的地址。 |
| `CANDY_OIDC_USERINFO_ENDPOINT` | 确认已验证 subject 的地址。 |
| `CANDY_OIDC_CLIENT_ID` | 本部署注册的客户端标识。 |
| `CANDY_OIDC_JWKS_PATH` | 存放校验 ID Token 所用 JSON Web Key Set 的文件。用路径而非内联密钥，是为了让轮换信任锚点成为对一个文件的一次运维操作。 |

以下是可选的：

| 变量 | 含义 |
| --- | --- |
| `CANDY_OIDC_CLIENT_SECRET_ENV` | 存放 OIDC 客户端密钥的那个变量的名字。仅用 PKCE 鉴别的公开客户端可以不填。 |
| `CANDY_BOOTSTRAP_ADMIN_SUBJECT` | 加载时录入的管理员在提供方处的确切 subject 声明。 |
| `CANDY_BOOTSTRAP_ADMIN_USER_ID` | 该 subject 登录后对应的 Candy 用户。 |

引导这一对要么都给要么都不给，而且只用于首次安装。一旦管理员已存在并录入了其他所有人，两者都不设置就是稳态，目录保持原样。

### 轮换凭据密钥

`CANDY_CREDENTIAL_KEY` 与 `CANDY_CREDENTIAL_KEY_VERSION` 一起更改，并在旧版本封存的信封还在时保持旧密钥可达。没有退役密钥，运行时打不开它们，每个租户都会被锁在自己配置的账户之外，直到旧值被放回。保留退役版本，正是让轮换成为迁移而不是故障的原因。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

### 为什么只为一个 domain 插入 SQLite

继承的 base 把存储路由到 JSON 后端，它没有 compare/exchange，读取也来自打开时载入的快照。控制面两样都需要相反的行为：把一个断言 nonce 恰好花掉一次，是一次必须在键已存在时失败的写；而第二个 Candy 进程必须看见第一个进程写下的内容。这一层插入 SQLite，只把 `candy_control_plane` 路由过去，让继承的会话 domain 保留为它们调优过的后端。

### 为什么账户 API 与调度器共用一个密钥版本

API 封存凭据，运行时打开它。用运行时打不开的版本封存的凭据，是一个租户配置了却没有任何运行能使用的账户，而两者之间没有任何东西会报告这件事。一个变量同时喂给两行。

### 为什么这一层不带任何字面量

写死了来源、issuer 或数据库路径的 bundle，是一个必须先编辑才能运行的 bundle，而被编辑过的 bundle 就不再是被测试过的那个产物。读取环境使发布的层在每次安装中保持一致，也使部署的密钥不落入一个因其他原因而被读取的文件。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-web-app`](../web-app/README.zh.md) —— 这一层所应用其上的浏览器界面。
- [`dsh-control-plane-store`](../../control-plane/control-plane-store/README.zh.md) —— 这里每一行读取的持久记录。
- [`dsh-run-scheduler`](../../control-plane/run-scheduler/README.zh.md) —— 准入、出资并结算一次运行的组件。
- [`dsh-oauth-sign-in-web`](../../control-plane/oauth-sign-in-web/README.zh.md) —— 登录路由与管理员引导。
- [`dsh-provider-account-api`](../../control-plane/provider-account-api/README.zh.md) —— 页面驱动的六个账户操作。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，取决于本层所组合的各个包；每个包各自记录自己的提示词、schema、工具与结果影响。

#### KV 缓存影响

无；本层从不组装或发送服务商请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

以下是当前组合的约束，不是任务待办清单。

- **audience 假定一个部署只有一个运行时** —— `CANDY_RUNTIME_AUDIENCE` 在这一层是单个值。让多个运行时共用一个控制面，意味着各给一层或各给一个值；这里没有任何东西阻止两个进程共用一个。
- **浏览器认证从 SQLite 读取当前会话** —— 退出登录写入介质后，已经运行的另一个进程会在下一次请求时拒绝该会话。灰度仍须使用独立数据库，因为 schema 兼容性与运行时 audience 仍是部署边界，而不再是会话撤销的临时补救。
- **没有服务商凭据检查被组合进来** —— `dsh-provider-credential-checks` 只作为注册表挂载，没有任何东西注册进去，因此 `validate` 回答的是没有服务商可问。
- **无法从这里配置退役凭据密钥** —— 调度器和账户 API 都接受退役版本，但需要保留退役密钥的轮换要靠再加一个补丁层；单个变量表达不了一个列表。
- **运行时池根目录本身的权限属于部署方** —— 每个池根被创建为私有，但它们被创建其下的那个目录是在这一层之外准备的。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布伴生模块。本层是一个补丁文件加一个惰性入口模块；它不注册任何东西，也不拥有可检查的关系。每个被组合的包各自发布自己的不变量。
