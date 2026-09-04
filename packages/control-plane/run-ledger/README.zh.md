---
description: "关于每次运行持有什么、花掉了什么的实时记录，因此一次丢失的运行会精确地归还父运行的额度，而不是永远占着它。"
kind: "package-library"
---

# @deepseek-ai/dsh-run-ledger

[English](README.md) | 中文

## 概述

[`dsh-run-budget`](../run-budget/README.zh.md) 是那套算术：子运行的额度在它开始时从父运行那里扣除，未花完的余额在它结算时归还。它没有回答谁持有一份预留，也没有回答持有预留的那次运行永远不结算时会怎样 —— 一个崩溃掉的子运行，会在父运行还活着的整段时间里一直占着它的 token。

本包就是回答这两件事的那份记录。记录存储的是花费，而「还能花多少」是推导出来的，因此提供方的账单会按它到达的样子被记录下来，而不是因为装不下就被拒绝；而一次被丢弃的运行可以被*精确*结算：账本已经知道它消耗了多少，什么都不需要估算。每条记录还带有一份租约，因此一份被遗弃的占用是按时钟归还的，而不是等某个人注意到。

这里不持久化任何东西。`RunRecord` 是调用方可以自行存储的纯数据；本包拥有的是那台状态机与那套算术。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 开启一次运行，并随其消耗计费

```ts
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'

declare const run: AdmittedRun
declare const now: number

const ledger = new RunLedger()
const opened = ledger.openRoot(run.claims.runId, run.budget, now + 60_000)

export const charged = opened.ok
  ? ledger.charge(run.claims.runId, { tokens: 1_200, wallMs: 3_400, costMicroUsd: 9_000 })
  : opened
```

计费只会被记录，绝不会被拒绝：提供方计了多少就是多少，而账本拒绝记录的一次花费，会让它继续报告那次运行早已用掉的额度。计费转而回答的是 `exhausted` —— 这次运行现在已经用尽的那些维度；它在运行还能继续时是空的，不为空时就是把运行停下来的信号。

`ledger.remaining(runId)` 是这次运行还能花的量，由它的额度、已记录的花费，以及每一个开启中子运行的预留推导得出。它永远不会为负；透支的运行读出来是零，而透支本身仍留在它自己记录的 `spent` 里可见。

### 委派，以及把额度收回来

```ts
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import type { RunId } from '@deepseek-ai/dsh-control-plane'

declare const ledger: RunLedger
declare const parent: RunId
declare const child: RunId
declare const now: number

const opened = ledger.openChild(parent, child, {
  tokens: 40_000,
  wallMs: 120_000,
  costMicroUsd: 250_000,
  children: 0,
}, now + 30_000)

export const settled = opened.ok ? ledger.close(child) : opened
```

关闭一次运行会释放它的占用，因此父运行推导出的额度会收回这个子运行没有用掉的一切，连同它当时占着的每一个名额 —— 它自己的那一个，以及它可以转手让出的那些。一次还有开启中子运行的运行会把它们一起关掉：留在一次已关闭运行身后的占用，是一份永远不会有人结算的占用。

### 释放一次丢失的运行所占用的东西

```ts
import type { RunLedger } from '@deepseek-ai/dsh-run-ledger'

declare const ledger: RunLedger
declare const now: number

export const released = ledger.expire(now)
```

`expire` 会结算每一次租约已到期的运行，最早到期的先结算。仍在工作的运行用 `renew` 把自己的租约往后推，因此一份不再往前推的租约，恰好就是一次没有任何东西在驱动的运行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `RunLedger`、`RunRecord`、`RunChargeResult`、`RunSettlement` 与各项账本拒绝 |
| — | 不发布运行时 invariant 伴生包；本模块不拥有事件流，而唯一值得检查的关系 —— 一棵树归还的绝不会多于它预留的 —— 是算术，由它的单元测试直接钉住。 |

### 为什么到期的运行能被精确结算

别处的租约到期只能靠猜：持有者已经不在，没人知道它消耗了多少，于是系统要么把整份预留全额退回（凭空造出那次运行已经花掉的预算），要么什么也不退（把额度一直漏到父运行结束）。在这里两者都不必要，因为计费与占用住在同一条记录里。父运行吸收的是这次运行确实消耗掉的量，并以它被允许的额度封顶。

唯一的不精确是有界且被点名的：一次最后的计费从未抵达账本的运行，会被多退那么多，至多是一个计费间隔的量。

### 为什么一次花费是被记录而不是被拒绝

计费发生在提供方已经计过费之后。一个因为「装不下」就拒绝记录花费的账本，会继续报告那次运行已经花掉的额度，而下一次调用又会按那个幻影额度来定尺寸 —— 这与上限恰好相反。那次拒绝所替代的，本来就是调用方无论如何都要做的决定，因此计费改为报告 `exhausted`，由调用方把运行停下来。

因此超支会被完整记录下来，而父运行只吸收它授权过的那一部分。一个花超了预留的子运行确实让租户付了那笔钱，但它的父运行只授权了那份预留；把超出的部分记到父运行头上，就是从这个子运行的兄弟那里拿走它。

### 为什么关闭一次运行会关闭它的后代

子运行的预留是从父运行记录里做的一次扣除。如果父运行在子运行仍开启时关闭，那次扣除就没有任何运行为它作证，也不会再有任何结算把它逆转 —— 这份额度会被搁浅到整棵树结束为止。关闭整个子树，守住的正是预算算术存在的理由：每一份预留最终都会回到做出它的那次运行。

### 为什么一个账本只持有一棵树

预留是从父运行记录里做的一次扣除，因此父运行与它的子运行必须共用同一个实例。两个账本会各自认为自己持有全部额度，而委派上限在两边都不成立。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-run-budget`](../run-budget/README.zh.md) —— 本包为之记账的预留、结算与计费算术。
- [`dsh-run-admission`](../run-admission/README.zh.md) —— 一次运行的开局额度从哪里来。
- [`dsh-control-plane`](../control-plane/README.zh.md) —— 记录以之为键的 `RunId` 与 `RunLineage`。
- [多租户 CLI agent 运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划；本包是 R3 的运行记录。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

以下是本包当前的约束，不是任务清单。

- **没有任何东西持久化账本** —— 记录只在实例存活期间留在内存里，因此一次重启会丢掉每一次开启中的运行以及它们携带的占用。记录类型是调用方可以自行存储的纯数据，但这里不提供任何存储、格式或恢复顺序。
- **没有任何东西驱动时钟** —— `expire` 是一次调用，不是一个定时器。从不调用它的部署就永远不会释放被遗弃的占用，而选择那个节奏是调度器的事。
- **租约不会告知运行本身** —— 它约束的是一次丢失的运行能占着父运行 token 多久，而在它到期时并不会取消那次运行本身。取消工作属于启动它的那一方。
- **一棵树，而不是一个租户** —— 一个账本持有的是一个根之下的那些运行。跨越并发的无关树的租户级视图是另一条记账缝隙，不是这一条。
- **没有 Cordis 服务** —— 这里没有任何东西注册到 `Context` 上；它被直接构造。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
