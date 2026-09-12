---
description: "五个设备操作的 HTTP 承载：租户管理、配对兑换，以及 Harness Host 的承载令牌认证。"
kind: "package-reference"
---

# @deepseek-ai/dsh-device-api

[English](README.md) | 中文

## 概述

[`dsh-device-registry`](../device-registry/README.zh.md) 判定设备属于谁。本包是租户与主机抵达这些判定的方式:三条挂在[已认证管理信封](../control-plane-api/README.zh.md)上的路由,以及供没有浏览器会话的调用方使用的配对兑换和设备认证。

完成兑换的 Harness Host 此前还不是任何人。它请求体中的配对码就是它声明的全部,而它将绑定到的租户,正是签发那个配对码的租户。因此兑换通过 `registerAnonymousRoute` 注册,该注册根本不向处理器交出 `Actor`——于是信封"持有 `Actor` 即意味着已认证会话"这条规则原封不动地保留下来,而不是被放宽以容纳这个调用方。

配对码与令牌各自只出现在一次回复中,此后再也读不到。介质上只有它们的摘要。

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
- id: device-api
  name: '@deepseek-ai/dsh-device-api'
  config:
    publicOrigin: 'https://candy.example'
    pairingCodeTtlMs: 900000
```

`publicOrigin` 必须与登录所配置的来源完全一致;寻址到任何其他权威的请求都会在其余一切之前被拒绝。`pairingCodeTtlMs` 是一个人把配对码带到机器前所拥有的时间,取值从 30 秒到一天,默认 15 分钟。

### 五个操作

| 路径 | 方法 | 谁可以调用 |
| --- | --- | --- |
| `/api/candy/devices` | `GET` | 已登录成员,读取自己的设备与配对码 |
| `/api/candy/devices/pair` | `POST` | 已登录成员,签发一个配对码 |
| `/api/candy/devices/revoke` | `POST` | 已登录成员,针对自己的设备 |
| `/api/candy/devices/exchange` | `POST` | 任何持有未兑换配对码的一方 |
| `/api/candy/devices/authenticate` | `GET` | 以 Bearer 凭据出示设备令牌的主机 |

`pair` 回答 `{ code, label, expiresAt }`。这次回复是配对码唯一以明文存在的时刻;丢失它的租户重新签发一个。

`exchange` 一次性回答 `{ deviceId, userId, label, token }`。主机保存该令牌并在此后出示它;丢失令牌的主机所配对的设备,它再也无法证明自己就是,补救办法是撤销并重新配对。

`authenticate` 为有效令牌回答 `{ deviceId, userId }`。缺失、格式错误、未知或已撤销的凭据都收到相同的空 `401`;只有租户审计会区分已撤销主机,回复和日志都不包含令牌。

`revoke` 回答设备当前的状态。属于另一租户的设备,与不存在的设备的回答完全一致。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件本体:配置、凭据铸造、五条路由的注册 |
| [`src/types.ts`](src/types.ts) | 客户端读取的路径,以及请求与回复的形状 |
| — | 不发布运行时不变量伴生包;本包注册路由、不拥有可变运行时数据,其拒绝行为由组合测试保证。 |

### 为什么兑换携带八十位

配对码是通过公共互联网出示、身旁别无他物的持有型凭据,而猜测与尝试之间没有任何速率限制。十六个每个五位的字符,才让在其有效期内猜中变成不可能而不仅仅是缓慢,这也是长度固定在这里而不是可配置的原因。

字符集是三十二个字形,不含 `I`、`L`、`O`、`U`。前三个会被输入者读作 `1`、`1` 和 `0`;第四个则频繁地让随机码变成单词。三十二还能整除 256,因此对随机字节做掩码即可选出字形,而不会带来在 26 或 36 字形字符集上取余所引入的偏置。

### 为什么兑换不要求 `Origin`

会话写入之所以要核对 `Origin`,是因为浏览器会自行附上会话 Cookie,而该头部正是把本部署自己的页面与仅仅知道 URL 的页面区分开的东西。这里没有 Cookie,调用方也不是浏览器:要求该头部会拒绝每一个真实客户端。伪造这个请求的页面必须已经持有配对码,而且读不到回复。

`Host` 检查照旧适用,与其他每条路由完全一样。

### 为什么 id 在这里铸造

自选设备 id 的主机可以指名另一租户的设备,并覆盖将其绑定的那条记录。id 与令牌都在服务端铸造,而回复是两者唯一出现的地方。

### 为什么不可用的配对码不产生审计记录

三条租户路由都按会话的租户记录,成功也记录:运维在追问某台主机为何被配对时,需要看到是谁配对的。被拒绝的兑换指不出本部署可以相信的任何租户——未知的配对码解析到无人——因此它只抵达部署的日志,而不是一条它能够灌满的踪迹。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-device-registry`](../device-registry/README.zh.md) —— 本包所承载的每一项判定。
- [`dsh-control-plane-api`](../control-plane-api/README.zh.md) —— 信封、两种注册方式,以及失败词汇表。
- [`dsh-provider-account-api`](../provider-account-api/README.zh.md) —— 同级层,也是本包所遵循的模板。
- [多租户 CLI 智能体运行时](../../../.agents/notes/proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) —— R1–R6 交付计划。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

以下是当前的包约束,不是任务清单。

- **没有任何东西限制租户可拥有的设备或配对码数量** —— 已认证成员可以一直签发配对码直到介质写满,正如他们可以一直创建服务商账户一样。上限属于其他限定租户占用的机制,而目前还没有这样的机制。
- **没有浏览器页面** —— 设置面板有 Candy 账户页,没有设备页。在页面出现之前,租户用 HTTP 客户端访问这些路由。
- **没有配对客户端** —— 主机侧 [`dsh-device-binding`](../device-binding/README.zh.md) 可以验证已存令牌,但还没有组件调用兑换并保存其回复。
- **没有传输绑定** —— 认证是显式请求。继承的 Remote Gateway 在建立或恢复 WebSocket 时尚不出示令牌。
- **从未兑换的配对码留在介质上** —— 本 API 签发配对码,[`dsh-control-plane-store`](../control-plane-store/README.zh.md) 保存它们;两者都不清扫已用尽和已过期的记录。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
