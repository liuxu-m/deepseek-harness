<#
  DeepSeek Harness portable launcher (Windows).

  Runs the bundled @deepseek-ai/dsh web server on http://127.0.0.1:3080 using
  the Node and production runtime bundled in this portable folder (no install,
  no network), waits until it answers, opens the DeepSeek Harness.exe window,
  and stops ONLY the server it started when that window closes.

  The runtime must already be present and patched - it is baked in by
  build-portable.ps1 on the build machine. This script verifies the three
  [dsh-patch:global-image] image markers and fails loud if any is missing, so a
  broken/repackaged folder never silently loses image support. It never runs
  npm and never downloads anything.

  If a server is already serving 127.0.0.1:3080 (e.g. started separately), the
  window opens against it and nothing is stopped.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File app\start.ps1 [-Port 3080]
#>
[CmdletBinding()]
param(
  [int]$Port = 3080
)
$ErrorActionPreference = 'Stop'

$setupDir = $PSScriptRoot
$appRootDir = Split-Path $setupDir -Parent        # <portable> root
$nodeExe = Join-Path $appRootDir 'node\node.exe'
$dshBin = Join-Path (Join-Path (Join-Path $appRootDir 'runtime') 'node_modules\@deepseek-ai\dsh') 'lib\bin.js'
# Start-Process -ArgumentList does NOT auto-quote arguments containing spaces, so the
# dsh bin path (which contains a space under the default "DeepSeek Harness" folder)
# must be quoted explicitly or node sees a truncated module path and fails with MODULE_NOT_FOUND.
$quotedDshBin = "`"$dshBin`""
$exePath = Join-Path $appRootDir 'DeepSeek Harness.exe'
$runtimeAiDir = Join-Path (Join-Path $appRootDir 'runtime') 'node_modules\@deepseek-ai'
$logDir = Join-Path $appRootDir 'logs'
$stdoutLog = Join-Path $logDir 'server.log'
$stderrLog = Join-Path $logDir 'server.err.log'
$patchMarker = '[dsh-patch:global-image]'
$patchedPackages = @('dsh-host-apiproxy', 'dsh-llm-pi-ai', 'dsh-tool-fs')

$serverStartedByUs = $false

function Show-Fatal([string]$message) {
  Write-Error $message
  try { (New-Object -ComObject WScript.Shell).Popup($message, 0, 'DeepSeek Harness', 48) | Out-Null } catch { }
  exit 1
}

function Test-Http([int]$port) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port" -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-PortOccupied([int]$port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $port)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

# --- Self-containment ---------------------------------------------------
if (-not (Test-Path $nodeExe)) {
  Show-Fatal "Bundled Node missing: $nodeExe. This must run inside a built portable distribution (see README.txt); app\setup.ps1 only creates a shortcut and does not install Node."
}
if (-not (Test-Path $dshBin)) {
  Show-Fatal "Bundled runtime missing: $dshBin. Repack the distribution with build-portable.ps1; it bundles the dsh runtime."
}
if (-not (Test-Path $exePath)) {
  Show-Fatal "Desktop app missing: $exePath. This portable distribution is incomplete."
}

# --- Verify the three image-patch markers ---------------------------------
$missing = @($patchedPackages | Where-Object {
  $lib = Join-Path (Join-Path $runtimeAiDir $_) 'lib\index.js'
  -not (Test-Path $lib) -or
    -not [bool](Select-String -Path $lib -Pattern $patchMarker -SimpleMatch -Quiet -ErrorAction SilentlyContinue)
})
if ($missing.Count -gt 0) {
  Show-Fatal "The bundled runtime is not fully patched for image support (missing $patchMarker in: $($missing -join ', ')). Rebuild the distribution with build-portable.ps1."
}

# --- Already serving (someone else's server): just open the window -------
if (Test-Http $Port) {
  Start-Process -FilePath $exePath | Out-Null
  exit 0
}

# --- Port occupied but not answering HTTP: a stale listener --------------
if (Test-PortOccupied $Port) {
  Show-Fatal "Port $Port is occupied by another program and is not serving HTTP. Close it and try again."
}

# --- Start the bundled dsh web server (this is the one we own) -----------
New-Item -ItemType Directory -Force $logDir | Out-Null
$server = Start-Process -FilePath $nodeExe `
  -ArgumentList @($quotedDshBin, 'web', '--port', "$Port") `
  -WorkingDirectory $appRootDir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
$serverStartedByUs = $true

# --- Wait for readiness (up to 120 s; first run populates the profile) ---
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  if ($server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    $detail = (Get-Content $stderrLog -Tail 5 -ErrorAction SilentlyContinue) -join ' '
    Show-Fatal "dsh web exited early (code $($server.ExitCode)). $detail"
  }
  if (Test-Http $Port) { $ready = $true; break }
  Start-Sleep -Milliseconds 1000
}
if (-not $ready) {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Show-Fatal "Timed out waiting for dsh web on port $Port. See $stdoutLog / $stderrLog"
}

# --- Open the desktop window, then stop only our server when it closes ---
$window = Start-Process -FilePath $exePath -PassThru
try { Wait-Process -Id $window.Id -ErrorAction Stop } catch { }
if ($serverStartedByUs -and -not $server.HasExited) {
  taskkill /PID $server.Id /T /F 2>$null | Out-Null
}
exit 0
