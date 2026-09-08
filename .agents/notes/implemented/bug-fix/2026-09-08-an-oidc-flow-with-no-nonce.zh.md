# Agent Note: 一个没有 nonce 的 OIDC 流程

Status: implemented

[English](2026-09-08-an-oidc-flow-with-no-nonce.md) | 中文

## Problem

Candy 的持久 OAuth 事务把回调绑定到 state、PKCE verifier、issuer 与 redirect URI，却没有携带 OIDC nonce。因此，一个提供商适配器可能验证 ID Token 的签名与 audience，却无法证明该 token 属于 Candy 刚刚启动的那次浏览器授权。只调用 UserInfo 也不能修补这个缺口：OpenID Connect 要求其 subject 与已验证 ID Token 的 subject 一致，以阻止 token substitution。

## Decision

`ControlPlaneStore.beginOAuthAttempt` 现在会在 state 和 PKCE verifier 旁边创建一个独立的 256 位 nonce。nonce 被持久化、能跨重启保留、出现在授权 URL 中，并且只在匹配的 state 被原子消费后返回。`completeOAuthSignIn` 把它直接交给部署验证器；回调输入永远不能提供它。

存储字段仅为介质兼容而设为 optional。消费一条没有 nonce 的旧记录会将它移除并且不返回任何内容，因此变更前事务会失败关闭。控制面存储域保持版本 8，不会为了一个最长只存活几分钟的记录而丢弃无关的账户、授权、运行与审计数据。

## Alternatives considered

**没有 ID Token 就信任 UserInfo。** 被否决，因为 bearer token substitution 可能返回不同 subject，除非它与已验证 ID Token 比对。

**把 state 当作 nonce。** 被否决，因为两者保护不同的协议边界；独立随机值避免一次泄露同时失去两份证明。

**提升整个控制面存储域版本。** 被否决，因为这会为了移除短期事务而使长期租户数据失效；失败关闭的 optional 解码提供同样的认证安全性，却没有这种损失。

## Consequences

具体 OIDC 适配器现在可以验证 issuer、audience、签名、过期时间、nonce，以及 UserInfo/ID Token subject 一致性。变更前创建且仍在途的尝试必须重新开始登录。SQLite 重启覆盖和 OAuth 路由测试证明了 nonce 持久化、授权 URL 绑定以及只向提供商交付；真实提供商 canary 仍待完成。
