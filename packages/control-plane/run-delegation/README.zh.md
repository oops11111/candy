---
description: "在一个子代理受委派的子会话存在之前为其开启一次有资金运行的 Candy 插件，并在父运行无力资助时拒绝这次委派。"
kind: "package-reference"
---

# @deepseek-ai/dsh-run-delegation

[English](README.md) | 中文

## 概述

`dsh-run-delegation` 在一个子代理的进程内受委派子会话存在之前，为它开启一次 Candy 运行。它针对 [`dsh-subagent`](../../subagent/subagent/README.zh.md) 的 `SubagentRuntime.onBeforeDelegate()`——委派器自己为「准备这次委派」这一步所提供的、消费方自有的扩展点——注册一个钩子，并通过 [`dsh-run-scheduler`](../run-scheduler/README.zh.md) 的 `startChildRun` 解析出正在委派的父会话自己开启中的运行，来回答这个钩子，请求 `config.childBudget` 所命名的那份固定额度。一个其运行无法资助这份请求的父会话，或者其运行已被控制平面标记为异常的父会话，会彻底拒绝这次委派，且从未创建出任何子会话；一个完全没有开启中 Candy 运行的父会话则不受限制。这个包不注册任何服务，除了插件入口点之外没有任何公开方法；移除它会让委派回到这个包存在之前的状态——一个没有自己 Candy 运行的进程内子会话。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与遗留工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

在一个把工作委派给进程内子代理、并希望每个受委派的子会话都像任何其他运行一样获得资金与限界的 Candy 组装中，把这个插件与 `dsh-subagent`、`dsh-run-scheduler` 一起加载。这个插件不需要其他任何接线：它通过 `inject` 发现这两个服务，并在自己 fiber 的生命周期内安装一个钩子。

### 最小组装

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-run-scheduler'
  config:
    issuer: candy-control-plane
    audience: candy-runtime-1
    credentialKeyVersion: 2026-09-a
    poolBase: /var/lib/candy/pools
- name: '@deepseek-ai/dsh-run-delegation'
  config:
    childBudget:
      tokens: 20000
      wallMs: 300000
      costMicroUsd: 500000
      children: 1
```

`childBudget` 是为每一次委派请求的那份固定额度，无论是哪个工具或提供方发起了这次委派。它没有默认值：运维者要明确说出这个数字，就像 `RunScheduler.startChildRun` 自己的 `share` 参数也没有默认值一样——参见 [插件中不写死可调参数](../../../AGENTS.md#conventions)。当父会话无法完全负担这份请求时,它会被拒绝，而不是被悄悄缩小。

### 对运维者意味着什么变化

通过 `dsh-subagent` 内置的进程内 spawn 或 fork 提供方发起的一次子代理委派，现在会在子 agent 被创建之前，先开启自己的一次 Candy 运行，挂在委派运行之下，并从 `childBudget` 获得资金。这次运行会像一次根运行一样精确地计量子会话自己的模型调用，其未花费的余量也会在子会话结算时归还给父运行。一次父会话无力承担所配置请求的委派,会在任何子会话存在之前就失败，并附带一条说明原因的消息。一个没有开启中 Candy 运行的父会话——例如一次本地的 `dsh --profile headless` 运行——不会看到任何变化：这个插件只会为一个 Candy 租户自己的委派提供资金，永远不会影响一次无关的组装。

### 失败与恢复

一次被拒绝的委派表现为调用方的 `ctx.subagents.start()` 调用以一个说明原因的 `Error` 拒绝：父会话解析不出唯一一个开启中的运行（被多个开启中的运行认领，或其账户被吊销），或者铸造成功但子会话无法获得资金（父租户的额度已耗尽，或其自身剩余的额度在某一维度上不够 `childBudget`）。放宽 `childBudget`，或者调查被指名的那个父运行，然后重试；被拒绝的这次尝试除了调用方已经看到的这个错误，以及 `dsh-run-scheduler` 自己的审计轨迹为这次准入尝试记录的内容之外，不会留下别的记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

这一节解释这个钩子背后的设计；可观察的行为已在 [使用这个包](#use-this-package) 中完整覆盖。

### 设计理念

- **一个策略插件，而不是委派器的功能。** `dsh-subagent` 是一个通用的 Harness 包，不携带任何 Candy 运行的概念；这个插件是 Candy 自有的、对其 `onBeforeDelegate()` 扩展点的消费方,因此这个委派器永远不需要为了 Candy 自己的这一步资助逻辑而改变——这与 [`dsh-tenant-preset-policy`](../tenant-preset-policy/README.zh.md) 同 `dsh-agent-presets` 的 `guard()` 之间的关系完全一致。
- **在子会话存在之前，而非之后。** `onBeforeDelegate()` 在进程内委派器调用 `ctx.agents.create()` 之前,从中运行,因此一个钩子的异步铸造并开启工作会在子会话可能发起第一次请求之前完成，而一个抛出异常的钩子不会留下任何已发布的东西需要回滚——为什么在发布之后才触发的 `subagent/start` 被否决作为钩子点，参见 [开发备注](#dev-note) 中的 Agent Note。
- **一份固定的请求，而非一份计算出的份额。** `config.childBudget` 是为每一个受委派子会话请求的、一份部署级别的固定额度；一份 `RunLedger.reserveChild` 无法资助的请求会被拒绝，而不是被缩小,因此一个受委派的子会话永远不会在一份调用方从未选择过的额度下启动。
- **对于 Candy 之外的会话，默认放行。** 一个会话完全解析不出任何开启中运行的父会话不受此插件约束——`RunScheduler.meterRequest` 与 `tenantOf` 早已采用的「不是这个运行时该资助的」默认行为在这里同样适用。一个运行存在但不可用的父会话（被多个开启中的运行认领，或其账户被吊销）则会被响亮地拒绝：与一个根本不存在的运行不同，一个异常的运行是控制平面已经标记出来的东西，放行一个子会话就等于绕过了这个标记，而不是尊重它。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config` schema 与插件入口点：通过 `RunScheduler.startChildRun` 铸造并开启一次子会话运行，并渲染出拒绝发生的原因 |
| — | 没有发布任何运行时不变式伴生包：这个钩子的判断只是其配置与 `RunScheduler.startChildRun` 的一个纯函数，已被 `tests/run-delegation.spec.ts` 中的真实组合测试完整覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-subagent](../../subagent/subagent/README.zh.md)——这个插件所钩住的委派器，以及 `onBeforeDelegate()` 自己的契约。
- [dsh-run-scheduler](../run-scheduler/README.zh.md)——`startChildRun`，这个插件驱动的铸造并开启调用。
- [dsh-tenant-preset-policy](../tenant-preset-policy/README.zh.md)——把同一种扩展点模式应用到另一份名册上。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-run-delegation)——每一个被接受的配置字段及其来源声明。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与遗留工作

- **只支持进程内一次性子会话。** `onBeforeDelegate()` 只接到了 `dsh-subagent-in-process-driver` 的一次性 spawn 与 fork 提供方上；一个可续接的子会话（`dsh-subagent` 的续接管理器）与一个进程外的产品提供方（例如 `dsh-subagent-claude-code`）在委派时不会由这个插件资助，因为一个可续接子会话的运行,或许需要在每次恢复时重新开启,而非只在创建时开启一次——这个包尚未回答这个生命周期问题。
- **一份固定的额度，而非一份计算出的份额。** 无论任务是什么、是哪个工具发起了这次委派，或者除了裸准入检查之外父会话自己还剩多少额度，每一个受委派的子会话都获得完全相同的资助；一个想要按工具或按任务给出不同份额的部署，应该针对 `onBeforeDelegate()` 组合自己的钩子，而不是扩展这个插件的配置形状。

-----

<a id="dev-note"></a>
## 开发备注

设计记录参见 [Agent Note](../../../.agents/notes/implemented/architecture/2026-09-06-a-driver-with-no-notion-of-a-run.zh.md)：为什么这个扩展点作为一个通用的委派前钩子活在 `dsh-subagent` 里,而不是一个 Candy 专属的检查，为什么它在发布之前运行而不是挂在 `subagent/start` 上，以及为什么一个受委派的子会话要铸造自己的执行断言，而不是复用其父会话的那一份。
