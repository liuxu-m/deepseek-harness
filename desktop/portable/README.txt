DeepSeek Harness - Portable Edition
====================================

This folder is a self-contained, portable build of DeepSeek Harness. It needs no
Node.js installed and no Internet connection to run: the Node runtime and the
production DeepSeek Harness runtime are bundled and pre-installed.

It contains no API credentials, no model configuration, and no personal
settings. You supply your own API key in the app (Settings when it first runs).

Requirements
------------
- Windows 10 or 11 (64-bit)
- Do NOT delete or move these folders inside this one:
    node\     (bundled Node runtime)
    runtime\  (bundled DeepSeek Harness server runtime)
  Only copy/move the whole folder or the zip as-is.

Start the app
-------------
Double-click  app\start.vbs
(or open a PowerShell here and run:  powershell -NoProfile -ExecutionPolicy Bypass -File app\start.ps1)

start.vbs opens no console window. It starts the bundled server on
http://127.0.0.1:3080, opens the DeepSeek Harness window, and stops the server
when you close the window.

Browser access
--------------
While the app runs, you can also drive the same harness from any browser at:
    http://127.0.0.1:3080

Create a desktop shortcut (optional, first run)
-----------------------------------------------
Double-click  app\Install.vbs
(or run:  powershell -NoProfile -ExecutionPolicy Bypass -File app\setup.ps1)
This only adds a "DeepSeek Harness" shortcut to your desktop pointing at
app\start.vbs. It downloads and installs nothing.

Notes
-----
- If 127.0.0.1:3080 is already in use by something else, start.vbs shows a
  message and exits so it does not interfere. Close that program and try again.
- If a server is already serving 127.0.0.1:3080, the window opens against it
  and nothing is stopped.
- Server logs: logs\server.log and logs\server.err.log.
- SmartScreen / antivirus may warn about the (unsigned) executable the first
  time; choose "More info" > "Run anyway", or add an exception. This is expected
  for a locally/portably built app.

Troubleshooting
---------------
- "Bundled runtime missing" or "node missing": the folder was not copied whole,
  or the zip was only partially extracted. Re-extract the whole zip and start
  again from app\start.vbs.
- The app will not start at all: the runtime may be incomplete. Rebuild the
  distribution on the build machine with build-portable.ps1.
