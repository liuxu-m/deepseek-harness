#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'
import { PARENT_CONTROL_ENV, PARENT_CONTROL_STDIN_V1 } from './parent-control.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const invocation = parseDshArgs(process.argv.slice(2), readVersion())

/**
 * Resolve the parent-shutdown channel from the environment. A typo must never
 * silently disable desktop shutdown, so any non-empty value other than the
 * stdin-v1 shake-hand fails loud before boot.
 * @returns the inherited stdin carrying the shutdown channel, or `undefined` when unset.
 */
function resolveParentControl(): NodeJS.ReadableStream | undefined {
  const raw = process.env[PARENT_CONTROL_ENV]
  if (raw === undefined || raw === '') return undefined
  if (raw !== PARENT_CONTROL_STDIN_V1) {
    throw new Error(`dsh: unsupported ${PARENT_CONTROL_ENV}=${JSON.stringify(raw)}`)
  }
  return process.stdin
}

switch (invocation.mode) {
  case 'profile': {
    const { runProfile } = await import('./profile-boot.ts')
    const parentControl = resolveParentControl()
    await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
      ...(parentControl === undefined ? {} : { parentControl }),
    })
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('./plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('./dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
