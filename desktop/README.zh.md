# DeepSeek Harness — Windows 桌面客户端

用 [Pake](https://github.com/tw93/Pake)（Tauri + WebView2，约 10 MB）把
DeepSeek Harness 的浏览器 GUI 打包成轻量原生 Windows 窗口应用。桌面双击图标即可
启动，无需命令行、无黑窗口；同一服务随时可用任意浏览器访问。

```
desktop/
  build.ps1            # 用 Pake 把 Web GUI 打包成桌面应用
  launch.ps1           # 运行时启动器：隐藏启动 dsh web -> 等待就绪 -> 开窗口 -> 关窗停服
  launch.vbs           # 零控制台入口（快捷方式指向它）
  create-shortcut.ps1  # 在桌面创建 "DeepSeek Harness" 快捷方式
  open-browser.ps1     # 用默认浏览器打开 http://127.0.0.1:3080
  assets/icon.png      # 应用图标（由 apps/web/public/favicon.svg 渲染）
  dist/                # 构建产物："DeepSeek Harness.exe" + 安装包 .msi
  logs/                # 启动时写入的服务日志
  tool/                # 本地 Pake CLI（npm 安装，非 pnpm workspace 成员）
```

## 工作原理

- 应用窗口加载 `http://127.0.0.1:3080` —— 与浏览器 GUI 是同一个服务，URL 在
  构建期固化。
- `launch.ps1` 通过 `node` 直接运行**本地安装**的 `@deepseek-ai/dsh` bin
  （`desktop\tool\node_modules\@deepseek-ai\dsh\lib\bin.js`）隐藏启动服务——
  不经过 npx、不连仓库镜像、不用 shell shim（npx 在这台机器上会因镜像/缓存
  不可达而间歇性报 "'dsh' 不是内部或外部命令"）。等待端口就绪后打开窗口；
  窗口关闭时停止服务（进程树）。
- 若端口上已有服务在跑（例如你手动在终端里启动的实例），启动器只打开窗口，
  不启动也不停止任何东西。
- 启动失败会弹出可见的对话框，不再静默失败。

想更新本地安装的 dsh 包版本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\launch.ps1 -Update
```

## 前置要求（build.ps1 会检查）

- Node.js ≥ 22（含 npm）—— Pake CLI 和启动器（node）都需要
- Rust 工具链（rustc/cargo）—— 首次构建编译 Tauri 壳
- WebView2 运行时 —— Windows 10/11 自带

## 构建一次

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\build.ps1
```

首次构建会下载 crate 并编译 Rust，约 5–15 分钟。产物在 `desktop\dist\`：

- `DeepSeek Harness.exe` —— 独立可执行文件（日常用这个）
- `DeepSeek Harness_*.msi` —— 可选安装包

## 安装到桌面

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\create-shortcut.ps1
```

在桌面创建 **DeepSeek Harness** 快捷方式，双击启动无控制台窗口
（wscript → 隐藏 PowerShell）。

## 使用

- 双击桌面 **DeepSeek Harness**（或 `desktop\launch.vbs`）。
- 服务就绪后窗口打开；首次启动会安装本地 `@deepseek-ai/dsh` 副本并初始化
  profile，可能稍慢。
- **浏览器支持**：应用运行期间，用任意浏览器打开 `http://127.0.0.1:3080`，
  或运行 `desktop\open-browser.ps1`。窗口与浏览器操作的是同一个 harness。
- 关闭窗口即停止服务；如果服务在打开应用前已在运行，关闭窗口不会停它。

## 常见问题

- **首次构建慢** —— 是 Rust 编译，不是卡死。
- **首次运行 SmartScreen 提示** —— exe 未签名，点"更多信息"→"仍要运行"。
  本地构建的应用属正常现象。
- **提示 "node not found"** —— 安装 Node.js 后重开终端。
- **端口 3080 被非 HTTP 程序占用** —— 关掉占用程序，或换端口重新打包：
  `desktop\build.ps1 -Port <端口>`，再以 `launch.ps1 -Port <端口>` 启动。
- **服务日志** —— `desktop\logs\server.log` / `server.err.log`。
- **Pake/Rust 构建报错** —— 用 `rustc --version`、`cargo --version` 确认工具链，
  并确认已安装 WebView2 运行时。
- **杀毒软件** 可能隔离未签名的全新二进制，必要时加白名单。

## 可复现性

- `desktop\tool\package.json` 固定 `pake-cli@3.15.6`，并用 npm `overrides`
  强制单一 `sharp` 版本。两个 sharp 版本（icon-gen 引入的 0.33.5 与 0.35.3）
  会在 Windows 上因同名 `libvips-42.dll` 重复加载而报
  `ERR_DLOPEN_FAILED`；override 已规避。重新安装：
  `npm install --prefix desktop\tool`。
- Pake 每次构建都会在自己的包目录内重装依赖（`cd <pake-cli> && npm install`），
  会再次引入 icon-gen 的双 sharp 冲突。因此 `build.ps1` 会在每次构建前把 npm
  `overrides` 补丁写入 `pake-cli` 自己的 `package.json`，并清掉其过期的嵌套
  `node_modules`（两步均幂等、自动执行）。
- 图标由 `desktop\tool\make-icon.mjs` 从 favicon 生成
  （仓库根目录运行 `node desktop/tool/make-icon.mjs`）。
