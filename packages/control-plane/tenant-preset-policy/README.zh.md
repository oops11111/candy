---
description: "面向 Candy 运维者的租户 preset 白名单插件，限制一个租户可以使用共享 dsh-agent-presets 名册中的哪些 preset。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tenant-preset-policy

[English](README.md) | 中文

## 概述

`dsh-tenant-preset-policy` 把一个 Candy 租户限制在一份原本共享的 [`dsh-agent-presets`](../../preset/agent-presets/README.zh.md) 名册的一个已配置子集内。它向 `AgentPresets.guard()`——名册自身为"这个 agent 是否可以组装这个 preset"这类由消费方拥有的判断而设的扩展点——注册一个守卫，并通过 [`dsh-run-scheduler`](../run-scheduler/README.zh.md) 的 `tenantOf` 解析一个会话的租户来回答它，随后把这个 preset id 对照该租户已配置的白名单核对。配置中未出现的租户，以及没有任何 Candy 运行驱动的会话，都不受限制。本包不注册任何服务，除插件入口外也没有任何公开方法；移除它会让每个租户回到裸的 `dsh-agent-presets` 组装本就给出的、不受限制的名册。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在想要限制租户可运行哪些 preset 的 Candy 组装中，把本插件与 `dsh-agent-presets` 和 `dsh-run-scheduler` 一起挂载。本插件不需要其他接线：它通过 `inject` 发现这两个服务，并在自己 fiber 的生命周期内安装一个守卫。

### 最小组合

```yaml
- name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
- name: '@deepseek-ai/dsh-run-scheduler'
  config:
    issuer: candy-control-plane
    audience: candy-runtime-1
    credentialKeyVersion: 2026-09-a
    poolBase: /var/lib/candy/pools
- name: '@deepseek-ai/dsh-tenant-preset-policy'
  config:
    allowlists:
      user-alice: [minimal, standard]
      user-bobby: [minimal]
```

`allowlists` 把一个租户 id 映射到该租户可以挂载或切换到的那些 preset id。在这份映射中没有条目的租户不受限制——这份配置陈述的是对一个开放默认值的例外，而不是一个封闭默认值，因此接入一个新租户在运维者选择收窄它之前不需要任何配置改动。

### 运维者看到的变化

一个租户的会话创建，以及随后任何一次 preset 切换，现在会以 `agent-preset/refused` 拒绝该租户白名单之外的 preset id，消息中指名租户与被拒绝的 preset。在白名单中没有条目的租户，以及背后完全没有 Candy 运行的会话（比如本地的一次 `dsh --profile headless` 运行），都不会看到任何变化：本插件只会收窄一次 Candy 运行自身租户可以使用的东西,绝不会收窄一个无关组装本来允许的东西。

### 失败与恢复

一次被拒绝的挂载或切换,就是调用方的 `agentPresets.mount()`/`recompose()` 调用以 `agent-preset/refused` 拒绝,与一个损坏的 preset 组装完全一样——参见 [`dsh-agent-presets` 自己的失败文档](../../preset/agent-presets/README.zh.md#use-this-package)。放宽该租户的 `allowlists` 条目,或者把它整个删除以解除限制,然后重试;被拒绝的尝试除了调用方已经看到的那个错误之外,不会留下任何别的记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释守卫背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计概念

- **是一个策略插件，不是名册的功能。** `dsh-agent-presets` 是一个通用的 Harness 包，不携带任何租户概念；本插件就是 Candy 对它 `guard()` 扩展点给出的自己的答案，因此名册本身永远不需要为了 Candy 自己的限制而改变。
- **每次守卫调用都重新解析。** 守卫在每次调用时都读取 `config.allowlists` 并调用 `RunScheduler.tenantOf`——不缓存任何东西——因此配置变更会在下一次挂载或切换尝试上立即生效，而一个刚刚开启运行的会话也会依据当前状态被判断。
- **靠构造而非约定做到不可绕过。** `AgentPresets.guard()` 是在 `resolveMountable` 内部被咨询的，而这正是 `mount()` 与 `recompose()` 背后唯一的那个函数——这是唯一会安装 agent 的 preset 绑定的两个操作——因此不存在本插件还需要单独看守的第二条调用路径。
- **默认开放，靠例外收窄。** 在 `allowlists` 中没有条目的租户，以及 `tenantOf` 无法为其解析出唯一租户的会话（没有开启中的运行、一个有歧义的认领，或者一个账户已不可用的运行），两者都不受限制——这与 `RunScheduler.meterRequest` 对一个背后没有 Candy 运行的会话早已采用的"不是这个运行时该收费的"默认行为相同。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config` schema 与插件入口：解析一个会话的租户,并对照已配置的白名单核对 |
| — | 不发布运行时不变量伴随模块；这个守卫的判断只是其配置与 `RunScheduler.tenantOf` 的一个纯函数，已由 `tests/policy.spec.ts` 中的真实组合测试完整覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent-presets](../../preset/agent-presets/README.zh.md) —— 本插件所限制的名册，以及它所消费的 `guard()` 扩展点。
- [dsh-run-scheduler](../run-scheduler/README.zh.md) —— `tenantOf`，本插件的守卫读取的那个同步会话到租户查找。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tenant-preset-policy) —— 每一个被接受的配置字段及其源码声明。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **白名单是静态插件配置，不是持久化的按租户状态。** 与保存在 `dsh-control-plane-store` 中的租户额度不同，preset 白名单只能通过编辑并重新加载组装来改变；没有任何管理 API 或以存储为后盾的记录能让部署在不做配置改动的情况下于运行期更新它。
- **一个守卫、一份部署级配置。** 单一的 `allowlists` 映射覆盖本运行时服务的每一个租户；如果一个部署想要一条不同的强制规则（比如在 preset 白名单之外再加一条路由白名单），应当组合一个独立的守卫，而不是扩展本插件的配置形状。

-----

<a id="dev-note"></a>
## 开发备注

设计记录见 [Agent Note](../../../.agents/notes/implemented/architecture/2026-09-06-a-roster-with-no-notion-of-a-tenant.zh.md)：为什么这个扩展点作为一个通用守卫活在 `dsh-agent-presets` 里，而不是一个 Candy 专属检查；以及为什么 `RunScheduler.tenantOf` 是同步的。
