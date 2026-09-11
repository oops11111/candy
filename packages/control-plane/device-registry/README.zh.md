---
description: "Candy 断言所指的设备：租户签发一次性配对码，主机用它换取一个终身绑定该租户的身份，租户可以随时撤销这一绑定。"
kind: "package-library"
---

# @deepseek-ai/dsh-device-registry

[English](README.md) | 中文

## 概述

执行断言一直携带 `DeviceId`，[工作区授权](../workspace-grant/README.zh.md)也一直标明其根目录是为哪台设备书写的。但没有任何东西签发过设备。仓库中不存在这个 id 所指的记录，因此没有任何一步能说出某台主机代表哪个人，也无法判断它是否仍然代表那个人。

本包持有该记录。租户在已认证的会话中签发配对码，把它读到主机上，主机用它换取——仅此一次——一个绑定到该租户的设备身份。绑定在设备的整个生命周期内固定不变：没有任何操作能迁移它，因为一台应当服务于另一个人的主机就是另一台设备，用它自己的配对码配对，持有它自己的令牌。

传输不在这里。主机如何连到部署、如何维持连接、如何执行工具，都是继承自 Harness 的行为。本包决定的是设备属于哪个租户，以及它是否仍然属于该租户。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 签发配对码并兑换

```ts
import { consumePairingCode, issuePairingCode } from '@deepseek-ai/dsh-device-registry'
import type { DeviceRegistryStore } from '@deepseek-ai/dsh-device-registry'
import type { DeviceId, UserId } from '@deepseek-ai/dsh-control-plane'

declare const store: DeviceRegistryStore
declare const userId: UserId
declare const code: string
declare const deviceId: DeviceId
declare const token: string

await issuePairingCode(store, { userId, label: 'Studio desktop', code, expiresAt: Date.now() + 900_000 }, Date.now())

// On the host, with the code a person carried across:
const { device } = await consumePairingCode(store, { code, deviceId, token }, Date.now())
export const boundTo = device.userId
```

配对码、设备 id 和令牌都由调用方铸造。它们各自携带多少熵、配对码用哪种便于阅读的字符集，都是传输层的决定，而只有摘要会进入持久记录。

配对码在无法解析时以 `pairing-code-unknown` 被拒绝，超出有效期时以 `pairing-code-expired` 被拒绝，已被主机兑换时以 `pairing-code-consumed` 被拒绝——包括在并发竞争同一配对码中落败的主机。

### 校验令牌，以及收回它

`authenticateDevice` 识别出示令牌的设备；未识别出时报告 `unknown` 或 `revoked`。对出示方应当以同一种方式回答这两者；区分只服务于审计记录，运维需要在其中看到一台已撤销的主机仍在尝试。

`revokeDevice` 撤回绑定并保留记录。`admitDevice` 是断言期的规则，与 [`admitWorkspaceGrant`](../workspace-grant/README.zh.md) 形状相同：`not-found`、`revoked` 或 `tenant-mismatch`。

### 存储

`DeviceRegistryStore` 是部署需要满足的端口；[`dsh-control-plane-store`](../control-plane-store/README.zh.md) 在 SQLite 上实现它。该端口有一个成员不是普通的读写：`claimPairingCode` 必须在并发调用无法插入的单一步骤中，同时标记配对码已兑换并检查其有效期。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 路径 | 职责 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 设备与配对码记录、存储端口，以及作用其上的全部操作 |
| — | 不发布运行时不变量伴生包；这个纯模块不拥有事件流或可变运行时数据，其规则由单元测试保证。 |

### 为什么先认领配对码再写入设备

认领在前，因此两者之间的失败会烧掉配对码，而不是留下一个仍可使用的码。这是安全的方向。租户可以重新签发一个没能用上的码；而一个在半途失败后幸存的码，会让第二台主机在第一台已经应答过的邀请下完成配对。

同样的理由说明为什么做决定的是认领而不是它上面的读取。两台主机读取同一个未兑换的配对码时都会发现它未兑换；那次读取只用于说明这是三种拒绝中的哪一种，而在读取成功之后失败的认领会被报告为已兑换。

### 为什么记录在被兑换后仍然保留

已兑换的配对码标明它产生了哪台设备，运维正是据此判断一台设备来自哪次配对。第二次拒绝它，于是成为记录陈述的事实，而不是记录的缺失。

### 为什么设备永不删除

断言和工作区授权所引用的 id 比设备本身活得更久。删除记录会让一个被撤销的设备读起来像从未配对过，而每一处解析该 id 的检查都会在真相是 `revoked` 时回答 `not-found`。

### 为什么要归一化输入的配对码

配对码从一块屏幕上读出、输入到另一块屏幕，因此两种写法的差异不携带任何信息：大小写、为便于阅读而加入的分隔符，以及输入时带上的空白。在取摘要之前把它们全部去掉，才使租户看到的和主机发送的产生相同的摘要。

-----

<a id="further-exploration"></a>
## 进一步探索

- [多租户 CLI 智能体运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划；本包是 R5 中 Windows Harness Host 绑定的注册一半。
- [`dsh-workspace-grant`](../workspace-grant/README.zh.md) —— 断言指向的另一条记录，以及其根目录所属的设备。
- [`dsh-control-plane`](../control-plane/README.zh.md) —— 本注册表所使用的 `DeviceId` 与 `UserId` 品牌类型。
- [`dsh-control-plane-store`](../control-plane-store/README.zh.md) —— 存储端口的持久化实现。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

以下是当前的包约束，不是任务清单。

- **运行准入之外没有任何地方检查设备** —— [`dsh-run-admission`](../run-admission/README.zh.md) 通过 `findDevice` 解析断言所指的设备并应用 `admitDevice`，因此被撤销的绑定会拦住下一次运行。没有其他操作查阅这条记录：已经被准入的运行会保留其凭据与额度直到结算，而也没有任何传输会在连接中途拒绝设备令牌。
- **没有任何东西清理已用尽的配对码** —— 已兑换和已过期的记录留在介质上。持续签发配对码的部署会让该表不断增长，直到出现类似 [`ControlPlaneStore.evictNonces`](../control-plane-store/README.zh.md) 为重放随机数提供的清扫。
- **设备终身持有一个令牌** —— 没有轮换。替换泄露的令牌意味着撤销该设备，再以新的 id 重新配对主机。
- **没有 Cordis 服务** —— 这里没有任何东西注册到 `Context` 上；与 [`dsh-workspace-grant`](../workspace-grant/README.zh.md) 一样直接导入使用。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
