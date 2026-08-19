# Agent Note: 手机导航抽屉

Status: implemented

[English](2026-08-19-phone-navigation-drawer.md) | 中文

## Problem

桌面侧边栏关闭后仍保留 56px 控制栏。在手机宽度下，这个控制栏持续压缩对话列，使阅读和输入区域过窄。边到边的 Android WebView 内容还需要浏览器安全区值和动态 viewport 高度。

## Decision

AppFrame 在 767px 及以下将手机 viewport 渲染为 `0px | 1fr | 0px` 网格。侧边栏保持挂载并复用现有 slot 内容，但以左侧覆盖式抽屉打开，而不占用网格轨道。控制收起侧边栏的同一个窄 viewport 状态也控制手机抽屉。菜单按钮、遮罩和 Escape 键可以开关抽屉，且不修改存储的桌面侧边栏首选宽度。

Web 入口声明 `viewport-fit=cover`。Web shell 将安全区 inset 应用到 document body，并在浏览器支持时使用 `100dvh`。手机 header 为菜单按钮预留空间。桌面和 tablet 宽度继续保留原有可调整的三栏布局。

## Alternatives considered

### 保留更窄的常驻控制栏

不采用，因为更窄的控制栏仍会减少可用对话宽度，并使触摸目标更难操作。临时抽屉能保留导航可达性而不压缩阅读列。

### 创建独立的手机导航树

不采用，因为现有 sidebar slot 已经拥有工作区、会话和设置导航。复用它能保留单一导航状态，并避免第二套实现。

### 应用固定的 Android 状态栏内边距

不采用，因为状态栏和打孔区域大小因设备而异。CSS 安全区环境值描述当前 WebView 的显示区域。

## Consequences

- 手机用户主动打开导航，抽屉关闭后回到全宽对话。
- 远程 Web Host 在重新构建 Web assets 后向 Android 客户端交付该行为；原生 Android 包不变。
- AppFrame 测试覆盖手机零宽网格和键盘关闭抽屉，浏览器验收检查实际渲染的抽屉和桌面回归。
