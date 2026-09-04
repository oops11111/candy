---
description: "一个 Candy 运行时的实时运行状态:一次运行据以被准入的账本与重放存储,以及释放无人结算之占用的那个时钟。"
kind: "package-reference"
---

# @deepseek-ai/dsh-run-scheduler

[English](README.md) | 中文

## 概述

本服务所组合的每一样东西,原本都已经作为库存在。原本不存在的是一个主人。账本与重放存储是按运行时存在的对象,却没有任何东西持有它们;准入策略必须在每一个调用点手工拼装;而 `RunLedger.expire` 是一次没有任何时钟去发起的调用,于是一次未经结算就被遗弃的运行,会一直占着它父运行的额度,直到有人想起来去回收。

`ctx.runScheduler` 持有那份状态,从一份执行断言启动一次运行,并驱动那个时钟。它不是策略:某个租户到底还能不能再开一次运行,以及排队的请求以什么顺序运行,这些决定这里都不做。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 组合它

```yaml
- id: run-scheduler
  name: '@deepseek-ai/dsh-run-scheduler'
  config:
    issuer: candy-control-plane
    audience: candy-runtime-debian-1
    credentialKeyVersion: 2026-09-a
    poolBase: /srv/candy/pools
```

它需要 [`dsh-control-plane-store`](../control-plane-store/README.zh.md) 来读取账户与额度,以及 `timer` 服务来提供时钟。两个秘密都以环境变量名的形式指名,而不是写进组合里:`assertionSecretEnv`(默认 `CANDY_ASSERTION_SECRET`)与 `credentialKeyEnv`(默认 `CANDY_CREDENTIAL_KEY`)。其中任何一个未设置都会让启动失败,而一个不是 32 字节的凭据密钥同样会 —— 保险库正是以那个长度密封的。

### 启动一次运行

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-run-scheduler'

declare const ctx: Context
declare const token: string

const outcome = await ctx.runScheduler.start(token)

export const started = outcome.started ? outcome.value.run.poolRoot : outcome.rejection.stage
```

`start` 接收那份断言,以及可选的、这次运行据以开启的额度。根运行默认用准入为它给出的那一份;子运行则用它父运行所委派的份额开启,而账本会拒绝超出该父运行所持有量的份额。

返回的东西不在运行。把提供方绑定到它上面、流式读取那个提供方、以及为它花掉的东西计费,都仍归调用方 —— `charge` 与 `close` 在本服务上,而这次运行的记录在 `close` 之前一直开着。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Config`、`RunScheduler` 服务、它的准入策略,以及那次清扫 |
| — | 不发布运行时不变量伴随模块;这里的关系属于账本与存储,而组合测试端到端地检查它们。 |

### 为什么一个实例拥有一个账本

这个运行时准入的每一次运行,都记在同一批委派树与同一批已消费 nonce 上。两个实例会各自认为自己持有全部额度,而委派上限在哪一个里都不成立 —— 这与 `dsh-run-ledger` 要求父运行与它的子运行共享一个实例,是同一个理由。

### 为什么预算查找是被组合出来的,而不是被转交出去的

根运行是针对它租户的额度被准入的,那份额度由存储持有。子运行是针对它**父运行**的剩余被准入的,那份剩余由本服务的账本持有。一个还剩很多的租户,可以有一个已经耗尽的父运行,因此拿租户自己的额度去回答子运行会让这项检查失效。这两种生命周期 —— 按部署持久的,与按运行时在内存里的 —— 只在这里相遇。

### 为什么时钟是服务该操心的事

`expire` 释放租约已过的占用,而 `evict` 丢掉那些已经无法拒绝任何东西的 nonce 记录。两者都不改变调用方本可以自己做出的决定;两者界定的都是运行时持有多少。持有自己决策时间戳的调用方可以直接调用 `sweep`,测试正是这么做的。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Candy 控制平面](../../../docs/subsystems/candy-control-plane.zh.md) —— 本服务所执行的组合顺序。
- [`dsh-run-start`](../run-start/README.zh.md) —— 准入、开启与放置,以及它们之间的回滚。
- [`dsh-run-ledger`](../run-ledger/README.zh.md) —— 本服务开启、计费、关闭并令其到期的那条记录。
- [`dsh-control-plane-store`](../control-plane-store/README.zh.md) —— 它所读取的持久账户与额度。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是本包当前的约束,不是任务积压。

- **没有调度策略** —— 它启动调用方要求的那次运行。某个租户到底还能不能再开一次、跨不相关的树同时能有多少个存活,以及排队的请求以什么顺序运行,这些决定目前都没有任何东西做出。
- **实时状态在内存里** —— 一次重启会丢失每一个开启中的运行以及它所携带的占用。存储保住账户与额度;持久的运行记录需要一套崩溃也毁不掉的结算说法。
- **只有一个凭据密钥** —— 配置只指名一个版本,因此这个密钥环打不开一个用已退役密钥密封的信封。轮换需要密钥环携带的不止当前那一把。
- **没有花费回写** —— `charge` 把一次运行的花费移进账本;没有任何东西把它折进租户持久的额度里,因此重启会忘掉花掉了什么。
- **它不运行提供方** —— 绑定、流式读取与取消都仍归调用方;本服务不持有任何进程,也不持有任何流。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景 —— 点击展开</summary>

无。

</details>
