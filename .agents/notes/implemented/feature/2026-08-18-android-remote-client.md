# Agent Note: Android remote client

Status: implemented

English | [中文](2026-08-18-android-remote-client.zh.md)

## Problem

The Windows shell owns a local Node Web Host and Windows process controls, so its portable executable cannot be reused as an Android package. A phone client needs the same Web UI without moving Agent execution, filesystem access, or shell tools onto Android.

## Decision

The Android target is a thin Tauri client. It creates one WebView, loads mobile-client.html, and lets the operator enter the computer's HTTPS dsh web URL. The setup page validates absolute HTTPS URLs, stores the last address in WebView local storage, and navigates to that remote Host. The Android target does not compile or start the Windows supervisor, bundled Node carrier, tray, or process-control modules.

The existing Windows target remains responsible for starting the bundled local Host. The remote Host must be reached through an HTTPS endpoint with access control because dsh web itself rejects public command-line binding and has no built-in authentication or TLS. The client does not add a proxy or weaken the Web Host's access controls.

## Alternatives considered

### Bundle a local Node Host in the APK

Rejected for this target: it would require an Android Node carrier, Android builds of native dependencies, replacements for PowerShell and Windows process controls, and an Android filesystem and background-process policy. Those capabilities are not needed by a remote client.

### Use the browser or a PWA only

Rejected as the product package: it avoids native packaging but does not provide the requested installable Android client. The Tauri WebView keeps the existing Web UI while providing an APK/AAB build target.

## Consequences

- Android packaging is independent of the Windows portable archive and does not include Node or DSH runtime files.
- The first client screen requires a reachable remote URL; changing the saved address is done by returning to the setup page or clearing the app's WebView data.
- Android builds require the Tauri Android project plus the Android SDK, NDK, Java, and Gradle environment on the build machine; the repository workflow supplies these on Ubuntu, restores its release keystore from Actions secrets, verifies the ARM64 APK signature, and uploads signed APK/AAB artifacts for pull requests and manual runs.
- The remote Web Host remains the single owner of sessions, settings, credentials, workspaces, and tool execution.
