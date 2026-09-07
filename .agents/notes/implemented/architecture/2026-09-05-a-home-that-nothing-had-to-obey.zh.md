# Agent Note: 一个没有东西必须服从的 home

Status: implemented

[English](2026-09-05-a-home-that-nothing-had-to-obey.md) | 中文

## Problem

两个租户运行同一个提供方时,不得共享可写的 home 或缓存的私有内容。Candy 通过给每个 Claude CLI 子进程各自的 `HOME`(指向该租户的运行时池根目录)来区分它们。

这种区分是间接的。它之所以成立,是因为 CLI 的配置、缓存和账户状态都是相对于 `HOME` 定位的——而不是因为有什么东西检查了子进程实际写到哪里。一个直接指名其中某个目录的变量,会在不碰 `HOME` 的情况下破坏这种推导。

一次探测在父进程中带着运维人员的变量,经由真实的 `dsh-subprocess` 合并构造出子进程收到的环境:

`PROBE-ENV {"HOME":"/pools/tenant-a","CLAUDE_CONFIG_DIR":"/srv/operator/.claude","XDG_CONFIG_HOME":"/srv/operator/.config"}`

`HOME` 是租户的。`CLAUDE_CONFIG_DIR` 的全部用途就是把 CLI 的配置和账户状态从 `HOME` 迁走,而它是运维人员的——并且每个租户的子进程拿到的都是同一个。接缝的父环境清洗会丢掉凭据形状的名字和 `DSH_*`,而它两者都不是;启动叠加层为提供方路由变量设置了墓碑,而它也不属于那一类。

## Decision

`SCRUBBED_STATE_VARIABLES` 指名那些会把子进程状态重定向到其 home 之外的变量,`claudeCliEnvironment` 在路由清单之外一并为它们设置墓碑:`CLAUDE_CONFIG_DIR`、四个 XDG 基础目录,以及 `ANTHROPIC_CONFIG_DIR`——后者此前待在路由清单里,而那个名字并不描述它。

这份清单覆盖标准的状态目录变量,而不只是已知某个 CLI 版本会读取的那些。两种错误并不对称。被设置墓碑而 CLI 又忽略的名字不改变任何事:变量不存在时,子进程回退到固定 `HOME` 之下的位置,而那正是想要的位置。漏掉的名字则是两个租户共享的一个目录。

## Consequences

被固定的 home 现在是唯一被告知给子进程用来保存状态的地方,因此池隔离取决于池根目录,而不是取决于部署的环境卫生。

反向对照——恢复单清单循环——恰好让三个测试失败:两个单元断言,以及组合 Loader 中关于 spawn 规格携带墓碑的那个断言。移除本身是 subprocess 接缝的契约,在那里由一次真实的 spawn 覆盖。

`SCRUBBED_ROUTING_VARIABLES` 现在只保留路由与认证的名字,因此它的文档与其内容相符。

## Alternatives considered

**为子进程环境设白名单。** 指名 CLI 子进程可以继承的少数变量,关闭的是这一整类问题而不是其中一个成员。它属于 `dsh-subprocess` 接缝,`scrubbedParentEnv` 在那里为仓库中每个 spawner 定义;改动那个基底也会改动 bash、pwsh 和语言服务器的子进程——那是一个需要自行收集证据的决定。

**在绑定层清除 `HOME` 邻近的变量。** `dsh-claude-cli-binding` 知道池根目录,可以在那里清洗。但"这个 CLI 读取哪些变量"这一知识属于该协议的其余部分,即 `dsh-claude-cli-protocol`,与命令行标志和路由清单放在一起。

**交给部署处理。** 写文档说明 Candy 服务器不得继承 `CLAUDE_CONFIG_DIR`,会让租户隔离取决于一个启动脚本。而这个变量最可能被设置的地方,恰恰就是这个运行时最可能被开发和运行的地方。
