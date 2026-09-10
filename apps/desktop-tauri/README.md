# DeepSeek Harness Desktop (Tauri)

English | [中文](README.zh.md)

The Tauri desktop shell and the deploy root for the portable Windows archive. It is an addition to the upstream repository, not a replacement: the official Electron desktop stays in `apps/desktop` untouched, so this branch applies upstream changes without modify/delete conflicts.

## What this package owns

| Path | Role |
|---|---|
| `src-tauri/` | Rust shell: host discovery, child-process supervision, single-instance lock, tray, window, and the Windows job-object containment boundary. |
| `static/` | `startup-error.html` and `mobile-client.html`, served when the shell cannot reach a host. |
| `icons/`, `README.txt` | Application icons, and the user-facing readme the portable archive ships at its root. |
| `package.json` | The pnpm deploy root: its `dependencies` are the runtime closure the portable bundles, and its scripts drive the Cargo build and tests. |

The shell starts the bundled server on `http://127.0.0.1:3080`, opens the window against it, and stops the server when the window closes through the tray. It requires the Microsoft Edge WebView2 runtime, which current Windows 10 and 11 install by default.

## Runtime closure

`pnpm deploy --prod` stages the dependency graph declared by this package into the archive's `runtime/` directory. That graph is generated, never hand-maintained:

```sh
pnpm run desktop:manifest
```

`scripts/release/desktop-tauri-manifest.ts` walks the workspace from the runtime entry points (`@deepseek-ai/dsh`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-web-frontend`), follows `dependencies`, `optionalDependencies`, and every workspace `peerDependencies` entry, and rewrites the manifest's `dependencies` block. `pnpm run desktop:manifest -- --check` fails when the committed manifest is stale. `pnpm run verify-runtime-closure --manifest apps/desktop-tauri/package.json` then rejects any reachable workspace peer the manifest omits.

## Build and test

```sh
pnpm run desktop:test                 # cargo test for the shell
pnpm run desktop:runtime              # deploy the runtime closure to dist/desktop/runtime
pnpm run desktop:build                # assemble the portable ZIP and its SHA-256
```

`desktop:build` runs `tauri build --no-bundle` for the shell, downloads the pinned Node carrier recorded in `scripts/release/desktop-node.json`, deploys the runtime closure, and writes `dist/desktop/output`. The archive is unsigned because it is a personal build; Windows SmartScreen warns on first launch.
