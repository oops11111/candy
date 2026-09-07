---
description: "dsh-llm 适配器对自身运行的共享生命周期与密钥处理契约套件，供适配器作者验证取消、清理与凭据不外泄。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-adapter-contract

[English](README.md) | 中文

## 概述

`dsh-llm-adapter-contract` 承载 `dsh-llm` 适配器契约中类型签名无法表述、[`dsh-llm/invariant`](../../llm/llm/README.zh.md) 也看不到的那一部分。那个校验器已经在每条已注册的提供方流周围强制执行 chunk 文法 —— 块的配对、唯一的 usage、唯一的终止 finish、其后不得再有内容。本套件覆盖其余部分：被取消的运行是否会落定，被放弃的运行是否释放了它启动的东西，以及适配器持有的凭据能否通过它产出的 chunk、错误或诊断信息到达调用方。

适配器包在自己的 spec 文件中调用 `testLlmAdapterContract`，并提供其测试设施能够编排的那些运行。本套件对传输方式不作任何假设，因此同样这八个用例既能跑在 HTTP 提供方上，也能跑在被启动的 CLI 上。

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

```ts
import { testLlmAdapterContract } from '@deepseek-ai/dsh-llm-adapter-contract'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

declare const SECRET: string
declare function viaSeam(script: 'ok' | 'fail' | 'leak' | 'open'): AsyncIterable<StreamChunk>
declare function releasedSoFar(): boolean

testLlmAdapterContract({
  name: 'MyAdapter',
  secret: SECRET,
  run: () => viaSeam('ok'),
  failingRun: () => viaSeam('fail'),
  leakingRun: () => viaSeam('leak'),
  openRun: () => ({ chunks: viaSeam('open'), released: releasedSoFar }),
}, { describe, it, expect })
```

### 每条流都必须来自缝隙

`run`、`failingRun` 与 `openRun` 返回的是 `LlmRuntime.stream()` 产出的东西，绝不是适配器自己的 `stream()`。这是关键而非风格问题：恰好一个终止 chunk 的保证属于运行时，是它把适配器的抛出转换成终止的 `error` 或 `aborted` finish。适配器完全可以选择抛出而不产出 finish —— `dsh-llm-deepseek` 就是这样 —— 因此一个对着原始适配器运行的套件会让合规的适配器失败，同时测试一份没有调用方依赖的契约。

### 每种运行必须是什么

| 运行 | 提供方做什么 |
|---|---|
| `run` | 产出内容并正常结束；当套件传入 `signal` 时遵守它 |
| `failingRun` | 在适配器已经提交之后失败 —— 凭据被拒、配额耗尽、崩溃 |
| `leakingRun` | 以凭据被引述在提供方自己文本里的方式失败 —— 例如一个点名了被拒密钥的错误响应体 |
| `openRun` | 产出至少一个 chunk，然后停下而不结束，代表仍然存活的进程或连接 |

`secret` 必须是适配器构造时所用的那个确切凭据。套件会在每个 chunk、每条消息与每个嵌套错误属性中搜索该字符串；若给的是占位符，它会通过，却什么也没有证明。

`leakingRun` 之所以存在，是因为 `failingRun` 自己证明不了脱敏。一份从行为良好的提供方录制来的 fixture 里没有凭据，因此无论适配器是否移除凭据，那条断言都会通过 —— 它量的是 fixture。把提供方脚本成会把密钥引述回来，同一条断言就转而量适配器了。要按那个提供方真会泄漏的方式来写；把秘密注入到适配器根本不会读的地方，同样什么也证明不了。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `testLlmAdapterContract`、被测对象与 harness 接口，以及泄漏搜索 |
| — | 不发布运行时不变量伴生模块；本包是仅用于测试的基础设施，不注册任何东西，也不拥有运行时关系。 |

### 为什么释放是轮询而不是直接断言

释放一次被放弃的运行并不总是同步的。终止进程树是同步的；关闭套接字则在之后的一个 tick 才完成。若在消费方停止读取后立刻断言，会让一个合规的 HTTP 适配器失败，因此这项观察改为轮询到一个截止时间 —— 释放及时时很快，而释放始终不来时是失败而不是挂起。

### 为什么泄漏搜索不止看 message

凭据会从适配器没有想到的那个字段抵达调用方。因此搜索会把每个值完全摊平：错误的 message、name、stack 与 `cause` 链，以及每个嵌套对象的每个属性，并带环路保护。只搜索 `error.message` 会漏掉一个回显了请求的提供方错误。

### 套件测试它自己

一个不会失败的一致性套件比没有更糟，因为它报告了自己并未挣得的信心。它自己的 spec 用刻意不合规的被测对象来驱动它 —— 一个永不结束的运行、一个结束两次的运行、一个从不释放的适配器，以及把密钥分别放进 chunk、放进报告出的失败、放进抛出的错误、放进没有 stack 的错误 —— 并断言是哪个用例拒绝了它。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-llm`](../../llm/llm/README.zh.md) —— `LlmAdapter` 契约、`StreamChunk` 协议，以及把适配器抛出规范化的运行时。
- [`dsh-llm-deepseek`](../../llm/llm-deepseek/README.zh.md)、[`dsh-llm-claude-cli`](../../llm/llm-claude-cli/README.zh.md) 与 [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) —— 这条缝隙上的每一个适配器都运行本套件，两个走 HTTP，一个走被启动的进程。
- [提供方适配器一致性](../../../.agents/notes/implemented/architecture/2026-09-03-llm-adapter-conformance.zh.md) —— 为什么这些性质放在一个共享套件里，以及运行它发现了什么。

-----

<a id="model-experience"></a>
## 模型体验

None, as this test-only suite sends no request to a provider model; it observes chunks the adapter under test already produced.

#### KV 缓存影响

None; this package neither assembles nor sends a provider request.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是本包当前的约束，不是任务清单。

- **场景由被测对象自己提供** —— 套件无法让一个提供方失败或挂起，因此测试设施无法编排这些运行的适配器就无法被覆盖。当前每一个被测对象都在传输层编排它们（一个模拟 HTTP 服务器、一个被脚本化的进程句柄）。
- **只有当密钥原样出现时才会被发现** —— 若凭据经过编码、哈希或截断后到达调用方，则能通过搜索。这项检查针对的是「值被原样透传」这一常见情形，而不是对抗性的编码者。
- **超时、配额与崩溃是一个用例而不是三个** —— 计划的夹具清单把它们分开列出，但它们到达适配器时都是一次失败的运行，而套件断言的是适配器必须拿一次失败怎么办，而不是它由什么引起。要区分它们的适配器需要为该区分自备测试。
- **不检查 chunk 文法** —— 那是 `dsh-llm/invariant` 在已注册流周围的职责，在这里重复一遍会让同一条规则出现在两个地方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- harness 参数之所以存在，是因为本套件是一个库而不是 spec 文件，vitest 的全局变量对它不可用。若将来落地了仓库级的 test-globals 决定，这个参数就可以去掉。

</details>
