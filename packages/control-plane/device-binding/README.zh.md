---
description: "Harness Host 所服务的那一台服务器,以及它所扮演的那一台设备:一条存放在凭据存储中的持久绑定,天然唯一,只能释放而不能替换。"
kind: "package-reference"
---

# @deepseek-ai/dsh-device-binding

[English](README.md) | 中文

## 概述

通过 [`dsh-device-api`](../device-api/README.zh.md) 完成配对的主机会一次性收到设备 id 与令牌,而在本包出现之前,它无处安放它们。harness 唯一的持久身份是 `dsh-anonymous-user-id`,一个按安装生成、被刻意设计为*不*标识个人的 UUID,而 [`host/`](../../host/README.zh.md) 中也没有任何东西命名一台通过网络访问的机器。

本服务把配对所产生的东西——本主机应答哪个部署、它是谁的设备、它出示哪枚令牌——保存在 [`ctx.credentials`](../../credentials/credentials/README.zh.md) 中,凭据这道接缝本来就负责持久密钥与跨进程互斥。

绑定天然唯一。只有一个记录键,而 `bind` 拒绝替换已经成立的绑定。一台同时服务两个租户的主机,是一台任一租户的工作都能触及另一租户文件的主机;改变一台机器服务对象的运维动作是 `release` 之后重新配对,而这刻意不是一次随手的调用就能做到的事。

连接状态不在这里。抵达服务器、察觉链路断开、退避与重连,都属于继承而来的传输层。本包回答该抵达哪一台服务器以及以谁的身份,`verify` 执行一次显式认证请求,不增加监视器或重试计划。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 组合方式

```yaml
- id: device-binding
  name: '@deepseek-ai/dsh-device-binding'
```

它没有配置项。记录存放在哪里是凭据提供方的决定,本地提供方把它放在 `$DSH_HOME/.credentials.yaml`。

### 配对、读取绑定、交出绑定

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-device-binding'
import type { DeviceId, UserId } from '@deepseek-ai/dsh-control-plane'

declare const ctx: Context
declare const userId: UserId
declare const deviceId: DeviceId
declare const token: string

await ctx.deviceBinding.pair('https://candy.example', 'ABCD-EFGH', Date.now())
await ctx.deviceBinding.bind(
  { serverOrigin: 'https://candy.example', userId, deviceId, token },
  Date.now(),
)
export const serving = await ctx.deviceBinding.describe()
```

`pair` 是主机侧的正常入口:它把运维人员输入的一次性配对码发送到部署已有的兑换路由,并把返回的身份装入凭据存储。已有绑定时,它会在发送之前拒绝;它不跟随重定向,也拒绝字段不完整的凭据回复。网络失败仍是留给调用方分类的错误,绝不会被报告成错误配对码。

`read` 回答完整的绑定,包含令牌,供出示它的一方使用。`describe` 回答除令牌之外的一切,供任何报告"这是哪台机器"的地方使用。`release` 交出绑定。

`verify` 询问已保存的部署,令牌是否仍标识完全相同的租户与设备。主机未配对或服务器返回统一 `401` 时,它返回 `false`。网络失败继续抛给继承的连接所有者;未约定状态或身份不匹配会抛出 `DeviceBindingVerificationError`,两者都不会被误判为撤销,绑定也不会自动删除。

第二次 `bind` 若指名了不同的租户、设备或部署,会以 `already-bound` 被拒绝。若指名的是同样的三者,则替换令牌并保留主机首次绑定的时刻——这正是轮换凭据之后的一次重新配对。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 绑定记录、其来源归一化,以及建立在 `ctx.credentials` 之上的服务 |
| — | 不发布运行时不变量伴生包;本包所拥有的唯一关系——一台主机至多持有一条绑定——由凭据接缝的排他写入保证,并由并发测试检查。 |

### 为什么由凭据接缝持有它

绑定携带一枚令牌,那是密钥,属于密钥本来就该待的地方。`modifyRecord` 同时也是一次序列化的读-改-写,在存储支持时跨进程成立,这才使「唯一绑定」成为事实而不是意图:同一台机器上同时启动并同时配对的两个 `dsh` 进程,不可能都装上一条绑定。

### 为什么要归一化来源

人们输入的 URL 会带路径、带末尾斜杠,或者主机名带大写,而这些都不足以区分两个部署。直接比较原始文本,会让针对同一台服务器的重新配对读起来像是另一台——那正是 `already-bound` 存在所要拒绝的情形——因此在存储或比较之前,scheme 与 authority 会被转成小写,其余部分被丢弃。

### 为什么要在读出时校验存储的载荷

凭据接缝把 `grant` 载荷当作不透明 JSON 存放,并原样交还。因此手工编辑过的文件,或者由另一版本留下的记录,会作为一种寻常可能而不是防御性假设抵达这道边界;而不是绑定的载荷会读成一台未配对的主机,而不是一条缺字段的绑定。

### 为什么重新配对保留原有时刻

这台机器自绑定以来一直在服务这个租户。轮换后的令牌是一份新凭据,而不是一段新关系,而 `boundAt` 回答的是这段关系何时开始。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-device-registry`](../device-registry/README.zh.md) —— 同一段关系在服务端的那一半。
- [`dsh-device-api`](../device-api/README.zh.md) —— 产生本包所存内容的配对兑换。
- [`dsh-credentials`](../../credentials/credentials/README.zh.md) —— 持有该记录并序列化写入的接缝。
- [多租户 CLI 智能体运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划;本包是 R5 中主机侧的绑定。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

以下是当前的包约束,不是任务清单。

- **没有任何东西用它去连接** —— 本服务回答该抵达哪台服务器、以谁的身份,并可为显式验证出示令牌。连接建立或重连时没有传输层读取它。
- **撤销不会释放绑定** —— `verify` 返回 `false`,但主机会保留记录直到运维释放。离线或服务器故障绝不能被当成更换机器所属租户的许可。
- **没有命令行界面** —— 配对与释放都是服务调用。没有 `dsh` 子命令、没有设置页,也没有引导运维输入配对码的提示流程。
- **并发的第二次兑换可能消耗其配对码** —— `pair` 会在发送前拒绝已经存在的绑定,但两个进程可能在任一网络请求返回前都观察到空存储。凭据接缝仍只允许一条绑定胜出;失败一方的一次性配对码此时可能已经被消费。
- **每个凭据存储一条绑定,而不是每台机器一条** —— 两个 `$DSH_HOME` 不同的安装,对这条记录而言就是两台主机。这与其他每一项凭据的行为一致,之所以在此说明,是因为「机器」是更自然的默认单位。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
