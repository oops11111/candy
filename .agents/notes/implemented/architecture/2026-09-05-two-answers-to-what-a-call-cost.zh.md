# Agent Note: Two answers to what a call cost

Status: implemented

[English](2026-09-05-two-answers-to-what-a-call-cost.md) | 中文

## Problem

`dsh-run-metering` 按 `totalTokens ?? inputTokens + outputTokens` 给一次运行计费。`inputTokens` 只是未命中缓存的输入 —— `TokenUsage` 是这么写的，并且写明被计费的输入是它与 `cacheReadTokens`、`cacheWriteTokens` 之和 —— 因此一个报告了缓存计数却没有报告总数的适配器，它的调用会按其实际成本的一小部分被计费。Anthropic 风格的提示词大部分是缓存命中，而那正是这个比例最小的地方。

每一个已发布的适配器都会报告 `totalTokens`，因此今天并没有谁被少算。真正错的是那条回退路径，以及仓库里对同一个问题有三个答案：这一个、`dsh-claude-cli-binding` 记账测试里手写的四项求和，以及 `dsh-token-meter` 自己的 `usageTokens`。

## Decision

`billedTokens` 住在 `dsh-llm` 里，与它所读取的那个类型并排。

它优先采用提供方精确的 `totalTokens`；没有的时候，把四个不相交的计数全部相加。`dsh-token-meter` 的回合归一化器本来就要求 `totalTokens` 至少等于它们之和，并在两个缓存计数都在场时与之相等，因此优先采用它只会更完整，绝不会重复计数。`reasoningTokens` 不再相加：它已经在 `outputTokens` 里面。

`dsh-token-meter` 的 `usageTokens` 保持原样，不被合并进来。它有意只把不相交的计数相加：它是「上下文窗口有多满」的一个保守基线，对那个问题较小的数字才安全，而对「这次调用花了多少」较大的那个才正确。两者看起来像重复，其实不是，因此新函数的契约把谁是谁说清楚了。

## Consequences

`dsh-run-metering` 与 `dsh-claude-cli-binding` 的记账测试都调用它，第三份副本没了。一个报告了缓存计数却没有总数的提供方，现在会按它的整个提示词被计费。

## Alternatives considered

**把计数相加并忽略 `totalTokens`。** 那与 `dsh-token-meter` 一致，并且会少算任何一个其总数覆盖了不相交计数所未指名的提示词 token 的提供方 —— 而那正是 `turn-usage` 的归一化器明确允许的情形。

**把 `dsh-token-meter` 的辅助函数并进这个共享的。** 那会让两者一致，同时让上下文压力基线变得不那么保守，而那是对一项没有任何人要求改动的测量的更改。
