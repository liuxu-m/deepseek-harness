/**
 * Desktop runtime identity route: GET-only non-sensitive identity JSON, method
 * rejection, no absolute-home disclosure, DSH_HOME home-kind classification,
 * and (HMR safety) removal of the exact route on fiber disposal.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import {
  DSH_RUNTIME_IDENTITY_PATH,
  internals,
  parseHomeKind,
  readPackageVersion,
  registerRuntimeIdentity,
  runtimeIdentity,
} from '../src/runtime-identity.ts'

/** One deterministic identity fixture shared by the response tests. */
interface Fixture {
  version: string
  instanceId: string
  /** When set, pins the seam to this kind; when omitted, reads the real `$DSH_HOME`. */
  homeKind?: 'default' | 'custom'
}

const defaultFixture: Fixture = {
  version: '0.1.0-test',
  instanceId: '7b7da8bb-4e74-4660-b324-6df099d101ea',
  homeKind: 'default',
}

/** A minimal captured HTTP response usable by the assertions. */
interface ResponseFixture {
  status: number | undefined
  headers: Record<string, string>
  body: string
}

const originalInternals = { ...internals }
const originalDshHome = process.env.DSH_HOME

afterEach(() => {
  internals.instanceId = originalInternals.instanceId
  internals.readVersion = originalInternals.readVersion
  internals.homeKind = originalInternals.homeKind
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

/**
 * Register the real identity route against a capture webserver and return the
 * registered handler (the same handler production mounts) plus its disposer.
 */
function captureRuntimeIdentityRoute(fixture: Fixture): { route: WebRoute; dispose: () => Promise<void> } {
  const ctx = new Context()
  let route: WebRoute | undefined
  ctx.provide('webServer', {
    register: (registered: WebRoute) => {
      route = registered
      return () => { if (route === registered) route = undefined }
    },
  } as unknown as WebServer)
  internals.instanceId = fixture.instanceId
  internals.readVersion = () => fixture.version
  if (fixture.homeKind !== undefined) internals.homeKind = () => fixture.homeKind
  registerRuntimeIdentity(ctx)
  return {
    route: route!,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/** Invoke one captured handler with a fake request/response pair. */
async function invoke(captured: { route: WebRoute }, init: { method: string }): Promise<ResponseFixture> {
  const headers: Record<string, string> = {}
  let status: number | undefined
  let body = ''
  const res = {
    writeHead: (code: number, extra?: Record<string, string>) => {
      status = code
      if (extra !== undefined) Object.assign(headers, extra)
      return res
    },
    end: (chunk?: string) => { if (chunk !== undefined) body += chunk },
  } as unknown as ServerResponse
  await captured.route.handler({ method: init.method } as IncomingMessage, res)
  return { status, headers, body }
}

describe('runtime identity route', () => {
  it('serves a non-sensitive identity to GET only', async () => {
    const route = captureRuntimeIdentityRoute(defaultFixture)
    const response = await invoke(route, { method: 'GET' })
    expect(response.status).toBe(200)
    expect(response.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    expect(response.headers.allow).toBeUndefined()
    expect(JSON.parse(response.body)).toEqual({
      product: 'deepseek-harness',
      desktopProtocol: 1,
      version: '0.1.0-test',
      instanceId: '7b7da8bb-4e74-4660-b324-6df099d101ea',
      homeKind: 'default',
    })
    expect(response.body).not.toContain(process.env.USERPROFILE ?? '')
  })

  it.each(['POST', 'PUT', 'DELETE'] as const)('rejects %s', async (method) => {
    const response = await invoke(captureRuntimeIdentityRoute(defaultFixture), { method })
    expect(response.status).toBe(405)
    expect(response.headers.allow).toBe('GET')
  })

  it('classifies an overridden DSH_HOME as a custom home', async () => {
    const customHome = mkdtempSync(join(tmpdir(), 'dsh-runtime-id-home-'))
    process.env.DSH_HOME = customHome
    // No homeKind in the fixture: the real env-driven seam classification applies.
    const response = await invoke(captureRuntimeIdentityRoute({
      version: '0.1.0-test',
      instanceId: 'f2c78671-19f3-4fb9-a298-e19e0c0ee7f4',
    }), { method: 'GET' })
    expect((JSON.parse(response.body) as { homeKind: string }).homeKind).toBe('custom')
    expect(response.body).not.toContain(process.env.USERPROFILE ?? '')
    expect(response.body).not.toContain(customHome)
  })

  it('proves fiber disposal removes the exact registered route', async () => {
    const ctx = new Context()
    const registered = new Set<string>()
    ctx.provide('webServer', {
      register: (route: WebRoute) => {
        registered.add(route.path)
        return () => { registered.delete(route.path) }
      },
    } as unknown as WebServer)
    registerRuntimeIdentity(ctx)
    expect(registered.has(DSH_RUNTIME_IDENTITY_PATH)).toBe(true)
    await ctx.fiber.dispose()
    expect(registered.has(DSH_RUNTIME_IDENTITY_PATH)).toBe(false)
  })
})

describe('identity classification', () => {
  it('reports this checkout as default when DSH_HOME is absent', () => {
    delete process.env.DSH_HOME
    expect(parseHomeKind()).toBe('default')
  })

  it('reports a custom home when DSH_HOME differs from the default', () => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-diff-home-'))
    expect(parseHomeKind()).toBe('custom')
  })

  it('materializes identity through the real default seams', () => {
    delete process.env.DSH_HOME
    const id = runtimeIdentity()
    expect(id.version.length).toBeGreaterThan(0)
    expect(id.instanceId).toBeTypeOf('string')
    expect(id.homeKind).toBe('default')
  })
})

describe('package version reader', () => {
  it('reads the non-empty version from a manifest', () => {
    const manifest = mkdtempSync(join(tmpdir(), 'dsh-version-'))
    const path = join(manifest, 'package.json')
    writeFileSync(path, JSON.stringify({ version: '1.2.3' }))
    expect(readPackageVersion(path)).toBe('1.2.3')
  })

  it('reads the bundle version through the default manifest location', () => {
    expect(readPackageVersion()).toBeTypeOf('string')
  })

  it('fails loud on a manifest with an empty or missing version', () => {
    const manifest = mkdtempSync(join(tmpdir(), 'dsh-version-'))
    const path = join(manifest, 'package.json')
    writeFileSync(path, JSON.stringify({ version: '' }))
    expect(() => readPackageVersion(path)).toThrow(/version/)
  })
})
