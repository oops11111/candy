---
description: "持久保存的提供方账户与租户额度,使准入所要求的凭据与预算查找由一种介质来回答,而不是继续悬在参数上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-control-plane-store

[English](README.md) | 中文

## 概述

[`dsh-provider-accounts`](../provider-accounts/README.zh.md) 把它的账户存储定义成一个端口,而 [`dsh-run-admission`](../run-admission/README.zh.md) 把凭据查找与预算查找也要求为端口。它们每一个都是没有任何部署能填上的参数,因为仓库里没有任何东西持有那些数据。

本服务持有它们:提供方账户连同它们密封的凭据、每个租户的额度、每一次存活运行的一条记录,以及一条记录每个租户的调度尝试做了什么的踪迹,都放在一个走 SQLite 后端的[存储域](../../../docs/subsystems/storage.zh.md)里。重启之后它们还在 —— 这正是重点。

它不是账本。`RunLedger` 仍然是记账权威,回答一次运行还能花什么;住在这里的是能挺过重启的那条记录,以及让一次被打断的结算恰好完成一次的那两个标记。

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
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-sqlite
  name: '@deepseek-ai/dsh-storage-sqlite'
  config:
    path: /var/lib/candy/candy.db
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: sqlite
- id: control-plane-store
  name: '@deepseek-ai/dsh-control-plane-store'
```

本服务自己不接受任何配置:哪种介质服务这个域,是域插件的路由决定,而不是本包的。

### 回答准入所要求的那些端口

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-control-plane-store'
import type { UserId } from '@deepseek-ai/dsh-control-plane'
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunBudget } from '@deepseek-ai/dsh-run-budget'
import type { RunLedger } from '@deepseek-ai/dsh-run-ledger'
import { remainingAllowance } from '@deepseek-ai/dsh-tenant-allowance'

declare const ctx: Context
declare const ledger: RunLedger
declare const partial: Omit<RunAdmissionPolicy, 'findBudget' | 'findCredential'>
/** The reservation of every run of one tenant that is still open. */
declare function heldByTenant(userId: UserId): readonly RunBudget[]

async function tenantRemaining(userId: UserId): Promise<RunBudget | undefined> {
  const allowance = await ctx.controlPlaneStore.tenantAllowance(userId)
  return allowance === undefined ? undefined : remainingAllowance(allowance, heldByTenant(userId))
}

export const policy: RunAdmissionPolicy = {
  ...partial,
  findCredential: claims => ctx.controlPlaneStore.findCredential(claims),
  findBudget: claims => claims.parentRunId === undefined
    ? tenantRemaining(claims.userId)
    : Promise.resolve(ledger.remaining(claims.parentRunId)),
}
```

`findBudget` 是被组合出来的,而不是整个由本服务提供,而这正是这次拆分的用意。两半单独拿出来都不是答案。子运行是针对它**父运行**的剩余额度被准入的,而那份剩余由内存中的 `RunLedger` 持有;拿租户自己的额度去回答一个子运行,会让这个端口存在的那项检查失效。根运行则是针对本服务的持久额度**减去该租户的开启中运行正扣着的部分**被准入的,而那部分由同一个账本知道、本服务并不知道。[`dsh-run-scheduler`](../run-scheduler/README.zh.md) 就是这两处组合各被执行一次的地方,而不是在每个调用点各写一遍。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/spec.ts`](src/spec.ts) | 域声明、它的记录 schema,以及存储形状与运行时形状之间的转换 |
| [`src/index.ts`](src/index.ts) | `ControlPlaneStore`,打开该域并回答那些端口的服务 |
| — | 不发布运行时不变量伴随模块;持久性归域层所有,而这里的关系由组合测试检查。 |

### 为什么存储形状不是运行时形状

JSON 会丢掉值为 `undefined` 的属性,因此一个运行时类型写作 `number | undefined` 的字段 —— 一个从未验证过的账户、一个从未重新封装过的信封 —— 读回来时是一个不存在的键。下面的 schema 把这些声明为 `optional`,而紧挨着它们的转换函数再把字段放回去。直接从 `z.infer` 拿运行时类型能编译通过,然后在这样的账户第一次往返时就自相矛盾。

### 为什么一笔记账携带它所吸收的那次运行的 id

为一次运行的出资方记账、随后忘掉那次运行,是这个介质无法合并成一次的两次写入,因此两者之间的一次崩溃会留下一条已结算记录,而恢复中的运行时会为它第二次记账。于是两种出资方 —— 租户的额度与父运行的记录 —— 都携带它们最后吸收的那次结算的 id,由与记账本身同一次原子更新写入。重复同一个 id 是空操作,因此恢复可以在不知道上次走到哪一步的情况下重新驱动一次被打断的结算。

这项保证需要每个出资方同一时刻只有一次结算:两次交错的结算留下的是较晚那次的 id,而一次崩溃随后会把较早那次记两遍账。[`dsh-run-scheduler`](../run-scheduler/README.zh.md) 把每一次对运行记录的写入排在同一条链上,而那正是这份串行化所在之处。

### 为什么一条踪迹是一扇窗,而不是一个档案库

域把它持有的每一条记录都放在内存里,因此一份无界的日志会让运行时无界地增长。于是踪迹是有上限的:`recordAudit` 为一个主体保留最近的 `retain` 条记录,其余的就没了。上限由调用方决定,因为一个部署保留多少历史是它自己的选择,而不是介质的属性。

这让这里成为一个查看近期活动的地方,而不是一个保存证据的地方。需要档案库的部署会把记录送到一个真正是档案库的地方去,而这里是它读取它们的起点。

### 为什么有些记录指名一个运行时而不是一个租户

断言之后的每一个步骤都基于已验证的声明,因此它的记录会指名它所拒绝的租户、账户与运行。一份验证不通过的断言,指名不出任何这个运行时可以相信的租户 —— 而它偏偏又是运营方最想要的那条记录 —— 因此它被归到拒绝它的那个运行时名下。主体键上的 `t_` 与 `r_` 前缀让这两个空间不会相撞。

### 为什么运行记录会指名它的账户

子运行继承其父运行授权的一个子集,而租户与账户是运行时能够裁定的那两项:父运行各自只持有一个。`findRun` 正是 `dsh-run-admission` 用来核对子运行所声明身份的东西,而这条记录就是父运行的身份被写下来的地方。

### 为什么运行记录会指名一个会话

模型请求携带的是它所面向的那个会话,而不携带任何属于自己的 Candy 概念;而执行断言指名了它那次运行所驱动的会话。把那个会话记在运行上,就让 `runsOfSession` 成为把一条提供方流变成它该被记账的那次运行的全部查找 —— 而不必在 `GenerateOptions` 上加一个 `runId`,那会让一个消费方去支配整个 `dsh-llm` 缝隙共享的一份契约。

### 为什么运行记录上盖着它的运行时

`runsOf` 只为一个运行时作答。否则,共享这个介质的两个运行时会在启动时互相恢复对方的记录,并结算掉仍在进行的运行。这个戳记就是读取方运行时自己的 audience 标识,而执行断言本来就绑定在它上面,因此两个运行时绝不会共用这个值。

### 为什么凭据查找要核对租户

账户按 id 读出,而它的记录所指名的租户,必须就是已校验声明所携带的那一个。保险库本来就会拒绝打开一个不匹配的信封,因此这不是强制手段 —— 它只是让一次不匹配进不了那唯一可能被交错信封的调用,而代价是一次比较。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [存储子系统](../../../docs/subsystems/storage.zh.md) —— 本服务所构建于其上的域声明、路由与变更事件。
- [`dsh-provider-accounts`](../provider-accounts/README.zh.md) —— 本包所满足的那个存储端口所属的账户操作。
- [`dsh-run-admission`](../run-admission/README.zh.md) —— 那三个端口,以及为什么子运行的预算是它父运行的剩余。
- [Candy 控制平面](../../../docs/subsystems/candy-control-plane.zh.md) —— 这些查找在组合顺序中的位置。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是本包当前的约束,不是任务积压。

- **重启会结束它恢复的每一次运行** —— 本运行时写下的记录,就是它当时在驱动的运行,而驱动它的那个进程已经没了,因此 `dsh-run-scheduler` 结算它找到的东西,而不是恢复它。这里没有任何东西能把一次崩溃掉的运行,与一次提供方竟然还活着的运行区分开。
- **面对损坏的存储,恢复是全有或全无** —— 无法构成完整树的记录会让启动失败,而不是被丢弃,因为对一个并不存在的父运行的占用,是没有任何东西能结算的。这里没有修复路径。
- **一个 audience 一个运行时** —— `runsOf` 按运行时戳记分区,因此共享同一 audience 的两个进程会互相恢复对方的记录。断言本来就绑定在 audience 上,因此这是一条部署规则,而不是这里所做的检查。
- **一次运行的授权就是它的租户与账户** —— 记录携带的是子运行可被据以核对的东西。工作区授权不在其中:收窄一个工作区授权是合法的,而这里也没有对包含关系建模。
- **`runsOfSession` 是扫描** —— 域把每一条运行记录都放在内存里,而这里对它们做过滤;在一个运行时的存活运行数量上这是对的,在一个机群的量级上就不是。
- **踪迹有界,而且整份重写** —— 一个主体的记录住在同一份文档里,因此每一次追加都会重写那份文档,而超出上限的记录是被丢弃而不是被归档。它适合一个部署量级上的近期活动窗口,不适合一个目录服务量级上的审计档案库。
- **踪迹记录的是控制平面观察到的东西** —— 调度尝试与保险库操作。路由、委派、工具授权与终止状态不在其中,因为仓库里还没有任何东西产出那些记录。
- **没有周期** —— 一份额度从它被授予起一直有效,直到运营方修改它,而 `setTenantGrant` 刻意保留已经消耗掉的部分。这里没有任何东西开启一个新的计费周期,因为仓库中没有任何东西决定它何时开始。
- **`listByUser` 是扫描** —— 域把每一条记录都放在内存里,而这里对它们做过滤;在一个部署的账户数量上这是对的,在一个目录服务的量级上就不是。
- **没有重放存储** —— nonce 端口是 [`dsh-run-replay`](../run-replay/README.zh.md),它按设计是进程内的。运行多于一个运行时进程的部署需要一个持久的,而这个域会是一个合理的落脚处。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景 —— 点击展开</summary>

无。

</details>
