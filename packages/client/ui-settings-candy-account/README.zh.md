---
description: "Candy 控制面设置页：已登录租户的服务商账户、Windows 设备和管理员审计窗口，全部位于既有 dsh 设置面板内。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-candy-account

[English](README.md) | 中文

## 概述

本包让已登录租户在 dsh 设置面板中管理服务商账户和 Windows 设备，并为管理员提供独立的审计窗口视图。它不自带外壳、导航、主题或布局；每个页面都占用既有 Web 客户端提供的设置 section。

页面的数据不走 `ctx.remote`。Candy 的控制面路由通过 OAuth 回调设置的会话 Cookie 鉴别浏览器用户，而 dsh 的 `/api` 载体鉴别的是进程启动令牌；两者是同一来源上的不同权威，因此页面直接使用同源 HTTP，不注入任何 Remote 命名空间。

服务商凭据只进不出。设备配对码同样只由一次签发调用返回，只保留在设备页的易失 store 中，并在页面关闭时清除；后续名单读取含元数据，但不含配对码或设备令牌。服务器 CLI 摘要不检查、也不复用服务用户的 Claude 或 Codex 主目录。

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

在 Host 已提供 [`dsh-provider-account-api`](../../control-plane/provider-account-api/README.zh.md)、[`dsh-device-api`](../../control-plane/device-api/README.zh.md) 和 [`dsh-oauth-sign-in-web`](../../control-plane/oauth-sign-in-web/README.zh.md) 的部署中挂载这个浏览器插件。**账户**、**审计**和**设备**页随即出现在既有设置面板中。

这些页面没有配置项。它们读取这些 Host 插件挂载的路径，就在自身被服务的来源上。

### 租户在这里能做什么

| 操作 | 效果 |
| --- | --- |
| 添加账户 | 为某个服务商在一个标签下封存凭据，可同时设为该服务商的默认账户 |
| 校验凭据 | 询问服务商已保存的凭据是否仍然可用 |
| 设为默认 | 将某个账户设为该租户在该服务商下的默认账户 |
| 撤销凭据 | 终止凭据，记录仍可读取 |
| 删除 | 移除账户，并且其标识不会被再次分配 |
| 退出登录 | 结束浏览器会话并回到登录入口 |
| 生成配对码 | 创建短期有效、只能使用一次的配对码，并只显示一次完整的 `candy-host` 命令 |
| 撤销设备 | 终止设备绑定，同时保留其可见记录 |

Claude CLI 和 Codex CLI 摘要是账户状态，不是实时进程探测。有可用租户账户时显示**已配置**，只有已撤销账户时显示**凭据已撤销**，没有账户时显示**未配置**。CLI 服务商在这里没有实时凭据校验，因此页面不会声称环境中的系统 CLI 会话已认证。

已撤销的账户仍然列出，因为看清某个服务商为何停止工作正是来这里的理由；已删除的账户则完全不在名单中。

设备页列出正常和已撤销设备，以及等待使用、已使用和已过期的配对记录。名单绝不会恢复明文配对码。关闭页面会清除浏览器持有的唯一副本；丢失后需要生成新码。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 职责 |
| --- | --- |
| [`src/client/api.ts`](src/client/api.ts) | 控制面调用、CSRF 回显，以及各状态码的含义 |
| [`src/client/store.ts`](src/client/store.ts) | 页面状态及使其落定的操作 |
| [`src/client/CandyAccountSection.tsx`](src/client/CandyAccountSection.tsx) | 页面本身 |
| [`src/client/device-store.ts`](src/client/device-store.ts) | 设备名单、一次性配对码生命周期和变更状态 |
| [`src/client/CandyDeviceSection.tsx`](src/client/CandyDeviceSection.tsx) | 设备签发、列表和撤销界面 |
| [`src/client/locales.ts`](src/client/locales.ts) | `settings.candyAccount` 词典 |
| — | 不发布运行时不变量伴生模块；本包不拥有事件流，也不拥有跨插件可变关系，其唯一的 slot 注册在 apply 规格中证明了释放。 |

### 为什么失败是状态而不是异常

每个操作都让 store 落定并正常返回。需要 catch 的调用方只会是组件，而这里的组件不持有自身状态——因此页面渲染发生了什么，而不是由点击处理函数来决定。

有一种失败不是被报告而是被响应：登录失效的回答会清空身份、名单和打开的表单，因为那些行属于一个已经不存在的会话。请求没能送达时的措辞就是「没能送达」，绝不写成关于凭据本身的判断。

### 为什么改动之后要重读控制面

将一个账户设为默认会清掉另一个账户的标记，删除一个账户则会提升出替代者。没有哪个单独的回答说明哪一行发生了移动，所以页面选择重读，而不是修补自己猜出的结果。校验凭据只报告一行，因此不重读。

### 为什么请求里的账户标识不能选择租户

它从不携带租户。租户由 [`dsh-control-plane-api`](../../control-plane/control-plane-api/README.zh.md) 从会话 Cookie 推导，该租户不拥有的标识回答 `404`——与从未签发过的标识得到的回答完全一致。

### 为什么配对码随页面离开

签发响应是唯一包含配对码的控制面回答。设备 store 在内存中保留该响应，供用户把它移到 Windows Host；设置 section 卸载或用户主动关闭时便清除它。名单刷新只携带签发时间、到期时间、使用状态和生成的设备元数据。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-settings](../ui-settings/README.zh.md) —— 设置领域基座，以及本页填入的 `settings.section` 座位。
- [dsh-provider-account-api](../../control-plane/provider-account-api/README.zh.md) —— 本页背后的六个操作。
- [dsh-device-api](../../control-plane/device-api/README.zh.md) —— 租户范围的设备签发、列表、兑换、认证和撤销。
- [dsh-candy-host](../../bundle/candy-host/README.zh.md) —— 消费所显示配对码的 Windows 命令。
- [dsh-oauth-sign-in-web](../../control-plane/oauth-sign-in-web/README.zh.md) —— 建立本页所发送会话 Cookie 的登录流程。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md) —— 每个客户端插件遵循的分层。

-----

<a id="model-experience"></a>
## 模型体验

无。本包是浏览器侧的设置页面，不触及提示词、消息、schema、流或工具结果。

#### KV 缓存影响

无；本包从不组装或发送服务商请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

以下是当前的包级约束，不是任务待办清单。

- **只有 DeepSeek 凭据具有实时校验** —— 部署通过模型目录校验 `deepseek-api`。Claude CLI 和 Codex CLI 显示租户保存的账户状态，校验时回答 `unsupported-provider`；它们不检查共享 CLI 主目录。
- **没有管理员视图** —— 页面只操作当前租户自己的账户。管理员管理其他租户账户在这里没有界面，因为 API 也没有。
- **名单整体返回** —— 没有分页；数量由运维配置的规模决定。
- **配对码无法恢复** —— 离开设备页会清除其易失副本；若尚未转移，租户必须重新签发。
- **登录失效后无法就地恢复** —— 登录入口是一次整页跳转，因此会话过期会结束这个页面，而不是在对话框后面刷新它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布伴生模块。本包在本地 store 上注册三个设置 section；它不发出 cordis 事件，不拥有跨插件可变关系，其注册通过 apply 规格中的 fiber 释放用例证明了释放。
