---
description: "把 Candy 的浏览器登录从部署自己的 OIDC 事实挂载到 Harness Host web 服务器上,并离线登记第一位管理员,使一个配置正确的部署不会把所有人都拒之门外。"
kind: "package-reference"
---

# @deepseek-ai/dsh-oauth-sign-in-web

[English](README.md) | 中文

## 概述

本插件所组合的一切,都已经作为库存在了。[`dsh-oauth-sign-in`](../oauth-sign-in/README.zh.md) 拥有 PKCE 回调、会话 cookie 与那四条浏览器路由;`createOidcUserInfoProvider` 拥有 ID Token 校验;[`dsh-control-plane-store`](../control-plane-store/README.zh.md) 拥有持久的尝试、会话与身份目录;[`dsh-host-webserver`](../../host/webserver/README.zh.md) 拥有那个套接字。不存在的是一次组合:它们每一个都只能从测试里够到,因此没有任何部署能让一个人登录进来。

它同时登记第一位管理员,因为身份目录是同一个问题的另一半。登录要通过目录把已验证的 issuer 与 subject 解析出来,而一个空目录谁也解析不出来 —— 一个配置正确的部署会拒绝每一个登录进来的人,包括那位本该去登记其余所有人的运维人员。通往第一个席位的自助路径是刻意不存在的:它是运维人员离线陈述的一项事实,以精确的 issuer 与 subject 表达。

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
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '0.0.0.0'
    port: 8787
- id: control-plane-store
  name: '@deepseek-ai/dsh-control-plane-store'
- id: oauth-sign-in-web
  name: '@deepseek-ai/dsh-oauth-sign-in-web'
  config:
    publicOrigin: 'https://candy.example'
    issuer: 'https://identity.example'
    authorizationEndpoint: 'https://identity.example/authorize'
    tokenEndpoint: 'https://identity.example/token'
    userInfoEndpoint: 'https://identity.example/userinfo'
    clientId: 'candy-debian'
    jwksPath: '/etc/candy/oidc-jwks.json'
    clientSecretEnv: 'CANDY_OIDC_CLIENT_SECRET'
```

它挂载的四条路由是 `dsh-oauth-sign-in` 的:`/auth/oauth/start`、`/auth/oauth/callback`、`/auth/session` 与 `/auth/logout`。每一条都被钉在 `publicOrigin` 那个精确的 authority 上。

### 登记第一位管理员

```yaml
    bootstrapAdministratorSubject: '8f1c2a54-0b7e-4f2d-9a31-6b0f2c7d4e58'
    bootstrapAdministratorUserId: 'user-alice'
```

要么两个键都写,要么一个都不写:只写一半会让加载失败,因为那会在"读起来像是登记过了"的同时谁也没登记。subject 用的是提供方的 `sub` 声明,而不是邮箱或姓名,因为后两者在多数提供方那里是可重新指派的,而一个可被重新指派的身份就是一个可被继承的管理员席位。

在重新部署时重复陈述同一项事实不改变任何东西。陈述另一个用户,或同一个用户但角色更低,会让加载失败,并在该租户的审计踪迹里记下一条 `refused` / `administrator-bootstrap` / `already-enrolled` —— 存储在冲突时什么都不写,因此踪迹是这次尝试唯一能留存下来的地方。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 角色 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 插件配置、JWKS 读取、管理员登记,以及客户端密钥加载器 |
| — | 不发布运行时不变量伴生模块;本插件不拥有事件流或可变运行时数据,其组合由一个真实的 Loader/Host 测试证明。 |

### 为什么密钥集是一个文件路径

JSON Web Key Set 是本部署校验每一份 ID Token 的信任锚,而系统不会为它发起任何发现请求:一个能给服务器递上新签名密钥的端点,也能递上伪造的。用路径可以把一大团密钥挡在一个因别的原因而被阅读的配置文件之外,也让轮换变成对一个文件的运维动作。

**轮换。**把新密钥与旧密钥并排放进该文件 —— 一个密钥集可以持有多把,由 `kid` 选择 —— 重新加载插件,并在提供方停止用旧密钥签名之后把它移除。重新加载该条目会重新读取文件,因此不牵涉重启。一个读不出来、不是 JSON、或者一把密钥都没有的文件会让加载失败,而不是挂载一个什么都不校验的登录。

### 为什么客户端密钥按每次交换读取

凭据缝隙自己的规则是:消费方在每一次操作时重新解析,且绝不跨操作缓存;正是这一点让一次被轮换过的密钥无需重启就能抵达下一次登录。`clientSecretLoader` 在部署组合了凭据服务时读取它,在没有组合时读取进程环境,并且宁可大声失败也不拿一个空密钥去交换授权码。这个值从不被记入日志,也从不离开那次令牌请求。

### 为什么登记不是一条路由

一个通过 HTTP 建立起来的管理员席位,就是一个先到者可以认领的席位。这一个是运维人员写在服务器上的配置,对着本部署本就信任的那个精确 issuer 校验,并在任何路由被挂载之前就已生效。

-----

<a id="further-exploration"></a>
## 进一步探索

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.zh.md) —— 为什么管理身份必须来自一个 OAuth 支撑的服务端会话,而不是一个 Host 令牌。
- [`dsh-oauth-sign-in`](../oauth-sign-in/README.zh.md) —— 本插件所挂载的路由、cookie 与回调。
- [`dsh-control-plane-store`](../control-plane-store/README.zh.md) —— 它们背后持久的尝试、会话与身份目录。
- [没有任何部署够得到的登录](../../../.agents/notes/implemented/architecture/2026-09-08-sign-in-that-no-deployment-could-reach.zh.md) —— 为什么这次组合与第一个席位是同一个插件。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前的包约束,不是任务待办。

- **没有 OIDC 发现** —— 每一个端点与密钥集都是配置出来的。提供方挪动了端点或轮换了密钥,需要按上面的轮换说明更新文件与配置。
- **每个部署一个提供方** —— 只配置一个 issuer,因此一个要联合两家身份提供方的部署无从陈述第二家。
- **登记只做引导** —— 本插件从配置创建一个席位。登记其他任何人、改变角色、移除身份都还没有界面;那些属于已认证的管理 API。
- **这里不撤销任何会话** —— 存储可以撤销一个,登出路由也在用它,但没有任何运维界面够得到它。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>
