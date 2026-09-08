---
description: "私有 Web profile 层，把 Candy 账户设置页挂到 dsh-web-app 上，使浏览器场景无需 Candy 部署即可驱动它。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-candy-web-profile

[English](README.md) | 中文

## 概述

一个补丁层，一行配置：把 [`dsh-client-ui-settings-candy-account`](../../client/ui-settings-candy-account/README.zh.md) 的浏览器半边挂到随发的 `dsh-web-app` 界面上。它存在的理由是让 `apps/web/tests/candy-account-settings.e2e.ts` 能在真实的设置面板里、真实的浏览器中、按桌面和手机宽度展示那个页面。

它是 private 且不发布的，也不是部署 Candy 的方式。页面调用的 Host 路由被刻意省去：它们需要公开来源、OIDC 密钥集和凭据密钥，这些都不是测试进程能以字面量提供的，而每一项都在各自包的 Loader 组合测试里得到了证明。

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

Web 场景两次点名这个层，每次承担不同的职责：

```text
const LAYER_DIR = new URL('../../../packages/experimental/candy-web-profile/', import.meta.url)
launchWebScaffold({
  extraOverlayPath: fileURLToPath(new URL('cordis.patch.yml', LAYER_DIR)),
  extraInstallAnchors: [fileURLToPath(new URL('package.json', LAYER_DIR))],
})
```

补丁插入这一行。清单则作为安装锚点，其依赖闭包把页面包链接进 scaffold profile；没有它，这一行会导入失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 职责 |
| --- | --- |
| [`cordis.patch.yml`](cordis.patch.yml) | 唯一插入的浏览器行 |
| [`package.json`](package.json) | 使那一行可解析的依赖 |
| — | 不发布运行时不变量伴生模块；本包完全不含运行时代码。 |

### 为什么层和 overlay 是同一个文件

scaffold 分别应用 overlay 路径和从锚点修复模块，所以场景本可以自带一份行的副本。让两者都指向这个层，意味着这一行只写在一个地方，也就没有第二份副本可以漂移。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-client-ui-settings-candy-account`](../../client/ui-settings-candy-account/README.zh.md) —— 本层挂载的页面。
- [`dsh-provider-account-api`](../../control-plane/provider-account-api/README.zh.md) —— 页面调用的路由，以及它们被证明的地方。

-----

<a id="model-experience"></a>
## 模型体验

无。本包是测试专用的组合层，不含运行时代码。

#### KV 缓存影响

无；本包从不组装或发送服务商请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

以下是当前的包级约束，不是任务待办清单。

- **它不组合任何 Candy Host 插件** —— 使用本层的场景自行编排控制面的回答。等到 Candy 部署 bundle 出现后，需要真实路由的场景应当组合那个 bundle，而不是扩展本层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布伴生模块。本包不含运行时代码，不注册任何东西，也不拥有可检查的关系。
