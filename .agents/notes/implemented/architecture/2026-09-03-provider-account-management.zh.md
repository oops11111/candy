# Agent Note: 提供方账户是带写入式凭据的租户记录

Status: implemented

[English](2026-09-03-provider-account-management.md) | 中文

## Problem

[多租户运行时计划的 R4](../../proposed/architecture/2026-09-02-multi-tenant-cli-agent-runtime.zh.md) 需要用户从共享的 Harness Web 表面管理 DeepSeek API、Claude CLI 与 Codex CLI 账户。继承来的 Harness credentials seam 有意保持提供方中立且进程本地：它按凭据引用存储记录，而不是按 Candy 租户、提供方账户、默认账户、撤销状态或控制面所有权组织。直接把它复用为用户可见账户 API，会让客户端选择的引用冒充账户授权。

## Decision

`@deepseek-ai/dsh-provider-accounts` 拥有 Web API 将暴露的控制面账户记录。它保存以 `ProviderAccountId` 为键的元数据，按 `userId` 检查每一次操作，用 `dsh-credential-vault` 封装密钥，并且只返回 `ProviderAccountView`：其中不包含凭据材料、加密载荷、密钥版本、路径或提供方响应正文。

创建是唯一接收明文密钥的操作。验证只在本次操作内部打开凭据，并把它交给提供方提供的 validator；返回前会把结果清理成有长度上限的诊断。列表、选择默认、验证、撤销与删除都会先解析存储记录，并把其他用户的 id 报告为 `not-found`，因此账户 id 不能被用作枚举租户的旁路。

每个用户在每个提供方下最多有一个默认账户。为某个提供方创建第一个活跃账户时，它会成为默认；显式选择默认会清掉同一用户和提供方的旧默认；撤销和删除会移除默认状态，并在存在其他活跃账户时提升一个替代默认。

## Consequences

R4 现在拥有了 Web controller 之前所需的后端账户生命周期。剩余 Web 工作更薄：认证用户，通过持久 store 调用这些函数，并把已有 Harness settings UI 投影到返回视图上。

一个已删除账户的 id 会被永远拒绝，而不只是在还没有人认领它的时候：`createProviderAccount` 此前只检查既有那一行是否未被删除，因此调用方可以在一个已删除的 id 之下重新创建账户，悄悄覆盖掉删除操作承诺会保留的那条记录 —— 而这一点未被发现，因为没有任何测试走过那条路径，覆盖率只要求普通重复 id 检查所需的那两个分支。这项检查现在会拒绝任何既有的行，无论它是否已被删除。

本包有意不是 validator 注册表或 Web 服务。提供方探测仍属于各提供方，因为 DeepSeek API key、Claude CLI home 与 Codex CLI home 并不共享一种验证协议。本包提供 validator 端口，是为了让这些探测能接入，而不让原始诊断、token、路径或环境值成为账户 API 的一部分。

## Alternatives considered

**把继承的 credentials settings API 当作账户列表。** 拒绝：凭据引用不是租户拥有的提供方账户，并且不编码所有权、提供方类型、默认选择、撤销或删除。

**随账户存储提供方诊断。** 拒绝：原始诊断可能包含 endpoint 细节、token 回显、文件系统路径或其他租户的元数据。账户层只保存 `validatedAt`；更丰富的诊断应进入单独的已脱敏审计轨迹。

**物理删除账户记录。** 在控制面核心中拒绝。软删除保留审计所需的元数据，同时从用户可见列表中隐藏已删除账户；它也是让 `createProviderAccount` 得以拒绝复用一个已删除 id 的前提 —— 物理删除会留下无物可查，而一个新账户就可能悄悄接管某个陌生人被保留下来的历史。
