<#
  Build the DeepSeek Harness Windows desktop app with Pake (Tauri/WebView2).

  Packages the served web GUI (http://127.0.0.1:3080) into a native window.
  Outputs land in desktop\dist\:
    - "DeepSeek Harness.exe"  standalone executable (needs the WebView2 runtime)
    - "DeepSeek Harness_*.msi"  optional installer

  Prerequisites (checked here):
    - Node.js + npm (for the local Pake CLI under desktop\tool)
    - Rust toolchain (rustc/cargo) for the Tauri compile
    - WebView2 runtime (preinstalled on Windows 10/11)

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 [-Port 3080]

  The first build downloads crates and compiles the Tauri shell; expect
  5-15 minutes. Subsequent builds are fast.
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'

$desktopDir = $PSScriptRoot
$toolDir = Join-Path $desktopDir 'tool'
$distDir = Join-Path $desktopDir 'dist'
$iconPath = Join-Path $desktopDir 'assets\icon.png'
$appName = 'DeepSeek Harness'

# 1) Local Pake CLI (npm flat install keeps sharp's @img packages consistent;
#    the pnpm workspace must not see this folder, so it is not a workspace member).
$pakeCmd = Join-Path $toolDir 'node_modules\.bin\pake.cmd'
if (-not (Test-Path $pakeCmd)) {
  if ($SkipInstall) { Write-Error "Pake CLI missing at $pakeCmd; run without -SkipInstall."; exit 1 }
  Write-Host '[desktop] installing Pake CLI under desktop\tool ...'
  Push-Location $toolDir
  try { npm install --no-audit --no-fund | Out-Null } finally { Pop-Location }
}
if (-not (Test-Path $pakeCmd)) { Write-Error "Pake CLI install failed at $pakeCmd"; exit 1 }

# 2) Icon (checked in at desktop\assets\icon.png; regenerate from
#    apps/web/public/favicon.svg if you change the logo).
if (-not (Test-Path $iconPath)) {
  Write-Error "Icon missing at $iconPath. Add a 1024x1024 PNG, or run the icon step in desktop\README.md."
  exit 1
}

# 3) Pake re-installs its own dependencies inside its package directory on
#    every build (`cd <pake-cli> && npm install`). That nested install resolves
#    icon-gen's sharp@0.33.x against pake-cli's sharp@0.35.x, and two same-named
#    libvips-42.dll copies in one process crash sharp with ERR_DLOPEN_FAILED.
#    Patching npm "overrides" into pake-cli's own manifest makes the nested
#    install resolve one sharp version. Idempotent; reapplied on every build.
$pakeCliDir = Join-Path $toolDir 'node_modules\pake-cli'
$pakeManifestPath = Join-Path $pakeCliDir 'package.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$pakeManifestText = [System.IO.File]::ReadAllText($pakeManifestPath, $utf8NoBom)
if (-not $pakeManifestText.Contains('"overrides"')) {
  $anchor = '"packageManager": "pnpm@10.26.2",'
  if (-not $pakeManifestText.Contains($anchor)) {
    Write-Error 'pake-cli manifest changed shape; the overrides patch needs manual review.'
    exit 1
  }
  $pakeManifestText = $pakeManifestText.Replace(
    $anchor,
    "$anchor`r`n  `"overrides`": { `"sharp`": `"0.35.3`", `"@img/sharp-win32-x64`": `"0.35.3`" },"
  )
  [System.IO.File]::WriteAllText($pakeManifestPath, $pakeManifestText, $utf8NoBom)
  Write-Host '[desktop] patched pake-cli overrides to unify sharp 0.35.3'
}

# A nested tree installed BEFORE the overrides patch contains icon-gen's
# sharp@0.33.x; two sharp versions in one process crash the CLI at startup
# (ERR_DLOPEN_FAILED), before its own install step can re-resolve. Pake
# recreates this tree on every build with the patched manifest, so clearing it
# here is free and keeps startup on the single-version root sharp.
$pakeCliNodeModules = Join-Path $pakeCliDir 'node_modules'
if (Test-Path $pakeCliNodeModules) {
  Remove-Item $pakeCliNodeModules -Recurse -Force
  Write-Host '[desktop] cleared stale pake-cli nested node_modules'
}

# 3) Package. Windows PowerShell 5.1 turns native stderr merged with 2>&1 into
#    ErrorRecords, and with $ErrorActionPreference='Stop' the first such record
#    (e.g. Pake's benign first-run warnings) terminates the script even though
#    the child keeps running. ErrorActionPreference is dropped to 'Continue'
#    for the call and each stderr line is converted to a string as it streams.
New-Item -ItemType Directory -Force $distDir | Out-Null
$raw = [System.Collections.Generic.List[string]]::new()
Push-Location $distDir
try {
  Write-Host "[desktop] pake $appName <- http://127.0.0.1:$Port (first build compiles Rust; be patient) ..."
  $ErrorActionPreference = 'Continue'
  & $pakeCmd "http://127.0.0.1:$Port" `
    --name $appName `
    --title $appName `
    --icon $iconPath `
    --width 1440 --height 900 --min-width 1024 --min-height 700 `
    --targets x64 --keep-binary --enable-find --enable-drag-drop `
    --app-version 0.1.0 --installer-language zh-CN --json 2>&1 |
    ForEach-Object { $line = $_.ToString(); Write-Host $line; $raw.Add($line) }
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
}
if ($exitCode -ne 0) {
  Write-Error "[desktop] pake exited $exitCode. Check the Rust toolchain (rustc --version) and WebView2 runtime."
  exit 1
}

# 4) Parse the machine-readable result (the single JSON object on stdout).
$result = $null
foreach ($line in $raw) {
  $trimmed = $line.Trim()
  if ($trimmed.StartsWith('{')) {
    try {
      $parsed = $trimmed | ConvertFrom-Json
      if ($null -ne $parsed -and $parsed.PSObject.Properties.Name -contains 'ok') { $result = $parsed }
    } catch { }
  }
}
if ($null -ne $result -and $result.ok) {
  Write-Host ''
  Write-Host '[desktop] build OK:'
  foreach ($out in $result.outputs) {
    $sizeMb = [math]::Round($out.sizeBytes / 1MB, 1)
    Write-Host ("  {0}  ({1} MB, {2})" -f $out.path, $sizeMb, $out.format)
  }
  Write-Host ''
  Write-Host "[desktop] next: run desktop\create-shortcut.ps1 to add a desktop icon, then launch via desktop\launch.vbs"
  exit 0
}
Write-Error "[desktop] pake did not report ok. Raw output above."
exit 1
