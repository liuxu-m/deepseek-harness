/**
 * The `globalImage` flag service: the schema default (off) and the shipped Web
 * profile patch (on). The flag is the single source of truth that the
 * api-proxy, llm-pi-ai and tool-fs host checks read; this bundle only provides
 * it and enables it under `dsh --profile web`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as webApp from '../src/index.ts'

let dist: string | undefined

afterEach(() => {
  vi.restoreAllMocks()
  webApp.internals.resolveDistIndex = originalResolve
  if (dist !== undefined) rmSync(dist, { recursive: true, force: true })
  dist = undefined
})

const originalResolve = webApp.internals.resolveDistIndex

/** Stage a dist fixture and point the bundle's resolver at it. */
function stageDist(): string {
  dist = mkdtempSync(join(tmpdir(), 'dsh-web-app-image-'))
  mkdirSync(join(dist, 'dist'))
  const index = join(dist, 'dist', 'index.html')
  writeFileSync(index, '<head></head><body>shell</body>')
  webApp.internals.resolveDistIndex = () => index
  return index
}

/** A fake webServer that satisfies the web-app injection proxy. */
function fakeServer(): WebServer {
  return {
    host: '127.0.0.1',
    port: 4567,
    register: () => () => {},
    registerFallback: () => () => {},
    applyIndexTaps: (html: string) => html,
  } as unknown as WebServer
}

/** Mount the real web-app plugin (so its invariant companion joins readiness). */
async function mountWebApp(ctx: Context, config: webApp.Config): Promise<void> {
  ctx.provide('webServer', fakeServer())
  await ctx.plugin(webApp, config)
}

/** The shipped `web-runtime` row's config, read from this bundle's patch file. */
function shippedWebRuntimeConfig(): Record<string, unknown> {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), {
    schema: entryListSchema,
  })
  if (!Array.isArray(parsed)) throw new TypeError('web-app patch must parse to a patch list')
  const insert = (parsed as { insert?: { id?: string; config?: Record<string, unknown> }[] }[]).flatMap(
    patch => patch.insert ?? [],
  )
  const row = insert.find(entry => entry.id === 'web-runtime')
  if (row === undefined) throw new Error('web-app patch must mount the web-runtime row')
  return row.config ?? {}
}

describe('globalImage flag service', () => {
  it('provides globalImage false by default', async () => {
    stageDist()
    const ctx = new Context()
    // Omit `globalImage` so the assertion proves the schema's `z.boolean().default(false)`,
    // not an explicit value. The static `z<Config>` input type requires the key, so cast the
    // literal to let the runtime zod validation supply the default.
    await mountWebApp(ctx, new webApp.Config({
      printUrl: false,
      surfaceContext: false,
      trustedHosts: [] as string[],
    } as unknown as webApp.Config))
    expect(ctx.get('globalImage')).toBe(false)
    // Disposal removes the service: the registry entry is torn down with the fiber.
    await ctx.fiber.dispose()
    expect(ctx.get('globalImage')).toBeUndefined()
  })

  it('ships globalImage true in the web-runtime patch row and provides it on apply', async () => {
    stageDist()
    const rowConfig = shippedWebRuntimeConfig()
    // The shipped `web-runtime` row enables the capability by default, so
    // `dsh --profile web` (the desktop and browser surface) turns it on and a
    // later user patch layer can turn it off.
    expect(rowConfig['globalImage']).toBe(true)
    const ctx = new Context()
    await mountWebApp(ctx, new webApp.Config({
      printUrl: false,
      surfaceContext: false,
      trustedHosts: [] as string[],
      globalImage: rowConfig['globalImage'] as boolean,
    }))
    expect(ctx.get('globalImage')).toBe(true)
    await ctx.fiber.dispose()
  })
})
