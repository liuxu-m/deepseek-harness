# Agent Note: 仓库自有的 Windows 桌面端宿主

Status: implemented

[English](2026-08-14-windows-desktop-host.md) | 中文

## Problem

`desktop/` 下的开发者预览证明了 WebView2 包装方案可行，但它依赖机器自带的 Node 与 npm（重新安装的发布版可能悄悄与当前检出不同）、对外部补丁整体重放编译产物、把端口上任意 HTTP 200 当作既有实例、关闭窗口即停止服务，并且没有托盘、单实例锁、优雅停机通道或进程树隔离。仓库因此需要一个一级 Windows x64 桌面入口：像普通 CLI 一样启动 `web` profile，让每台机器的一个 DSH Web Host 同时服务 WebView 窗口与任意浏览器，并让“退出”停掉一切，而窗口只是视口。

## Decision

`apps/desktop/` 是一个精简的 Tauri (Rust) 外壳（crate `deepseek-harness-desktop`，仅 Windows），通过 `tauri-plugin-single-instance` 负责单实例、WebView2 主窗口、系统托盘，以及捆绑的 DSH Web Host 子进程的生命周期。它不引入第二套 UI，也不引入第二层数据：WebView 加载 Host 提供的精确 URL，桌面端与浏览器渲染相同的 `@deepseek-ai/dsh-web-app` Client bundle、API 与会话事件。

### Runtime topology

一个 DSH Web Host 同时服务两方客户端。桌面 Tauri 进程启动捆绑的 `node/node.exe`，从捆绑的 runtime 闭包运行 `web` profile；窗口与任意浏览器连接同一个 `127.0.0.1` 回环 HTTP 端口。

```text
DeepSeek Harness Desktop.exe
├─ Tauri main process
│  ├─ system tray
│  ├─ WebView2 window (loads the Host URL)
│  └─ host supervisor (probe, spawn, readiness, graceful stop)
│
└─ bundled node.exe
   └─ bundled @deepseek-ai/dsh web
      ├─ http://127.0.0.1:<port>  (API + event stream + built web assets)
      │
      ├─ WebView2 window ─┐  connect the same Host
      └─ any browser ─────┘
```

### Host 归属与附着或启动的身份

桌面应用持有一个单实例 OS 锁；第二次启动只唤起既有窗口，不派生第二个 Host。在启动自己的 Host 之前，host 主管探测 `http://127.0.0.1:3080/api/runtime.identity`——一个由 `@deepseek-ai/dsh-web-app` 提供的只读身份路由。响应只携带非敏感事实——`{product: "deepseek-harness", desktopProtocol: 1, version, instanceId, homeKind}`——绝不返回 `$DSH_HOME` 的绝对路径。被探测确认为兼容的监听者（product 匹配、协议 `1`、`homeKind: "default"`、version/instanceId 非空）会被**附着**：桌面绝不触碰该进程，Exit 也只对其解除附着。端口上什么都没有或只有非 DSH 监听者时触发 **StartDefault**（在 3080 启动自有 Host）；3080 被不兼容监听者占用时触发 **StartDynamic**（在动态分配的回环端口启动自有 Host），而不是杀死占用者。探测会解码 chunked-transfer 响应体（Node host 的默认行为），并把响应限制在 4 KiB 以内。

自有 Host 运行捆绑的 `node/node.exe`，执行 `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port <port>`，并被包裹在一个关闭即杀（kill-on-close）的 Windows Job Object 中。原生 `CreateProcessW` 桥接在派生之前会为所有 UTF-16 路径缓冲区（包括显式工作目录）追加 NUL 终止符。就绪判据是 `dsh web: http://127.0.0.1:<port>` 这一 stdout 行加上身份再校验。关停通过 stdin 上的父进程控制帧（`{"type":"shutdown","protocol":1}`）进行，带一个有界宽限期，随后关闭 Job（整树 kill）。桌面崩溃会回收整棵自有进程树。

### 窗口与托盘生命周期

`X` 把窗口隐藏到托盘，Host 继续运行。托盘提供 Open（恢复/聚焦）、Open in browser（用系统默认浏览器打开实际端口）、View logs 与 Exit。Exit 关闭窗口、停止桌面拥有的 Host（先优雅后强制）、对外部 Host 保持不动。

### 数据共享与路径

桌面 Host 使用默认 Harness home `%USERPROFILE%\.dsh`，通过仓库既有的 [`home-paths` 解析器](../../implemented/architecture/2026-07-24-single-harness-home-resolver.zh.md) 解析。这与 `$DSH_HOME` 未设置时的 `dsh web` 是同一个根，因此 `profiles/`、`cordis.patch.yml`、`settings.yaml`、`.credentials.yaml`、`.env`、会话日志、投影、附件、workspace、agent preset 与匿名身份被直接共享——不做任何复制或同步。初始 Agent 工作目录是 `%USERPROFILE%`，随后由既有 Workspace UI 选择项目。日志写入 `%LOCALAPPDATA%\DeepSeek Harness\logs`（`desktop.log` 为外壳事件、`host.log` 为受主管监控的 host 输出），绝不写入便携解压目录。便携目录只包含 EXE、`node/`、`runtime/`、README.txt、LICENSE、THIRD_PARTY_NOTICES.txt 与 VERSION.json。

### 构建与打包

发布流水线构建当前仓库修订：Host、Client 与 Web 构件，再按仓库自有的 deploy root 生成仅生产依赖闭包（[单一文件可执行 SDK 运行时](../../implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md) 建立的模式），随后加入捆绑的 Node 运行时、Tauri EXE、许可证与构建元数据。`scripts/release/build-desktop-runtime.ts` 产出 runtime 闭包；`scripts/release/build-desktop-portable.ts` 组装确定性的便携 ZIP，其使用固定 Node v24.11.1 carrier（以 SHA-256 校验）、`SOURCE_DATE_EPOCH` 保证可复现构建，并经 `RUSTUP_TOOLCHAIN` 固定 MSVC Rust 工具链。`VERSION.json` 记录 `product`、`dshVersion`、`gitCommit`、`nodeVersion`、`desktopProtocol`、`target` 与 `buildTime`。构件只从仓库源码组装——不下载 npm 发布版 DSH，也不做构建后的 `lib/index.js` 覆盖。产物是一个 Windows x64 便携 ZIP，其 SHA-256 由 `desktop-portable` GitHub Actions 工作流（windows-2025）校验，并用 `scripts/smoke-desktop-portable.ps1` 冒烟验证。

Web profile 提供 `globalImage: true`（见 [global-image 记录](2026-08-14-global-image-web-profile.zh.md)），因此图片型提示无需图片能力模型即可被受理。旧的 `desktop/` Pake + PowerShell 原型已移除；Pake CLI、npm 运行时下载、补丁重放与 PowerShell 生命周期脚本都不属于正式构建链。

### v1 范围

Windows x64 便携 ZIP；机器需要 WebView2 Runtime（Windows 10/11）；无安装器、无自动更新、无自定义 `$DSH_HOME`、无 macOS/Linux。

## Verification

`desktop-portable` GitHub Actions 工作流（windows-2025）构建便携 ZIP、校验其 SHA-256，并运行 `scripts/smoke-desktop-portable.ps1`。该冒烟脚本把新构建解压到含空格与 CJK 的路径，隔离 profile 并用干净的子进程 PATH 运行，检查自有/附着模式、关闭到托盘、Job Object 对崩溃进程的回收、端口被占时的回退、`globalImage` 图片提示，以及泄漏扫描。Windows supervisor 测试还会在真实进程上使用已存在的工作目录，覆盖 `CreateProcessW` 路径缓冲区终止规则。

## Alternatives considered

### 把 Pake + PowerShell 原型当作产品

改动最小。已拒绝：其 npm 发布版错配的运行时、外部构件补丁、仅凭 HTTP 200 的实例检测、关闭窗口即杀 Host 的行为，以及缺少托盘、单实例、优雅停机与进程隔离，全部违反约定。Pake 的一次性生成适合概念验证，不适合作为长期维护的发行来源。

### Electron 加内嵌 Node sidecar

自带完整 Chromium、不依赖 WebView2。在“Windows 优先、且已普遍具备 WebView2”的基线上被拒绝：ZIP 明显更大、多一套 Node 运行时，并且因为 `node-pty` 等原生模块不以 Electron 的 ABI 为前提，仍然需要独立的 DSH Node sidecar。Tauri 以远小于 Electron 的体积提供托盘/单实例/窗口能力，而机器已自带 WebView2。

### 两个独立 Host（一个桌面拥有、一个 CLI 拥有）

让桌面端和浏览器各自“能用”的最直接路径。已拒绝：两个进程共享同一个 `$DSH_HOME`，因此会话日志、SQLite 投影与搜索索引、配置热加载以及活跃 Agent 的所有权会以 Harness 不支持的方式互相竞争。

### 把数据复制或迁移到独立桌面 home

隔离很干净。直接拒绝：这违背“桌面端与 CLI 显示相同设置、会话与 workspace”的要求，也重新制造了[单一 Harness-home 解析器](../../implemented/architecture/2026-07-24-single-harness-home-resolver.zh.md) 所防止的数据分裂。

## Consequences

- 每台机器的一个 DSH Web Host 在同一个回环端口上同时服务 WebView 窗口与任意浏览器，且没有第二套 UI 或数据层。
- 附着或启动策略让桌面不触碰外部 Host 的进程：兼容的外部 Host 永不被改动并会在桌面 Exit 后继续存活，不兼容的占用者只把桌面推到动态端口，而不是被杀掉。
- 捆绑的 Node 运行时、固定的工具链、SHA-256 校验与 Job-Object 隔离让便携 ZIP 自洽、可复现，并在 Windows 上崩溃安全。
- 移除 `desktop/` 原型并仅从源码组装，保证每个随附构件与当前仓库构建逐字节一致。

## Known limitations

- **未签名 EXE 与 SmartScreen。** v1 便携 EXE 未签名，首次运行的 SmartScreen 会告警；Authenticode 签名暂缓。
- **极旧 Windows 上的 WebView2 缺失。** Windows 10/11 一般预装 WebView2，但不绝对；捆绑 Fixed Runtime 的变体暂缓。
- **Job Object 无法覆盖脱离进程。** 隔离是有界的尽力而为；脱离或在外围派生的进程会逃出关闭即杀的进程树。
- **仅默认 home。** 以自定义 `$DSH_HOME` 运行 CLI 的用户不会自动看到桌面状态；v1 只支持默认 Harness home。
