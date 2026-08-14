<#
  Create a "DeepSeek Harness" shortcut on the current user's desktop.
  The shortcut points at wscript.exe running desktop\launch.vbs, so launching
  it shows no console window. Run this once after desktop\build.ps1.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File create-shortcut.ps1
#>
$ErrorActionPreference = 'Stop'

$desktopDir = $PSScriptRoot
$exePath = Join-Path $desktopDir 'dist\DeepSeek Harness.exe'
$vbsPath = Join-Path $desktopDir 'launch.vbs'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'DeepSeek Harness.lnk'

if (-not (Test-Path $vbsPath)) { Write-Error "Missing $vbsPath"; exit 1 }

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = "$env:WINDIR\System32\wscript.exe"
$shortcut.Arguments = "`"$vbsPath`""
$shortcut.WorkingDirectory = $desktopDir
$shortcut.Description = 'DeepSeek Harness desktop client (starts dsh web and opens the app window)'
if (Test-Path $exePath) {
  $shortcut.IconLocation = "$exePath,0"
}
$shortcut.Save()

Write-Host "Created: $lnkPath"
if (-not (Test-Path $exePath)) {
  Write-Host 'Note: the app exe is not built yet (desktop\dist\DeepSeek Harness.exe).'
  Write-Host 'Run desktop\build.ps1 first; the shortcut will pick up its icon automatically.'
}
