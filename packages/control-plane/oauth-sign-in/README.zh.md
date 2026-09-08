---
description: "提供商无关的 OAuth PKCE 回调完成与 Candy 授权映射。"
kind: "package-library"
---

# @deepseek-ai/dsh-oauth-sign-in

[English](README.md) | 中文

## 概述

`dsh-oauth-sign-in` 消费一次持久 PKCE 事务，把 authorization code 交换和身份验证交给部署选定的提供商，通过 Candy 自有目录映射已验证的 issuer/subject，并创建可撤销用户会话。它还注册开始及完成登录所需的公开 Host 路由，通过仅限 host 的安全会话/CSRF cookie 读取和撤销会话，并且从不接受浏览器传来的用户或角色字段。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

为已配置 issuer 实现 `OAuthCodeProvider`，并为部署已登记用户实现 `OAuthIdentityDirectory`。把二者传给 `completeOAuthSignIn`；无效 state、issuer 不匹配、已验证 subject 为空或身份未登记时都不会返回会话。交换故障保持为故障，使 HTTP 所有者能够报告提供商不可用，而不会把它当成未认证回调。

对于浏览器表面，实现 `OAuthWebProvider.authorizationUrl`，并用真实 Host `WebServer`、`ControlPlaneStore` 和固定的 `publicOrigin` 调用 `registerOAuthHttpRoutes`。注册器拥有四条精确路径：`GET /auth/oauth/start`、`GET /auth/oauth/callback`、`GET /auth/session` 和 `POST /auth/logout`。它返回一个可一次移除全部四条注册的 disposer。

<a id="understand-the-implementation"></a>
## 理解实现

PKCE 事务在 code exchange 前消费。提供商只收到回调 code 与服务端保留的 verifier/redirect URI。它返回的 issuer 必须同时匹配其配置 issuer 和事务 issuer，之后目录才能看到该身份。只有目录能够返回 `UserId` 与 `ControlPlaneRole`。

`oauthSessionCookies` 把 bearer 写入带 `Secure`、`HttpOnly`、`Path=/` 和 `SameSite=Lax` 的 `__Host-candy-session`；独立且可读的 `__Host-candy-csrf` 使用 `Secure`、`Path=/` 和 `SameSite=Strict`。`authenticateOAuthHttpRequest` 只从有效 bearer 记录取得身份；除 GET、HEAD 和 OPTIONS 外，每种方法还必须同时通过 CSRF cookie、匹配的请求 header 与已存 CSRF 摘要。

路由注册器把每一个请求钉在配置的公网 authority 上，而不信任任意 `Host`。start 在持久存储中创建 state 与 S256 challenge，然后验证提供商的授权 URL 完整保留了精确 state、challenge、challenge method 和回调 URI。callback 在交换前消费 state，设置两枚 cookie，并且只重定向到配置的同源路径。session 响应只暴露 Candy 用户 id、角色和过期时间。logout 要求精确的公网 `Origin`、双提交 CSRF 证明以及服务端撤销。所有路径都会发送 no-store、no-referrer、no-sniff 和严格 CSP header；畸形输入与提供商失败只得到有界的通用响应。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-control-plane-store`](../control-plane-store/README.zh.md) 拥有 PKCE 事务和可撤销用户会话。
- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md) 规定浏览器与控制面的信任规则。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **没有提供商实现** —— 部署必须选择 OAuth issuer，并实现其发现、token exchange 和 identity token 验证。
- **没有部署组合** —— 本包已经提供全部四条路由注册，但在配置具体 `OAuthWebProvider` 与公网 origin 之前，随附的 Web profile 不会挂载它们。
- **不会自动登记** —— 未知外部身份会被拒绝。`dsh-control-plane-store` 提供持久的一次性登记与目录解析，但经过认证的预置接口仍未构建。

<a id="dev-note"></a>
## 开发备注

无。
