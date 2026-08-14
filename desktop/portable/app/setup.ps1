<#
  DeepSeek Harness portable distribution installer.

  The portable folder is already self-contained: Node and the production
  @deepseek-ai/dsh runtime are bundled and pre-installed by the build machine,
  so the recipient needs no network and no npm. This script only creates a
  "DeepSeek Harness" shortcut on the current user's desktop that launches
  app\start.vbs (no console window); it installs or downloads nothing.

  Run from a hidden console via Install.vbs:
      app\Install.vbs
  or directly:
      powershell -NoProfile -ExecutionPolicy Bypass -File app\setup.ps1
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

$setupDir = $PSScriptRoot
$appRootDir = Split-Path $setupDir -Parent          # <portable> root
$exePath = Join-Path $appRootDir 'DeepSeek Harness.exe'
$startVbs = Join-Path $setupDir 'start.vbs'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'DeepSeek Harness.lnk'

function Show-Fatal([string]$message) {
  Write-Error $message
  try { (New-Object -ComObject WScript.Shell).Popup($message, 0, 'DeepSeek Harness', 48) | Out-Null } catch { }
  exit 1
}

if (-not (Test-Path $startVbs)) {
  Show-Fatal "Missing $startVbs. The '$($appRootDir)' folder is not a complete portable distribution; re-extract it."
}
$nodeExe = Join-Path $appRootDir 'node\node.exe'
$dshBin = Join-Path (Join-Path (Join-Path $appRootDir 'runtime') 'node_modules\@deepseek-ai\dsh') 'lib\bin.js'
if (-not (Test-Path $nodeExe) -or -not (Test-Path $dshBin)) {
  Show-Fatal "This portable distribution is incomplete (missing bundled Node or runtime). Re-extract the zip; do not delete the node\ and runtime\ folders."
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = "$env:WINDIR\System32\wscript.exe"
$shortcut.Arguments = "`"$startVbs`""
$shortcut.WorkingDirectory = $appRootDir
$shortcut.Description = 'DeepSeek Harness (portable) - starts dsh web and opens the app window'
if (Test-Path $exePath) {
  $shortcut.IconLocation = "$exePath,0"
}
$shortcut.Save()

Write-Host "Created shortcut: $lnkPath"
Write-Host 'Double-click "DeepSeek Harness" on the desktop (or run app\start.vbs) to launch.'
exit 0
