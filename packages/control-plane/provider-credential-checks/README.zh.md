---
description: "提供方集成用来说出一份已存储凭据是否仍然有效的注册表,使管理 API 可以发问而不必知道端点、请求或响应。"
kind: "package-reference"
---

# @deepseek-ai/dsh-provider-credential-checks

[English](README.md) | 中文

## 概述

检查一份凭据意味着与那个提供方对话,而只有它的集成知道该怎么做。这个注册表是两者之间的缝隙:[`dsh-provider-account-api`](../provider-account-api/README.zh.md) 索要一个裁定,而从不得知端点、请求或响应体;集成作答时也不知道这份密钥来自哪个租户、哪个账户。

没有任何东西为之注册过的提供方,回答 `unsupported-provider` —— 而不是"凭据无效",因为这个部署根本无从知道。

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
```

该服务不接受任何配置:它持有的,就是被组合进来的那些集成所注册的东西。

### 贡献一次检查

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-provider-credential-checks'

declare const ctx: Context
declare function authenticates(key: string): Promise<boolean>

export const dispose = ctx.providerCredentialChecks.register('deepseek-api', async (secret) => {
  return await authenticates(Buffer.from(secret).toString('utf8'))
    ? { valid: true }
    : { valid: false, reason: 'invalid-credential' }
})
```

这次检查接收被打开的密钥并给出一个裁定。它那个可选的 `diagnostic` 是唯一会抵达客户端的文本,因此它绝不能携带提供方的响应体、端点或凭据本身。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 角色 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 服务本身、它的注册效果,以及裁定查找 |
| [`src/types.ts`](src/types.ts) | `ProviderCredentialCheck` |
| — | 不发布运行时不变量伴生模块;该注册表不拥有事件流,其处置由其消费方测试套件里的 HMR 测试证明。 |

### 为什么由第一次注册作答

一个部署为每个提供方组合一个集成。第二个会是关于同一项事实的两种意见,而没有在它们之间做选择的规则;取最新的、或者合并裁定,都会是一条没人陈述过的规则。

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-provider-account-api`](../provider-account-api/README.zh.md) —— 唯一的调用方,以及一个裁定在哪里成为一次 HTTP 回复。
- [`dsh-provider-accounts`](../provider-accounts/README.zh.md) —— 在发问之前打开那份凭据的领域操作。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前的包约束,不是任务待办。

- **还没有任何东西注册过检查** —— 在有集成组合进来之前,每个提供方都回答 `unsupported-provider`。Claude CLI 与 DeepSeek API 路线都还没有自己的检查。
- **没有缓存或限流** —— 每一次 validate 请求都抵达提供方。一个反复发问的租户所带来的负载,要由集成自己去设界。
- **每个提供方一次检查** —— 为同一提供方注册的第二个会被持有,但永远不会被查询。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>
