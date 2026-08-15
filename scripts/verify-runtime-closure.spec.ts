/** Closure diagnostics: runtimeName-derived messages, apps/* discovery, manifest + count. */

import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatClosureSuccess, verifyRuntimeClosure } from './verify-runtime-closure.ts'

/**
 * Build a temporary throwaway repository with the given package manifests.
 * @param manifests - repository-relative path to a manifest JSON body.
 * @returns the temporary repository root (callers remove it).
 */
async function makeRepository(manifests: Record<string, object>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'closure-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.0-rc.5', private: true }))
  for (const [relative, manifest] of Object.entries(manifests)) {
    const path = join(root, relative)
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    await writeFile(join(root, relative), JSON.stringify(manifest))
  }
  return root
}

describe('verify-runtime-closure diagnostics', () => {
  it('derives the missing-peer error prefix from the runtime manifest name', async () => {
    const root = await makeRepository({
      'apps/desktop/package.json': {
        name: '@deepseek-ai/dsh-desktop',
        version: '0.1.0-rc.5',
        dependencies: { '@deepseek-ai/dsh': 'workspace:^' },
      },
      'packages/a/dsh/package.json': {
        name: '@deepseek-ai/dsh',
        version: '0.1.0-rc.5',
        peerDependencies: { '@deepseek-ai/dsh-missing-peer': '*' },
      },
      'packages/a/missing-peer/package.json': { name: '@deepseek-ai/dsh-missing-peer', version: '0.1.0-rc.5' },
    })
    try {
      let thrown: unknown
      try {
        await verifyRuntimeClosure(root, 'apps/desktop/package.json')
      } catch (caught) {
        thrown = caught
      }
      expect(thrown).toBeInstanceOf(Error)
      const error = thrown as Error
      expect(error.message).toContain('required workspace peers are missing from @deepseek-ai/dsh-desktop dependencies:')
      expect(error.message).toContain('@deepseek-ai/dsh -> @deepseek-ai/dsh-missing-peer')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('discovers workspace packages under apps/ as members of the closure', async () => {
    const root = await makeRepository({
      'apps/desktop/package.json': {
        name: '@deepseek-ai/dsh-desktop',
        version: '0.1.0-rc.5',
        dependencies: { '@deepseek-ai/dsh': 'workspace:^' },
      },
      'apps/web/package.json': { name: '@deepseek-ai/dsh-web-frontend', version: '0.1.0-rc.5' },
      'packages/a/dsh/package.json': {
        name: '@deepseek-ai/dsh',
        version: '0.1.0-rc.5',
        dependencies: { '@deepseek-ai/dsh-web-frontend': 'workspace:^' },
      },
    })
    try {
      // The @deepseek-ai/dsh-web-frontend dependency lives under apps/, so the
      // closure only counts it if apps/ participates in workspace discovery.
      const result = await verifyRuntimeClosure(root, 'apps/desktop/package.json')
      expect(result.runtimeName).toBe('@deepseek-ai/dsh-desktop')
      expect(result.packageCount).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the manifest path and package count on success', async () => {
    const root = await makeRepository({
      'apps/desktop/package.json': {
        name: '@deepseek-ai/dsh-desktop',
        version: '0.1.0-rc.5',
        dependencies: { '@deepseek-ai/dsh': 'workspace:^' },
      },
      'packages/a/dsh/package.json': { name: '@deepseek-ai/dsh', version: '0.1.0-rc.5' },
    })
    try {
      const result = await verifyRuntimeClosure(root, 'apps/desktop/package.json')
      expect(result.packageCount).toBe(1)
      const message = formatClosureSuccess(result)
      expect(message).toContain('apps/desktop/package.json')
      expect(message).toContain('1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
