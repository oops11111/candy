# 一次 DeepSeek 运行穿过真实控制面

[English](2026-09-09-one-deepseek-run-crosses-the-real-control-plane.md) | 中文

Candy bundle 现在有一条无密钥集成证明：从已认证的 Candy 用户会话开始，经过租户所有的 `deepseek-api` 账户、真实 DSH 会话、执行断言准入、回放模型输出，最后进入 Candy 的实时运行账本。Provider 报告 42 个计费 token 和 900 微美元；终止分片到达调用方之前，调度器已将两者记到该租户。随后撤销账户，同一会话的下一次请求会在回放收到第二次调用前，以 `CREDENTIAL_REVOKED` 结束。

它被刻意实现为 bundle 测试，而不是新的运行时 Adapter。会话仍归 `dsh-session`，确定性 Provider 输出仍归 `dsh-llm-replay`，分发仍归继承的 LLM waterfall。Candy 只贡献真实的会话认证、加密账户记录、授权、断言、权限检查、计量和撤销边界。

测试中的回放密钥是合成值，绝不会到达 Provider。真实 DeepSeek 凭据仍属于部署输入，而不是仓库数据。变异负控制将回放输入量从 30 改为 31，记账断言按预期从 42 与实际 43 不符而转红；提交前已恢复 fixture。
