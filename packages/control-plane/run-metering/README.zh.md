---
description: "把一次提供方流按一次开启中运行的额度来计量，使预算能够停下工作，而不只是把它记下来。"
kind: "package-library"
---

# @deepseek-ai/dsh-run-metering

[English](README.md) | 中文

## 概述

[`dsh-run-admission`](../run-admission/README.zh.md) 会拒绝一次额度已经用光的运行，而 [`dsh-run-ledger`](../run-ledger/README.zh.md) 记录每一次运行花掉了什么。在这两个时刻之间，没有任何东西在看着。一次以一千 token 被准入的运行可以流出一百万：`charge` 报告一次运行已经用尽了哪些维度，而没有任何调用方在读这份报告。

本包就是中间那段的强制执行。它为一次开启中的运行包裹一条提供方流 —— 在运行已经什么都不剩时，在抵达提供方之前就拒绝这次调用；在这次调用跑过运行尚存的挂钟时间时，切断这条流；并在它的终止块被传出去之前，把这次调用消耗掉的东西记上账。

它不持有账本，也不决定任何额度。两者都是传进来的，因为账本属于一个运行时，而本包属于一次调用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 计量一次调用

```ts
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RunId } from '@deepseek-ai/dsh-control-plane'
import type { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import { meterRun } from '@deepseek-ai/dsh-run-metering'

declare const ledger: RunLedger
declare const runId: RunId
declare const provider: AsyncIterable<StreamChunk>

export const metered = meterRun(provider, runId, {
  remaining: id => ledger.remaining(id),
  charge: (id, spend) => Promise.resolve(ledger.charge(id, spend)),
})
```

只要运行还负担得起，结果就是同一条流。已经有调度器的部署不直接调用它 —— [`dsh-run-scheduler`](../run-scheduler/README.zh.md) 的 `meter` 把它绑定到那个运行时的账本以及它的持久计费上。

### 读出是什么提前结束了一次调用

```ts
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { RUN_BUDGET_EXHAUSTED, RUN_NOT_OPEN } from '@deepseek-ai/dsh-run-metering'

export function endedByBudget(chunk: StreamChunk): boolean {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return false
  return chunk.reason.failure.code === RUN_BUDGET_EXHAUSTED || chunk.reason.failure.code === RUN_NOT_OPEN
}
```

两种结束都是一个终止的 `error` finish，而不是抛出的异常，因为 [`dsh-llm`](../../llm/llm/README.zh.md) 缝隙向消费方承诺的是恰好一个终止块，而异常不是其中之一。

`refusedCall` 为这样一种调用方构造同样的结局：它在 `meterRun` 之前就判定这次调用无法被计量 —— 因为它说不出该记到哪次运行头上。[`dsh-run-scheduler`](../run-scheduler/README.zh.md) 把它用在一个被两次开启中运行同时认领的会话上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `meterRun`、它的端口，以及那两个失败码 |
| — | 不发布运行时不变量伴随模块；这里产出的流语法已经由 [`dsh-llm`](../../llm/llm/README.zh.md) 自己的不变量强制执行。 |

### 为什么拒绝发生在调用提供方之前

一条流至多携带一次用量，而且通常靠近末尾，因此一次已经花光的运行否则会把整次调用做完，再从那个恰好把钱花掉的块里得知自己负担不起。先读剩余额度，才是让一次已耗尽的运行停止发起调用，而不是停止对结果感到意外。

那次检查也是为什么计费落在终止块抵达消费方之前：agent 循环一看到 finish 就会索要下一次调用，而事后才施加的计费会让它多做一次调用。

### 为什么切断的是一次调用，而不是那次运行

流结束了；运行仍然开启，它的记录上带着这次调用消耗掉的东西。在这里结束运行，会替启动它的那一方做决定 —— 调用方可以报告这次耗尽、申请更多额度，或者结算。本包保证的是工作会停下来。

### 为什么 token 数来自 `dsh-llm`

`billedTokens` 是那个包自己的推导，也是它唯一存在的地方。它优先采用提供方精确的 `totalTokens`；没有的时候，它把四个不相交的计数全部相加 —— `inputTokens` 只是未命中缓存的输入，因此一次提示词大部分命中缓存的调用，否则会按其实际成本的一小部分被计费。`reasoningTokens` 已经包含在 `outputTokens` 里，不再重复相加。

它刻意不是 `dsh-token-meter` 的上下文压力基线 —— 那里只把不相交的计数相加：当问题是「上下文窗口有多满」时，较小的那个数字才是保守的；而当问题是「这次调用花了多少」时，较大的那个才是对的。

### 为什么未报告的费用不等于零花费

`TokenUsage.costMicroUsd` 只在提供方报告了一个已计费数字时才出现。缺失意味着「未报告」，因此一次跑在沉默提供方上的运行按 token 与时间计量，而它的金额维度不会移动。在这里从价目表推导一个数字，会与真正被报告的数字无法区分，而且在部署合约不是标价的任何地方都是错的。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-run-ledger`](../run-ledger/README.zh.md) —— 这里读到的剩余额度在哪里推导出来，以及计费在哪里被记录。
- [`dsh-run-scheduler`](../run-scheduler/README.zh.md) —— 把本包绑定到持久计费上的那个运行时。
- [`dsh-llm`](../../llm/llm/README.zh.md) —— 流的词汇表，以及每一条被计量的流仍然满足的那套语法。
- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md) —— 子运行不得超出其父运行 token、时间与成本授权的那条规则。

-----

<a id="model-experience"></a>
## 模型体验

### 一次运行负担不起的调用

#### 模型看到什么

计量本身的任何东西都看不到。拒绝与切断都是提供方流上终止的 `error` finish 块，用的是提供方失败所用的同一套词汇，因此消费方在它本来就处理失败调用的地方处理它们。一次切断会留下提供方已经流出的那部分内容；这部分内容由消费方决定保留还是丢弃，而本包不写入任何属于自己的内容。

#### token 影响

不新增。这里数出来的每一个 token，都是提供方为消费方所要求的一次调用开出的账。改变的是哪些调用会发生：一次已耗尽的运行根本不会再发出请求，因此一次被拒绝的调用本会花掉的 token 从未被花掉。

#### KV 缓存影响

没有。请求不被触碰，因此一次被计量的调用拥有的前缀与缓存身份，与它未被计量时完全相同。一次被拒绝的调用不发出请求，因此它既不读也不写提供方缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些是本包当前的约束，不是任务积压。

- **沉默的流不会被切断** —— 挂钟时间是在块抵达时检查的，因此一个不发出任何东西就卡住的提供方会在无人察觉的情况下跑过它的截止时刻。`dsh-run-ledger` 的租约才是界定被遗弃运行的东西；本包界定的是话多的那种。
- **token 每次调用只计一次费** —— 一条流至多报告一次用量，因此过长的单次回复只有在它结束时才被量出来。挂钟切断界定的是这一次调用；token 切断界定的是下一次。
- **并发的调用各自读到同一份剩余额度** —— 针对同一次运行计量的两条流，都是针对谁都还没记过账的那份额度起步的。调用彼此重叠的运行，每条流可能超出一次调用的量。
- **写不下去的计费是抛出，而不是收尾** —— 两种预算结局都是终止块，但一次被拒绝的计费会以抛出的方式离开这条流。这正是 [`dsh-llm`](../../llm/llm/README.zh.md) 缝隙对中间件失败的说法，而它意味着一个只处理失败调用的消费方，还需要处理失败的介质。
- **不传播任何取消** —— 一次切断会停止读取源，并让生成器把它关掉。无视这一点的提供方会一直跑到启动它的那一方去收割它为止。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景 —— 点击展开</summary>

无。

</details>
