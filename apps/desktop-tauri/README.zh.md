# DeepSeek Harness 桌面端（Tauri）

[English](README.md) | 中文

Tauri 桌面外壳，同时是 Windows 便携包运行时的部署根。它是对上游仓库的**新增**，不是替换：官方 Electron 桌面端原样保留在 `apps/desktop`，因此本分支应用上游改动时不会产生 modify/delete 冲突。

## 本包负责的内容

| 路径 | 作用 |
|---|---|
| `src-tauri/` | Rust 外壳：主机发现、子进程监管、单实例锁、托盘、窗口，以及 Windows job object 的进程树包含边界。 |
| `static/` | `startup-error.html` 与 `mobile-client.html`，外壳无法连通主机时展示。 |
| `icons/`、`README.txt` | 应用图标，以及便携包放在根目录、面向使用者的说明文件。 |
| `package.json` | pnpm 部署根：其 `dependencies` 即便携包捆绑的运行时闭包，其中的脚本负责 Cargo 构建与测试。 |

外壳在 `http://127.0.0.1:3080` 启动内嵌服务端，据此打开窗口；通过托盘关闭窗口时一并停止服务端。它依赖 Microsoft Edge WebView2 运行时，当前 Windows 10 与 11 默认已安装。

## 运行时闭包

`pnpm deploy --prod` 会把本包声明的依赖图部署到归档的 `runtime/` 目录。该依赖图由脚本生成，不手工维护：

```sh
pnpm run desktop:manifest
```

`scripts/release/desktop-tauri-manifest.ts` 从运行时入口（`@deepseek-ai/dsh`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-web-frontend`）出发遍历 workspace，沿 `dependencies`、`optionalDependencies` 以及全部 workspace `peerDependencies` 收集，然后重写清单的 `dependencies` 段。`pnpm run desktop:manifest -- --check` 在提交的清单过期时失败。随后 `pnpm run verify-runtime-closure --manifest apps/desktop-tauri/package.json` 会拒绝清单遗漏的任何可达 workspace peer。

## 构建与测试

```sh
pnpm run desktop:test                 # cargo test for the shell
pnpm run desktop:runtime              # deploy the runtime closure to dist/desktop/runtime
pnpm run desktop:build                # assemble the portable ZIP and its SHA-256
```

`desktop:build` 先用 `tauri build --no-bundle` 构建外壳，再下载 `scripts/release/desktop-node.json` 记录的 Node 载体版本，部署运行时闭包，最后写入 `dist/desktop/output`。归档未签名，因为它是个人构建；首次启动时 Windows SmartScreen 会给出警告。
