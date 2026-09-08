# Agent Note: OIDC 身份止于两个相同的 subject

Status: implemented

[English](2026-09-08-oidc-userinfo-provider.md) | 中文

## Problem

OAuth 编排刻意接受提供商接口而不猜测 issuer，但此前没有实现能把真实 authorization code 变成已验证身份。一个只信任 token endpoint 或只信任 UserInfo 的最小适配器，会让新路由看起来可用，却仍把身份边界留作假设。

## Decision

`createOidcUserInfoProvider` 针对固定 HTTPS endpoint 和部署提供的 JWK 实现 Authorization Code + PKCE。它先验证 ID Token 的非对称签名、issuer、audience、过期时间、签发时间、nonce 与 authorized party，再调用 UserInfo。UserInfo subject 必须与已验证 ID Token subject 完全相同；可选的 UserInfo issuer 必须与配置 issuer 相同。只有这一对结果会成为 `OAuthIdentity`。

Token 与 UserInfo 调用禁止重定向，施加独立期限与字节上限，要求 JSON 对象，并且绝不把提供商响应体或凭据放进错误。机密客户端 secret 来自只在 exchange 期间调用的 loader，并使用 OAuth HTTP Basic 编码发送；公开 PKCE 客户端在表单体中发送 client id。

受信任的 metadata 与 JWK 仍是部署输入。自动 discovery 与远程密钥刷新会给登录增加第二套网络信任和缓存生命周期；它们属于选择 issuer 与轮换策略的部署组合。

## Alternatives considered

**不验证 ID Token 就使用 UserInfo。** 被否决，因为 OpenID Connect 明确要求两个 subject 相同，以阻止 token substitution。

**接受密钥支持的所有 JOSE 算法。** 被否决，因为认证策略不能随库或 JWK 改动而扩大。适配器只接受已配置且属于其非对称白名单的成员。

**在每次登录时获取 discovery 与 JWK。** 被否决，因为提供商故障或 metadata 重定向会变成一次无界认证策略更新。适配器对于受信任部署输入是确定性的。

## Consequences

Candy 现在拥有一个不把产品身份绑定到单一厂商的具体标准提供商。密钥轮换要求重新加载新的已验证 JWK 集，随附 Web profile 仍需要 issuer 专属组合与初始登记。测试使用真实 ES256 签名，覆盖 nonce、audience、authorized-party、subject substitution、客户端认证、响应限制、仅 HTTPS endpoint 与重定向拒绝；真实 issuer canary 仍属于 R6 工作。
