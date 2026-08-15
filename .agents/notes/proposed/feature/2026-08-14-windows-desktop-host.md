# Agent Note: Repository-owned Windows desktop host

Status: proposed

English | [中文](2026-08-14-windows-desktop-host.zh.md)

## Problem

A developer preview started as a prototype under `desktop/` and proved the WebView2 wrapper technically works: Pake (Tauri + WebView2) opens the served Web GUI in a native window, a PowerShell launcher starts the local `dsh web` hidden, waits for readiness, shows the window, and stops the server when the window closes. That prototype does not meet the delivery bar the approved design sets:

- It relies on the machine's own Node and npm, and a `desktop/tool/node_modules/@deepseek-ai/dsh` re-installed from the npm registry, so it can silently serve a release version (`0.1.0-rc.6`) that differs from the checked-out source (`0.1.0-rc.5`).
- It overwrites three compiled `lib/index.js` files with an external `[dsh-patch:global-image]` replay script, so the shipped artifacts are not built from current source.
- It decides "a DSH instance is already running" from any HTTP 200 on the port, which a non-Harness local service also satisfies.
- Closing the window stops the server, so a browser tab sharing the same service dies at the same time.
- It has no tray, no single-instance lock, no graceful-stop channel, and no process-tree containment, so the machine loses the harness process when the console launcher is gone.

The approval target is a first-class Windows x64 desktop entry that starts the `web` profile like ordinary CLI does, keeps one DSH Web Host per machine for both a WebView window and any browser, and lets "exit" stop everything while the window is only a viewport.

## Proposal

Add a repository-owned Windows desktop application under `apps/desktop/` as a thin Tauri (Rust) shell. The shell owns single-instance, the main WebView2 window, a system tray, and the lifecycle of a bundled DSH Web Host subprocess. It introduces no second UI and no second data layer: the WebView loads the exact URL the Host serves, so desktop and browser render the same `@deepseek-ai/dsh-web-app` Client bundle, API, and session events.

### Runtime topology

One DSH Web Host serves both clients. The desktop Tauri process launches `bundled node.exe` running the `web` profile from a bundled runtime closure, and the window plus any browser connect to the same `127.0.0.1` loopback HTTP port.

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

### Host ownership and the single-instance identity

The desktop app holds a single-instance OS lock. A second launch surfaces the existing window instead of spawning another Host. When the desktop owns the Host, exiting from the tray triggers a private shutdown channel first, then a bounded timeout, then terminates the process tree through a Windows Job Object owned by the Tauri process (`KILL_ON_JOB_CLOSE`), so a desktop crash cannot leak the Host or its children.

Before starting its own Host, the supervisor probes the configured port with a dedicated read-only runtime identity endpoint on the Host (for example `GET /api/runtime.identity`). The response carries only non-sensitive facts — product name, a desktop-protocol version, the DSH version, an instance id, and a `homeKind: default` marker — never the absolute `$DSH_HOME` path. The desktop attaches to an external Host only when the probe confirms the right product, a compatible desktop protocol, and the default Harness home; an HTTP 200 from any other program, or an incompatible DSH version, is refused. A port occupied by a non-DSH service makes the desktop start its own Host on another free loopback port rather than kill the occupant. The desktop never stops an external Host it did not start.

### Window and tray lifecycle

`X` hides the window to the tray and leaves the Host running. The tray offers Open (restore/focus), Open in browser (system default browser at the real port), View logs, and Exit. Exit closes the window, stops a desktop-owned Host (graceful then forced), and leaves an external Host untouched. Windows logoff or shutdown runs a bounded cleanup and never blocks shutdown.

### Data sharing and paths

The desktop Host uses the default Harness home `%USERPROFILE%\.dsh`, resolved through the repo's single [`home-paths` resolver](../../implemented/architecture/2026-07-24-single-harness-home-resolver.md). This is the same root `dsh web` uses when `$DSH_HOME` is unset, so `profiles/`, `cordis.patch.yml`, `settings.yaml`, `.credentials.yaml`, `.env`, session logs, projections, attachments, workspaces, agent presets, and the anonymous identity are shared directly — nothing is copied or synchronized. No custom-`$DSH_HOME` mounting is in v1; custom-directory CLI users do not merge automatically. The initial Agent working directory is `%USERPROFILE%`, then the existing Workspace UI selects projects. Logs write to `%LOCALAPPDATA%\DeepSeek Harness\logs`, never into the portable unpack directory, and never contain API keys, credential contents, or full environment dumps.

### Build and packaging

The release pipeline builds the current repository revision: Host, Client, and Web artifacts, then a production-only dependency closure from a repository-owned deploy root (the pattern the [single-file executable SDK runtime](../../implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) established), then the bundled Node runtime, the Tauri EXE, licenses, and build metadata. Artifacts are assembled from current source only — no npm-downloaded DSH release and no post-build `lib/index.js` overwrites. `VERSION.json` records the DSH version, Git commit, Node version, desktop-protocol version, target architecture, and build time. The output is a Windows x64 portable ZIP plus a SHA-256 manifest, smoked by re-extracting and launching offline with no system Node, npm, pnpm, Rust, or network.

The `desktop/` prototype stays during development for comparison and is removed only once the `apps/desktop/` implementation is verified against these acceptance criteria; the Pake CLI, npm runtime download, patch replay, and PowerShell lifecycle scripts do not share the official build chain.

### v1 scope

Windows x64 portable ZIP; WebView2 Runtime required on the machine (Windows 10/11); no auto-update, no installer, no custom `DSH_HOME`, no macOS or Linux. A future WebView2 Fixed Runtime "fully offline" variant and Authenticode signing for public distribution are recorded below, not built now.

## Alternatives considered

### Keep the Pake + PowerShell prototype as the product

The smallest-possible change. Rejected: its npm-published-mismatched runtime, external artifact patching, HTTP-200-only instance detection, window-close-kills-Host behavior, and absence of tray, single-instance, graceful stop, and process containment all fail the approved contract. Pake's one-shot generation is fine for a proof of concept, not a maintained distribution source.

### Electron with an embedded Node sidecar

Full Chromium and no WebView2 dependency. Rejected for a Windows-first, WebView2-already-present baseline: materially larger ZIP, a second Node runtime, and the same need for a standalone DSH Node sidecar because `node-pty` and other native modules do not assume Electron's ABI. Tauri keeps the tray/single-instance/window features at a fraction of the footprint and the machine already supplies WebView2.

### Two independent Hosts (one desktop-owned, one CLI-owned)

The plainest way to let desktop and a browser each "work". Rejected: two processes share one `$DSH_HOME`, so session logs, the SQLite projection and search index, config hot-reload, and live Agent ownership race in ways the harness does not support.

### Copy or migrate data into a separate desktop home

Clean isolation. Rejected outright: it contradicts the approved requirement that desktop and CLI show the same settings, sessions, and workspaces, and it recreates the data-split the [single Harness-home resolver](../../implemented/architecture/2026-07-24-single-harness-home-resolver.md) exists to prevent.

## Acceptance criteria

- A freshly built portable ZIP unzips on a clean Windows 10/11 machine with no system Node/npm/pnpm/Rust, no network, and no other DSH process; launching `DeepSeek Harness.exe` starts the bundled Host and a working WebView2 window.
- Desktop and browser connected to the same running Host show the same workspaces, settings, and session history as an ordinary `dsh web` run against the default `~/.dsh`.
- A second `DeepSeek Harness.exe` launch surfaces the first window and does not spawn a second Host.
- Clicking `X` hides to the tray; the Host still answers and a browser still loads the GUI; tray Open restores the window.
- Tray Exit stops a desktop-owned Host and its children, and `127.0.0.1:<port>` stops answering; during the test a thrown desktop process tree can be shown to have been reclaimed by the Job Object.
- Attaching to a compatible external command-line DSH Host works; exiting the desktop leaves that external Host running.
- A non-Harness HTTP service on the port is refused, and the desktop instead starts its own Host on another loopback port.
- No shipped artifact carries a source path, a developer's machine directory, an API key, or personal configuration, and every `lib/*` file is byte-identical to the current repository build (verified against a fresh build, not a patched copy).
- `VERSION.json` matches the repository version and Git commit.

## Risks

- **WebView2 absence.** Windows 10/11 generally preinstalls webview2.exe but not universally; a future bundled Fixed Runtime variant fixes the long tail without changing the Host or runtime architecture.
- **Unsigned EXE and SmartScreen.** Untrusted binaries warn on first run. Authenticode signing is needed for confident public distribution and is deferred from the v1 portable flow.
- **Port and identity guesses.** Instance detection depends on a Host identity endpoint that does not exist yet and must be added to the Web carrier; until then the supervisor works from the documented probe contract and fails closed, never attaching to an unverified HTTP 200.
- **Process-tree containment gaps.** A Windows Job Object cannot reach processes that detach, spawn far outside, or RDP-session interactions. A deliberate supervised kill remains the bounded best effort.
- **Default-home only.** Users who run CLI with a custom `$DSH_HOME` will not automatically see desktop state in v1; forcing a separate desktop home is out of scope and deliberately opposed.
