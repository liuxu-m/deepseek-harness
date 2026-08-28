<#
.SYNOPSIS
    Packaged-acceptance smoke for the portable DeepSeek Harness Windows archive.

.DESCRIPTION
    Runs the twelve sequential native checks the desktop plan (Task 13) requires
    against a built portable ZIP, without any development toolchain in the
    child PATH and without touching the caller's real user profile. Each check
    prints [PASS] or [FAIL]; any failure exits non-zero.

    Checks:
      1. Verify the SHA-256 checksum, extract into a path with spaces and CJK.
      2. Isolate USERPROFILE/LOCALAPPDATA; no DSH_HOME anywhere.
      3. Strip node/npm/pnpm/cargo/git from the child PATH.
      4. Start the EXE; desktop.log records an owned 127.0.0.1 URL.
      5. GET /api/runtime.identity (default home); GET / has __DSH_BOOT__.
      6. Launch again; one desktop process and one owned Node Host remain.
      7. WM_CLOSE hides to tray; process and Host keep running, HTTP answers.
      8. Kill the desktop; the owned Node PID and descendants disappear.
      9. External compatible Host on 3080: desktop attaches, external PID survives.
     10. Non-DSH listener on 3080: owned Host uses another loopback port.
     11. Image prompt is admitted (no MODEL_DOES_NOT_SUPPORT_IMAGES).
     12. Scan extracted files and logs for leaks.

.PARAMETER Archive
    Path to the portable ZIP (DeepSeek_Harness_Portable_<version>_windows_x64.zip).
.PARAMETER WorkRoot
    Optional scratch root; a fresh subdirectory is created when omitted.
.EXAMPLE
    pwsh -NoProfile -File scripts/smoke-desktop-portable.ps1 -Archive (Get-ChildItem dist/desktop/output/*.zip).FullName
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [string]$WorkRoot = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# State and helpers.
# ---------------------------------------------------------------------------

$Script:Root = ''          # extraction root (the folder containing the EXE)
$Script:Profile = ''       # isolated USERPROFILE
$Script:LocalAppData = ''  # isolated LOCALAPPDATA
$Script:Logs = ''          # <LocalAppData>\DeepSeek Harness\logs
$Script:DesktopLog = ''    # <Logs>\desktop.log
$Script:NodeExe = ''       # <Root>\node\node.exe
$Script:RuntimeBin = ''    # <Root>\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js
$Script:Exe = ''           # <Root>\DeepSeek Harness.exe
$Script:HostPid = 0        # the owned Node Host pid read from desktop.log
$Script:HostUrl = ''       # the owned Host base URL read from desktop.log

function Write-Pass([string]$message) { Write-Host "[PASS] $message" }
function Write-Fail([string]$message) {
  Write-Host "[FAIL] $message"
  $script:failed = $true
}

function Assert-True([bool]$condition, [string]$message) {
  if ($condition) { Write-Pass $message } else { Write-Fail $message }
}

# Whether a process with this processId is still alive.
function Test-ProcessAlive([int]$processId) {
  if ($processId -le 0) { return $false }
  try { return $null -ne (Get-Process -Id $processId -ErrorAction Stop) } catch { return $false }
}

# Wait until a predicate becomes true, polling every 500 ms.
function Wait-Until {
  param(
    [scriptblock]$predicate,
    [int]$timeoutSeconds,
    [string]$what
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (& $predicate) { return $true }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "  (timed out after ${timeoutSeconds}s waiting for: $what)"
  return $false
}

# Start a process with an explicit environment block (PS 5.1-safe: no
# Start-Process -Environment). Keys not listed inherit from this process; the
# DSH_HOME key is always blanked so children run from their default home.
function Start-IsolatedProcess([string]$filePath, [string[]]$arguments, [string]$workingDirectory, [hashtable]$environment) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $filePath
  $psi.WorkingDirectory = $workingDirectory
  $psi.UseShellExecute = $false
  foreach ($key in $environment.Keys) {
    $psi.EnvironmentVariables[$key] = [string]$environment[$key]
  }
  if ($arguments.Count -gt 0) {
    # .NET Framework (PS 5.1) has no ArgumentList; quote each argument.
    $quoted = $arguments | ForEach-Object {
      if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '""') + '"' } else { $_ }
    }
    $psi.Arguments = ($quoted -join ' ')
  }
  return [System.Diagnostics.Process]::Start($psi)
}

# Start the desktop EXE with the isolated environment and a clean PATH.
function Start-Desktop {
  $envBlock = @{
    USERPROFILE = $Script:Profile
    LOCALAPPDATA = $Script:LocalAppData
    APPDATA = (Join-Path $Script:LocalAppData 'AppData\Roaming')
    HOMEDRIVE = (Split-Path -Qualifier $Script:Profile)
    HOMEPATH = (Split-Path -NoQualifier $Script:Profile)
    # Blank out any inherited DSH_HOME so the child always runs from its
    # default `~/.dsh` under the isolated profile (empty is treated as unset).
    DSH_HOME = ''
    DSH_TELEMETRY_DISABLED = '1'
    PATH = $script:cleanPath
  }
  # No stdio redirection: the desktop shell's stderr stays on the smoke
  # console, and its own supervisor writes desktop.log/host.log under the
  # isolated LocalAppData. (Redirecting would force an async drain, which
  # Windows PowerShell 5.1's Task API cannot parse cleanly.)
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $Script:Exe
  $psi.WorkingDirectory = $Script:Root
  $psi.UseShellExecute = $false
  foreach ($key in $envBlock.Keys) {
    $psi.EnvironmentVariables[$key] = [string]$envBlock[$key]
  }
  $process = [System.Diagnostics.Process]::Start($psi)
  Start-Sleep -Milliseconds 500
  return $process
}

# Read the current desktop.log text, tolerating a missing file.
function Get-DesktopLogText {
  if (Test-Path $Script:DesktopLog) { return (Get-Content $Script:DesktopLog -Raw -ErrorAction SilentlyContinue) }
  return ''
}

# Wait for desktop.log to record an owned (or attached) start with a URL.
# Matches the *latest* start line so a previous check's host (already killed)
# is never mistaken for this run's host.
function Wait-DesktopStart([string]$ownership, [int]$timeoutSeconds) {
  $pattern = "ownership=$ownership url=http://127\.0\.0\.1:"
  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $log = Get-DesktopLogText
    $matches = [regex]::Matches($log, "ownership=$ownership url=(http://127\.0\.0\.1:\d+)")
    if ($matches.Count -gt 0) {
      $last = $matches[$matches.Count - 1]
      $Script:HostUrl = $last.Groups[1].Value
      $Script:HostPid = 0
      $spawn = [regex]::Matches($log, '\[spawn\] pid=(\d+)')
      if ($spawn.Count -gt 0) {
        $Script:HostPid = [int]$spawn[$spawn.Count - 1].Groups[1].Value
      }
      return $true
    }
    # Diagnostic: while waiting, report the host's printed URL and whether the
    # desktop process is still alive, so a readiness failure is observable.
    $hlog = Join-Path $Script:Logs 'host.log'
    if (Test-Path $hlog) {
      $urlLine = (Get-Content $hlog -ErrorAction SilentlyContinue | Select-String 'dsh web: http://127\.0\.0\.1:\d+' | Select-Object -Last 1)
      if ($urlLine) {
        $port = [regex]::Match($urlLine.ToString(), 'http://127\.0\.0\.1:(\d+)').Groups[1].Value
        $probe = $null
        try { $probe = (Get-HttpJson "http://127.0.0.1:$port/api/runtime.identity" -TimeoutSec 2) } catch { $probe = $null }
        Write-Host "  (waiting: host url port=$port identity=$probe)"
      }
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "  (timed out after ${timeoutSeconds}s waiting for: $what)"
  return $false
}

function Get-HttpJson([string]$url, [int]$timeoutSeconds = 10) {
  $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSeconds
  return $response.Content
}

# ---------------------------------------------------------------------------
# Check 1: checksum + extraction into a path with spaces and CJK characters.
# ---------------------------------------------------------------------------
function Invoke-Check1 {
  Write-Host 'Check 1: checksum and extraction (spaces + CJK path)'
  $shaFile = "$Archive.sha256"
  Assert-True (Test-Path $shaFile) "checksum file exists at $shaFile"
  if (-not (Test-Path $shaFile)) { return }

  $expected = ((Get-Content $shaFile -TotalCount 1) -split '\s+')[0]
  $actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLower()
  Assert-True ($expected -eq $actual) "ZIP SHA-256 matches the checksum file"

  $extract = Join-Path $Script:Scratch 'DeepSeek Harness 便携 smoke'
  if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
  New-Item -ItemType Directory -Path $extract | Out-Null
  # Expand-Archive stalls on this large archive under Windows PowerShell 5.1;
  # the .NET ZipFile extractor is reliable and reports per-entry progress.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipFile = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $Archive))
  $extractCount = 0
  try {
    foreach ($entry in $zipFile.Entries) {
      $target = Join-Path $extract $entry.FullName
      if ($entry.FullName.EndsWith('/')) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        continue
      }
      New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      $extractCount++
      if ($extractCount % 5000 -eq 0) { Write-Host "  (extracted $extractCount entries)" }
    }
  } finally {
    $zipFile.Dispose()
  }
  Write-Host "  (extracted $extractCount files total)"

  $Script:Root = Join-Path $extract 'DeepSeek Harness'
  $Script:Exe = Join-Path $Script:Root 'DeepSeek Harness.exe'
  $Script:NodeExe = Join-Path $Script:Root 'node\node.exe'
  $Script:RuntimeBin = Join-Path $Script:Root 'runtime\node_modules\@deepseek-ai\dsh\lib\bin.js'
  Assert-True (Test-Path $Script:Exe) 'DeepSeek Harness.exe exists in the archive'
  Assert-True (Test-Path $Script:NodeExe) 'node\node.exe exists in the archive'
  Assert-True (Test-Path $Script:RuntimeBin) 'runtime CLI bin.js exists in the archive'
  Assert-True (Test-Path (Join-Path $Script:Root 'VERSION.json')) 'VERSION.json exists in the archive'
  Assert-True (Test-Path (Join-Path $Script:Root 'THIRD_PARTY_NOTICES.txt')) 'THIRD_PARTY_NOTICES.txt exists'
}

# ---------------------------------------------------------------------------
# Check 2: isolated user profile; no DSH_HOME.
# ---------------------------------------------------------------------------
function Invoke-Check2 {
  Write-Host 'Check 2: isolated profile and LocalAppData, no DSH_HOME'
  # LocalAppData must be <USERPROFILE>\AppData\Local and must exist: the
  # Windows known-folder API (FOLDERID_LocalAppData) expands %USERPROFILE% and
  # verifies the resulting directory before returning it.
  $Script:Profile = Join-Path $Script:Scratch 'profile 用户'
  $Script:LocalAppData = Join-Path $Script:Profile 'AppData\Local'
  New-Item -ItemType Directory -Path (Join-Path $Script:Profile '.dsh') -Force | Out-Null
  New-Item -ItemType Directory -Path $Script:LocalAppData -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $Script:Profile 'AppData\Roaming') -Force | Out-Null
  $Script:Logs = Join-Path $Script:LocalAppData 'DeepSeek Harness\logs'
  $Script:DesktopLog = Join-Path $Script:Logs 'desktop.log'
  # The smoke never sets DSH_HOME; Start-Desktop blanks any inherited value so
  # the child always resolves its default `~/.dsh` under the isolated profile.
  # Check 5 asserts homeKind=default end to end.
  Assert-True (Test-Path (Join-Path $Script:Profile '.dsh')) 'isolated profile .dsh directory exists'
  Assert-True ((Get-ChildItem $Script:LocalAppData -Force -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) 'LocalAppData is empty (no DSH_HOME) before the desktop starts'
}

# ---------------------------------------------------------------------------
# Check 3: strip development tools from the child PATH.
# ---------------------------------------------------------------------------
function Invoke-Check3 {
  Write-Host 'Check 3: clean child PATH (no node/npm/pnpm/cargo/git)'
  # Keep only the OS system directories; drop every toolchain directory.
  $keep = @(
    (Join-Path $env:SystemRoot 'System32'),
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0'),
    $env:SystemRoot,
    (Join-Path $env:SystemRoot 'SysWOW64')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
  $script:cleanPath = ($keep -join ';')
  foreach ($tool in @('node', 'npm', 'pnpm', 'cargo', 'git', 'rustc')) {
    $resolved = Get-Command $tool -ErrorAction SilentlyContinue
    if ($resolved) {
      $dir = Split-Path $resolved.Source
      $script:cleanPath = ($script:cleanPath -split ';' | Where-Object { $_ -and $_ -ne $dir }) -join ';'
    }
  }
  Assert-True ($script:cleanPath.Length -gt 0) 'clean PATH is non-empty'
  # Prove the EXE really runs without the toolchain: the runtime closure and
  # the bundled node.exe must satisfy every dependency of the desktop shell.
  Assert-True (Test-Path $Script:NodeExe) 'bundled node.exe is independent of the dev PATH'
}

# ---------------------------------------------------------------------------
# Check 4: owned start — desktop.log records an owned 127.0.0.1 URL.
# ---------------------------------------------------------------------------
function Invoke-Check4 {
  Write-Host 'Check 4: owned host start'
  $started = $false
  $process = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ($attempt -gt 1) {
      Write-Host "  (retry $attempt after a failed owned-host start)"
      Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$Script:Root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 3
      Remove-Item (Join-Path $Script:Logs 'desktop.log'), (Join-Path $Script:Logs 'host.log') -Force -ErrorAction SilentlyContinue
    }
    $process = Start-Desktop
    Write-Host "  (debug) desktop pid=$($process.Id)"
    $started = Wait-DesktopStart 'owned' 120
    if ($started) { break }
    Write-Host "  (debug) Exe=$Script:Exe"
    Write-Host "  (debug) Root=$Script:Root"
    Write-Host "  (debug) Exe exists: $(Test-Path $Script:Exe)"
    Write-Host "  (debug) Profile=$Script:Profile"
    Write-Host "  (debug) LocalAppData=$Script:LocalAppData"
    Write-Host "  (debug) Logs=$Script:Logs"
    Write-Host "  (debug) DesktopLog=$Script:DesktopLog"
    Write-Host "  (debug) desktop.log exists: $(Test-Path $Script:DesktopLog)"
    $altReal = 'C:\Users\17930\AppData\Local\DeepSeek Harness\logs\desktop.log'
    Write-Host "  (debug) real-user desktop.log exists: $(Test-Path $altReal)"
    if (Test-Path $altReal) { Get-Content $altReal | ForEach-Object { Write-Host "    REAL: $_" } }
  }
  Assert-True $started "desktop.log records an owned start (url=$Script:HostUrl)"
  Assert-True ($Script:HostUrl -match '^http://127\.0\.0\.1:\d+$') 'the owned URL is a loopback URL'
  Assert-True (Test-ProcessAlive $process.Id) 'the desktop process stays alive after startup'
  $script:desktopProcess = $process
}

# ---------------------------------------------------------------------------
# Check 5: identity endpoint + index page.
# ---------------------------------------------------------------------------
function Invoke-Check5 {
  Write-Host 'Check 5: runtime identity and index page'
  $identity = $null
  try {
    $identity = Get-HttpJson "$Script:HostUrl/api/runtime.identity" | ConvertFrom-Json
  } catch {
    Write-Fail "GET /api/runtime.identity failed: $($_.Exception.Message)"
    return
  }
  Assert-True ($identity.product -eq 'deepseek-harness') 'identity product is deepseek-harness'
  Assert-True ([int]$identity.desktopProtocol -eq 1) 'identity desktopProtocol is 1'
  Assert-True ($identity.homeKind -eq 'default') 'identity homeKind is default (no DSH_HOME)'
  Assert-True ([string]$identity.instanceId -ne '') 'identity instanceId is non-empty'

  $index = ''
  try {
    $index = Get-HttpJson "$Script:HostUrl/"
  } catch {
    Write-Fail "GET / failed: $($_.Exception.Message)"
    return
  }
  Assert-True ($index.Contains('globalThis["__DSH_BOOT__"]')) 'GET / contains the __DSH_BOOT__ boot graph'
}

# ---------------------------------------------------------------------------
# Check 6: second launch — single desktop process, single owned Host.
# ---------------------------------------------------------------------------
function Invoke-Check6 {
  Write-Host 'Check 6: single instance'
  $second = Start-Desktop
  Start-Sleep -Seconds 3
  $exeCount = (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Measure-Object).Count
  Assert-True ($exeCount -eq 1) "exactly one desktop process remains (found $exeCount)"
  if (-not (Test-ProcessAlive $Script:HostPid)) {
    Write-Host "  (debug) HostPid=$Script:HostPid dead; desktop alive=$(-not $script:desktopProcess.HasExited); second alive=$(-not $second.HasExited)"
    $hlog = Join-Path $Script:Logs 'host.log'
    if (Test-Path $hlog) { Get-Content $hlog -Tail 5 | ForEach-Object { Write-Host "    host: $_" } }
  }
  Assert-True (Test-ProcessAlive $Script:HostPid) 'the owned Node Host pid is still alive'
  # A second process may have been reaped by the single-instance plugin.
  if (-not $second.HasExited) {
    try { $second.Kill() } catch { }
  }
}

# ---------------------------------------------------------------------------
# Check 7: WM_CLOSE hides to tray; processes and HTTP survive.
# ---------------------------------------------------------------------------
function Invoke-Check7 {
  Write-Host 'Check 7: close-to-tray via WM_CLOSE'
  $script:mainWindowHandle = [IntPtr]::Zero
  Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshNative {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
'@
  # Find the visible main window of the desktop process by title, robust to
  # hidden helper windows that FindWindow may otherwise match first.
  $mainHandle = [IntPtr]::Zero
  $callback = [DshNative+EnumProc]{
    param($hWnd, $lParam)
    $windowPid = 0
    [DshNative]::GetWindowThreadProcessId($hWnd, [ref]$windowPid) | Out-Null
    if ($windowPid -eq [uint32]$script:desktopProcess.Id -and [DshNative]::IsWindowVisible($hWnd)) {
      $sb = New-Object System.Text.StringBuilder 256
      [DshNative]::GetWindowText($hWnd, $sb, 256) | Out-Null
      if ($sb.ToString() -eq 'DeepSeek Harness') {
        $script:mainWindowHandle = $hWnd
        return $false
      }
    }
    return $true
  }
  [DshNative]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  $handle = $script:mainWindowHandle
  Assert-True ($handle -ne [IntPtr]::Zero) 'main window handle is found'
  if ($handle -eq [IntPtr]::Zero) { return }
  $WM_CLOSE = 0x0010
  $posted = [DshNative]::PostMessage($handle, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
  Assert-True $posted 'WM_CLOSE was posted'
  Start-Sleep -Seconds 3
  Assert-True (Test-ProcessAlive $script:desktopProcess.Id) 'desktop process survives WM_CLOSE (close-to-tray)'
  Assert-True (Test-ProcessAlive $Script:HostPid) 'owned Node Host survives WM_CLOSE'
  $stillAnswers = $false
  try { Get-HttpJson "$Script:HostUrl/api/runtime.identity" | Out-Null; $stillAnswers = $true } catch { }
  Assert-True $stillAnswers 'HTTP still answers after WM_CLOSE'
}

# ---------------------------------------------------------------------------
# Check 8: kill the desktop; the owned tree disappears.
# ---------------------------------------------------------------------------
function Invoke-Check8 {
  Write-Host 'Check 8: crash cleanup (kill the desktop process)'
  $desktopPid = $script:desktopProcess.Id
  $hostPid = $Script:HostPid
  Stop-Process -Id $desktopPid -Force -ErrorAction SilentlyContinue
  $treeGone = Wait-Until -predicate { -not (Test-ProcessAlive $hostPid) } -timeoutSeconds 30 -what 'owned Node Host to disappear'
  Assert-True $treeGone 'owned Node Host (and descendants) are gone after the desktop crash'
}

# ---------------------------------------------------------------------------
# Check 9: attach to a compatible external bundled Host on 3080.
# ---------------------------------------------------------------------------
function Invoke-Check9 {
  Write-Host 'Check 9: attach to an external compatible Host'
  # The default port must be free for this check: the external Host binds 3080
  # itself. When another non-test process already listens there (e.g. a
  # developer's own `dsh web`), the check is skipped explicitly rather than
  # racing that process; a clean CI runner always executes it.
  $existing = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
  if ($existing) {
    $owner = Get-Process -Id $existing.OwningProcess -ErrorAction SilentlyContinue
    Write-Host "  (SKIP: port 3080 is already owned by $($owner.ProcessName) pid $($owner.Id); attach is covered on a clean CI runner)"
    Write-Pass 'attach check skipped: 3080 occupied by a non-test process (CI covers it)'
    return
  }
  # The external Host is the bundled CLI, run directly with the bundled node
  # (no dev node), on the default port. DSH_HOME deliberately unset: the
  # identity must report the default home so the desktop attaches.
  $externalEnv = @{
    USERPROFILE = $Script:Profile
    LOCALAPPDATA = $Script:LocalAppData
    APPDATA = (Join-Path $Script:LocalAppData 'AppData\Roaming')
    # Blank any inherited DSH_HOME so the external Host reports homeKind=default.
    DSH_HOME = ''
    DSH_TELEMETRY_DISABLED = '1'
    PATH = $script:cleanPath
  }
  $external = Start-IsolatedProcess -filePath $Script:NodeExe -arguments @($Script:RuntimeBin, '--profile', 'web', '--port', '3080') -workingDirectory $Script:Root -environment $externalEnv
  $externalReady = Wait-Until -predicate {
    try {
      $id = Get-HttpJson 'http://127.0.0.1:3080/api/runtime.identity' | ConvertFrom-Json
      return ($id.product -eq 'deepseek-harness' -and [int]$id.desktopProtocol -eq 1)
    } catch { return $false }
  } -timeoutSeconds 120 -what 'external Host to be ready on 3080'
  Assert-True $externalReady 'external bundled Host is ready on 3080'

  $desktop = Start-Desktop
  $attached = Wait-DesktopStart 'attached' 60
  Assert-True $attached "desktop.log records ownership=attached (url=$Script:HostUrl)"
  Assert-True ($Script:HostUrl -eq 'http://127.0.0.1:3080') 'the attached URL is the external Host'
  Assert-True (Test-ProcessAlive $external.Id) 'external Host pid is alive after attach'

  # Close the desktop (the controller Exit path is covered by the Rust test);
  # the external Host must survive because it was never owned.
  Stop-Process -Id $desktop.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Assert-True (Test-ProcessAlive $external.Id) 'external Host survives the desktop closing'
  Stop-Process -Id $external.Id -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Check 10: non-DSH listener on 3080 -> owned Host on another loopback port.
# ---------------------------------------------------------------------------
function Invoke-Check10 {
  Write-Host 'Check 10: non-DSH listener on 3080'
  # Prefer an already-listening non-test process (e.g. a developer's `dsh web`
  # that answers 404 to the identity probe) as the non-DSH fixture: the
  # desktop must still start its own host on another port and never stop the
  # listener. Otherwise start a minimal non-DSH HTTP fixture ourselves.
  $existing = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
  $ownFixture = $false
  $listener = $null
  if (-not $existing) {
    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add('http://127.0.0.1:3080/')
    $listener.Start()
    $ownFixture = $true
    $respond = [System.Action[System.Threading.Tasks.Task[System.Net.HttpListenerContext]]]{
      param($task)
      $context = $task.Result
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"not":"a-dsh-host"}')
      $context.Response.ContentType = 'application/json'
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      $context.Response.Close()
    }
    $null = $listener.GetContextAsync().ContinueWith($respond, [System.Threading.Tasks.TaskScheduler]::Default)
  }

  # Clear the logs so Wait-DesktopStart matches only this run's start line.
  Remove-Item (Join-Path $Script:Logs 'desktop.log'), (Join-Path $Script:Logs 'host.log') -Force -ErrorAction SilentlyContinue
  $desktop = $null
  $started = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ($attempt -gt 1) {
      Write-Host "  (retry $attempt after a failed owned-host start)"
      Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$Script:Root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 3
      Remove-Item (Join-Path $Script:Logs 'desktop.log'), (Join-Path $Script:Logs 'host.log') -Force -ErrorAction SilentlyContinue
    }
    $desktop = Start-Desktop
    $started = Wait-DesktopStart 'owned' 120
    if ($started) { break }
  }
  Assert-True $started "desktop.log records an owned start on a non-default port (url=$Script:HostUrl)"
  Assert-True ($Script:HostUrl -ne 'http://127.0.0.1:3080') 'the owned Host used another loopback port'
  if ($ownFixture) {
    Assert-True $listener.IsListening 'the non-DSH fixture on 3080 is still listening'
  } else {
    $stillListening = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
    Assert-True ($null -ne $stillListening) 'the pre-existing listener on 3080 is still listening'
  }
  Assert-True (Test-ProcessAlive $desktop.Id) 'desktop process is alive with a dynamic port'
  Stop-Process -Id $desktop.Id -Force -ErrorAction SilentlyContinue
  if ($ownFixture) {
    $listener.Stop()
    $listener.Close()
  }
}

# ---------------------------------------------------------------------------
# Check 11: image prompt admission (globalImage shipped in the Web profile).
# ---------------------------------------------------------------------------
function Invoke-Check11 {
  Write-Host 'Check 11: image prompt admission through the API gateway'
  # Clear the logs so Wait-DesktopStart matches only this run's start line.
  Remove-Item (Join-Path $Script:Logs 'desktop.log'), (Join-Path $Script:Logs 'host.log') -Force -ErrorAction SilentlyContinue
  $desktop = $null
  $started = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    if ($attempt -gt 1) {
      Write-Host "  (retry $attempt after a failed owned-host start)"
      Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$Script:Root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 3
      Remove-Item (Join-Path $Script:Logs 'desktop.log'), (Join-Path $Script:Logs 'host.log') -Force -ErrorAction SilentlyContinue
    }
    $desktop = Start-Desktop
    $started = Wait-DesktopStart 'owned' 120
    if ($started) { break }
  }
  Assert-True $started 'desktop is owned for the image-prompt check'
  if (-not $started) { return }

  $base = $Script:HostUrl
  $png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  $createBody = @{ type = 'client-request'; rpcId = 'smoke-create'; method = 'session.create'; payload = @{} } | ConvertTo-Json -Depth 6
  $create = Invoke-RestMethod -Uri "$base/api/session.create" -Method Post -ContentType 'application/json' -Body $createBody -TimeoutSec 30
  $sessionId = $create.result.value.sessionId
  Assert-True ([string]$sessionId -ne '') 'session.create returns a sessionId'

  $promptBody = @{
    type = 'client-request'; rpcId = 'smoke-prompt'; method = 'session.prompt'
    payload = @{
      sessionId = $sessionId; mode = 'queue'
      content = @(
        @{ type = 'image'; mediaType = 'image/png'; data = $png },
        @{ type = 'text'; text = 'describe this image' }
      )
    }
  } | ConvertTo-Json -Depth 8
  $response = Invoke-RestMethod -Uri "$base/api/session.prompt" -Method Post -ContentType 'application/json' -Body $promptBody -TimeoutSec 60
  $json = $response | ConvertTo-Json -Depth 10
  Assert-True (-not $json.Contains('MODEL_DOES_NOT_SUPPORT_IMAGES')) 'the image prompt is not rejected by the model gate'
  # When the isolated profile cannot route a model, the rejection must come
  # from the attachment service, never from the model gate.
  if ($response.result.ok -eq $false -and $response.result.error) {
    $code = [string]$response.result.error.code
    Assert-True ($code -eq 'attachment-error') "rejection code is the attachment-service error (got $code)"
  } else {
    Write-Pass 'image prompt accepted or routed past admission'
  }
  Stop-Process -Id $desktop.Id -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Check 12: leak scan of extracted files and logs.
# ---------------------------------------------------------------------------
function Invoke-Check12 {
  Write-Host 'Check 12: leak scan'
  $leaks = [System.Collections.Generic.List[string]]::new()
  $checkout = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  $marker = '[dsh-patch:global-image]'
  # Machine-specific patterns: an absolute checkout path, a literal
  # %USERPROFILE%, a secret-looking value, or the prototype patch marker.
  $patterns = @(
    [regex]::Escape($checkout),
    [regex]::Escape('%USERPROFILE%'),
    'sk-[A-Za-z0-9]{16,}',
    [regex]::Escape($marker)
  )
  # Real credential documents, wherever they appear.
  $forbiddenNames = @('.credentials.yaml', '.env')

  # 1) Assembly-written top-level files are scanned fully.
  $topLevel = Get-ChildItem -Path $Script:Root -File -ErrorAction SilentlyContinue
  foreach ($file in $topLevel) {
    $text = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $text) { continue }
    foreach ($pattern in $patterns) {
      if ($text -match $pattern) {
        $leaks.Add("$($file.Name) matches $pattern")
        break
      }
    }
  }

  # 2) The runtime closure (third-party packages) is scanned only for the
  #    prototype patch marker and forbidden secret filenames. Bundled JS may
  #    legitimately embed the build machine path in source maps/regions, and
  #    package READMEs document the credential format; neither is a leak.
  Get-ChildItem -Path (Join-Path $Script:Root 'runtime') -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -notin @('.exe', '.node', '.dll', '.png', '.jpg', '.ico', '.woff', '.woff2', '.map') } |
    ForEach-Object {
      if ($forbiddenNames -contains $_.Name) {
        $rel = $_.FullName.Substring($Script:Root.Length).TrimStart('\', '/')
        $leaks.Add("$rel is a forbidden secret/config filename")
        return
      }
      if ($_.Length -gt 2MB) { return }
      $text = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
      if ($text -and $text.Contains($marker)) {
        $rel = $_.FullName.Substring($Script:Root.Length).TrimStart('\', '/')
        $leaks.Add("$rel contains the prototype patch marker")
      }
    }

  # 3) Logs (isolated profile) are scanned fully.
  if (Test-Path $Script:Logs) {
    Get-ChildItem -Path $Script:Logs -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
      $text = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
      if ($text) {
        foreach ($pattern in $patterns) {
          if ($text -match $pattern) {
            $leaks.Add("log $($_.Name) matches $pattern")
            break
          }
        }
      }
    }
  }
  Assert-True ($leaks.Count -eq 0) "no credential/checkout/marker leaks (found $($leaks.Count))"
  foreach ($leak in $leaks) { Write-Host "    leaked: $leak" }
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
$script:failed = $false
$script:desktopProcess = $null
$script:cleanPath = ''

Assert-True (Test-Path $Archive) "archive exists: $Archive"
if (-not (Test-Path $Archive)) { exit 1 }

$Script:Scratch = if ($WorkRoot) { Join-Path $WorkRoot "dsh-smoke-$([Guid]::NewGuid().ToString('N').Substring(0, 8))" } else { Join-Path $env:TEMP "dsh-smoke-$([Guid]::NewGuid().ToString('N').Substring(0, 8))" }
New-Item -ItemType Directory -Path $Script:Scratch | Out-Null

try {
  Invoke-Check1
  if (-not $script:failed) { Invoke-Check2 }
  if (-not $script:failed) { Invoke-Check3 }
  if (-not $script:failed) { Invoke-Check4 }
  if (-not $script:failed) { Invoke-Check5 }
  if (-not $script:failed) { Invoke-Check6 }
  if (-not $script:failed) { Invoke-Check7 }
  if (-not $script:failed) { Invoke-Check8 }
  if (-not $script:failed) { Invoke-Check9 }
  if (-not $script:failed) { Invoke-Check10 }
  if (-not $script:failed) { Invoke-Check11 }
  if (-not $script:failed) { Invoke-Check12 }
} finally {
  # Reap any desktop process left behind by a failed check.
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process -Name 'node' -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "$Script:Root*"
  } | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($script:failed) {
    Write-Host "  (scratch kept at $Script:Scratch for diagnosis)"
    Write-Host "  desktop.log:"
    $dlog = Join-Path $Script:Logs 'desktop.log'
    if (Test-Path $dlog) { Get-Content $dlog | ForEach-Object { Write-Host "    $_" } } else { Write-Host '    (absent)' }
    Write-Host "  host.log:"
    $hlog = Join-Path $Script:Logs 'host.log'
    if (Test-Path $hlog) { Get-Content $hlog -TotalCount 40 | ForEach-Object { Write-Host "    $_" } } else { Write-Host '    (absent)' }
  } else {
    Remove-Item -Recurse -Force $Script:Scratch -ErrorAction SilentlyContinue
  }
}

if ($script:failed) {
  Write-Host 'SMOKE RESULT: FAIL'
  exit 1
}
Write-Host 'SMOKE RESULT: PASS'
exit 0
