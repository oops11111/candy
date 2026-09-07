---
description: "租户的既定授予额度，以及其已结算运行从中消耗掉的部分，使一份授予额度只为一个租户拨款，而不是为它启动的每一次运行拨款。"
kind: "package-library"
---

# @deepseek-ai/dsh-tenant-allowance

[English](README.md) | 中文

## 概述

[`dsh-run-budget`](../run-budget/README.zh.md) 为一棵委派树设界，[`dsh-run-ledger`](../run-ledger/README.zh.md) 持有那棵树的存活记录。两者都没有对它们之上的租户说过什么，而在本包之前也没有任何东西说过：`dsh-run-admission` 的 `findBudget` 端口是用一份直接从存储里读出来的授予额度来回答的，因此一个被授予一百万 token 的租户可以启动一次运行、花掉这一百万、关闭它，然后再针对同一个一百万启动下一次。那份授予额度界定的是一次运行，而不是一个租户。

本包就是那个缺失的量。租户是每一棵委派树所悬挂的根，因此它的记账方式与父运行完全相同：一次开启中的运行，其预留在运行期间被从剩余额度里扣住；而它实际花掉的，在结算时被加进租户的消耗里。

本包不持久化任何东西，也不持有任何时钟。`TenantAllowance` 是调用方可以存储的普通数据，而哪些运行是开启中的，则由调用方自己知道。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 回答一个租户可以针对什么启动运行

```ts
import { remainingAllowance, type TenantAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'

declare const allowance: TenantAllowance
declare const openRuns: readonly RunBudget[]

export const available: RunBudget = remainingAllowance(allowance, openRuns)
```

`held` 是该租户每一次仍然开启中的运行的预留。传入 `[]` 回答的是**不计**正在运行者时该租户还剩多少，而正是这种读法让两棵存活的树各自持有整份额度；持有账本的调用方传入那个账本所持有的东西。

### 为一棵已结算的树记账

```ts
import { consumeAllowance, openAllowance } from '@deepseek-ai/dsh-tenant-allowance'
import type { RunSpend } from '@deepseek-ai/dsh-run-budget'

declare const settled: RunSpend

const opened = openAllowance({ tokens: 1_000_000, wallMs: 3_600_000, costMicroUsd: 5_000_000, children: 8 })

export const charged = consumeAllowance(opened, settled)
```

`RunLedger` 为一次根运行报出的结算已经覆盖了它的整棵子树，因此一棵树只被记账一次 —— 在它的根关闭时 —— 而不是树中每次运行各记一次。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `TenantAllowance` 以及针对它的四个函数 |
| — | 不发布运行时不变量伴随模块；本模块不拥有事件流也不持有状态，因此它的算术由单元测试检查。 |

### 为什么授予额度与消耗并排保存

一个就地递减的单一剩余数字同样能回答准入问题，却会丢掉其余一切：运营方授予了什么、租户已经用掉了多少，以及因此能否产出配额报告。同时保留两者也让「修改授予额度」有了明确定义 —— 运营方在周期中途把配额翻倍，意味着该租户现在总共可以花两倍，而不是它的历史被抹掉了。

### 为什么消耗被记录而不是被封顶

提供方账单是多少就是多少。一笔租户记录拒绝吸收的结算，会让该租户报出一份它已经花掉的额度；而一次在零处夹断的减法，会抹掉一次运行超出其授予额度多远。被夹断的只有「现在可以启动什么」这个答案，它不能为负。

### 为什么一次被扣住的运行要为它可以下发的名额付费

`remainingAllowance` 为一次被扣住的运行收取一个属于它自己的并发名额，外加它自己可以委派出去的每一个名额，这正是 `reserveChild` 在低一层所做的算术。按每次开启中的运行只收一个名额，会让 `children` 在租户的整片森林上不再有界，理由与它当初在一棵树上不再有界时相同：一个被授予四个并发运行的租户可以开启四个、每个又各自委派四个，而任何一层都没有为它下面的那些付过费。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-run-budget`](../run-budget/README.zh.md) —— 四个维度，以及本模块在高一层所镜像的那次子运行预留。
- [`dsh-run-ledger`](../run-ledger/README.zh.md) —— `held` 所指的那些开启中的预留从哪里来，以及结算在哪里产生。
- [`dsh-control-plane-store`](../control-plane-store/README.zh.md) —— 租户额度的持久化归宿。
- [`dsh-run-scheduler`](../run-scheduler/README.zh.md) —— 存储与账本相遇之处，也是这份组合唯一完整的地方。
- [Candy 控制平面](../../../docs/subsystems/candy-control-plane.zh.md) —— 这些包所处的组合顺序。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是本包当前的约束，不是任务积压。

- **没有周期** —— 一份额度从它被授予起一直有效，直到运营方修改它。这里没有月份、没有重置、也没有结转，因为仓库中还没有任何东西决定一个计费周期何时开始；想要周期的部署通过写入一份全新的额度来重置消耗。
- **`held` 的正确性由调用方负责** —— 一个忘记了某次开启中运行的调用方，会针对那次运行正扣着的额度准入第二次运行。本模块无法检查这项声明，因为它不持有记录；`dsh-run-scheduler` 才是两半恰好被组合一次的地方。
- **是一份额度，不是一个速率** —— 这些维度都是总量。一个按每分钟而不是按每份授予额度限制 token 的租户需要另一种记录，而目前没有任何消费方提出这个要求。
- **没有 Cordis 服务** —— 本包不在 `Context` 上注册任何东西；这些函数被直接调用。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景 —— 点击展开</summary>

无。

</details>
