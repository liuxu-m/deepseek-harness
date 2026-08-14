# DeepSeek Harness — Windows desktop client

Packages the DeepSeek Harness web GUI into a lightweight native Windows app
window using [Pake](https://github.com/tw93/Pake) (Tauri + WebView2, ~10 MB).
Double-click a desktop icon and the harness starts with no command line and no
console window; the same server stays reachable from any browser.

```
desktop/
  build.ps1            # package the web GUI into the desktop app (Pake)
  launch.ps1           # runtime launcher: start dsh web hidden -> wait -> open window -> stop on close
  launch.vbs           # zero-console entry point (what the shortcut runs)
  create-shortcut.ps1  # add a "DeepSeek Harness" icon to the desktop
  open-browser.ps1     # open http://127.0.0.1:3080 in the default browser
  assets/icon.png      # app icon (rendered from apps/web/public/favicon.svg)
  dist/                # build output: "DeepSeek Harness.exe" + installer .msi
  logs/                # server logs written at launch time
  tool/                # local Pake CLI install (npm, not a pnpm workspace member)
```

## How it works

- The app window loads `http://127.0.0.1:3080` — the same server the web GUI
  uses. The URL is baked in at build time.
- `launch.ps1` starts the server hidden by running the **locally installed**
  `@deepseek-ai/dsh` bin (`desktop\tool\node_modules\@deepseek-ai\dsh\lib\bin.js`)
  with `node` directly — no npx, no registry, no shell shims at launch time
  (npx failed intermittently on this machine when the npm mirror/cache was
  unreachable, with "'dsh' is not recognized"). It waits until the port
  answers, opens the window, and stops the server (process tree) when the
  window closes.
- If a server is already running on the port (for example an instance you
  started by hand in a terminal), the window simply connects to it and the
  launcher does not start or stop anything.
- Startup errors pop a visible dialog instead of failing silently.

Refresh the locally installed dsh package when you want a newer version:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\launch.ps1 -Update
```

## Prerequisites (checked by `build.ps1`)

- Node.js ≥ 22 (with npm) — needed by the Pake CLI and by the launcher (`node`)
- Rust toolchain (rustc/cargo) — compiles the Tauri shell on first build
- WebView2 runtime — preinstalled on Windows 10/11

## Build once

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\build.ps1
```

The first build downloads crates and compiles the Rust shell — expect 5-15
minutes. Output lands in `desktop\dist\`:
- `DeepSeek Harness.exe` — standalone executable (use this)
- `DeepSeek Harness_*.msi` — optional installer

## Install on the desktop

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\create-shortcut.ps1
```

Creates a **DeepSeek Harness** shortcut on your desktop that launches with no
console window (wscript → hidden PowerShell).

## Use

- Double-click **DeepSeek Harness** on the desktop (or `desktop\launch.vbs`).
- The window opens once the server is ready; the first launch installs the
  local `@deepseek-ai/dsh` copy and the profile, so it may take a few seconds.
- **Browser support:** while the app runs, open
  `http://127.0.0.1:3080` in any browser — or run `desktop\open-browser.ps1`.
  Both the window and the browser drive the same harness.
- Closing the window stops the server. If the server was already running
  before you launched the app, closing the window leaves it running.

## Global image support

The desktop launcher can run the same **`[dsh-patch:global-image]`** image scheme
as the terminal flow. Point it at the vision toolkit's replay script with the
`-PatchReplayScript <path>` argument (or the `DSH_PATCH_REPLAY_SCRIPT`
environment variable); `launch.ps1` then replays it against the local
`@deepseek-ai/dsh` before serving, so the three compiled artifacts
(`dsh-host-apiproxy`, `dsh-llm-pi-ai`, `dsh-tool-fs`) stay patched across
`npm install`/`npm update`. Pre-patch originals are kept in
`desktop\tool\.patch-backup\`. Without a replay script configured the launcher
warns once and serves without image support.

## Troubleshooting

- **First build is slow** — that is the Rust compile, not a hang.
- **SmartScreen warning on first run** — the executable is unsigned; click
  "More info" → "Run anyway". This is expected for a locally built app.
- **"node not found"** — install Node.js and reopen the shell.
- **Port 3080 occupied by a non-HTTP program** — close the program or change
  the port: rebuild with `desktop\build.ps1 -Port <port>` and launch with
  `launch.ps1 -Port <port>`.
- **Server logs** — `desktop\logs\server.log` / `server.err.log`.
- **Pake/rust build errors** — verify with `rustc --version` and
  `cargo --version`, and that the WebView2 runtime is installed.
- **Windows Defender / antivirus** may quarantine unsigned fresh binaries;
  add an exception if needed.

## Reproducibility

- `desktop\tool\package.json` pins `pake-cli@3.15.6` and uses npm `overrides`
  to force a single `sharp` version. Two sharp versions (0.33.5 via `icon-gen`
  and 0.35.3) crash the CLI on Windows with `ERR_DLOPEN_FAILED` (same-named
  `libvips-42.dll` loaded twice); the override prevents it. Reinstall with:
  `npm install --prefix desktop\tool`.
- Pake re-installs its own dependencies inside its package directory on every
  build (`cd <pake-cli> && npm install`), which would reintroduce the same
  two-sharp conflict from `icon-gen`. `build.ps1` therefore patches npm
  `overrides` into `pake-cli`'s own `package.json` and clears its stale nested
  `node_modules` before every build (both idempotent, applied automatically).
- The icon is generated from the favicon by `desktop\tool\make-icon.mjs`
  (runs `node desktop/tool/make-icon.mjs` from the repo root).
