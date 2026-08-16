# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The Windows desktop shell for DeepSeek Harness: a Tauri 2 host process that discovers a compatible Web Host on the loopback default port, supervises the bundled web runtime, and presents it in a native WebView2 window with a tray. The package itself is not published; `scripts/release/build-desktop-portable.ts` assembles the portable ZIP that ships it.

## Supported baseline

Windows 10 or 11 (x64) with the Microsoft Edge WebView2 runtime (preinstalled on current Windows). The portable archive contains a bundled Node runtime (`node/node.exe`) and the production runtime closure (`runtime/`), so no Node.js installation, npm, or network is needed to run it. macOS and Linux are unsupported in v1; installers, auto-update, and a custom `$DSH_HOME` are unsupported.

## Archive layout

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

Build the archive with `pnpm run desktop:build` (Windows, MSVC Rust toolchain). `scripts/release/build-desktop-portable.ts` pins the Node carrier, verifies its SHA-256, assembles the stage, and writes a deterministic ZIP plus `.sha256`; `SOURCE_DATE_EPOCH` must be set for a reproducible release build.

## Host ownership

On startup the shell probes `http://127.0.0.1:3080/api/runtime.identity`. A compatible host there is **attached**: the shell never touches that process, and Exit only detaches. Otherwise the shell starts its own bundled host at the default port, or at a dynamically assigned loopback port when 3080 is occupied by a non-compatible listener. An owned host is contained in a kill-on-close Job Object; closing the window hides to the tray, tray Exit shuts the owned host down gracefully (bounded) and then exits the app, and a desktop crash reclaims the whole owned process tree.

## Runtime identity compatibility

`GET /api/runtime.identity` answers `{product: "deepseek-harness", desktopProtocol: 1, version, instanceId, homeKind}`. The shell attaches only to a host with `desktopProtocol: 1`, a default home (`homeKind: "default"`), and non-empty version/instance id. The bundled Web profile ships `globalImage: true`, so image-bearing prompts are admitted without requiring an image-capable model.

## Data and logs

Per-user state lives under `%USERPROFILE%\.dsh` (the default home; the shell never writes state into the portable folder). Logs live under `%LOCALAPPDATA%\DeepSeek Harness\logs`: `desktop.log` records shell lifecycle events, `host.log` the supervised host's output. Tray "View logs" opens that directory.

## Development

Run the native tests with `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`. The packaged acceptance smoke is `scripts/smoke-desktop-portable.ps1`, invoked by the `desktop-portable` GitHub Actions workflow on `windows-2025` after `pnpm run desktop:build`. It extracts the archive into a path with spaces and CJK characters, isolates the user profile, strips development tools from the child PATH, and exercises owned start, attach, close-to-tray, crash cleanup, occupied-port fallback, image-prompt admission, and a leak scan.

The shell is unsigned in development; Windows SmartScreen or antivirus may warn on a locally built copy.
