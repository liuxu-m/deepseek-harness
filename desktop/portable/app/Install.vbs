' DeepSeek Harness portable setup entry (no console window).
' Double-click this file, or point a shortcut at wscript.exe with this file as
' its argument. Delegates to setup.ps1 running hidden. setup.ps1 only creates a
' desktop shortcut; the portable folder is already self-contained (no install,
' no network).
Option Explicit
Dim shell, fso, scriptDir, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\setup.ps1"""
shell.Run command, 0, False
