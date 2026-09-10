---
description: "每一条 Candy 管理路由都经由的已认证信封:身份只从会话 cookie 推导,写操作有防护,角色有守卫,而失败词汇永远不把别的租户的记录与一条不存在的记录区分开。"
kind: "package-library"
---

# @deepseek-ai/dsh-control-plane-api

[English](README.md) | 中文

## 概述

Candy 的管理操作决定谁拥有一个提供方账户、一个租户可以调用哪些路线、一台设备授予了哪个工作区。这些都不允许由调用方提供的任何东西来驱动。Harness Host 访问令牌授权的是一个进程,不是一个人;而路径或请求体里的 `userId` 是调用方自己的主张。

本模块是一次 HTTP 请求成为 [`Actor`](src/types.ts) 的唯一地方,而拿到一个 `Actor` 的唯一途径,是出示了一份 [`ControlPlaneStore`](../control-plane-store/README.zh.md) 认证过的会话 cookie。处理器拿到的是 actor 与已解析的请求体;它没有任何别的途径读出一个租户。

有一类调用方没有会话可以出示:兑换配对码的 Harness Host 此前还不是任何人,而它请求体中的配对码就是它声明的全部。`registerAnonymousRoute` 服务于这种情形,同时并不削弱上面那句话——这样的路由根本不会收到 `Actor`,因此持有 `Actor` 的唯一途径仍然是一份已认证的会话,而需要身份的处理器从它拿到的凭据中自行推导。

它同时拥有失败词汇,因为失败正是一个管理 API 泄露的地方。属于另一个租户的记录,回答得与一条不存在的记录一模一样;而一次拒绝只指名那一步,不带产生它的令牌、授权码、密钥或提供方响应。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 注册一条路由

```ts
import { registerApiRoute } from '@deepseek-ai/dsh-control-plane-api'
import type { ApiHost, ApiWebServer } from '@deepseek-ai/dsh-control-plane-api'

declare const server: ApiWebServer
declare const host: ApiHost
declare function accountsOf(userId: string): Promise<readonly { id: string }[]>

export const dispose = registerApiRoute(server, host, {
  path: '/api/candy/accounts',
  methods: ['GET'],
  role: 'member',
  action: 'accounts.list',
  handle: async actor => ({ kind: 'json', status: 200, body: await accountsOf(actor.userId) }),
})
```

`ApiHost` 携带每条路由共享的东西:精确的 `publicOrigin`、浏览器登录写下的那份会话权威、一个 `audit` 汇聚点,以及一个可选的 `log`。

### 作答

处理器返回 `json`、`empty`、`notFound`、`forbidden`、`invalid` 之一。它从不写响应,也从不为一次拒绝挑选状态码,因此每条路由都以同样的方式报告同样的事。

对于一条 actor 不该持有的记录,返回 `notFound`。它以 `404` 作答且不带细节 —— 与一个从未签发过的 id 无从分辨。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 角色 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 信封本身、它按次序做的那些检查,以及回复映射 |
| [`src/types.ts`](src/types.ts) | `Actor`、拒绝与结果词汇,以及审计事件 |
| — | 不发布运行时不变量伴生模块;本模块不拥有事件流或可变运行时数据,其拒绝由针对真实服务器的测试证明。 |

### 次序即契约

origin 最先被检查,因此一个不指向本部署的请求永远到不了会话查找。方法第二个被检查,因为一条不服务该方法的路由没有什么需要认证。会话第三个被推导 —— 它是身份的唯一来源 —— 而对写操作,CSRF 在同一步里被证明。角色第四个被检查,因此一个角色不足的已认证者被告知 `403` 而不是 `404`。请求体最后才被读取,有界,并且只对一个已经确立为可以发送它的调用方读取。

### 为什么写操作必须声明它的 origin

`Host` 在每一种方法上都被检查;`Origin` 在写操作上额外被检查。浏览器在跨站写操作上会发送 `Origin`,因此精确匹配正是把这个租户自己的页面,与一个仅仅知道该 URL 的页面分开的东西。一个完全不带 `Origin` 的写操作会被拒绝,而不是被假定为同站。

CSRF cookie 与请求头由 [`dsh-oauth-sign-in`](../oauth-sign-in/README.zh.md) 自己的检查证明,就在认证会话的那同一次调用里。会话缺失与 CSRF 证明失败作答一致:告诉调用方是这两者中的哪一个,等于报告了它手上的 cookie 是不是一个活着的会话。

### 为什么匿名路由核对 `Host` 而不核对 `Origin`

会话写入之所以要核对 `Origin`,是因为浏览器会自行附上会话 Cookie,而该头部把本部署自己的页面与仅仅知道 URL 的页面区分开。自带凭据的调用方没有 Cookie,通常也不是浏览器,因此要求该头部会拒绝每一个真实客户端。伪造这种请求的页面必须已经持有凭据,而且读不到回复。

这样的请求同样不会按租户归档:处理器只有在解析凭据之后才知道这是谁的请求,因此在知道该记到哪个租户名下之后,记录这次尝试是它自己的事。

### 为什么处理器失败时是作答而不是重新抛出

Harness Host Web 服务器会销毁那些在头部已发出之后其处理器被拒绝的响应。于是重新抛出会把本信封刚刚裁定的 `500` 换成调用方无法与崩溃区分的挂断。错误改为送往 `ApiHost.report`,这样部署仍然读得到失败是什么,而调用方仍然收得到答案。

### 为什么每一次回复都是 `no-store`

它们每一份都是一个租户的数据、在一次会话上作答的。一个共享缓存或一个被还原的前进后退页面,会把它交给下一个拿着这个浏览器的人。同一组头还否定了这份 JSON 被内嵌成框架、被嗅探成另一种类型、或把它的路径作为 referrer 泄露出去的能力。

### 为什么请求体上限是停止读取而不是关闭套接字

一个已认证端点上的超大请求体,要么是个失误,要么是想耗尽这个进程,因此读取在上限处停止。拒绝先被作答,未读的余量随后被丢弃:先销毁套接字会把一个 `413` 换成一次客户端无法与崩溃区分开的挂断。

-----

<a id="further-exploration"></a>
## 进一步探索

- [Candy Runtime Boundaries](../../../docs/candy-runtime-boundaries.zh.md) —— 为什么管理身份必须来自一个 OAuth 支撑的服务端会话。
- [`dsh-oauth-sign-in`](../oauth-sign-in/README.zh.md) —— 本信封所对照认证的会话与 CSRF 权威。
- [`dsh-oauth-sign-in-web`](../oauth-sign-in-web/README.zh.md) —— 挂载登录、并建立这些路由所读取之会话的那个插件。
- [一个无从指名租户的管理 API](../../../.agents/notes/implemented/architecture/2026-09-08-a-management-api-with-no-way-to-name-a-tenant.zh.md) —— 为什么 actor 没有任何调用方够得到的构造方式。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前的包约束,不是任务待办。

- **它自己没有任何路由** —— 这是信封。每一个路径、方法与处理器都来自挂载它的插件;在有插件注册东西之前,这里没有任何可达之处。
- **匿名路由的权限完全属于它的处理器** —— 本模块核对被寻址的主机、方法与请求体上限,然后把请求交出去。请求中的凭据是否证明了什么、拒绝的代价是什么,都是挂载它的插件所做的决定。
- **只有一条角色阶梯** —— `member` 与 `administrator`,其中管理员同时满足两者。没有按操作的授予,也没有办法只给某个人多一项能力。
- **没有限流** —— 一个已认证的调用方想调多频繁就多频繁。为它设界属于部署前面的反向代理。
- **审计汇聚点是一个参数** —— 本模块决定记录什么,挂载它的插件决定记到哪里。一个不提供汇聚点的部署什么也不记录。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>
