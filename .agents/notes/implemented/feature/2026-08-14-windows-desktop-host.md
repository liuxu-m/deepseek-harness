# Agent Note: Repository-owned Windows desktop host

Status: implemented

English | [中文](2026-08-14-windows-desktop-host.zh.md)

## Problem

A developer preview under `desktop/` proved the WebView2 wrapper works, but it depended on the machine's own Node and npm (re-installing a release that could silently differ from checkout), replayed an external patch over compiled artifacts, treated any HTTP 200 on the port as an existing instance, killed the Host when the window closed, and shipped no tray, single-instance lock, graceful-stop channel, or process-tree containment. The repository therefore needs a first-class Windows x64 desktop entry that starts the `web` profile like ordinary CLI, keeps one DSH Web Host per machine shared by a WebView window and any browser, and lets "exit" stop everything while the window is only a viewport.

## Decision

`apps/desktop/` is a thin Tauri (Rust) shell (crate `deepseek-harness-desktop`, Windows-only) that owns single-instance via `tauri-plugin-single-instance`, the WebView2 main window, a system tray, and the lifecycle of a bundled DSH Web Host subprocess. It introduces no second UI and no second data layer: the WebView loads the exact URL the Host serves, so desktop and browser render the same `@deepseek-ai/dsh-web-app` Client bundle, API, and session events.

### Runtime topology

One DSH Web Host serves both clients. The desktop Tauri process launches the bundled `node/node.exe` running the `web` profile from a bundled runtime closure, and the window plus any browser connect to the same `127.0.0.1` loopback HTTP port.

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

### Host ownership and the attach-or-start identity

The desktop app holds a single-instance OS lock; a second launch surfaces the existing window instead of spawning another Host. Before starting its own Host, the supervisor probes `http://127.0.0.1:3080/api/runtime.identity`, a GET-only identity route served by `@deepseek-ai/dsh-web-app`. The response carries only non-sensitive facts — `{product: "deepseek-harness", desktopProtocol: 1, version, instanceId, homeKind}` — and never the absolute `$DSH_HOME` path. A listener the probe confirms as compatible (product match, protocol `1`, `homeKind: "default"`, non-empty version/instanceId) is **attached**: the desktop never touches that process, and Exit detaches it only. Nothing or a non-DSH listener on the port triggers **StartDefault** (an own Host at 3080) or, when 3080 is occupied by a non-compatible listener, **StartDynamic** (an own Host on a dynamically assigned loopback port) rather than killing the occupant. The probe decodes chunked-transfer bodies (the Node host's default) and caps responses at 4 KiB.

An owned Host runs the bundled `node/node.exe` executing `runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port <port>`, contained in a kill-on-close Windows Job Object. The native `CreateProcessW` bridge NUL-terminates every UTF-16 path buffer, including the explicit working directory, before spawning. Readiness is the `dsh web: http://127.0.0.1:<port>` stdout line plus identity revalidation. Shutdown is a parent-control frame on stdin (`{"type":"shutdown","protocol":1}`) with a bounded grace, then Job close (tree kill). A desktop crash reclaims the whole owned tree.

### Window and tray lifecycle

`X` hides the window to the tray and leaves the Host running. The tray offers Open (restore/focus), Open in browser (system default browser at the real port), View logs, and Exit. Exit closes the window, stops a desktop-owned Host (graceful then forced), and leaves an external Host untouched.

### Data sharing and paths

The desktop Host uses the default Harness home `%USERPROFILE%\.dsh`, resolved through the repository's single [`home-paths` resolver](../../implemented/architecture/2026-07-24-single-harness-home-resolver.md). This is the same root `dsh web` uses when `$DSH_HOME` is unset, so `profiles/`, `cordis.patch.yml`, `settings.yaml`, `.credentials.yaml`, `.env`, session logs, projections, attachments, workspaces, agent presets, and the anonymous identity are shared directly — nothing is copied or synchronized. The initial Agent working directory is `%USERPROFILE%`, then the existing Workspace UI selects projects. Logs write to `%LOCALAPPDATA%\DeepSeek Harness\logs` (`desktop.log` shell events, `host.log` supervised host output), never into the portable unpack directory. The portable folder holds only the EXE, `node/`, `runtime/`, README.txt, LICENSE, THIRD_PARTY_NOTICES.txt, and VERSION.json.

### Build and packaging

The release pipeline builds the current repository revision: Host, Client, and Web artifacts, then a production-only dependency closure from a repository-owned deploy root (the pattern the [single-file executable SDK runtime](../../implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) established), then the bundled Node runtime, the Tauri EXE, licenses, and build metadata. `scripts/release/build-desktop-runtime.ts` produces the runtime closure; `scripts/release/build-desktop-portable.ts` assembles the deterministic portable ZIP with a pinned Node v24.11.1 carrier verified by SHA-256, `SOURCE_DATE_EPOCH` for reproducible builds, and an MSVC Rust toolchain pinned via `RUSTUP_TOOLCHAIN`. `VERSION.json` records `product`, `dshVersion`, `gitCommit`, `nodeVersion`, `desktopProtocol`, `target`, and `buildTime`. Artifacts are assembled from repository source only — no npm-downloaded DSH release and no post-build `lib/index.js` overwrites. The output is a Windows x64 portable ZIP whose SHA-256 the `desktop-portable` GitHub Actions workflow (windows-2025) verifies and then smokes with `scripts/smoke-desktop-portable.ps1`.

The Web profile ships `globalImage: true` (see [the global-image note](2026-08-14-global-image-web-profile.md)), so image-bearing prompts are admitted without an image-capable model. The old `desktop/` Pake + PowerShell prototype is removed; the Pake CLI, npm runtime download, patch replay, and PowerShell lifecycle scripts are not part of the official build chain.

### v1 scope

Windows x64 portable ZIP; WebView2 Runtime required on the machine (Windows 10/11); no installer, no auto-update, no custom `$DSH_HOME`, no macOS or Linux.

## Verification

The `desktop-portable` GitHub Actions workflow (windows-2025) builds the portable ZIP, verifies its SHA-256, and runs `scripts/smoke-desktop-portable.ps1`. The smoke extracts a fresh build into a path with spaces and CJK, runs with an isolated profile and a clean child PATH, and checks owned and attached modes, close-to-tray, crash reclaim by the Job Object, occupied-port fallback, the `globalImage` image prompt, and a leak scan. The Windows supervisor tests also spawn a real fixture with an existing working directory, covering the `CreateProcessW` path-buffer termination requirement.

## Alternatives considered

### Keep the Pake + PowerShell prototype as the product

The smallest-possible change. Rejected: its npm-published-mismatched runtime, external artifact patching, HTTP-200-only instance detection, window-close-kills-Host behavior, and absence of tray, single-instance, graceful stop, and process containment all fail the contract. Pake's one-shot generation suits a proof of concept, not a maintained distribution source.

### Electron with an embedded Node sidecar

Full Chromium and no WebView2 dependency. Rejected for a Windows-first, WebView2-already-present baseline: materially larger ZIP, a second Node runtime, and the same need for a standalone DSH Node sidecar because `node-pty` and other native modules do not assume Electron's ABI. Tauri keeps the tray/single-instance/window features at a fraction of the footprint and the machine already supplies WebView2.

### Two independent Hosts (one desktop-owned, one CLI-owned)

The plainest way to let desktop and a browser each "work". Rejected: two processes share one `$DSH_HOME`, so session logs, the SQLite projection and search index, config hot-reload, and live Agent ownership race in ways the harness does not support.

### Copy or migrate data into a separate desktop home

Clean isolation. Rejected outright: it contradicts the requirement that desktop and CLI show the same settings, sessions, and workspaces, and it recreates the data split the [single Harness-home resolver](../../implemented/architecture/2026-07-24-single-harness-home-resolver.md) exists to prevent.

## Consequences

- One DSH Web Host per machine serves a WebView window and any browser over the same loopback port, with no second UI or data layer.
- Attach-or-start keeps the desktop free of an external Host's process; a compatible external Host is never touched and survives desktop Exit, while an incompatible occupant merely moves the desktop to a dynamic port instead of being killed.
- The bundled Node runtime, pinned toolchain, SHA-256 verification, and Job-Object containment make the portable ZIP self-contained, reproducible, and crash-safe on Windows.
- `desktop/` prototype removal and source-only assembly keep every shipped artifact byte-identical to the current repository build.

## Known limitations

- **Unsigned EXE and SmartScreen.** The v1 portable EXE is unsigned, so first-run SmartScreen warns; Authenticode signing is deferred.
- **WebView2 absence on very old Windows.** Windows 10/11 generally preinstalls WebView2 but not universally; a bundle-Fixed-Runtime variant is deferred.
- **Job Object cannot reach detached processes.** Containerization is a bounded best effort; a process that detaches or spawns externally escapes the kill-on-close tree.
- **Default-home only.** Users who run CLI with a custom `$DSH_HOME` do not automatically see desktop state; v1 supports only the default Harness home.
