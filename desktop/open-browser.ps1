<#
  Open the DeepSeek Harness web GUI in the default browser.
  The desktop window and the browser share the same server on 127.0.0.1:3080.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File open-browser.ps1 [-Port 3080]
#>
param([int]$Port = 3080)
Start-Process "http://127.0.0.1:$Port"
