---
description: "子运行从父运行那里取走的 token、时间、金额与并发额度，使一棵委派树无法花超启动它的那次运行所持有的量。"
kind: "package-library"
---

# @deepseek-ai/dsh-run-budget

[English](README.md) | 中文

## 概述

`dsh-run-budget` 为一棵运行树所能消耗的量设界。harness 已经限制了委派*深度* —— `dsh-subagent` 在超过 `maxDepth` 时抛出 `SubagentDepthError` —— 并把被委派子运行的沙箱模式与审批策略钉在父运行上。这些都不限制花费：深度 3、每层十个子运行就是一千次运行，每一个都可以随意消耗租户的 token、时间与金钱。本模块正是缺失的那一半。子运行的额度在它启动时就从父运行那里扣除，因此无论父运行委派多少个子运行，都不可能把同一批 token 承诺两次；而未花完的余额只有在子运行结算时才归还。

金额全程使用整数微美元。用浮点比较或扣减的上限会漂移，而会漂移的花费上限不是上限。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 委派一次运行的部分额度

```ts
import { reserveChild, settleChild } from '@deepseek-ai/dsh-run-budget'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'

declare const parent: RunBudget

const reservation = reserveChild(parent, {
  tokens: 40_000,
  wallMs: 120_000,
  costMicroUsd: 250_000,
  children: 2,
})

export const outcome = reservation.reserved
  ? { child: reservation.child, parentNow: reservation.parent }
  : { refused: reservation.denial.dimension }
```

`reservation.parent` 是父运行在这次委派*之后*的额度。使用它正是强制手段：继续花用委派前额度的父运行，可以把同一批 token 交给它启动的每一个子运行。

子运行结束时，把它没用掉的部分还回去：

```ts
import { settleChild } from '@deepseek-ai/dsh-run-budget'
import type { RunBudget, RunSpend } from '@deepseek-ai/dsh-run-budget'

declare const parentNow: RunBudget
declare const childBudget: RunBudget
declare const childSpent: RunSpend

export const parentAfter = settleChild(parentNow, childBudget, childSpent)
```

### 随消耗对一次运行计费

```ts
import { chargeRun, hasRemainingBudget } from '@deepseek-ai/dsh-run-budget'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'

declare const budget: RunBudget

const charge = chargeRun(budget, { tokens: 1_200, wallMs: 3_400, costMicroUsd: 9_000 })

export const next = charge.charged
  ? { budget: charge.remaining, keepGoing: hasRemainingBudget(charge.remaining) }
  : { stop: charge.denial }
```

被拒绝的计费不扣除任何东西，因此在拒绝时停止运行的调用方，绝不会发现自己的额度已被它拒绝的那次计费花掉了一部分。

### 请求会被拒绝，而不会被削减

每个操作都返回一个具名的拒绝，指出是哪一个维度不够，并且什么也不改变。悄悄把请求削减到剩余量，会让子运行在一个其调用方从未选择过的额度下启动；而一个因为被悄悄只给了它所要求的五分之一而中途停下的 subagent，比一个被干脆拒绝的更难诊断。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `RunBudget`、`RunSpend`、`reserveChild`、`settleChild`、`chargeRun`、`hasRemainingBudget` 与预算断言 |
| — | 不发布运行时不变量伴生模块；本纯模块不拥有事件流或可变运行时数据，其算术由单元测试保障。 |

### 为什么子运行名额是被占用而不是被花掉

`children` 是同时可存活的子运行数量，因此它的行为与另外三个维度不同：预留一个子运行会占用一个名额，结算时又归还。token、毫秒与金钱则是一去不返的消耗。这也是 `RunSpend` 根本没有 `children` 字段的原因 —— 一个能够「花掉」并发度的调用方，会摧毁它本应释放的那份容量。

子运行自己可以再委派的并发度归它自己持有，不从父运行的名额中扣除；只有该子运行占用的那一个名额才扣。因此只剩一个名额的父运行，仍然可以启动一个被允许拥有五个孙运行的子运行。

### 为什么超支不予返还

`settleChild` 返回 `max(0, reserved - spent)`。消耗超过其预留量的子运行已经让租户付出了那笔钱；把差额返还等于凭空造出预算，让父运行把它再花一次。超支由 `chargeRun` 在运行过程中阻止，而不是在结算时纠正 —— 这也正是要随运行计费、而不是最后对账的原因。

### 为什么断言抛出而不是给出拒绝

一个负数、带小数或超出安全整数范围的预算是存储或算术缺陷，而不是一次被耗尽的运行，这两者绝不能经由同一条通道抵达调用方。耗尽是调用方据以分流的一个值；而畸形的预算是一个指明参数与字段的 `RangeError`，因为带着它继续下去会产出根本不成立的上限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [多租户 CLI 智能体运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划；本包是 R3 中父子运行记录的预算那一半。
- [跨委派树的运行预算](../../../.agents/notes/implemented/architecture/2026-09-03-run-budget-delegation.zh.md) —— harness 已经限制了什么，以及为什么预留要做扣除而不是检查。
- [`dsh-control-plane`](../control-plane/README.zh.md) —— 预算所记录到的 `RunId` 与 `RunLineage`。
- [`dsh-subagent`](../../subagent/subagent/README.zh.md) —— 继承而来的委派深度上限，以及子运行从父运行继承的策略。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

以下是本包当前的约束，不是任务清单。

- **这里不存储预算** —— 这里只是对调用方所持有的值做算术。[`dsh-run-admission`](../run-admission/README.zh.md) 已经会拒绝启动预算已耗尽的运行，但持久化一次运行的剩余额度并重新加载它，属于 R3 尚未构建的运行存储。
- **没有挂钟来源** —— `wallMs` 是调用方自行测量并计费的数字。这里不读取任何时钟，因此一次从不为其耗时计费的运行，也永远不会因为超时而被停下。
- **只有一条路由报告成本** —— `TokenUsage.costMicroUsd` 携带由提供方报告的数值，而 [`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.zh.md) 是唯一提供它的路由。对着 HTTP 路由计费 `costMicroUsd` 的调用方仍要自行为 token 定价，而且没有任何东西把已报告的数值折叠成一个持久总量。
- **预留不是租约** —— 没有任何东西会让未结算的预留过期，因此一个丢失且未结算的子运行会一直占着父运行的额度，直到调用方去对账。要做到崩溃安全的占用，需要 R3 所拥有的持久运行记录。
- **是一棵树，而不是一个租户** —— 这些操作为某一次运行之下的委派树设界。跨并发无关运行的租户级上限属于另一条记账缝隙，不是这一条。
- **没有 Cordis 服务** —— 这里不向任何 `Context` 注册；它像 `dsh-brand` 一样被直接导入。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
