# Agent Note: Phone frame pins the center column to the full-width middle track

Status: implemented

[English](2026-08-27-phone-center-column-grid-placement.md) | 中文

## Problem

在手机宽度（frame 的 767px 断点及以下）下，真实浏览器引擎里对话渲染为空白页，但 DOM 已完整挂载、单元测试也通过。中心列的内容盒在三条轨道组成的 frame 里解析为 0px 宽，于是每条消息和输入框都绘制在一个不可见的列里。问题来自通过 Tailscale HTTPS serve 访问 GUI 的手机；桌面视口不受影响。

根因在[手机导航抽屉](../bug-fix/2026-08-19-phone-navigation-drawer.zh.md)决策里。为了让侧边栏在手机上成为覆盖层，`.frame[data-phone] .sidebarCol` 变成 `position: absolute`，`.detailsCol` 变成 `display: none`。frame 的手机内联网格模板始终是 `0px minmax(0, 1fr) 0px`，三个列子的源码顺序是 sidebar → center → details。在桌面上，侧边栏仍在网格流内，源码顺序的自动放置算法碰巧把中心列放进中间轨道。在手机上，侧边栏脱离网格流、详情列不再作为网格项，于是中心列成为唯一在流内的网格项，自动放置把它塞进了**第一条（0px 宽）轨道**。布局意图——全宽会话配临时抽屉——从未在放置层面实现。

缺陷静默上线，因为现有覆盖看不到它。`app-frame.client.spec.tsx` 只断言 `frame.dataset.phone` 和 `grid-template-columns` 内联字符串，而 jsdom 从不执行真实网格布局，无法观察网格项实际落入哪条轨道。web e2e 场景在桌面视口宽度运行，从不触发手机断点。

## Decision

在与 `[data-phone] .sidebarCol` 相同的手机媒体查询里，为中心列增加显式网格放置：

```css
.frame[data-phone] .centerCol {
  grid-row: 1;
  grid-column: 2;
}
```

frame 已把中间轨道尺寸设为 `minmax(0, 1fr)`，在手机上解析为 frame 全宽，因此把中心列放进中间轨道即把会话钉到全宽。放置现在是显式的、不依赖源码顺序，未来对 frame 子元素重新排序也不会再静默破坏手机布局。

三个列子获得稳定的 `data-frame-column="sidebar|center|details"` 属性，浏览器验收可以按行为钩子选中它们，而不是哈希后缀的类名。

新增浏览器验收覆盖：`apps/web/tests/phone-frame-geometry.e2e.ts` 扫一个手机档（393px）和一个对照档（900px），记录关系式 golden，并断言手机档下 frame 带上 `data-phone`、中心列非零且横跨整个 frame、对话滚动容器位于其中。900px 对照档是桌面三栏布局，侧边栏自动收起为 56px 窄轨，中心列不再横跨 frame——证明手机测量并非平凡地恒为真。

## Alternatives considered

### 让 frame 在手机上变成单轨道网格
与其钉住中心列，不如在设置 `data-phone` 时把 frame 的 `grid-template-columns` 设为单条 `100%` 轨道。轨道布局是 `AppFrame.tsx` 拥有的内联样式（`cols`），因此需要组件分支而非一条 CSS 规则，而三条轨道模板也是组件始终写出的桌面契约。纯 CSS 放置把修复集中在一处，且不为第二种布局分叉组件的列计算。

### 让侧边栏在手机上以零宽留在流内
让侧边栏继续作为网格项（宽度 0、平移出屏）可以保留自动放置顺序。但它去掉了手机笔记选择的叠加抽屉设计——带阴影、遮罩和边到边安全区处理的悬浮抽屉——并重新引入该笔记修掉的窄内容风险。叠加方案是已交付的决策；缺陷只是该决策留下的隐式放置。

### 在中心列前插入一个空的网格项占位
在网格流里加一个兄弟占位就能恢复源码顺序而无需 CSS 放置。它把布局耦合到 DOM 顺序，除非处理否则在无障碍树里不可见，并且恰好重新引入显式放置要消除的顺序脆弱性。

## Consequences

- 手机宽度现在显示全宽会话，会话内容与输入框可见，符合[Android 远程客户端](../feature/2026-08-18-android-remote-client.zh.md)所述“在手机宽度下共享 Web UI 保持会话全宽”。
- 网格放置显式且经受真实引擎放置测试；关系式 golden 记录行为而非像素，因此能扛住平台的亚像素差异。
- `data-frame-column` 仅是测试钩子——不引入运行时行为，也不改变列的渲染方式。
- 手机导航抽屉笔记里“AppFrame tests cover the zero-width phone grid”的说法在单元层面仍有误导性：jsdom 无法断言真实放置，因此浏览器 e2e 才是实际覆盖。本笔记的 Testing 面即该 e2e。

## Related

- [Phone navigation drawer](../bug-fix/2026-08-19-phone-navigation-drawer.zh.md) — 引入本笔记在放置层面修复的叠加抽屉手机网格。
- [Android remote client](../feature/2026-08-18-android-remote-client.zh.md) — 声明手机宽度下全宽会话的承诺。
