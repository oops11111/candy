# 审计窗口有了入口

[English](2026-09-09-the-audit-window-has-a-door.md) | 中文

Candy 现在通过 `GET /api/candy/audits` 暴露保留期内的租户与运行时审计窗口。继承的管理信封从 OAuth 会话派生身份，并且只允许管理员进入。响应携带 `retention` 与 `completeHistory: false`，绝不会暗示已被有界存储挤出的记录还能翻页取回。

DSH 设置框架在 Provider 账户页之外收到第二个 `candy-audit` section。它复用既有导航、渲染器、本地化、响应式布局和主题，不建立第二套 Web 界面。

测试证明成员收到 403，而管理员能读取两个窗口。原计划用于负控制的弱化路由角色变异在写入前被执行策略拒绝，因此没有运行或保留任何被削弱的授权状态。
