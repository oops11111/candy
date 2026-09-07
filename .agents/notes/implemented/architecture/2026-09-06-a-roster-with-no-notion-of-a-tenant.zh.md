# Agent Note：一份不知道租户为何物的名册

状态：已实现

[English](2026-09-06-a-roster-with-no-notion-of-a-tenant.md) | 中文

## 问题

多租户运行时计划的 R3 明确点出了一项真正属于 Candy 自己要添加的事：「把一个租户限制在一份原本共享的 preset 名册或路由白名单的一个子集内」。`dsh-agent-presets` 已经能列出每个已组装的 preset、为每个会话挂载一个，并允许一个会话在仍是空白时切换到另一个——但它是一个通用的 Harness 包，不携带任何租户概念，而它目前的消费方也都不需要一个。若直接在名册里加入租户检查，就会违反这个仓库已经在别处强制执行的包边界规则（「为所有当前消费方设计 Service Definition……不要让某一个消费方来决定服务契约」）：Candy 只是这个包的众多部署之一，其他组装也会加载它，教会它 Candy 自己的词汇会让每一个非 Candy 消费方都背上一个它不需要的概念。

这项检查还必须真正做到不可绕过。一个会话的 preset 在 `dsh-agent-presets` 内部恰好只在两处被解析——`mount()`（首次组装，来自 agent 工厂的 `setup` 钩子）和 `recompose()`（之后的一次切换，只在会话仍是空白时有效）——而一个只从 Candy 自己外层的会话创建包装器里做的限制，会完全漏掉第二条路径，因为一个会话可以独立于创建它的那个包装器,直接调用 `select()`/`recompose()`。

## 决策

`dsh-agent-presets` 得到了一个通用扩展点：`AgentPresets.guard(guard: AgentPresetGuard)`。一个守卫的类型是 `(agentCtx: Context, id: string) => string | undefined`——一个在 `resolveMountable` 内部被咨询的同步检查，而这正是 `mount()` 与 `recompose()` 在组装或重新链接之前都会调用的那一个私有函数。返回一个字符串即以该原因、以 `agent-preset/refused` 拒绝这个 preset；返回 `undefined` 则交给下一个守卫，且没有任何守卫能强行放行另一个守卫已经拒绝的 preset——这与 `dsh-tools` 的 `ToolRuntime.guard()` 早已为工具调度确立的单调契约完全一致，两个包也复用同一个 `dsh-scope` 的 `AnonymousEntries` 作为幂等的处置器登记表。`standingKeyFor()` 那条冷的、无 agent 的会话记录读取路径,刻意没有被守卫覆盖：它不启动任何 agent 也不启动任何会话，因此对于一个依赖 `agentCtx.agent` 的守卫来说，那里没有任何东西可供判断。

守卫唯一的身份钩子是 `agentCtx.agent`——`dsh-agent` 安装在自己构造出的 context 上的那个 `Agent` 关联，在两个调用点上都存在，因为 `mount()` 与 `recompose()` 永远是用某个 Agent 自己的 `ctx` 调用的。这足以支撑 `RunScheduler.tenantOf(sessionId)`——一个把 `agentCtx.agent.id` 解析成其租户的新公开方法，复用 `findSessionRun` 早已为计量而读取的那份内存中的运行索引。它是同步的，这与 `runIdentityFor` 不同，因为一个守卫没有 `await` 可花，也不需要读取任何要靠凭据保险库解锁的东西——它只从 `RunLedger`/`ControlPlaneStore` 已经常驻内存的状态中作答。

`dsh-tenant-preset-policy` 是把这两者组合起来的、新的 Candy 自有的包：一个函数插件（`name`/`inject`/`Config`/`apply`，没有服务，也没有默认导出），其 `Config.allowlists` 把一个租户 id 映射到它可以使用的那些 preset id，并注册一个守卫，通过 `RunScheduler.tenantOf` 解析出租户，再把这个 preset id 对照该租户的条目核对。在这份映射中没有出现的租户，以及 `tenantOf` 无法为其解析出唯一租户的会话（没有开启中的运行、一个有歧义的认领、一个已不可用的账户），两者都不受限制——这与 `RunScheduler.meterRequest` 对一个背后没有 Candy 运行的会话早已采用的「不是这个运行时该收费的」默认行为相同。

## 后果

一个组合了 `dsh-agent-presets` + `dsh-run-scheduler` + `dsh-tenant-preset-policy` 的 Candy 部署，现在可以按租户指名一份原本共享的 preset 名册的一个子集。任何其他 `dsh-agent-presets` 的部署——完全没有租户概念的那些——都不受影响：名册自身的测试与行为都没有改变，因为守卫登记表在有东西向它注册之前一直是空的。

两个包各自的真实组合测试证明了这一强制执行：`dsh-agent-presets` 自己的测试套件证明了一个守卫会拒绝 `mount()` 与 `recompose()`、能看到正在构造的那个 agent 自己的身份、在多次注册下保持单调，并且从不被那条冷读路径咨询；`dsh-tenant-preset-policy` 的测试套件启动一个真实的调度器（真实的已准入运行、一个真实的、以 SQLite 为后盾的控制平面存储）与一份真实的 preset 名册（与 `dsh-agent-presets` 自己测试所用的同一份 fixture）一起运行，并证明了一个受限的租户会被指名拒绝、一个被允许的 preset 仍能挂载、一个不在名单上的租户不受限制、一个没有开启中运行的会话不受限制，以及一次 preset 切换会被与首次挂载完全一样地守住。

## 考虑过的替代方案

**用一个 waterfall 事件（`agent-preset/resolving`）取代一个 guard 方法。** 已拒绝：waterfall 那种环绕式中间件的形状（调用 `next()` 委派、直接返回则短路）适合逐步构建的一个值，而不适合一个没有数据要累积的、单一的是否判断。`dsh-tools` 自己的 `guard()` 早已在同一个仓库里为完全相同种类的判断确立了更简单、有先例的形状，复用它意味着只需一个共享的登记原语（`AnonymousEntries`），而不用再多记录、再多把关一种分发方式。

**只从 Candy 外层的会话创建包装器里检查这个租户限制。** 直接拒绝：`select()`/`recompose()` 是第二条独立的解析路径，一个会话可以不经过创建它的那个包装器就到达那里——一个只在外层做的检查从构造上就是可以绕过的，而这正是包约定明确点名反对的（「在做出决定的那个操作内部强制执行……通过执行者本身来测试拒绝」）。

**把白名单作为持久化的按租户状态存进 `dsh-control-plane-store`，与 `dsh-tenant-allowance` 自己的额度一致。** 曾经考虑过，因为租户的额度本身就是存储数据，而非静态配置。这一批次里拒绝了：与一个路由/模型限制最接近的现有先例——`dsh-subagent` 的 `ModelSelectionPolicy`——本身也是从 Settings/配置里解析出来的，而不是一份可变的账本，而一份持久化存储需要新的 schema、一次 SQLite 迁移，以及一个大得多的接口，只为了一项在部署配置的节奏上变化、而非在请求节奏上变化的限制。静态的插件 `Config` 是文档记录过的、更窄的选择；把它挪到持久化存储，留给将来某个运维者真正需要在不重启的情况下改变它的那一刻。
