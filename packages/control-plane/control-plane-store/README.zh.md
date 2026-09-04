---
description: "持久保存的提供方账户与租户额度,使准入所要求的凭据与预算查找由一种介质来回答,而不是继续悬在参数上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-control-plane-store

[English](README.md) | 中文

## 概述

[`dsh-provider-accounts`](../provider-accounts/README.zh.md) 把它的账户存储定义成一个端口,而 [`dsh-run-admission`](../run-admission/README.zh.md) 把凭据查找与预算查找也要求为端口。它们每一个都是没有任何部署能填上的参数,因为仓库里没有任何东西持有那些数据。

本服务持有它们:提供方账户连同它们密封的凭据,以及每个租户的额度,都放在一个走 SQLite 后端的[存储域](../../../docs/subsystems/storage.zh.md)里。重启之后它们还在 —— 这正是重点。

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
import type { RunAdmissionPolicy } from '@deepseek-ai/dsh-run-admission'
import type { RunLedger } from '@deepseek-ai/dsh-run-ledger'

declare const ctx: Context
declare const ledger: RunLedger
declare const partial: Omit<RunAdmissionPolicy, 'findBudget' | 'findCredential'>

export const policy: RunAdmissionPolicy = {
  ...partial,
  findCredential: claims => ctx.controlPlaneStore.findCredential(claims),
  findBudget: claims => claims.parentRunId === undefined
    ? ctx.controlPlaneStore.tenantBudget(claims.userId)
    : Promise.resolve(ledger.remaining(claims.parentRunId)),
}
```

`findBudget` 是被组合出来的,而不是整个由本服务提供,而这正是这次拆分的用意。子运行是针对它**父运行**的剩余额度被准入的,而那份剩余由内存中的 `RunLedger` 持有;拿租户自己的额度去回答一个子运行,会让这个端口存在的那项检查失效。本服务拥有租户那一半,并且把这一点说出来。

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

- **没有运行记录** —— 账本仍在内存里,因此重启会保住租户的账户与额度,却会丢掉每一个开启中的运行以及它所携带的占用。持久的运行记录需要一套崩溃也毁不掉的结算说法,而那不属于本包。
- **没有花费回写** —— 租户的额度就是部署记录下来的那个数;这里没有任何东西会随着运行计费而把它扣减。把一次运行的花费折进一个持久的租户总量,属于调度器,而且需要同一套崩溃说法。
- **`listByUser` 是扫描** —— 域把每一条记录都放在内存里,而这里对它们做过滤;在一个部署的账户数量上这是对的,在一个目录服务的量级上就不是。
- **没有重放存储** —— nonce 端口是 [`dsh-run-replay`](../run-replay/README.zh.md),它按设计是进程内的。运行多于一个运行时进程的部署需要一个持久的,而这个域会是一个合理的落脚处。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景 —— 点击展开</summary>

无。

</details>
