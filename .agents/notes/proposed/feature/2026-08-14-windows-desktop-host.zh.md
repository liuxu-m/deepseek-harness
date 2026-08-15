# Agent Note: 仓库自有的 Windows 桌面端宿主

Status: proposed

[English](2026-08-14-windows-desktop-host.md) | 中文

## Problem

一个开发者预览在 `desktop/` 下作为原型起步，并证明了 WebView2 包装方案在技术上可行：Pake（Tauri + WebView2）把被服务的 Web GUI 打开成一个原生窗口，PowerShell 启动器隐藏启动本地 `dsh web`，等待就绪，显示窗口，并在窗口关闭时停止服务。但该原型达不到已批准设计设定的交付标准：

- 它依赖机器自带的 Node 与 npm，以及从 npm 重新安装到 `desktop/tool/node_modules/@deepseek-ai/dsh` 的副本，因此可能悄悄服务与当前检出源码（`0.1.0-rc.5`）不同的发布版本（`0.1.0-rc.6`）。
- 它用外部的 `[dsh-patch:global-image]` 重放脚本整体覆盖三个 `lib/index.js` 编译产物，因此随附构件并非从当前源码构建。
- 它把端口上任意 HTTP 200 都当作“DSH 实例已在运行”，而任何本地非 Harness 服务同样满足该条件。
- 关闭窗口即停止服务，因此共享同一服务的浏览器标签页会在同一刻断连。
- 它没有托盘、没有单实例锁、没有优雅停机通道、没有进程树隔离，因此控制台启动器消失时，机器的 Harness 进程也会随之丢失。

批准的目标是一个一级 Windows x64 桌面入口，像普通 CLI 一样启动 `web` profile，让每台机器的一个 DSH Web Host 同时服务一个 WebView 窗口和任意浏览器，并让“退出”停掉一切，而窗口只是视口。

## Proposal

在 `apps/desktop/` 下新增一个仓库自有的 Windows 桌面应用，作为一个精简的 Tauri (Rust) 外壳。该外壳只负责单实例、主 WebView2 窗口、系统托盘，以及捆绑的 DSH Web Host 子进程的生命周期。它不引入第二套 UI，也不引入第二层数据：WebView 加载 Host 提供的精确 URL，桌面端与浏览器渲染相同的 `@deepseek-ai/dsh-web-app` Client bundle、API 与会话事件。

### 运行拓扑

一个 DSH Web Host 同时服务两方客户端。桌面 Tauri 进程启动 `bundled node.exe` 从捆绑的 runtime 闭包运行 `web` profile，窗口与任意浏览器连接同一个 `127.0.0.1` 回环 HTTP 端口。

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

### Host 归属与单实例身份

桌面应用持有一个单实例 OS 锁。第二次启动只唤起既有窗口，不派生第二个 Host。当桌面拥有该 Host 时，从托盘“退出”会先走私有停机通道，再等待有界超时，随后通过 Tauri 进程持有的 Windows Job Object（`KILL_ON_JOB_CLOSE`）结束整个进程树，因此桌面崩溃不会泄漏 Host 或其子进程。

在启动自己的 Host 之前，host 主管用 Host 上一个专用的只读运行时身份端点探测配置端口（例如 `GET /api/runtime.identity`）。响应只携带非敏感事实——产品名、桌面协议版本、DSH 版本、实例 id、`homeKind: default` 标记——绝不返回 `$DSH_HOME` 的绝对路径。只有当探测确认正确的产品、兼容的桌面协议与默认 Harness home 时，桌面才附着到外部 Host；任何其他程序的 HTTP 200，或版本不兼容的 DSH，都被拒绝。端口被非 DSH 服务占用时，桌面改为在另一个空闲回环端口启动自己的 Host，而不是杀死占用者。桌面绝不停止它未启动的外部 Host。

### 窗口与托盘生命周期

`X` 把窗口隐藏到托盘，Host 继续运行。托盘提供 Open（恢复/聚焦）、Open in browser（用系统默认浏览器打开实际端口）、View logs 与 Exit。Exit 关闭窗口、停止桌面拥有的 Host（先优雅后强制）、对外部 Host 保持不动。Windows 注销或关机执行有界清理，永不阻塞关机。

### 数据共享与路径

桌面 Host 使用默认 Harness home `%USERPROFILE%\.dsh`，通过仓库既有的 [`home-paths` 解析器](../../implemented/architecture/2026-07-24-single-harness-home-resolver.md) 解析。这与 `$DSH_HOME` 未设置时的 `dsh web` 是同一个根，因此 `profiles/`、`cordis.patch.yml`、`settings.yaml`、`.credentials.yaml`、`.env`、会话日志、投影、附件、workspace、agent preset 与匿名身份被直接共享——不做任何复制或同步。v1 不挂载自定义 `$DSH_HOME`；使用自定义目录的 CLI 用户不会自动合并。初始 Agent 工作目录是 `%USERPROFILE%`，随后由既有 Workspace UI 选择项目。日志写入 `%LOCALAPPDATA%\DeepSeek Harness\logs`，绝不写入便携解压目录，且绝不含 API Key、凭据内容或完整环境转储。

### 构建与打包

发布流水线构建当前仓库修订：Host、Client 与 Web 构件，再按仓库自有的 deploy root 生成仅生产依赖闭包（[单一文件可执行 SDK 运行时](../../implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) 建立的模式），随后加入捆绑的 Node 运行时、Tauri EXE、许可证与构建元数据。构件只从当前源码组装——不下载 npm 发布版 DSH，也不做构建后的 `lib/index.js` 覆盖。`VERSION.json` 记录 DSH 版本、Git commit、Node 版本、桌面协议版本、目标架构与构建时间。产物是 Windows x64 便携 ZIP 外加一份 SHA-256 清单，并通过在无系统 Node、npm、pnpm、Rust 与网络的离线环境下重新解压启动来冒烟验证。

`desktop/` 原型在开发期保留用于对照，只有 `apps/desktop/` 实现通过本验收标准验证后才移除；Pake CLI、npm 运行时下载、补丁重放与 PowerShell 生命周期脚本都不进入正式构建链。

### v1 范围

Windows x64 便携 ZIP；机器需要 WebView2 Runtime（Windows 10/11）；无自动更新、无安装器、无自定义 `$DSH_HOME`、无 macOS/Linux。未来的 WebView2 Fixed Runtime“完全离线”变体与面向公开分发的 Authenticode 签名记录在下方，本次不构建。

## Alternatives considered

### 把 Pake + PowerShell 原型当作产品

改动最小。已拒绝：其 npm 发布版错配的运行时、外部构件补丁、仅凭 HTTP 200 的实例检测、关闭窗口即杀 Host 的行为，以及缺少托盘、单实例、优雅停机与进程隔离，全部违反已批准约定。Pake 的一次性生成适合概念验证，不适合作为长期维护的发行来源。

### Electron 加内嵌 Node sidecar

自带完整 Chromium、不依赖 WebView2。在“Windows 优先、且已普遍具备 WebView2”的基线上被拒绝：ZIP 明显更大、多一套 Node 运行时，并且因为 `node-pty` 等原生模块不以 Electron 的 ABI 为前提，仍然需要独立的 DSH Node sidecar。Tauri 以远小于 Electron 的体积提供托盘/单实例/窗口能力，而机器已自带 WebView2。

### 两个独立 Host（一个桌面拥有、一个 CLI 拥有）

让桌面端和浏览器各自“能用”的最直接路径。已拒绝：两个进程共享同一个 `$DSH_HOME`，因此会话日志、SQLite 投影与搜索索引、配置热加载以及活跃 Agent 的所有权会以 Harness 不支持的方式互相竞争。

### 把数据复制或迁移到独立桌面 home

隔离很干净。直接拒绝：这违背“桌面端与 CLI 显示相同设置、会话与 workspace”的批准要求，也重新制造了[单一 Harness-home 解析器](../../implemented/architecture/2026-07-24-single-harness-home-resolver.md) 所防止的数据分裂。

## Acceptance criteria

- 解压新构建的便携 ZIP 到一台干净的 Windows 10/11 机器，该系统没有 Node/npm/pnpm/Rust、没有网络、也没有其他 DSH 进程；运行 `DeepSeek Harness.exe` 会启动捆绑 Host 与一个可用的 WebView2 窗口。
- 连接到同一运行中 Host 的桌面端与浏览器，与对默认 `~/.dsh` 执行的普通 `dsh web` 运行展示相同的 workspace、设置与会话历史。
- 第二次运行 `DeepSeek Harness.exe` 只唤起第一个窗口，不派生第二个 Host。
- 点击 `X` 隐藏到托盘；Host 仍应答，浏览器仍能加载 GUI；托盘 Open 恢复窗口。
- 托盘 Exit 停止桌面拥有的 Host 及其子进程，`127.0.0.1:<port>` 停止应答；测试中可展示桌面进程树被抛掉后由 Job Object 回收。
- 附着到兼容的外部命令行 DSH Host 可行；退出桌面后该外部 Host 继续运行。
- 端口上的非 Harness HTTP 服务被拒绝，桌面改为在另一个回环端口启动自己的 Host。
- 随附构件不含源码路径、开发者机器的目录、API Key 或个人配置，且每个 `lib/*` 文件与当前仓库构建逐字节一致（对照全新构建，而非被补丁的副本验证）。
- `VERSION.json` 与仓库版本和 Git commit 一致。

## Risks

- **WebView2 缺失。** Windows 10/11 一般预装 webview2.exe，但不绝对；未来捆绑 Fixed Runtime 变体可修复长尾，而不改变 Host 或 runtime 架构。
- **未签名 EXE 与 SmartScreen。** 未受信任的二进制首次运行会告警。面向放心的公开分发需要 Authenticode 签名，这在 v1 便携流程中被推迟。
- **端口与身份猜测。** 实例检测依赖一个尚不存在的 Host 身份端点，必须先加到 Web carrier；在此之前，supervisor 依据文档化探测约定工作并失败关闭，绝不附着到未验证的 HTTP 200。
- **进程树隔离缺口。** Windows Job Object 无法覆盖脱离、在外围派生或涉及 RDP 会话交互的进程。刻意的受控 kill 仍是当前有界的尽力而为。
- **仅默认 home。** 使用自定义 `$DSH_HOME` 运行 CLI 的用户在 v1 不会自动看到桌面状态；强制使用独立桌面 home 不在范围内，并明确反对。
