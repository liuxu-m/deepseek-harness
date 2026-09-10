# Agent Note: Tauri desktop shell as an additive package

Status: implemented

English | [中文](2026-09-10-tauri-desktop-shell-as-additive-package.zh.md)

## Problem

A personal portable Windows build needs a shell that starts the bundled dsh runtime, owns the window, and stops the runtime on exit. The first attempt reused the official `apps/desktop` package for it: the Tauri sources replaced the Electron sources in place, sixty Electron files were deleted, and the package manifest was rewritten. Upstream keeps changing `apps/desktop` (twelve commits in three days at the time of writing), so every synchronization hit modify/delete conflicts on files this branch had removed, plus three-way conflicts in `package.json`, `tsconfig.host.json`, and `tsdown.config.ts`, where the same removal surgery was needed again.

The maintainer's requirement is that the shell survives while upstream merges stay cheap, and that the runtime closure stops needing hand repair each time an upstream package is added or renamed.

## Decision

The Tauri shell is a separate workspace package, `apps/desktop-tauri` (`@deepseek-ai/dsh-desktop-tauri`), added beside the untouched official `apps/desktop`. The branch adds files and appends rows; it deletes nothing from upstream packages.

Three mechanical consequences follow.

The runtime deploy root moves with it. `apps/desktop-tauri/package.json` is the package `pnpm deploy --prod` stages, and `scripts/release/build-desktop-runtime.ts` and `scripts/release/build-desktop-portable.ts` name it through `DESKTOP_PACKAGE`, `DESKTOP_MANIFEST`, `DEFAULT_EXE`, and the deploy-hoist recovery path. The official manifest and its release scripts remain in place and untouched.

The closure is generated rather than maintained. `scripts/release/desktop-tauri-manifest.ts` walks the workspace from `@deepseek-ai/dsh`, `@deepseek-ai/dsh-web-app`, and `@deepseek-ai/dsh-web-frontend`, follows `dependencies`, `optionalDependencies`, and every workspace `peerDependencies` entry, and rewrites the manifest's `dependencies` block; `--check` turns a stale manifest into a failure. The previous hand-written list had drifted by construction: against the packages this branch now tracks, fifty-nine listed entries had no workspace manifest and fifty-five reachable packages were missing. The walk also declares PLUGIN_CLIENT_PEERS — @deepseek-ai/dsh-client-ui-primitives and @deepseek-ai/dsh-client-ui-slots — which upstream keeps as build-time devDependencies while a published bundle may name them in dsh.client.inject; the hand-written list shipped them, so dropping them would break plugin resolution for a profile that falls back to this runtime.

Root wiring is append-only. `package.json` keeps every upstream `build:desktop` through `upload:win:x64` row and gains `desktop:manifest`, `desktop:runtime`, `desktop:build`, and `desktop:test`. `tsdown.config.ts` and `tsconfig.host.json` are not modified at all, because the official Electron desktop remains a workspace member that those configurations already cover.

## Runtime closure walk

The walk starts at three entry points: the `dsh` CLI that boots the application, the Web profile bundle that composes the application layer, and the built Web frontend assets the CLI serves. Reaching a package through those entry points is what makes it runtime-reachable; `verify-runtime-closure` then enforces the two properties that a generated list can still violate — every plugin a shipped agent preset references, and every non-optional workspace peer of a declared package.

Deploy keeps `--config.auto-install-peers=false`, so an undeclared workspace peer is unresolvable at runtime rather than silently repaired. Optional peers are declared but not traversed: they must resolve if a consumer loads them, and following them would pull in trees the archive does not need.

## Alternatives considered

**Keep replacing `apps/desktop` in place.** This is what the branch did first. It yields one package instead of two and reuses the official manifest's deploy wiring, but every upstream commit touching `apps/desktop` can conflict, and the conflict rate grows with upstream activity. The cheap-merge requirement is incompatible with deleting files upstream still edits.

**Keep the Tauri shell in a separate repository.** This would leave the tracked repository free of local additions. It loses workspace link resolution, so the runtime closure would have to be assembled from published npm packages rather than from `pnpm deploy` over workspace links, and it would need its own CI to build and smoke-test the archive. The branch already carries the packaging scripts and workflow; colocating them keeps one build path.

**Hand-maintain the 150-entry dependency list.** Generous and explicit, and it needs no generator. It had already drifted, and the drift fails late — at archive runtime, when Cordis cannot resolve a plugin — rather than at manifest generation.

## Consequences

Upstream synchronization now applies as ordinary merges over added files, and `pnpm run desktop:manifest` absorbs upstream package additions and renames without a code change. The repository sells two desktop shells: `apps/desktop` (official Electron, untouched) and `apps/desktop-tauri` (this branch's portable). The closure generator must keep pace with new runtime entry points; adding a fourth seed is a manifest change, not a code change, but forgetting one silently drops packages from the archive.

The portable archive is unsigned, and `apps/desktop-tauri` ships no update channel. Both remain personal-build properties, not repository properties.

## Verification

`pnpm run verify-runtime-closure --manifest apps/desktop-tauri/package.json` reports zero failures over four shipped presets and the reachable workspace packages. `apps/desktop-tauri/README.md` and its Chinese counterpart document the closure generator, the deploy root, and the build commands.
