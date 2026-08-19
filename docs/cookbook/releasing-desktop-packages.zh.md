# 发布 Windows 和 Android 桌面包

[English](releasing-desktop-packages.md) | 中文

本实操手册用于构建、获取和验证 `.github/workflows/desktop-portable.yml` 生成的 Windows 便携版归档和 Android 远程客户端包。Android 客户端连接 HTTPS 远程 Host，绝不在本地执行 DSH 工具。

## 前提条件

仓库的 Actions Secrets 包含 Android release 签名材料：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

把对应的 release keystore 和密码元数据保存在外部安全备份中。未来的 APK 和 AAB 必须继续使用同一签名密钥和现有 Android application ID，才能更新已安装的版本。绝不要把 keystore、密码、alias 或编码后的 keystore 数据存入源文件、工作流日志、artifact、issue 评论或聊天记录。

Android job 在 PR 和手动触发时运行。Windows 便携版 job 还会在推送到 `master` 时运行。

## 构建发布候选版本

1. 在分支上提交并推送更改，然后创建或更新 PR。`Desktop packages (Windows and Android)` 会并行启动 Windows 和 Android job。

2. 若无需 PR 也要构建分支，请打开 **Actions**，选择 **Desktop packages (Windows and Android)**，点击 **Run workflow**，再选择分支。GitHub CLI 用户也可运行：

   ```sh
   gh workflow run desktop-portable.yml --ref <branch>
   ```

3. 等待两个 job 都成功。该 run 会发布 Windows 便携版 ZIP 的 `desktop-portable-<commit>`，以及已签名 ARM64 APK 和适用于 Play 的 AAB 的 `desktop-android-arm64-<commit>`。PR 和手动运行的 artifact 保存七天。

## 安装和验证 Android

1. 从成功的工作流 run 下载并解压 `desktop-android-arm64-<commit>`。

2. 在 ARM64 Android 设备上安装 `apk/universal/release/app-universal-release.apk`。首个页面只接受 HTTPS 远程 Host 地址。使用受保护的私有网络或反向代理入口，不要使用原始 `dsh web` 环回端口。

3. 保留 `bundle/universalRelease/app-universal-release.aab` 用于 Play Console 分发。Android 设备不能直接安装 AAB。

4. Android SDK Build Tools 可用时，在分发前验证 APK：

   ```sh
   apksigner verify --verbose --print-certs app-universal-release.apk
   ```

   命令必须报告至少一个 signer 和一个成功的签名方案。CI 会在上传前执行此验证。

## 安装和验证 Windows

1. 下载 `desktop-portable-<commit>`，解压 ZIP，然后启动 `DeepSeek Harness.exe`。

2. 保持解压后的目录完整，因为其中包含捆绑的 Node runtime 和生产 runtime closure。

3. 重新分发前，用其 `.sha256` 文件校验 ZIP。CI 会在上传前运行已打包的 Windows 冒烟测试。

## 维护工作流

1. 修改 `.github/workflows/desktop-portable.yml` 前，运行：

   ```sh
   pnpm exec vitest run scripts/desktop-workflow.spec.ts
   ```

2. 保持 Android 顺序：生成 Tauri Android 项目，从 Actions Secrets 恢复临时 keystore，为被忽略的生成 Gradle 文件注入 release 签名配置，构建，用 `apksigner` 验证 APK，删除临时密钥，然后只上传明确的已签名 APK 和 AAB 路径。

3. `apps/desktop/src-tauri/gen/android/` 已被忽略。不要提交它的 Gradle 签名块。CI 在 `tauri android init` 后注入它，从而让签名凭据不进入源文件和 artifact。

4. Android job 保持在 Ubuntu，Windows 便携版 job 保持在 `windows-2025`。便携版构建器依赖 Windows 可执行文件和捆绑 `node.exe` 的行为。

5. 修改工作流后，推送 PR。检查 Android 的 **Configure Android release signing**、**Verify signed Android APK** 和 **Upload signed Android APK and AAB** 步骤。修改签名逻辑时，下载 artifact 并运行一次 `apksigner verify`。

## 排查常见故障

| 症状 | 原因 | 修复方式 |
|---|---|---|
| 生成 `*-unsigned.apk` | 生成的 Gradle release build type 没有 release 签名配置。 | 保留 CI 签名注入，并且只上传 `app-universal-release.apk`；policy 测试会拒绝通配符和未签名上传路径。 |
| Gradle 报告 `Command "tauri" not found` | 生成的 Android Gradle task 无法解析 workspace Tauri CLI。 | 保留 **Expose Tauri CLI to Gradle**，它会将 `apps/desktop/node_modules/.bin` 加入 `GITHUB_PATH`。 |
| 签名设置报告缺少环境变量 | 某个 Actions Secret 缺失、改名或对此次 run 不可用。 | 在仓库 Actions Secrets 中检查四个 Secret 名称；绝不要在工作流中写入它们的值。 |
| APK 验证失败或没有报告 signer | 选择了错误产物，或者 Gradle 没有应用 release 签名。 | 检查 Gradle 注入，重新构建，并用 `apksigner` 验证明确的 APK 路径。 |
| Maven Central 返回 HTTP 429 | 短暂的仓库限流中断了 Gradle 解析。 | 重新运行工作流；Android 构建已通过退避重试三次。 |
| 在 `pipefail` 下 SDK 许可证安装非零退出 | 管道式许可证接受命令遇到预期的管道关闭。 | 保留工作流中非管道式的许可证接受实现。 |
| 新 release 无法更新已安装应用 | 包使用了不同的签名密钥或 application ID。 | 恢复原始 release keystore 并保留现有 application ID；不同密钥需要新的应用身份。 |
| 手机无法连接电脑 | 远程地址不是 HTTPS，或手机无法访问。 | 使用带访问控制的 HTTPS 地址，例如 Tailnet HTTPS 地址；绝不要公开原始 DSH 端口。 |

## 发布前

修改本实操手册或工作流后，运行：

```sh
pnpm exec vitest run scripts/desktop-workflow.spec.ts
pnpm run doc-sync
```

对于工作流变更，最终证据是成功的 GitHub Actions run：两个打包 job 都成功，Android 签名验证通过，Android artifact 只包含已签名 APK 和 AAB。
