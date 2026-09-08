---
description: "一次 Candy 运行被准入时所持的文件系统权限:某台设备授予的根目录、在这些根目录下工作的文件效应上限,以及被委派的子代两者都不得放宽的规则。"
kind: "package-library"
---

# @deepseek-ai/dsh-workspace-grant

[English](README.md) | 中文

## 概述

一份执行断言携带一个 `WorkspaceGrantId`,除此之外关于文件系统什么都不带。在本包存在之前,这个 id 在整个仓库里解析不到任何记录,[`dsh-run-admission`](../run-admission/README.zh.md) 也从不读它:一次运行想指名哪份授权就指名哪份,一个被委派的子代可以指名另一份,而没有任何一步会看。子代继承的租户与账户是被检查的;它的文件系统权限不是。

本包持有这个 id 所解析到的东西 —— 某台设备授予某个租户的根目录、在这些根目录下工作的文件效应上限、该授权的修订号,以及它是否仍然有效 —— 以及准入对它施加的那一条规则。

路径包含关系刻意不在这里。一份授权的根目录是为签发它的那台设备拼写的,而判断一条路径是否落在其中一个之下,是那台设备的文件系统语义 —— 大小写、junction、符号链接、8.3 别名。另一台主机上的控制面无法靠比较字符串复现这些,因此本规则判定的是身份与继承,而这两者在每台主机上都相同。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 判定一次运行是否可以持有它所指名的授权

```ts
import { admitWorkspaceGrant } from '@deepseek-ai/dsh-workspace-grant'
import type { WorkspaceGrantStore } from '@deepseek-ai/dsh-workspace-grant'
import type { DeviceId, UserId, WorkspaceGrantId } from '@deepseek-ai/dsh-control-plane'

declare const store: WorkspaceGrantStore
declare const userId: UserId
declare const deviceId: DeviceId
declare const grantId: WorkspaceGrantId
declare const parentGrantId: WorkspaceGrantId | undefined

const outcome = admitWorkspaceGrant(
  { userId, deviceId, grantId, parentGrantId },
  await store.findGrant(grantId),
)
export const roots = outcome.admitted ? outcome.grant.roots : []
```

在以下情况下运行被拒绝:id 解析不到任何东西(`not-found`)、授权已被吊销(`revoked`)、它属于另一个租户(`tenant-mismatch`)或属于同一租户的另一台设备(`device-mismatch`),或者一个子代指名了其父代所持之外的任何一份授权(`not-inherited`)。

### 存储一份授权

`WorkspaceGrantStore` 是部署要满足的端口;[`dsh-control-plane-store`](../control-plane-store/README.zh.md) 在 SQLite 之上实现它。吊销是带上 `revokedAt` 的 `saveGrant`,而不是一次删除:记录才是权限本身,断言只是指名它,因此把记录删掉会让一份被撤回的授权读起来像是从未签发过。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 角色 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 授权记录、存储端口与准入规则 |
| — | 不发布运行时不变量伴生模块;本纯模块不拥有事件流或可变运行时数据,其规则由单元测试保障。 |

### 为什么子代必须精确指名其父代的授权

相等是子集规则最强的形态。一个不能指名另一份授权的子代,既放宽不了它的根目录,也抬高不了它的模式,因此超额授予是不可能的而不是可检测的 —— 这正是 [`dsh-run-budget`](../run-budget/README.zh.md) 对 token 与并发已经采取的形状。另一个选择是拿子代的根目录与父代的作比较,而那正是本包不做的路径算术。

本仓库今天没有任何东西会签发一份收窄后的子代授权:[`RunScheduler.startChildRun`](../run-scheduler/README.zh.md) 把父代的授权 id 复制进铸造出来的断言。当有东西需要它时,那将是一条由签发设备在用自己的文件系统检查过包含关系之后派生出来的记录,而本规则会接受那种派生。

### 为什么记录要带上设备

根目录是某一台机器的路径。从另一台设备上认可这份授权,就是把这些路径套用到另一块磁盘上,而同一个字符串在那里指的是别的东西,或者什么都不是。记录上的设备同时也是"谁可以拿路径去对这些根目录求解"的答案,而这正是文件系统那一侧的检查所需要的。

### 为什么记录要带上版本

一份断言只指名 id,因此一次在收窄之前被准入的运行,与一次在收窄之后被准入的运行,单看 id 无从分辨。准入把它读到的版本记在被准入的运行上,而这正是让后续的检查能够把"持有已被削减的权限"的运行,与"持有它当初所获权限"的运行区分开来的东西。

-----

<a id="further-exploration"></a>
## 进一步探索

- [Multi-tenant CLI agent runtime](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划;本包是 R3 父子授权中工作区的那一半。
- [一份谁也解析不了的授权](../../../.agents/notes/implemented/architecture/2026-09-07-a-grant-nobody-could-resolve.zh.md) —— 为什么这个 id 没有记录,以及准入现在拒绝什么。
- [`dsh-run-admission`](../run-admission/README.zh.md) —— 唯一的调用方,以及这次拒绝相对于其他检查的次序。
- [`dsh-sandbox`](../../sandbox/sandbox/README.zh.md) —— 一份授权的上限所使用的 `SandboxMode` 词汇。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

这些是当前的包约束,不是任务待办。

- **根目录强制检查依赖执行 Provider** —— 准入判定的是一次运行是否可以持有一份授权。[`dsh-workspace-grant-execution`](../workspace-grant-execution/README.zh.md) 在继承来的文件系统与 Shell 沙箱操作处提供第二次检查；省略它的组合仍有准入检查，但没有本地根目录强制检查。
- **没有任何东西在签发授权** —— 部署通过存储手工写入记录。没有配对流程,没有运维界面,也没有在设备注册时创建一份授权的生命周期。
- **表达不出收窄的子代授权** —— 子代要么指名其父代的授权,要么被拒绝。收窄需要一条由签发设备创建的派生记录,而没有任何东西创建它。
- **没有 Cordis 服务** —— 这里没有任何东西注册到 `Context` 上;它像 `dsh-run-budget` 一样被直接导入。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

None.

</details>
