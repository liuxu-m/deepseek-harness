# DeepSeek Harness — Portable Edition (build)

Builds a self-contained, **offline-at-launch** Windows distribution of DeepSeek
Harness. The recipient does no install and needs no network:

- the Node runtime is bundled (`node\`)
- the production-only `@deepseek-ai/dsh` runtime is pre-installed (`runtime\`)
- the three compiled artifacts patched with the `[dsh-patch:global-image]`
  image scheme are baked in and verified
- `app\setup.ps1` **only** creates a desktop shortcut — it downloads and
  installs nothing

This README is for the build machine. The file shipped in the distribution is
`README.txt`, and the end-user entry points live in `app\`.

## Layout

```
desktop/portable/
  app/                shipped, end-user entry points
    setup.ps1         create a "DeepSeek Harness" desktop shortcut only (no install/net)
    Install.vbs       zero-console wrapper around setup.ps1 (what the shortcut points at)
    start.ps1         launch: verify bundled node+runtime+patch markers, start dsh web
                      hidden, wait for readiness, open the window, stop the server on close
    start.vbs         zero-console wrapper around start.ps1
  README.txt          end-user README shipped inside the distribution
  build-portable.ps1  <-- the build script (this file's subject)
  _cache/             downloaded node zips, reused across builds (gitignored)
  _stage/             assembled distribution folder (gitignored)
  _output/            the shipped ZIP (gitignored)
```

## What the build does (offline-at-launch)

`build-portable.ps1` runs entirely on the build machine:

1. **Node v26.7.0** — downloads `node-v26.7.0-win-x64.zip` once (cached in
   `_cache\`, reused on rebuilds; `-SkipDownload` forces reuse without
   re-fetching) and extracts it to `_stage\<AppName>\node\`.
2. **Production runtime** — writes a minimal `runtime\package.json` pinning
   `@deepseek-ai/dsh@0.1.0-rc.6`, then runs the **bundled** node's npm
   (`node\node_modules\npm\bin\npm-cli.js`) with `--omit=dev --no-audit
   --no-fund`, so `runtime\node_modules` holds only production deps. No npm
   is needed on the recipient.
3. **Patch artifacts** — copies the developer's already-patched `lib\index.js`
   for `dsh-host-apiproxy`, `dsh-llm-pi-ai`, `dsh-tool-fs` from
   `desktop\tool\node_modules\@deepseek-ai\` onto the fresh runtime and
   verifies each carries the `[dsh-patch:global-image]` marker. Fails loud if
   the source install is unpatched or the runtime package changed shape.
4. **Zip** — compresses `_stage\<AppName>\` into
   `_output\DeepSeek_Harness_Portable_v26.7.0.zip`.

The staged folder and ZIP are verified-good but the build never bundles API
credentials, model configuration, or personal settings.

## Build it

1. Build the desktop app shell first (produces `desktop\dist\DeepSeek Harness.exe`):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\build.ps1
   ```

2. Build the portable distribution:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\portable\build-portable.ps1
   ```

   Add `-SkipDownload` to reuse the cached Node zip without re-downloading.
   Everything else (npm install, patch, zip) still runs fresh.

## Inspecting / smoking the result

The staged folder is the ground truth; the ZIP is just that folder compressed.
Validate it before shipping by running the bundled runtime the way a recipient
would:

```powershell
$stage = 'desktop\portable\_stage\DeepSeek Harness'
# markers present on all three patched artifacts
Get-ChildItem "$stage\runtime\node_modules\@deepseek-ai\*\lib\index.js" |
  Select-String -Pattern '[dsh-patch:global-image]' -SimpleMatch
# bundled node + pinned runtime version
& "$stage\node\node.exe" --version
(Get-Content "$stage\runtime\node_modules\@deepseek-ai\dsh\package.json" -Raw | ConvertFrom-Json).version
```

On a recipient machine, extract the ZIP and start with `app\start.vbs` (no
console window). `app\setup.ps1` / `app\Install.vbs` only create the desktop
shortcut.

## Notes

- The recipient must have the WebView2 runtime (preinstalled on Windows 10/11);
  it is not bundled with the ZIP.
- `desktop\portable\_cache\`, `_stage\`, and `_output\` are gitignored — both
  here and in the root `.gitignore`. Only the source under `app\`,
  `build-portable.ps1`, `README.md`, and `README.txt` are meant to be tracked.
