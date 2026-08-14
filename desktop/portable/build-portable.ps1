<#
  Build a self-contained, portable Windows DeepSeek Harness distribution.

  Produces a folder (and a ZIP) that can be copied to any Windows 10/11 machine
  and run with no Node.js install, no registry access at launch, no npm download
  on the recipient, and no API credentials or model configuration bundled.

  Everything that needs a network or a toolchain happens HERE on the build
  machine:

    1. Node v26.7.0 is downloaded (once, cached in _cache\) and extracted to
       app\node\.
    2. The production-only @deepseek-ai\dsh runtime is npm-installed with the
       bundled Node into app\runtime\ (no dev dependencies).
    3. The three compiled artifacts that carry the [dsh-patch:global-image]
       image scheme (dsh-host-apiproxy, dsh-llm-pi-ai, dsh-tool-fs) are copied
       from the developer's already-patched install under
       desktop\tool\node_modules onto the fresh runtime, and verified.
    4. The assembled folder is ZIPped to _output\.

  The recipient does NO install: setup.ps1 only creates a desktop shortcut, and
  start.ps1 runs the ready runtime straight from the folder.

  Build the desktop app first (produces desktop\dist\DeepSeek Harness.exe):

      powershell -NoProfile -ExecutionPolicy Bypass -File desktop\build.ps1

  Then build the portable distribution:

      powershell -NoProfile -ExecutionPolicy Bypass -File desktop\portable\build-portable.ps1

  Output lands in desktop\portable\_output\, staged in desktop\portable\_stage\;
  downloads are cached in desktop\portable\_cache\ so rebuilds avoid re-fetching.
  Stamp the folder and rename to taste; app\start.vbs is the no-console entry
  point. No source, no company path, no credentials, and no model config are
  included.
#>
[CmdletBinding()]
param(
  [string]$AppName = 'DeepSeek Harness',
  [string]$NodeVersion = 'v26.7.0',
  [string]$DshVersion = '0.1.0-rc.6',
  [string]$NodeDownloadBase = 'https://nodejs.org/dist',
  [switch]$SkipDownload             # use an already-cached Node zip without re-downloading
)
$ErrorActionPreference = 'Stop'

# --- Locations ---------------------------------------------------------------
$portableDir = $PSScriptRoot
$desktopDir = Split-Path $portableDir -Parent
$toolDir = Join-Path $desktopDir 'tool'
$distDir = Join-Path $desktopDir 'dist'
$exePath = Join-Path $distDir "$AppName.exe"

$stageRoot = Join-Path $portableDir '_stage'
$cacheDir = Join-Path $portableDir '_cache'
$outputDir = Join-Path $portableDir '_output'
$stageAppDir = Join-Path $stageRoot $AppName

$nodeRel = "node-$NodeVersion-win-x64"
$nodeZipName = "$nodeRel.zip"
$nodeDownloadUrl = "$NodeDownloadBase/$NodeVersion/$nodeZipName"

# The three compiled artifacts patched with the global-image scheme.
$patchedPackages = @('dsh-host-apiproxy', 'dsh-llm-pi-ai', 'dsh-tool-fs')
$patchMarker = '[dsh-patch:global-image]'

function Show-Info([string]$message) { Write-Host "[portable] $message" }

function Assert-PatchedSource([string]$pkg) {
  $lib = Join-Path (Join-Path (Join-Path $toolDir 'node_modules\@deepseek-ai') $pkg) 'lib\index.js'
  if (-not (Test-Path $lib)) {
    Write-Error "[portable] missing patched artifact: $lib. Run desktop\build.ps1 / desktop\launch.ps1 first to create the patched install."
  }
  $marked = Select-String -Path $lib -Pattern $patchMarker -SimpleMatch -Quiet -ErrorAction SilentlyContinue
  if (-not $marked) {
    Write-Error "[portable] $lib does not carry the $patchMarker marker; the source install is not patched."
  }
  return $lib
}

# --- Prerequisites -----------------------------------------------------------
if (-not (Test-Path $exePath)) {
  Write-Error "[portable] desktop app not built: $exePath. Run desktop\build.ps1 first."
  exit 1
}
$patchedSource = @{}
foreach ($pkg in $patchedPackages) { $patchedSource[$pkg] = Assert-PatchedSource $pkg }

Show-Info "prerequisites OK: exe, bundled Node $NodeVersion target, patched source artifacts present"

# --- Work dirs -----------------------------------------------------------
New-Item -ItemType Directory -Force $cacheDir | Out-Null
New-Item -ItemType Directory -Force $outputDir | Out-Null

# --- 1) Bundled Node ----------------------------------------------------
$nodeZip = Join-Path $cacheDir $nodeZipName
if (-not (Test-Path $nodeZip)) {
  if ($SkipDownload) { Write-Error "[portable] node zip not cached: $nodeZip"; exit 1 }
  Show-Info "downloading Node $NodeVersion ..."
  Invoke-WebRequest -Uri $nodeDownloadUrl -OutFile $nodeZip
} else {
  Show-Info "using cached Node zip: $nodeZip"
}

# --- 2) Assemble a fresh stage ---------------------------------------------
if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Force $stageAppDir | Out-Null

# App binaries and scripts.
Copy-Item $exePath (Join-Path $stageAppDir "$AppName.exe")
Copy-Item (Join-Path $portableDir 'app') (Join-Path $stageAppDir 'app') -Recurse
Copy-Item (Join-Path $portableDir 'README.txt') (Join-Path $stageAppDir 'README.txt')

# --- 3) Node extract ----------------------------------------------------
Show-Info "extracting Node $NodeVersion ..."
$extractDir = Join-Path $cacheDir 'unpack'
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
New-Item -ItemType Directory -Force $extractDir | Out-Null
try {
  Expand-Archive -Path $nodeZip -DestinationPath $extractDir -Force
} catch {
  Remove-Item $nodeZip -Force -ErrorAction SilentlyContinue
  Write-Error "[portable] failed to extract Node zip ($nodeZip); the download may be corrupt. It was removed; re-run to fetch again."
  exit 1
}
$unpackedNode = Join-Path $extractDir $nodeRel
if (-not (Test-Path (Join-Path $unpackedNode 'node.exe'))) {
  Write-Error "[portable] unpacked Node layout unexpected: no node.exe at $unpackedNode"
  exit 1
}
$stageNode = Join-Path $stageAppDir 'node'
Move-Item $unpackedNode $stageNode
Remove-Item $extractDir -Recurse -Force

$nodeExe = Join-Path $stageNode 'node.exe'
$npmCli = Join-Path (Join-Path $stageNode 'node_modules') 'npm\bin\npm-cli.js'
if (-not (Test-Path $npmCli)) {
  Write-Error "[portable] bundled npm CLI missing: $npmCli. The Node zip is incomplete."
  exit 1
}

# --- 4) Production npm runtime ------------------------------------------
# Installed HERE with the bundled Node, so the recipient needs no network.
$runtimeDir = Join-Path $stageAppDir 'runtime'
$runtimeManifest = Join-Path $runtimeDir 'package.json'
if (-not (Test-Path $runtimeDir)) { New-Item -ItemType Directory -Force $runtimeDir | Out-Null }
@"
{
  "name": "dsh-portable-runtime",
  "private": true,
  "version": "0.0.0",
  "description": "Production-only @deepseek-ai/dsh runtime bundled with the DeepSeek Harness portable distribution.",
  "dependencies": {
    "@deepseek-ai/dsh": "$DshVersion"
  }
}
"@ | Set-Content -Path $runtimeManifest -Encoding UTF8

Show-Info "installing production @deepseek-ai/dsh@$DshVersion runtime (bundled Node npm) ..."
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $nodeExe $npmCli install --prefix $runtimeDir --omit=dev --no-audit --no-fund --no-progress --loglevel=error 2>&1 |
  ForEach-Object { Write-Host $_.ToString() }
$npmExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($npmExit -ne 0) {
  Write-Error "[portable] production npm install failed (exit $npmExit). See the npm output above."
  exit 1
}

# --- 5) Apply the global-image patch to the fresh runtime -----------------
# The fresh runtime's lib\index.js artifacts are pristine (the production
# install just replaced them); copy the developer's patched versions over them
# exactly as the desktop flow serves them.
$runtimeAi = Join-Path $runtimeDir 'node_modules\@deepseek-ai'
$dshBin = Join-Path $runtimeAi 'dsh\lib\bin.js'
if (-not (Test-Path $dshBin)) {
  Write-Error "[portable] @deepseek-ai/dsh did not land under the runtime (missing $dshBin)."
  exit 1
}
foreach ($pkg in $patchedPackages) {
  $destLib = Join-Path (Join-Path $runtimeAi $pkg) 'lib'
  if (-not (Test-Path $destLib)) {
    Write-Error "[portable] runtime is missing package $pkg (no $destLib). The installed dsh bundle differs from the developer's."
    exit 1
  }
  Copy-Item $patchedSource[$pkg] (Join-Path $destLib 'index.js') -Force
  $marked = Select-String -Path (Join-Path $destLib 'index.js') -Pattern $patchMarker -SimpleMatch -Quiet -ErrorAction SilentlyContinue
  if (-not $marked) {
    Write-Error "[portable] failed to apply the $patchMarker patch to $pkg in the runtime."
    exit 1
  }
  Show-Info "patched runtime ${pkg}: marker OK"
}

# --- 6) Package ---------------------------------------------------------
$zipPath = Join-Path $outputDir (($AppName -replace ' ', '_') + "_Portable_$NodeVersion.zip")
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Show-Info "compressing $zipPath ..."
Compress-Archive -Path (Join-Path $stageAppDir '*') -DestinationPath $zipPath -Force

Show-Info "done."
Show-Info "  unpacked : $stageAppDir"
Show-Info "  archive  : $zipPath"
Write-Host ''
Write-Host "Copy the packed folder '$AppName' (or the zip) to any Windows 10/11 PC, then run app\start.vbs. On first run, run app\Install.vbs (or setup.ps1) to create a desktop shortcut. See README.txt."
exit 0
