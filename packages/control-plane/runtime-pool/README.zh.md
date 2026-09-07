---
description: "Candy 的运行时池键,以及一个池所拥有的那一个目录:按租户、提供方与提供方账户划分、互不碰撞且无法越界的根目录。"
kind: "package-library"
---

# @deepseek-ai/dsh-runtime-pool

[English](README.md) | 中文

## 概述

`dsh-runtime-pool` 为之后每一个包用同一种方式回答一个问题:哪些运行时状态可以共享,以及一个池的私有状态存放在哪里。`runtimePoolKey` 把租户、提供方与提供方账户变成一个隔离键,`runtimePoolRoot` 再把这个键变成该池所拥有的唯一目录。这个键是小写十六进制摘要而不是三元组的文本,因此两个租户绝不会落到同一个目录中,任何不透明 id 也无法越出基准目录。本包是一个普通模块,没有 Cordis 服务,也不访问文件系统:它只推导路径,而创建、填充与删除这些路径由管理池的运行时负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 推导一个池的键与目录

```ts
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'
import { runtimePoolKey, runtimePoolRoot } from '@deepseek-ai/dsh-runtime-pool'

const key = runtimePoolKey({
  userId: UserId('user-1'),
  provider: 'claude-cli',
  accountId: ProviderAccountId('account-1'),
})

export const root = runtimePoolRoot('/srv/candy/pools', key)
```

`provider` 是来自 [`dsh-control-plane`](../control-plane/README.zh.md) 的 `ProviderKind`:取 `deepseek-api`、`claude-cli`、`codex-cli` 之一,这是一个封闭集合,因为交付计划恰好点名了这三个。它放在那里而不是这里,因为账户、断言与池都会命名它。基准目录必须在 POSIX 或 Win32 语法下是绝对路径，并且由基准目录自身的语法决定如何拼接 —— 一个跑在 Linux 上的控制平面会解析某台 Windows 主机的池根目录，而本平台的 `path.join` 会给出另一种分隔符。两种语法下都不是绝对路径的基准目录会抛出错误，而不是被相对于工作目录解析。

### 创建一个池的目录

```ts
import { openRuntimePool, runtimePoolKey } from '@deepseek-ai/dsh-runtime-pool'
import { ProviderAccountId, UserId } from '@deepseek-ai/dsh-control-plane'

const pool = runtimePoolKey({
  userId: UserId('user-1'),
  provider: 'claude-cli',
  accountId: ProviderAccountId('account-1'),
})

export const home = await openRuntimePool('/srv/candy/pools', pool)
```

权限是被施加的,而不是被请求的。`mkdir` 只对它自己创建的目录设置模式,因此一个由先前运行、运维人员或不同 umask 留下的池根目录,会保留它原本的权限,而下一次运行会把租户的提供方凭据写进去。之后那次显式的修改,才使 `0o700` 成为该调用所返回的那个目录的事实,而不只是它恰好创建了的那个目录的事实。

基目录从不被创建。一个不存在的池基目录意味着部署从未准备好它的存储,而在一个写错的路径下、以其祖先所隐含的任意权限凭空造出整棵树,是把这件事藏起来而不是报告出来,因此缺失的基目录会抛出异常。准备基目录、以及决定谁可以在其中写入,都仍归部署所有:如果另一个本地账户能在它旁边创建目录,任何池都不可能对其租户私有。

在池所在位置上已经存在的东西,必须是一个真正的目录。`chmod` 会跟随符号链接,因此在那里被植入的一个链接,会把模式送到它的目标上,并把那个目标当作 home 交给这个租户 —— 而一个指向另一个租户池根目录的链接,属主与本进程相同,因此没有任何权限检查会拦住它。`lstat` 描述的是那个条目本身,因此这个链接会被看见并被拒绝。

打开一个已经存在的池,正是第二次运行加入它的方式,因此该调用是幂等的,并保留池中已有的内容。

### 什么属于根目录之下,什么不属于

一个池的所有私有内容都放在它的根目录下:已认证的提供方主目录、可写的提供方配置、环境覆盖、私有缓存与会话状态。不可变的 CLI 二进制文件与共享包缓存留在其外——这些正是池被允许共享的内容。

### 从存储中读回一个键

```ts
import { parseRuntimePoolKey } from '@deepseek-ai/dsh-runtime-pool'

declare const stored: string

const key = parseRuntimePoolKey(stored)
export const usable = key === undefined ? 'reject the record' : key
```

存储中的键是以普通文本形式到达的,因此它会先对照签发时所产生的语法接受检查,然后才重新成为 `RuntimePoolKey`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `RuntimePoolIdentity`、`RuntimePoolKey`、`runtimePoolKey`、`parseRuntimePoolKey` 与 `runtimePoolRoot` |
| — | 未发布运行时不变式伴生模块;这个纯模块不拥有事件流或可变运行时数据;其键代数由单元测试强制保证。 |

### 为什么键是摘要而不是三元组

租户与账户 id 是本仓库不加约束的不透明字符串。若直接写进路径,其中之一可能用 `../` 越出基准目录、超出平台路径长度上限,或者——在大小写不敏感的文件系统上——把两个仅大小写不同的租户折叠到同一个目录中,这是一种跨租户泄漏,而后续任何检查都不会察觉。64 个字符的小写十六进制摘要不具备这些性质。

摘要的输入带有长度前缀,因此任何两个不同的三元组都无法通过移动字段之间的边界而发生碰撞:`('ab', 'c')` 与 `('a', 'bc')` 的摘要不同。

### 为什么没有自由形式的键构造函数

`RuntimePoolKey` 只能来自 `runtimePoolKey`(签发)或 `parseRuntimePoolKey`(先检查语法)。由于没有任何构造函数接受任意文本,`runtimePoolRoot` 不可能收到一个能越出基准目录的键——这种约束是类型的性质,而不是每个调用点都必须重复的检查。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

阅读这些页面,了解本包所实现的隔离规则,以及它所依据的 id。

- [Candy 运行时边界](../../../docs/candy-runtime-boundaries.zh.md)——池可以共享与不可共享的内容,以及本约束所关闭的进程逃逸与路径遍历滥用场景。
- [多租户 CLI 代理运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md)——提议中的 R1–R6 交付计划;本包对应 R1 的池键分区条目。
- [`dsh-control-plane`](../control-plane/README.zh.md)——构成池身份的 `UserId` 与 `ProviderAccountId`。
- [`dsh-credential-vault`](../credential-vault/README.zh.md)——池的提供方进程用以认证的密钥,它们绝不跨池共享。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前包的约束,不是任务积压。

- **池只被创建,从不被删除**——`openRuntimePool` 创建一个池根目录并使其私有;属主、配额,以及池退役时的清理都属于管理池的运行时。`runtimePoolRoot` 对只需要路径的调用方而言仍是一次纯推导。
- **不检查池基目录自身的权限**——一个另一个本地账户可写的基目录,会让该账户在本包见到之前,就在池根目录该在的位置放上点什么。其中两种会被拒绝:符号链接或任何非目录都过不了条目检查,而属主是别人的目录会让模式修改以 `EPERM` 失败。至于该账户创建、而本运行时拥有的目录,则与先前某次运行留下的目录无法区分,因此把基目录准备成私有的仍是部署的职责 —— 而在 Windows 上是 `dsh-sandbox-windows-acl` 的职责,因为 POSIX 模式位并不描述该平台的访问控制。
- **不强制配额、进程或事件日志分区**——边界页面同样按池键分区配额、进程归属与事件日志。本包提供这些分区所共享的键;强制执行它们需要 R1 尚未构建的调度器与会话存储。
- **没有环境覆盖**——池的提供方进程接收哪些变量(包括其主目录指向何处)与提供方相关,属于 R2 的适配器。
- **刻意不给出子目录布局**——本包只命名每个池的一个根目录,其内部结构留给拥有者,以免在消费者需要之前就发明一套分类。
- **没有 Cordis 服务**——本包中没有任何东西注册到 `Context` 上;它像 `dsh-brand` 一样被直接导入。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
