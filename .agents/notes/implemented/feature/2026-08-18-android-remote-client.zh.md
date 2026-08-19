# Agent Note: Android 远程客户端

Status: implemented

[English](2026-08-18-android-remote-client.md) | 中文

## Problem

Windows 外壳负责启动本地 Node Web Host 和 Windows 进程控制，因此它的便携式可执行文件不能直接复用为 Android 包。手机端需要复用同一套 Web UI，同时不把 Agent 执行、文件访问和 Shell 工具迁移到 Android。

## Decision

Android target 是一个精简的 Tauri 客户端。它创建一个 WebView，加载 mobile-client.html，允许操作者输入电脑上的 HTTPS dsh web 地址。设置页校验绝对 HTTPS 地址，把最近一次地址保存到 WebView local storage，然后跳转到远程 Host。Android target 不编译或启动 Windows supervisor、捆绑 Node carrier、托盘或进程控制模块。

现有 Windows target 继续负责启动捆绑的本地 Host。dsh web 的命令行拒绝公开监听，且服务本身没有内置身份验证或 TLS，因此远程 Host 必须经 HTTPS 和访问控制保护的入口访问；客户端不增加代理，也不放宽 Web Host 的访问控制。

## Alternatives considered

### 在 APK 中捆绑本地 Node Host

本 target 不采用此方案：它需要 Android Node carrier、原生依赖的 Android 构建、PowerShell 和 Windows 进程控制的替代实现，以及 Android 文件系统和后台进程策略，而远程客户端不需要这些能力。

### 只使用浏览器或 PWA

不作为产品包采用：它不提供用户要求的可安装 Android 客户端。Tauri WebView 能复用现有 Web UI，同时提供 APK/AAB 构建 target。

## Consequences

- Android 打包独立于 Windows 便携式归档，不包含 Node 或 DSH runtime 文件。
- 首次客户端页面要求输入可访问的远程地址；修改保存地址需要返回设置页或清除应用 WebView 数据。
- Android 构建机需要 Tauri Android 项目，以及 Android SDK、NDK、Java 和 Gradle 环境；仓库工作流可在 Ubuntu 上提供这些环境，并在 PR 和手动运行时上传 ARM64 APK/AAB artifact。
- 远程 Web Host 继续作为 session、设置、凭据、workspace 和工具执行的唯一拥有者。
