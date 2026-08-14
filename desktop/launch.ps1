<#
  DeepSeek Harness desktop launcher (Windows).

  Starts the dsh web server hidden from a locally installed copy of the
  published @deepseek-ai/dsh package (desktop\tool\node_modules\@deepseek-ai\dsh),
  waits until http://127.0.0.1:3080 answers, opens the Pake desktop window, and
  stops the server (process tree) when the window closes. If a server is already
  serving the port (e.g. an instance started by hand from a terminal), the
  window just opens against it and nothing is stopped.

  The launcher does NOT use npx: npx resolved the package through the npm
  registry mirror and its cache shims, which failed intermittently with
  "'dsh' is not recognized" whenever the mirror or cache was unreachable.
  Running the locally installed bin with node directly makes startup
  deterministic and offline. Refresh the local copy with -Update.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File launch.ps1 [-Port 3080] [-Update] [-PatchReplayScript <path>]

  The global-image patch (see desktop/README.md) is replayed at launch only
  when -PatchReplayScript points at the vision toolkit's replay script, or the
  DSH_PATCH_REPLAY_SCRIPT environment variable names it. Without one, the
  launcher serves without image support and warns once.
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [switch]$Update,
  [string]$PatchReplayScript = ''
)
$ErrorActionPreference = 'Stop'

$desktopDir = $PSScriptRoot
$toolDir = Join-Path $desktopDir 'tool'
$exePath = Join-Path $desktopDir 'dist\DeepSeek Harness.exe'
$logDir = Join-Path $desktopDir 'logs'
$stdoutLog = Join-Path $logDir 'server.log'
$stderrLog = Join-Path $logDir 'server.err.log'
$dshBin = Join-Path $toolDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$replayScript = ''

function Show-Fatal([string]$message) {
  Write-Error $message
  try {
    (New-Object -ComObject WScript.Shell).Popup($message, 0, 'DeepSeek Harness', 48) | Out-Null
  } catch { }
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

if (-not (Test-Path $exePath)) {
  Show-Fatal "Desktop app not built: $exePath. Run desktop\build.ps1 first."
}

# 1) Local dsh copy: install when missing, refresh on -Update.
if ($Update -or -not (Test-Path $dshBin)) {
  Write-Host '[desktop] installing/updating @deepseek-ai/dsh into desktop\tool ...'
  Push-Location $toolDir
  try {
    if ($Update -and (Test-Path $dshBin)) {
      npm update @deepseek-ai/dsh --no-audit --no-fund | Out-Null
    } else {
      npm install --no-audit --no-fund | Out-Null
    }
  } finally {
    Pop-Location
  }
  if (-not (Test-Path $dshBin)) {
    Show-Fatal "The dsh package failed to install at $dshBin. Check network access and npm registry (`npm config get registry`)."
  }
}

# 2) Ensure the "global image" patch is present on the local dsh runtimes.
#    The image scheme ([dsh-patch:global-image]) is applied to the compiled
#    artifacts, and `npm install`/`npm update` overwrites them, so the patch is
#    replayed at every launch from the vision toolkit's replay script. If the
#    toolkit (replay-global-image.ps1) is not present we only warn and continue
#    the normal (non-image) path.
$aiDir = Join-Path $toolDir 'node_modules\@deepseek-ai'
# Vision patch replay script: explicit -PatchReplayScript wins over the
# DSH_PATCH_REPLAY_SCRIPT environment variable. No private-path defaults:
# without one of these the launcher runs the standard (non-image) path.
if (-not $replayScript) { $replayScript = $env:DSH_PATCH_REPLAY_SCRIPT }
if (-not ($replayScript -and (Test-Path $aiDir))) { $replayScript = '' }
if (-not (Test-Path (Join-Path $aiDir 'dsh-host-apiproxy\lib\index.js'))) {
  Show-Fatal "Local dsh package is incomplete (dsh-host-apiproxy missing): $aiDir"
}
if ($replayScript -and (Test-Path $replayScript)) {
  $patchedFiles = @('dsh-host-apiproxy','dsh-llm-pi-ai','dsh-tool-fs') | Where-Object {
    $f = Join-Path (Join-Path $aiDir $_) 'lib\index.js'
    Test-Path $f -and (Select-String -Path $f -Pattern '[dsh-patch:global-image]' -SimpleMatch -Quiet -ErrorAction SilentlyContinue)
  }
  if ($patchedFiles.Count -lt 3) {
    Write-Host '[desktop] replaying the global-image patch on the local dsh ...'
    powershell -NoProfile -ExecutionPolicy Bypass -File $replayScript -TargetAiDir $aiDir 2>&1 | ForEach-Object { Write-Host $_.ToString() }
  } else {
    Write-Host '[desktop] global-image patch already present on the local dsh'
  }
} else {
  Write-Warning '[desktop] vision-patch replay script not found; global-image mode unavailable'
}

# 3) Already serving (e.g. the user's own terminal instance): just open the window.
if (Test-Http $Port) {
  Start-Process -FilePath $exePath
  exit 0
}

# 4) Port occupied but not answering HTTP: could be a stale orphan from a
#    closed console window (Windows often leaves node processes holding the
#    port). Give it a few seconds, then free the port if it is a node process.
if (Test-PortOccupied $Port) {
  for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 1500
    if (-not (Test-PortOccupied $Port)) { break }
    if (Test-Http $Port) { Start-Process -FilePath $exePath; exit 0 }
  }
  if (Test-PortOccupied $Port) {
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($listenerPid in $listeners) {
      $listener = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
      if ($null -ne $listener -and $listener.ProcessName -match 'node') {
        Write-Warning "[desktop] killing stale node listener on port $Port (pid $listenerPid) that is not serving HTTP"
        & taskkill /PID $listenerPid /T /F 2>$null | Out-Null
      }
    }
    Start-Sleep -Seconds 2
  }
  if (Test-PortOccupied $Port) {
    Show-Fatal "Port $Port is still occupied by another program. Close it and try again, or repack with another port."
  }
}

# 5) Start the server hidden: node runs the locally installed dsh bin directly.
New-Item -ItemType Directory -Force $logDir | Out-Null
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = 'node' }
$server = Start-Process -FilePath $nodeExe `
  -ArgumentList @($dshBin, 'web', '--port', "$Port") `
  -WorkingDirectory $desktopDir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

# 6) Wait for readiness (up to 120 s; first launch installs the profile).
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  if ($server.HasExited) {
    & taskkill /PID $server.Id /T /F 2>$null | Out-Null
    $detail = (Get-Content $stderrLog -Tail 5 -ErrorAction SilentlyContinue) -join ' '
    Show-Fatal "dsh web exited early (code $($server.ExitCode)). $detail"
  }
  if (Test-Http $Port) { $ready = $true; break }
  Start-Sleep -Milliseconds 1000
}
if (-not $ready) {
  & taskkill /PID $server.Id /T /F 2>$null | Out-Null
  Show-Fatal "Timed out waiting for dsh web on port $Port. See $stdoutLog / $stderrLog"
}

# 7) Open the desktop window, then stop the server when it closes.
$window = Start-Process -FilePath $exePath -PassThru
try { Wait-Process -Id $window.Id -ErrorAction Stop } catch { }
& taskkill /PID $server.Id /T /F 2>$null | Out-Null
