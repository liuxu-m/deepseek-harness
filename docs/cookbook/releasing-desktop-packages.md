# Releasing Windows and Android desktop packages

English | [中文](releasing-desktop-packages.zh.md)

This cookbook builds, retrieves, and verifies the Windows portable archive and Android remote-client packages from `.github/workflows/desktop-portable.yml`. The Android client connects to an HTTPS remote Host and never runs DSH tools locally.

## Prerequisites

The repository Actions secrets contain the Android release signing material:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Keep the matching release keystore and its password metadata in an external secure backup. Future APK and AAB packages must use this same signing key and the existing Android application ID to update installed copies. Never store the keystore, passwords, aliases, or encoded keystore data in source, workflow logs, artifacts, issue comments, or chat transcripts.

The Android job runs for pull requests and manual dispatches. The Windows portable job also runs for pushes to `master`.

## Build a release candidate

1. Commit and push the change on a branch, then open or update a pull request. `Desktop packages (Windows and Android)` starts Windows and Android jobs concurrently.

2. To build a branch without a pull request, open **Actions**, select **Desktop packages (Windows and Android)**, choose **Run workflow**, and select the branch. A GitHub CLI user may run:

   ```sh
   gh workflow run desktop-portable.yml --ref <branch>
   ```

3. Wait for both jobs to succeed. The run publishes `desktop-portable-<commit>` for the Windows portable ZIP and `desktop-android-arm64-<commit>` for the signed ARM64 APK plus Play-compatible AAB. Pull-request and manual artifacts expire after seven days.

## Install and verify Android

1. Download and extract `desktop-android-arm64-<commit>` from a successful workflow run.

2. Install `apk/universal/release/app-universal-release.apk` on an ARM64 Android device. The first screen accepts only an HTTPS remote Host URL. Use a protected private-network or reverse-proxy endpoint, not the raw `dsh web` loopback port.

3. Keep `bundle/universalRelease/app-universal-release.aab` for Play Console distribution. Android devices do not install an AAB directly.

4. Verify an APK before distribution when Android SDK Build Tools are available:

   ```sh
   apksigner verify --verbose --print-certs app-universal-release.apk
   ```

   The command must report at least one signer and a successful signature scheme. CI performs this verification before upload.

## Install and verify Windows

1. Download `desktop-portable-<commit>`, extract the ZIP, and launch `DeepSeek Harness.exe`.

2. Keep the extracted directory intact because it includes the bundled Node runtime and production runtime closure.

3. Compare the ZIP against its `.sha256` file before redistribution. CI runs the packaged Windows smoke test before upload.

## Maintain the workflow

1. Before changing `.github/workflows/desktop-portable.yml`, run:

   ```sh
   pnpm exec vitest run scripts/desktop-workflow.spec.ts
   ```

2. Preserve the Android order: generate the Tauri Android project, restore the temporary keystore from Actions secrets, patch the ignored generated Gradle file with release signing configuration, build, verify the APK with `apksigner`, remove the temporary key, then upload only explicit signed APK and AAB paths.

3. `apps/desktop/src-tauri/gen/android/` is ignored. Do not commit its Gradle signing block. CI injects it after `tauri android init`, keeping signing credentials out of source and artifacts.

4. Keep the Android job on Ubuntu and the Windows portable job on `windows-2025`. The portable builder depends on Windows executable and bundled `node.exe` behavior.

5. After a workflow change, push a pull request. Inspect the Android **Configure Android release signing**, **Verify signed Android APK**, and **Upload signed Android APK and AAB** steps. When signing logic changes, download the artifact and run `apksigner verify` once.

## Diagnose common failures

| Symptom | Cause | Repair |
|---|---|---|
| `*-unsigned.apk` is produced | The generated Gradle release build type has no release signing configuration. | Keep the CI signing injection and upload only `app-universal-release.apk`; the policy test rejects wildcard and unsigned upload paths. |
| Gradle reports `Command "tauri" not found` | The generated Android Gradle task cannot resolve the workspace Tauri CLI. | Keep **Expose Tauri CLI to Gradle**, which adds `apps/desktop/node_modules/.bin` to `GITHUB_PATH`. |
| Signing setup reports a missing environment variable | An Actions secret is absent, renamed, or unavailable to the run. | Check the four secret names in repository Actions secrets; never put their values in the workflow. |
| APK verification fails or reports no signer | The wrong output was selected or Gradle did not apply release signing. | Inspect the Gradle injection, rebuild, and verify the explicit APK path with `apksigner`. |
| Maven Central returns HTTP 429 | A transient repository rate limit interrupted Gradle resolution. | Re-run the workflow; the Android build already retries three times with backoff. |
| SDK license installation exits nonzero under `pipefail` | A piped license-acceptance command receives an expected pipe closure. | Keep the workflow non-piped license acceptance implementation. |
| A release cannot update an installed app | The package uses a different signing key or application ID. | Restore the original release keystore and keep the existing application ID; a different key requires a new app identity. |
| The phone cannot connect to the computer | The remote URL is not HTTPS or is unreachable from the phone. | Use an access-controlled HTTPS endpoint such as a Tailnet HTTPS address; never expose the raw DSH port publicly. |

## Before publishing

After changing this cookbook or the workflow, run:

```sh
pnpm exec vitest run scripts/desktop-workflow.spec.ts
pnpm run doc-sync
```

For workflow changes, the final evidence is a successful GitHub Actions run: both package jobs succeed, Android signature verification passes, and the Android artifact contains only the signed APK and AAB.
