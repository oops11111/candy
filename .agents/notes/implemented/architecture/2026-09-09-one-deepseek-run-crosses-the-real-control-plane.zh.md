# Agent Note: 一次 DeepSeek 运行穿过真实控制面

Status: implemented

[English](2026-09-09-one-deepseek-run-crosses-the-real-control-plane.md) | 中文

## Problem

Candy 的认证、Provider 账户、执行准入、计量与撤销分别已有定向证明，但没有测试证明真实控制平面组合能在一个 Provider 生命周期中保持所有这些边界。

## Decision

Candy bundle 提供一条无密钥集成证明：从已认证的 Candy 用户会话开始，经过租户所有的 `deepseek-api` 账户、真实 DSH 会话、执行断言准入、回放模型输出，最后进入 Candy 的实时运行账本。Provider 报告 42 个计费 token 和 900 微美元；终止分片到达调用方之前，调度器已将两者记到该租户。随后撤销账户，同一会话的下一次请求会在回放收到第二次调用前，以 `CREDENTIAL_REVOKED` 结束。

它是 bundle 测试，而不是新的运行时 Adapter。会话归 `dsh-session`，确定性 Provider 输出归 `dsh-llm-replay`，分发归继承的 LLM waterfall。Candy 只贡献真实的会话认证、加密账户记录、授权、断言、权限检查、计量和撤销边界。

## Alternatives considered

**在默认测试中调用真实 DeepSeek API。** 这会让控制平面证明依赖网络、费用和生产秘密，而不是 Candy 自己负责的行为。

**再增加一个 Candy 模型 Adapter。** DSH 已负责 Provider 分发和回放，另建 Adapter 会重复继承的扩展点并越过项目边界。

**只保留隔离的包级测试。** 这些测试不能证明 bundle 接线保持租户归属，也不能证明撤销后下一次调用被拒绝。

## Consequences

Bundle 现在无需真实 Provider 密钥即可证明完整控制平面链路。回放秘密是合成值，绝不会到达 Provider；真实 DeepSeek 凭据仍属于部署输入。变异负控制把回放输入量从 30 改为 31，记账断言按预期从 42 与实际 43 不符而转红，随后恢复 fixture。
