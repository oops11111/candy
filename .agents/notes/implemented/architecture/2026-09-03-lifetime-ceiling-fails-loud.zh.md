# Agent Note: 无法施加的生存期上限会被拒绝，而不是被套用

Status: implemented

[English](2026-09-03-lifetime-ceiling-fails-loud.md) | 中文

## Problem

`admitExecutionAssertion` 从部署那里取两个值：HMAC 密钥和 `ExecutionAssertionExpectation.maxLifetimeMs`。它只校验了其中一个。密钥一直会在不足 32 字节时抛出 `RangeError`。而生存期上限则直接进入 `claims.expiresAt - claims.issuedAt > expectation.maxLifetimeMs`，未经任何检查。

`NaN` 上限会让该比较对任何时间跨度都为假，于是这个上限不再约束任何东西，一个签发出一年寿命的断言也会被准入。`NaN` 在这里不是什么冷僻的值：它正是 `Number(...)` 对一个部署忘记设置的环境变量返回的结果，而 `dsh-run-admission` 会把 expectation 原样传进这次调用，自己并不读它。运行时会继续准入运行并且什么也不报，因此唯一的症状是：短寿命凭据不再短寿命了。

零或负数上限是镜像的失败，同样安静。每一个断言都会以 `lifetime` 被拒绝，而该拒绝的既定含义是签发方的签发到过期跨度太长。一个运维看到运行时以 `lifetime` 拒绝所有运行，被指向的是控制平面，而控制平面并没有签发错任何东西。

## Decision

`admitExecutionAssertion` 像它早已准入密钥那样准入自己的上限：`maxLifetimeMs` 必须是正的安全整数，其他任何值都会在解析令牌之前抛出 `RangeError` 并写出该值。

拒绝是唯一能承载这个事实的结果。准入结果做不到：它要么是一组已校验的声明，要么是一组封闭拒绝原因中的一个，而那些原因描述的都是断言，没有一个描述运行时自身的配置。改为选一个默认上限会更糟 —— 一个本意是三十秒却什么都没写的部署，会悄悄拿到本包挑的那个值，而那正是 `packages/AGENTS.md` 所禁止的无依据默认。

这是一次线上与配置的检查，不是同进程类型边界的检查。`maxLifetimeMs: number` 无法表达正数、整数或有限，因此静态接口并不要求那次比较所需要的东西。

## Consequences

生存期上限缺失或写错的部署，现在会在第一次准入时失败，并给出点名 `maxLifetimeMs` 的消息，而不是在没有生存期约束的情况下运行，或以一个指向它对端的拒绝原因拒绝所有运行。

调用方获得一条写明的 `@throws`。`dsh-run-admission` 是当前唯一的调用方，转发的是部署提供的 expectation，因此这个抛出浮现的位置，正是它的密钥长度抛出早已浮现的位置。

## Alternatives considered

**返回一个新的 `configuration` 拒绝原因。** 那会把一个运行时故障放进一组原因里，而那组原因的每一个成员都是因为断言做了什么而拒绝某一次具体运行。一个按运行记录拒绝原因的调用方会记下成千上万条，却永远不会知道是某一个数字写错了。

**把非正数上限夹到一个最小值，并把 `NaN` 当作零。** 两者都凭空造出部署没有陈述过的策略，而 `NaN` 那一半会把生存期约束的彻底失效转换成彻底拒绝，且两者都不会告诉任何人。

**在类型上校验，用一个带品牌的 `PositiveMilliseconds`。** expectation 由组装运行时配置的那一段代码构造，而那段代码尚未写出；品牌会把检查移到一个并不存在的边界上，同时让这次调用继续信任它的输入。
