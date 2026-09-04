---
description: "把一次被准入的运行变成 Claude CLI 的启动事实，将一个进程限制在一个租户的主目录、凭据与花费上限之内。"
kind: "package-library"
---

# @deepseek-ai/dsh-claude-cli-binding

[English](README.md) | 中文

## 概述

`dsh-run-admission` 回答一次运行属于谁、它可以打开哪份凭据、它拥有哪个目录，以及它可以花多少。[`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.zh.md) 在一个主目录、一把 API 密钥和一个花费上限之下运行 `claude` 进程。两者是相互对着建起来的，却没有任何东西把它们接上，因此把它们接起来的部署要手工挑选主目录、密钥与上限 —— 而这恰恰是选错就等于跨租户泄漏、而不只是一个 bug 的地方。

本包就是那个接点，形式是一次调用，其唯一与运行相关的输入就是那次被准入的运行。池根目录成为 CLI 的 `HOME`，被打开的密钥成为它的 API 密钥，被准入的预算成为它的花费上限，因此调用方无法把一个租户的目录和另一个租户的凭据配在一起还能通过类型检查。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 启动一次被准入的运行

```ts
import { bindClaudeCliRun } from '@deepseek-ai/dsh-claude-cli-binding'
import type { ClaudeCliAdapterOptions } from '@deepseek-ai/dsh-llm-claude-cli'
import type { AdmittedRun } from '@deepseek-ai/dsh-run-admission'

declare const run: AdmittedRun
declare const spawn: ClaudeCliAdapterOptions['spawn']

const deployment = { executable: '/opt/candy/bin/claude', graceMs: 5_000, maxOutputBytes: 16 * 1024 * 1024 }
const result = bindClaudeCliRun(run, deployment, run.budget)

export const options: ClaudeCliAdapterOptions | undefined = result.bound
  ? { ...result.binding, spawn }
  : undefined
```

部署只提供该主机上每个租户共享的那些值 —— 可执行文件路径和终止宽限时间。一切在租户之间有差异的值都从运行里读取。

第三个参数是*这一次调用*可以花的额度。一次运行每做一次模型调用就发起一次调用，而 CLI 是按调用强制它的上限的，因此一次每回都带着被准入预算的运行，可以每调用一次就花掉一遍那份预算。持有 [`dsh-run-ledger`](../run-ledger/README.zh.md) 记录的调用方传入该记录的剩余额度；一次运行的第一次调用传入 `run.budget`。

### 凭据只会被拒绝，不会被修补

绑定会在两种情形下失败：被打开的密钥无法成为环境变量 —— 它为空、它不是 UTF-8，或者它带有 NUL 或换行 —— 或者额度已经什么都不剩。拒绝会点名是哪一种，并且不产生任何启动。剥掉某个字节会注入一把谁也认证不了的密钥，而运维人员遇到它时会是一次无从解释的提供方拒绝，而不是这里一次具名的拒绝。

### 凭据隔离不是部署可选项

绑定始终设置 `requireCredentialIsolation`，因此 CLI 报告自己用了注入密钥以外的任何凭据时，运行就会失败。抵达本包的每一次运行都恰好是为一个租户准入的；一次够到了别的凭据的运行，花的是一个并未授权它的租户的钱。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `bindClaudeCliRun`、`ClaudeCliDeployment`、`ClaudeCliRunBinding` 与各项绑定拒绝 |
| [`tests/tenant-isolation.spec.ts`](tests/tenant-isolation.spec.ts) | 端到端的整条链路：签发、准入、绑定，并运行一个会报告自己实际拿到的环境的真实进程；随后检验取消或放弃该运行会把它以及它启动的那个进程一并回收 |
| — | 不发布运行时 invariant 伴生包；这个纯模块不拥有事件流或可变运行时数据，它组装出的值由单元测试强制。 |

### 为什么池根目录既是工作目录也是主目录

`HOME` 是把一个租户的 CLI 状态与另一个租户分开的东西，而工作目录决定一个忽略自身参数的进程会落在哪里。在 `--bare` 之下 CLI 不从工作目录读取任何东西，因此把它指向该租户自己的池不付出任何代价，却移除了一次启动本可能从启动它的东西那里继承来的那一个目录。

池根目录按构造就是绝对路径：`runtimePoolRoot` 拒绝相对基准目录，因此每一次被准入的运行携带的都是绝对路径，本模块不再重复检查。

### 为什么花费上限是推导出来的而不是配置出来的

`RunBudget.costMicroUsd` 是可以花的额度，单位是整数微美元；而 CLI 的 `--max-budget` 单位是美元。在这一处做除法，让整数算术留在预算里，让美元数字留在进程参数上。一个由部署配置的上限会是第二个限额，它可能与被准入的那个不一致，而这种不一致会以一张账单的形式被发现。

额度之所以是参数而不是运行的一个字段，是因为运行被准入时的预算只对它的第一次调用是正确的。CLI 把上限施加在一次调用上，因此这个上限必须随运行的花费而下降；一个从不计费的调用方得到的是按调用而非按运行的限额，而 README 在这里把这一点写出来，而不是留给别人去发现。

一份什么都不剩的额度会被拒绝，而不是被换算。`claudeCliArguments` 拒绝零上限，因此绑定一次已花光的运行的调用方，会在流开始时从适配器内部撞上一个 `RangeError`，而不是在它提供额度的地方得到一次具名的拒绝。`children` 不在考察之列 —— 没有委派名额的运行仍然可以做自己的工作。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-run-admission`](../run-admission/README.zh.md) —— 产出本包所绑定的那次运行的准入。
- [`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.zh.md) —— 这些启动事实所配置的适配器。
- [`dsh-runtime-pool`](../runtime-pool/README.zh.md) —— 池键，以及成为 CLI 主目录的那个目录。
- [`dsh-run-budget`](../run-budget/README.zh.md) —— 花费上限由之推导的那份额度。
- [多租户 CLI agent 运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— 本接点所属的 R1–R6 交付计划。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

以下是本包当前的约束，不是任务清单。

- **不创建也不校验池目录** —— 绑定把它点名为 CLI 的主目录，而启动到一个没人创建过的目录会在 spawn 处失败。用正确的属主与权限位创建它、并证明没有别的租户能读它，属于拥有文件系统的那个部署。
- **凭据的生命周期仍归调用方** —— 绑定把被打开的密钥复制进一个与适配器同寿的字符串。事后把调用方的 `Uint8Array` 清零并不会触及那份副本。
- **目前还没有消费者接上它** —— 仓库里没有任何东西启动按运行划分的 Claude CLI 适配器，因为那个会持有「一次被准入的运行对应一个进程」的调度器属于尚未交付的 R3 工作。
- **只覆盖 Claude CLI** —— 一次 Codex CLI 运行需要针对它自己的启动事实写自己的绑定，而那在该适配器存在之前无法写出。
- **没有 Cordis 服务** —— 这里没有任何东西注册到 `Context` 上；它被直接导入。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
