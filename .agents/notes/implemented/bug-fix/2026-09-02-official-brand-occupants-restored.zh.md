# Agent Note: 恢复官方品牌占位组件

Status: implemented

[English](2026-09-02-official-brand-occupants-restored.md) | 中文

## Problem

[Candy 产品品牌](../feature/2026-09-02-candy-product-brand.zh.md) 改名把 `dsh-client-ui-brand-official` 的侧边栏占位组件换成了手绘标记与字面 JSX 文本 `Candy`,并去掉了此前把这些占位组件挡在非 official 构建之外的 `DSH_CLIENT_BUILD_PROFILE !== 'official'` 守卫。Client 源码中的字面产品文案正是 `verify-client-ui-i18n` 所拒绝的内容,因此携带该改名的每个分支上 `pnpm run hygiene` 都会失败。该门禁没有豁免名单:locale 字典是它唯一认可的可翻译文本拥有者,而以 JSX 文本渲染的产品名无法满足它。

## Decision

`packages/client/ui-brand-official` 回到改名之前的占位组件:`OfficialBrandMark` 渲染 `FishLogo`,`OfficialBrandName` 以 `includeMark={false}` 渲染 `BrandWordmark`。两者都是来自 `dsh-client-ui-primitives` 的 `aria-hidden` 矢量图形,因此本包不贡献任何可翻译字符串,无需为产品名新增 locale 条目即可通过 i18n 门禁。

恢复图形的同时也恢复了它的构建 profile 守卫。二者是同一个决定:拼写特定厂商名称的图形只应出现在该厂商的构建中,而包 README 的 profile 段落描述的正是这一安排。没有该守卫,官方图形会在每一个组合了本包的部署中渲染,包括那些本想保留外壳回退内容的部署。

该 Agent Note 所记录的 Candy 产品标识在其余方面不受影响:标题、可安装元数据、引导声明与 README 仍读作 Candy。侧边栏标签也仍停留在它原本所在的位置,即 `brand.localBuild` locale 键,侧边栏外壳与 `AppFrame` 从中读取回退名称与文档标题。因此未占用品牌插槽的构建仍显示 `Candy`,只有 `official` 构建显示厂商字标。

## Alternatives considered

**为产品名新增 locale 条目并通过 `t` 渲染。** 这是门禁认可的路径,并且可以保留 Candy 字标。它落败的原因是 `sidebar.brand.name` 不向其占位组件传入 `t`:该插槽的 owner props 被刻意留空(`children?: never`,"占位组件自行拥有其内容与宽度"),因此本包需要扩宽插槽约定,或拥有自己的 locale 字典——相对于这个品牌问题而言改动过大,而且这会把产品名当作可翻译文案对待。

**在占位组件内复用现有的 `brand.localBuild` 键。** 只需一行,而且该键已经读作 `Candy`。予以拒绝,因为该键命名的是外壳回退时使用的本地构建标签,而不是产品字标;把官方占位组件绑定到它上面,会让这两个界面无法独立变更。

**恢复图形但不恢复守卫。** 作为不自洽的折中方案予以拒绝:README 的 profile 段落会描述代码已不再执行的门控,而厂商图形会在第三方部署中渲染。

## Consequences

`pnpm run hygiene` 以 15/15 通过,`pnpm run doc-sync` 以 32/32 通过;本包自身的测试套件重新固定了字标的 `viewBox` 与 profile 门控,而断言 `Candy` 的侧边栏、布局与快照套件依旧通过,因为它们读取的是 locale 键而不是本包。

产品呈现现在按构建 profile 划分,这正是包 README 所记录的安排:`official` 构建显示厂商标记与字标,其余构建显示 fish 标记与 `Candy` 标签。若某个部署希望在侧边栏插槽本身——而不是通过回退——显示 Candy 名称,则需要自有的品牌包来占用这些插槽,这正是 README 已经指明的组合路径。
