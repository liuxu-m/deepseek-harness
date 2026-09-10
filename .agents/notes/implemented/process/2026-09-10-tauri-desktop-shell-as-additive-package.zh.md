# Agent Note：Tauri 桌面外壳作为新增包

Status: implemented

[English](2026-09-10-tauri-desktop-shell-as-additive-package.md) | 中文

## 问题

个人 Windows 便携版需要一个外壳：启动内嵌的 dsh 运行时、持有窗口、关闭时停止运行时。最初的实现复用了官方 `apps/desktop` 包：Tauri 源码就地替换 Electron 源码，删除了六十个 Electron 文件并改写了包清单。上游一直在改动 `apps/desktop`（撰写时三天内十二个提交），因此每次同步都会在本分支已删除的文件上产生 modify/delete 冲突，并在 `package.json`、`tsconfig.host.json`、`tsdown.config.ts` 上产生三方冲突——同一处删除手术每次都要重做。

维护者的要求是：外壳要保留，同时上游合并保持低成本，并且运行时闭包不再需要在上游新增或改名包时手工修补。

## 决策

Tauri 外壳是独立的 workspace 包 `apps/desktop-tauri`（`@deepseek-ai/dsh-desktop-tauri`），新增在未改动的官方 `apps/desktop` 旁边。本分支只新增文件、追加行，不删除上游包中的任何内容。

由此产生三项机械性结果。

运行时部署根随之迁移。`apps/desktop-tauri/package.json` 是 `pnpm deploy --prod` 部署的包，`scripts/release/build-desktop-runtime.ts` 与 `scripts/release/build-desktop-portable.ts` 通过 `DESKTOP_PACKAGE`、`DESKTOP_MANIFEST`、`DEFAULT_EXE` 以及部署 hoist 恢复路径引用它。官方清单及其发布脚本原样保留、不受影响。

闭包由生成而非维护。`scripts/release/desktop-tauri-manifest.ts` 从 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-web-frontend` 出发遍历 workspace，沿 `dependencies`、`optionalDependencies` 以及全部 workspace `peerDependencies` 收集，并重写清单的 `dependencies` 段；`--check` 会把过期清单变成失败。此前手工维护的列表必然是漂移的：对照本分支现在跟踪的包，有五十个列出的条目没有对应 workspace 清单，另有五十五个可达包被遗漏。遍历还会声明 `PLUGIN_CLIENT_PEERS`——`@deepseek-ai/dsh-client-ui-primitives` 与 `@deepseek-ai/dsh-client-ui-slots`：上游把二者保留为构建期 `devDependencies`，而已发布的 bundle 可能在 `dsh.client.inject` 中指名它们；手工列表曾随包提供它们，一旦丢弃，解析回退到本运行时的 profile 就会插件加载失败。

根接线是纯追加的。`package.json` 保留全部上游 `build:desktop` 至 `upload:win:x64` 行，并新增 `desktop:manifest`、`desktop:runtime`、`desktop:build`、`desktop:test`。`tsdown.config.ts` 与 `tsconfig.host.json` 完全不改动，因为官方 Electron 桌面端仍是这些配置已覆盖的 workspace 成员。

## 运行时闭包遍历

遍历从三个入口开始：启动应用的 `dsh` CLI、组合应用层的 Web profile bundle，以及 CLI 提供的已构建 Web 前端资产。通过这些入口可达，才意味着该包在运行时可达；随后 `verify-runtime-closure` 强制检查生成列表仍可能违反的两项属性——交付的 agent preset 引用的每个插件，以及每个已声明包的非可选 workspace peer。

部署保留 `--config.auto-install-peers=false`，因此未声明的 workspace peer 在运行时是无法解析的，而不会被静默补装。可选 peer 会被声明但不继续遍历：消费方一旦加载就必须能解析，而继续遍历会拉入归档并不需要的树。

## 曾考虑的替代方案

**继续就地替换 `apps/desktop`。** 这是本分支最初的做法。它只需一个包而非两个，并复用官方清单的部署接线；但上游每次触及 `apps/desktop` 的提交都可能冲突，冲突率随上游活跃度上升。低成本合并的要求与"删除上游仍在编辑的文件"不相容。

**把 Tauri 外壳放到独立仓库。** 这样被跟踪的仓库就没有本地新增内容。但它失去 workspace link 解析，运行时闭包必须从已发布的 npm 包拼装，而不是通过 workspace link 上的 `pnpm deploy`；同时它需要自己的 CI 来构建和冒烟测试归档。本分支已经带有打包脚本与工作流，放在一起即保持单一构建路径。

**手工维护那 150 条依赖列表。** 直观、明确，不需要生成器。但它已经漂移，而且漂移是延迟暴露的——在归档运行时 Cordis 无法解析插件时才失败，而不是在清单生成时。

## 后果

上游同步现在以针对新增文件的普通合并方式应用，`pnpm run desktop:manifest` 无需改动代码即可吸收上游的包新增与改名。仓库因此提供两个桌面外壳：`apps/desktop`（官方 Electron，未改动）与 `apps/desktop-tauri`（本分支的便携版）。闭包生成器必须跟上新的运行时入口；新增第四个 seed 属于清单变更而非代码变更，但遗漏一个就会静默地从归档中丢掉包。

便携归档未签名，且 `apps/desktop-tauri` 不提供更新通道。两者都是个人构建的属性，不是仓库的属性。

## 验证

`pnpm run verify-runtime-closure --manifest apps/desktop-tauri/package.json` 在四个交付 preset 与可达 workspace 包上报告零失败。`apps/desktop-tauri/README.md` 及其中文对照文件记录了闭包生成器、部署根与构建命令。
