---
description: "按既定顺序一次性完成准入、拨款与放置,使一次失败的放置不会让父运行少掉一份没有任何人在花的额度。"
kind: "package-library"
---

# @deepseek-ai/dsh-run-start

[English](README.md) | 中文

## 概述

[control-plane 组](../README.zh.md)只按一个顺序组合,而[子系统页面](../../../docs/subsystems/candy-control-plane.zh.md)陈述了那个顺序是什么、每一步为什么在它所在的位置。在本包出现之前,没有任何东西执行它:每个调用方都自己把这段序列写一遍,而它们没有一个会在后续步骤被拒时把已经持有的东西撤回去。

`startRun` 执行准入、开启与放置,并拥有它们之间的回滚。那次回滚,正是它存在、而不是被留作三次连续调用的理由。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 启动一次运行

```ts
import { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import { startRun } from '@deepseek-ai/dsh-run-start'
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'

declare const policy: RunAdmissionPolicy
declare const ledger: RunLedger
declare const token: string

const outcome = await startRun({ token }, policy, {
  ledger,
  share: run => run.budget,
  leaseExpiresAt: Date.now() + 60_000,
}, Date.now())

export const started = outcome.started ? outcome.value.run.poolRoot : outcome.rejection.stage
```

`share` 在这次运行的身份已知之后,选择用多少额度开启它。根运行通常按准入给出的额度开启;子运行则按它父运行所委派的份额开启,而当那个份额超出父运行所持有的量时,账本会拒绝它。

返回的东西还没有在跑。绑定提供方、流式读取它、为它花掉的东西计费,以及关闭这次运行,都仍归调用方 —— 在它调用 `close` 之前,账本记录一直开着。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `startRun`、它的选项,以及结果与拒绝类型 |
| — | 不发布运行时不变量伴随模块;本模块不拥有事件流,而它持有的那一条关系由单元测试检查。 |

### 为什么回滚才是重点

`RunLedger.openChild` 在子运行开启的那一刻,就把它的额度从父运行那里扣掉。而创建池目录是可能被拒的 —— 部署从未准备过的基目录,或者被植入在根目录位置上的一个链接。一段开启了记录就停在那里的序列,会让父运行少掉一份没有任何人在花的额度,直到租约到期。

这条记录会在退出路上被关掉,于是那份占用立刻回来。失败继续往上抛:它是一次部署错误,不是一次被拒绝的运行。

### 为什么绑定不在这里

绑定提供方不分配任何东西,因此它不需要回滚;而它与提供方相关,这里的每一步都不是。把它挡在外面,本包就是面向所有提供方的一段组合,而不是每个提供方一段。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Candy 控制平面](../../../docs/subsystems/candy-control-plane.zh.md) —— 本包所执行的顺序,以及每一步决定什么。
- [`dsh-run-admission`](../run-admission/README.zh.md) —— 准入这一步,以及部署方提供的那三个端口。
- [`dsh-run-ledger`](../run-ledger/README.zh.md) —— 本包开启并关闭的那条记录。
- [`dsh-runtime-pool`](../runtime-pool/README.zh.md) —— 放置这一步。
- [多租户 CLI agent 运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是本包当前的约束,不是任务积压。

- **它启动一次运行,而不运行它** —— 绑定提供方、流式读取它、为它花掉的东西计费以及关闭记录,都仍归调用方。本包不持有任何进程,也不持有任何流。
- **不做调度决定** —— 哪一次运行开始、以什么顺序开始,以及某个租户到底还能不能再开一次,都属于本次发布尚未构建的调度器。本包是那个决定做出之后,一次运行所要走的那段序列。
- **账本在内存里** —— 一次重启会丢失每一个开启中的运行,正如 [`dsh-run-ledger`](../run-ledger/README.zh.md) 所记录的那样。回滚在一个进程之内把占用还回去;它无法找回一次崩溃所搁浅的占用。
- **没有 Cordis 服务** —— 本包不在 `Context` 上注册任何东西;它被直接导入。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景 —— 点击展开</summary>

无。

</details>
