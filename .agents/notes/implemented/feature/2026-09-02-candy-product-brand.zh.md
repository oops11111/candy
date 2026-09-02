# Agent Note: Candy 产品品牌

Status: implemented

[English](2026-09-02-candy-product-brand.md) | 中文

## Problem

此 fork 已使用 Candy 仓库名，但 Web 标题、可安装应用元数据、侧栏、引导声明和主 README 仍自称 DeepSeek Harness。用户无法区分 Candy 产品和它的上游基础。

## Decision

面向用户的产品界面把应用标识为 Candy。现有浏览器品牌 slot 承载 Candy 标志和名称，现有 Harness 主题系统继续负责所有颜色和外观偏好。Candy 不增加调色板或第二套主题实现。

`dsh` 命令、`DSH_*` 兼容变量和 `@deepseek-ai/dsh-*` 内部包名保持不变。这样可以稳定运行时协议和上游合并，同时让面向产品的文本保持独立品牌。

## Alternatives considered

**重命名所有内部包、命令、环境变量和协议标识符。** 这种方案可以让源码词汇立即匹配产品，但会造成大规模兼容性破坏，并让上游合并产生不必要的成本。

**保留上游品牌，只修改仓库名称。** 这种方案的差异最小，但用户仍无法判断自己运行的是哪个产品。

## Consequences

Candy 获得独立产品身份，而不引入重复的样式系统。维护者导入上游变更时，必须继续区分稳定的 `dsh` 兼容标识符和面向用户的 Candy 文案。
