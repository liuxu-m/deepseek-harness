DeepSeek Harness - Portable Edition
====================================

This folder is a self-contained, portable build of DeepSeek Harness. It needs
no Node.js installed and no Internet connection to run: the Node runtime and the
production DeepSeek Harness runtime are bundled and pre-installed in this folder.

It contains no API credentials, no model configuration, and no personal
settings. You supply your own API key when the app first asks for one.

Requirements
------------
- Windows 10 or 11 (64-bit)
- Microsoft Edge WebView2 runtime (preinstalled on current Windows 10/11)
- Do NOT delete or move these folders inside this one:
    node\     (bundled Node runtime)
    runtime\  (bundled DeepSeek Harness server runtime)
  Only copy or move the whole folder, or the ZIP archive as-is.

Start the app
-------------
Double-click  "DeepSeek Harness.exe".

The executable starts the bundled server on http://127.0.0.1:3080, opens the
window, and stops the server when you close the window (via the tray Exit).

Browser access
--------------
While the app runs, you can also drive the same harness from any browser at:
    http://127.0.0.1:3080

Where data and logs live
------------------------
Your per-user state lives under your Windows user profile, not inside this
portable folder, so an update replaces only this folder and keeps your data:
    ~/.dsh                                                (harness data)
    LocalAppData\DeepSeek Harness\logs                    (desktop and server logs)

Notes
-----
- If 127.0.0.1:3080 is already in use by another process, the bundled server uses
  another loopback port so it does not interfere.
- SmartScreen / antivirus may warn about the (unsigned) executable the first
  time you run a locally built copy; choose "More info" > "Run anyway". This is
  expected for a portable build.

Troubleshooting
---------------
- "Bundled runtime missing" or "node missing": the folder was not copied whole,
  or the ZIP was only partially extracted. Re-extract the whole ZIP and start
  again from "DeepSeek Harness.exe".
- The app will not start: the runtime may be incomplete. Rebuild the
  distribution on the build machine with `pnpm run desktop:build`.
