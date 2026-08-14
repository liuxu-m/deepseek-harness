' DeepSeek Harness portable launcher entry (no console window).
' Double-click this file, or point a desktop shortcut at wscript.exe with this
' file as its argument. Delegates to start.ps1 running hidden.
Option Explicit
Dim shell, fso, scriptDir, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\start.ps1"""
shell.Run command, 0, False
