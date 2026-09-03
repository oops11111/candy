---
description: "执行断言 nonce 背后的一次性记录，使同一个令牌的两份副本不可能都启动一次运行。"
kind: "package-library"
---

# @deepseek-ai/dsh-run-replay

[English](README.md) | 中文

## 概述

执行断言携带一个 nonce，而 [`dsh-execution-assertion`](../execution-assertion/README.zh.md) 刻意不消费它：签名把它绑定住，记住它则是别人的活。[`dsh-run-admission`](../run-admission/README.zh.md) 就是这份活落到的地方 —— 它要求一个 `spendNonce` 端口，并且从不重试一个被报告为已消费的 nonce，这使得那个端口就是 Candy 重放防护的全部。

本包是该端口的进程内实现，也是对任何一种实现所欠下的义务的陈述。三件事决定一个重放存储能否工作，而每一件都容易做错：决定必须是一个不可分割的步骤、保留期必须由断言而不是由定时器界定，以及记录必须按租户分区。

本包不持久化任何东西，也不持有任何时钟。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 满足 `spendNonce` 端口

```ts
import { RunReplayStore } from '@deepseek-ai/dsh-run-replay'
import type { ExecutionAssertionClaims } from '@deepseek-ai/dsh-execution-assertion'

const replay = new RunReplayStore()

export const spendNonce = (claims: ExecutionAssertionClaims): Promise<boolean> =>
  Promise.resolve(replay.spend(claims, Date.now()))
```

当这个 nonce 未曾被见过时 `spend` 返回 true，从而准入该次运行；曾被见过时返回 false，从而拒绝它。当前时间是参数，而不是对进程时钟的读取，因此已经持有决策时间戳的调度器可以针对那一刻进行准入，测试也无需控制时钟。

### 回收那些已经无法拒绝任何东西的记录

```ts
import { RunReplayStore } from '@deepseek-ai/dsh-run-replay'

declare const replay: RunReplayStore

export const dropped = replay.evict(Date.now())
```

`evict` 不改变任何决定 —— `spend` 本来就把过期记录视为不存在 —— 因此一个从不调用它的部署，拒绝的运行完全相同，只是持有得更多。它是一次调用而不是一个定时器，理由与 `RunLedger.expire` 相同：本存储不拥有时钟，而驱动其中一个的调用方也会驱动另一个。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 键的推导与 `RunReplayStore` |
| — | 不发布运行时不变量伴随模块；本模块不拥有事件流，而它持有的那一条关系由单元测试检查。 |

### 为什么决定必须是一个步骤

`spend` 在读与写之间不插入 `await`。端口返回的是 promise，因此诱人的实现是「先查这个 nonce，再插入它」—— 而这样写出来的存储会把被重放令牌的**两份**副本都准入，因为在任何一份记录下来之前，每一份都看到 nonce 是新的。测试让同一个令牌的三十二份并发副本穿过该端口，并要求恰好一份被准入。

一个持久化实现用一条语句而不是两条来保持这一点：一次在唯一性冲突时失败的插入，其受影响行数就是答案。先读后写只是同一个缺陷被拉长了距离。

### 为什么保留期由断言界定

一个 nonce 在其断言仍可被准入期间被持有，之后被遗忘。更早遗忘会在断言自身的生存期之内重新打开重放，而那恰恰是 nonce 存在所要关闭的那个窗口。持有更久则留下一条已经无法拒绝任何东西的记录，因为 `admitExecutionAssertion` 会自行拒绝该断言，准入根本到不了本存储。

两条边界落在同一毫秒上：那次调用在过期时刻拒绝，而一条记录也在过期时刻起不再计数。

### 为什么记录按租户分区

键是租户与 nonce，且带长度前缀，因此没有任何一对值能够伪造它们之间的边界 —— 两者都是本包不加约束的不透明字符串，而 `('ab', 'c')` 不能与 `('a', 'bc')` 相撞。

分区不削弱任何东西：被重放的令牌总是携带其签名所绑定的那个租户，因此重新算出来的是同一个键。它所阻止的，是一个租户通过抢先消费某个 nonce 值来拒绝另一个租户的运行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-execution-assertion`](../execution-assertion/README.zh.md) —— nonce 在哪里被签名，以及过期断言在抵达本存储之前于何处被拒绝。
- [`dsh-run-admission`](../run-admission/README.zh.md) —— `spendNonce` 端口，以及为什么 nonce 在读取预算之后、打开凭据之前被消费。
- [Candy 控制平面](../../../docs/subsystems/candy-control-plane.zh.md) —— 本存储所处的组合顺序。
- [多租户 CLI agent 运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划；本包是 R1 的重放存储。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是本包当前的约束，不是任务积压。

- **一个进程，而不是一个部署** —— 记录在实例存活期间存于内存。共享同一控制平面的两个运行时进程会各自准入同一个令牌的一份副本，而一次重启会遗忘每一个尚未过期的 nonce。运行多于一个进程的部署需要一个持久化存储，而本包的契约正是那个存储必须满足的东西。
- **没有任何东西驱动时钟** —— `evict` 是一次调用，不是一个定时器。一个从不调用它的部署拒绝的运行完全相同，只是持有更多记录。
- **规模只由签发速率界定** —— 数量就是一个最大断言生存期之内被准入的量。这里没有上限，因为面对一个满了的存储，两种答案都是错的：遗忘一条记录会重新打开重放，而拒绝一个新的 nonce 会拒掉一次合法运行。
- **没有 Cordis 服务** —— 本包不在 `Context` 上注册任何东西；它被直接构造。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景 —— 点击展开</summary>

无。

</details>
