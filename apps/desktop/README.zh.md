# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness 的 Windows 桌面外壳：一个 Tauri 2 宿主进程，在环回默认端口发现兼容的 Web Host，监督捆绑的 Web 运行时，并在原生 WebView2 窗口加系统托盘中呈现它。该包本身不发布；`scripts/release/build-desktop-portable.ts` 组装发布它的便携 ZIP。

## 受支持基线

Windows 10 或 11（x64），带 Microsoft Edge WebView2 运行时（当前 Windows 预装）。便携归档包含捆绑的 Node 运行时（`node/node.exe`）和生产运行时闭包（`runtime/`），运行它无需安装 Node.js、npm 或网络。v1 不支持 macOS 和 Linux；不支持安装器、自动更新和自定义 `$DSH_HOME`。

## 归档布局

```text
DeepSeek Harness/
  DeepSeek Harness.exe   Tauri shell
  node/node.exe          bundled Node runtime
  runtime/               bundled dsh web runtime closure
  README.txt             end-user quick start
  LICENSE                repository license
  THIRD_PARTY_NOTICES.txt  disclosed dependency licenses
  VERSION.json           provenance metadata
```

用 `pnpm run desktop:build` 构建归档（Windows，MSVC Rust 工具链）。`scripts/release/build-desktop-portable.ts` 固定 Node 载体、校验其 SHA-256、组装 stage，并写出确定性 ZIP 加 `.sha256`；可复现的发布构建必须设置 `SOURCE_DATE_EPOCH`。

## 宿主所有权

启动时外壳探测 `http://127.0.0.1:3080/api/runtime.identity`。那里的兼容宿主被**附加**：外壳从不触碰该进程，Exit 仅分离。否则外壳在默认端口启动自己的捆绑宿主；当 3080 被不兼容监听者占用时，改在动态分配的环回端口启动。自有宿主被包含在关闭即杀（kill-on-close）的 Job 对象中；关闭窗口隐藏到托盘，托盘 Exit 先（有界地）优雅关闭自有宿主再退出应用，桌面崩溃会回收整个自有进程树。

## 运行时身份兼容

`GET /api/runtime.identity` 返回 `{product: "deepseek-harness", desktopProtocol: 1, version, instanceId, homeKind}`。外壳只附加到 `desktopProtocol: 1`、默认 home（`homeKind: "default"`）、version 与 instanceId 非空的宿主。捆绑的 Web profile 自带 `globalImage: true`，因此带图提示无需支持图像的模型即可准入。

## 数据与日志

每用户状态位于 `%USERPROFILE%\.dsh`（默认 home；外壳从不把状态写进便携文件夹）。日志位于 `%LOCALAPPDATA%\DeepSeek Harness\logs`：`desktop.log` 记录外壳生命周期事件，`host.log` 记录被监督宿主的输出。托盘"查看日志"打开该目录。

## 开发

用 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` 运行原生测试。打包验收冒烟是 `scripts/smoke-desktop-portable.ps1`，由 `desktop-portable` GitHub Actions 工作流在 `pnpm run desktop:build` 后的 `windows-2025` 上调用。它把归档解压到含空格和 CJK 字符的路径，隔离用户 profile，从子进程 PATH 移除开发工具，并演练自有启动、附加、关闭到托盘、崩溃清理、端口占用回退、图像提示准入和泄漏扫描。

外壳在开发中未签名；Windows SmartScreen 或杀毒软件可能对本地构建的副本发出警告。
