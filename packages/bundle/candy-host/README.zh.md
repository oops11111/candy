---
description: "一次性的 Windows Harness Host 设备管理：配对 Candy、查看不含秘密的绑定或释放绑定，且不启动另一套传输。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-candy-host

[English](README.md) | 中文

## 概述

这个独立 profile 为 Windows Harness Host 提供面向运维人员的入口，用来消费 Candy 已有的配对码。它只挂载本地凭据提供方、`dsh-device-binding`、命令解析器和一次性 runner，不启动 Agent、Web 服务器、文件工具、Shell、Remote Gateway 或重连循环。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

先从现有 DSH 设置面板的“设备”页签发配对码，再在 Windows 机器上输入：

```powershell
dsh --profile candy-host pair --server https://candy.example --code ABCD-EFGH-IJKL-MNPQ
dsh --profile candy-host status
```

第一条命令只兑换一次配对码，并通过既有凭据提供方写入返回的令牌。输出只显示归一化后的服务器、租户和设备，不打印配对码或令牌。`status` 读取相同的安全视图。若要明确停止本安装继续服务该身份：

```powershell
dsh --profile candy-host release
```

每个操作都是一次性的，成功退出 0，拒绝或失败退出 1。意外网络错误只会被分类，不会把请求详情转换为字符串，因此库诊断不能把配对码复制进终端历史。

<a id="understand-the-implementation"></a>
## 理解实现

`src/startup.ts` 拥有 `pair`、`status` 和 `release` 语法，并发布一个不可变操作。配对码只经过该进程内服务，绝不进入 Loader 配置。`src/index.ts` 只调用 `dsh-device-binding`；bundle patch 提供本地凭据存储及这两个配置项。内置 `candy-host` profile 采用仅启动时加载，因为进程只完成一个管理操作就退出。

不发布运行时 invariant companion；该命令在所调用的 `dsh-device-binding` 操作之外不拥有持久关系，其进程级输出和退出约定由命令测试覆盖。

这是管理表层，不是尚缺的远程主机传输。现有 DSH Gateway 连接浏览器客户端与 Host，不能靠提供该令牌反向使用。未来由 DSH 拥有的远程 Host 能力必须在自己的连接建立和重连操作中读取已保存的绑定。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-device-binding`](../../control-plane/device-binding/README.zh.md) —— 唯一持久绑定与配对兑换。
- [`dsh-device-api`](../../control-plane/device-api/README.zh.md) —— 服务端签发、兑换、认证、列表与撤销。
- [`dsh-client-ui-settings-candy-account`](../../client/ui-settings-candy-account/README.zh.md) —— 签发配对码并撤销设备的继承设置面板页面。
- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md) —— Candy/DSH 归属规则。

<a id="model-experience"></a>
## 模型体验

无，因为这个仅用于管理的 profile 不组装提示词，也不调用模型。

#### KV Cache 影响

无；不会创建 Provider 请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 该 profile 只管理身份，不负责把 Host 连接到 Candy。
- `release` 只移除本地绑定；服务端撤销仍是独立的租户操作。

<a id="dev-note"></a>
### 开发备注

无。
