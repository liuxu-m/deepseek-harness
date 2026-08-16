/** Deploy plan and post-deploy staged-runtime validation for the desktop closure. */

import { describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { materializeStagedLinks, planDesktopRuntime, REPO_ROOT, restoreLegacyHoists, validateDeployedRuntime } from './build-desktop-runtime.ts'

const VERSION = '0.1.0-rc.5'

/** A clean repository plus a staged deploy layout the validator can read. */
async function makeFixture(): Promise<{ root: string; stage: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-runtime-'))
  const root = join(dir, 'repo')
  const stage = join(dir, 'stage')
  const write = (path: string, content: string) => {
    // `dirname` keeps the fixture portable: `join()` yields `/` separators on
    // POSIX and `\` on Windows, so a literal backslash split would mis-parent.
    return mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, content))
  }
  await write(
    join(root, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-root', version: VERSION, private: true }),
  )
  await write(
    join(root, 'apps/cli/package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION, bin: { dsh: 'lib/bin.js' } }),
  )
  await write(join(stage, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '#!/usr/bin/env node\n')
  await write(
    join(stage, 'node_modules/@deepseek-ai/dsh/package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }, null, 2) + '\n',
  )
  await write(join(stage, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'), '<html></html>\n')
  await write(join(stage, 'node_modules/node-pty/prebuilds/win32-x64/pty.node'), '<bin>\ufeff')
  return { root, stage, dir }
}

/** Remove the temporary fixture created with {@link makeFixture}. */
async function teardownFixture(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Create a directory link (junction on Windows, symlink elsewhere) without admin privileges. */
async function createDirLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

describe('desktop runtime deploy plan', () => {
  it('orders build, closure verification, then a production desktop deploy', () => {
    const stage = 'C:/repo/dist/desktop/runtime'
    expect(planDesktopRuntime({ stage })).toEqual([
      { command: 'pnpm', args: ['run', 'build'] },
      { command: 'pnpm', args: ['run', 'verify-runtime-closure', '--manifest', 'apps/desktop/package.json'] },
      {
        command: 'pnpm',
        args: [
          '--filter', '@deepseek-ai/dsh-desktop',
          'deploy', '--legacy', '--prod',
          '--config.node-linker=hoisted',
          '--config.auto-install-peers=false',
          '--config.link-workspace-packages=true',
          stage,
        ],
      },
    ])
  })

  it('resolves the repository root two levels above scripts/release', async () => {
    // The script lives at scripts/release/, so a single `..` would land in
    // scripts/ and restore/validate would look in the wrong deploy source.
    await expect(readFile(join(REPO_ROOT, 'apps/desktop/package.json'), 'utf8')).resolves.toContain('@deepseek-ai/dsh-desktop')
  })
})

describe('desktop runtime post-deploy validation', () => {
  it('accepts a staged runtime carrying every required artifact at matching versions', async () => {
    const fixture = await makeFixture()
    try {
      await expect(validateDeployedRuntime(fixture.root, fixture.stage)).resolves.toBeUndefined()
    } finally {
      await teardownFixture(fixture.dir)
    }
  })

  it('rejects a missing CLI bin with the repository-relative path', async () => {
    const fixture = await makeFixture()
    await rm(join(fixture.stage, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
    try {
      await expect(validateDeployedRuntime(fixture.root, fixture.stage)).rejects.toThrow(
        /node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js/,
      )
    } finally {
      await teardownFixture(fixture.dir)
    }
  })

  it('rejects a staged runtime version that differs from the repository and CLI', async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.stage, 'node_modules/@deepseek-ai/dsh/package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' }, null, 2) + '\n',
    )
    try {
      await expect(validateDeployedRuntime(fixture.root, fixture.stage)).rejects.toThrow(/version mismatch/)
    } finally {
      await teardownFixture(fixture.dir)
    }
  })

  it('rejects a staged text artifact carrying the prototype patch marker', async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.stage, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      '// [dsh-patch:global-image]\n',
    )
    try {
      await expect(validateDeployedRuntime(fixture.root, fixture.stage)).rejects.toThrow(
        /node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js/,
      )
    } finally {
      await teardownFixture(fixture.dir)
    }
  })

  it('rejects a staged runtime that still contains a link', async () => {
    const fixture = await makeFixture()
    const realDir = join(fixture.dir, 'real-content')
    await mkdir(realDir, { recursive: true })
    const staged = join(fixture.stage, 'node_modules/@deepseek-ai/leaked')
    await mkdir(join(fixture.stage, 'node_modules/@deepseek-ai'), { recursive: true })
    await createDirLink(realDir, staged)
    try {
      await expect(validateDeployedRuntime(fixture.root, fixture.stage)).rejects.toThrow(
        /node_modules\/@deepseek-ai\/leaked/,
      )
    } finally {
      await teardownFixture(fixture.dir)
    }
  })
})

describe('staged link materialization', () => {
  it('replaces every directory link with a real copy of its target', async () => {
    const fixture = await makeFixture()
    const sourceDir = join(fixture.dir, 'linked-source')
    await mkdir(join(sourceDir, 'nested'), { recursive: true })
    await writeFile(join(sourceDir, 'nested', 'payload.txt'), 'payload')
    const staged = join(fixture.stage, 'node_modules/@deepseek-ai/dsh-web-frontend', 'dist', 'redirected')
    await mkdir(join(fixture.stage, 'node_modules/@deepseek-ai/dsh-web-frontend/dist'), { recursive: true })
    await createDirLink(sourceDir, staged)
    try {
      await materializeStagedLinks(fixture.stage)
      const materialized = await lstat(staged)
      expect(materialized.isSymbolicLink()).toBe(false)
      expect(materialized.isDirectory()).toBe(true)
      await expect(readFile(join(staged, 'nested', 'payload.txt'), 'utf8')).resolves.toBe('payload')
    } finally {
      await teardownFixture(fixture.dir)
    }
  })

  it('deletes a linked `.bin` directory instead of copying its cyclic targets', async () => {
    const fixture = await makeFixture()
    const binDir = join(fixture.dir, 'bin-source')
    await mkdir(join(binDir, 'tool'), { recursive: true })
    const stagedBin = join(fixture.stage, 'node_modules/.bin')
    await mkdir(fixture.stage, { recursive: true })
    await createDirLink(binDir, stagedBin)
    try {
      await materializeStagedLinks(fixture.stage)
      await expect(lstat(stagedBin)).rejects.toThrow()
    } finally {
      await teardownFixture(fixture.dir)
    }
  })
})

describe('legacy deploy hoist restore', () => {
  it('copies a missing direct dependency from the deploy root node_modules', async () => {
    const fixture = await makeFixture()
    // The staged manifest declares a dependency the legacy deploy dropped.
    await writeFile(
      join(fixture.stage, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: VERSION, dependencies: { '@deepseek-ai/cosmokit': 'workspace:^' } }, null, 2) + '\n',
    )
    const source = join(fixture.root, 'apps/desktop/node_modules/@deepseek-ai/cosmokit')
    await mkdir(join(source, 'lib'), { recursive: true })
    await writeFile(join(source, 'lib/index.js'), 'export const answer = 42\n')
    try {
      await restoreLegacyHoists(fixture.root, fixture.stage)
      await expect(
        readFile(join(fixture.stage, 'node_modules/@deepseek-ai/cosmokit/lib/index.js'), 'utf8'),
      ).resolves.toBe('export const answer = 42\n')
    } finally {
      await teardownFixture(fixture.dir)
    }
  })

  it('skips the source package nested node_modules so cyclic self-links never recurse', async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.stage, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: VERSION, dependencies: { '@deepseek-ai/dsh': 'workspace:^' } }, null, 2) + '\n',
    )
    // The stage already carries a fake `dsh` from makeFixture; drop it so the
    // restore path actually runs against the deploy-root source below.
    await rm(join(fixture.stage, 'node_modules/@deepseek-ai/dsh'), { recursive: true, force: true })
    const source = join(fixture.root, 'apps/desktop/node_modules/@deepseek-ai/dsh')
    await mkdir(join(source, 'lib'), { recursive: true })
    await writeFile(join(source, 'lib/bin.js'), '#!/usr/bin/env node\n')
    // A real package whose nested node_modules links back to itself, like the
    // CLI's `node_modules/@deepseek-ai/dsh` junction. Restore must not descend
    // into it, so the copy cannot loop forever.
    const nestedNodeModules = join(source, 'node_modules')
    await mkdir(join(nestedNodeModules, '@deepseek-ai'), { recursive: true })
    await createDirLink(source, join(nestedNodeModules, '@deepseek-ai', 'dsh'))
    try {
      await restoreLegacyHoists(fixture.root, fixture.stage)
      const staged = join(fixture.stage, 'node_modules/@deepseek-ai/dsh')
      await expect(readFile(join(staged, 'lib/bin.js'), 'utf8')).resolves.toBe('#!/usr/bin/env node\n')
      // Nested node_modules is skipped, leaving one flat stage closure.
      await expect(readFile(join(staged, 'node_modules'), 'utf8')).rejects.toThrow()
    } finally {
      await teardownFixture(fixture.dir)
    }
  })

  it('reports a dependency absent from both the stage and the deploy root', async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.stage, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: VERSION, dependencies: { '@deepseek-ai/absent': 'workspace:^' } }, null, 2) + '\n',
    )
    try {
      await expect(restoreLegacyHoists(fixture.root, fixture.stage)).rejects.toThrow(
        /@deepseek-ai\/absent is absent from both/,
      )
    } finally {
      await teardownFixture(fixture.dir)
    }
  })
})
