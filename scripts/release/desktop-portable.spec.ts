/** Desktop portable archive assembly: node carrier, staging, scans, and zip determinism. */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildVersionJson,
  createZipArchive,
  downloadNodeArchive,
  isExcludedArtifact,
  loadNodeCarrier,
  parseChecksums,
  planPortableBuild,
  REPO_ROOT,
  readZipEntries,
  resolveNodeArtifacts,
  scanStagedArtifacts,
  sha256Hex,
  verifySha256Against,
} from './build-desktop-portable.ts'

const VERSION = '0.1.0-rc.5'

/** Write a file, creating parents, with portability across separators. */
async function write(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** A throwaway temp root for a fixture. */
async function makeDir(): Promise<{ dir: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-portable-'))
  return { dir, root: join(dir, 'repo') }
}

async function teardown(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

describe('node carrier pin', () => {
  it('reads the pinned node carrier from desktop-node.json', async () => {
    const fixture = await makeDir()
    try {
      await write(
        join(fixture.root, 'scripts/release/desktop-node.json'),
        JSON.stringify({ version: 'v24.11.1', archive: 'node-v24.11.1-win-x64.zip', baseUrl: 'https://nodejs.org/dist/v24.11.1' }),
      )
      expect(loadNodeCarrier(fixture.root)).toEqual({
        version: 'v24.11.1',
        archive: 'node-v24.11.1-win-x64.zip',
        baseUrl: 'https://nodejs.org/dist/v24.11.1',
      })
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('reads the committed carrier from the repository root', async () => {
    const carrier = loadNodeCarrier(REPO_ROOT)
    expect(carrier.version).toBe('v24.11.1')
    expect(carrier.archive).toBe('node-v24.11.1-win-x64.zip')
  })
})

describe('shasums parsing', () => {
  const ARCHIVE = 'node-v24.11.1-win-x64.zip'
  const DIGEST = 'a'.repeat(64)

  it('returns the single digest for the archive', () => {
    expect(parseChecksums(`${DIGEST}  ${ARCHIVE}\nother  other.zip\n`, ARCHIVE)).toBe(DIGEST)
  })

  it('rejects a checksum file with duplicate archive lines', () => {
    expect(() =>
      parseChecksums(
        `${DIGEST}  ${ARCHIVE}\n${'b'.repeat(64)}  ${ARCHIVE}\n`,
        ARCHIVE,
      ),
    ).toThrow(/exactly one/)
  })

  it('rejects a checksum file with no archive line', () => {
    expect(() => parseChecksums(`${DIGEST}  other.zip\n`, ARCHIVE)).toThrow(/exactly one checksum line/)
  })
})

describe('sha-256 verification', () => {
  it('accepts a matching digest', () => {
    const data = Buffer.from('payload')
    const digest = sha256Hex(data)
    expect(() => { verifySha256Against(data, digest) }).not.toThrow()
  })

  it('rejects a wrong checksum with a clear message', () => {
    expect(() => { verifySha256Against(Buffer.from('payload'), 'a'.repeat(64)) }).toThrow(/does not match/)
  })
})

describe('node archive download', () => {
  it('fails loud on an offline download', async () => {
    const fixture = await makeDir()
    try {
      const cache = join(fixture.dir, 'cache')
      const failingFetch = (async () => {
        throw new Error('network unreachable')
      }) as typeof fetch
      await expect(
        downloadNodeArchive(
          { version: 'v24.11.1', archive: 'node-v24.11.1-win-x64.zip', baseUrl: 'https://nodejs.org/dist/v24.11.1' },
          cache,
          failingFetch,
        ),
      ).rejects.toThrow(/download failed|fetch failed/)
    } finally {
      await teardown(fixture.dir)
    }
  })
})

describe('node artifact extraction', () => {
  it('extracts node.exe and LICENSE from a carrier zip', async () => {
    const fixture = await makeDir()
    try {
      const stageNode = join(fixture.dir, 'stage/node')
      const zip = createZipArchive([
        { name: 'node-v24.11.1-win-x64/LICENSE', data: Buffer.from('node license\n') },
        { name: 'node-v24.11.1-win-x64/node.exe', data: Buffer.from('exe') },
      ], 0)
      const zipPath = join(fixture.dir, 'node.zip')
      await writeFile(zipPath, zip)
      const result = await resolveNodeArtifacts(zipPath, stageNode)
      expect(result.nodeExe).toBe(join(stageNode, 'node.exe'))
      expect(result.license).toBe(join(stageNode, 'LICENSE'))
      await expect(readFile(join(stageNode, 'node.exe'), 'utf8')).resolves.toBe('exe')
      await expect(readFile(join(stageNode, 'LICENSE'), 'utf8')).resolves.toBe('node license\n')
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('rejects a carrier zip missing node.exe', async () => {
    const fixture = await makeDir()
    try {
      const stageNode = join(fixture.dir, 'stage/node')
      const zip = createZipArchive([
        { name: 'node-v24.11.1-win-x64/LICENSE', data: Buffer.from('node license\n') },
      ], 0)
      const zipPath = join(fixture.dir, 'node.zip')
      await writeFile(zipPath, zip)
      await expect(resolveNodeArtifacts(zipPath, stageNode)).rejects.toThrow(/node\.exe/)
    } finally {
      await teardown(fixture.dir)
    }
  })
})

describe('portable build plan', () => {
  it('orders the tauri no-bundle exe build and the runtime build', () => {
    expect(planPortableBuild({ package: '@deepseek-ai/dsh-desktop', runtimeStage: 'dist/desktop/runtime' })).toEqual([
      {
        command: process.execPath,
        args: [
          'apps/desktop/node_modules/@tauri-apps/cli/tauri.js',
          'build',
          '--no-bundle',
          '--config',
          'apps/desktop/src-tauri/tauri.conf.json',
        ],
      },
      { command: 'pnpm', args: ['run', 'desktop:runtime', '--', '--out', 'dist/desktop/runtime'] },
    ])
  })
})

describe('msvc toolchain pin', () => {
  it('pins the MSVC host toolchain for tauri builds on Windows', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/release/build-desktop-portable.ts'), 'utf8')
    expect(source).toContain("RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc'")
    expect(source).toContain("process.platform === 'win32'")
  })
})

describe('deterministic version metadata', () => {
  it('renders VERSION.json with generated inputs substituted', () => {
    const version = buildVersionJson({
      dshVersion: VERSION,
      gitCommit: 'a'.repeat(40),
      nodeVersion: 'v24.11.1',
      buildTime: '2026-01-01T00:00:00.000Z',
    })
    expect(version).toEqual({
      product: 'deepseek-harness-desktop',
      dshVersion: VERSION,
      gitCommit: 'a'.repeat(40),
      nodeVersion: 'v24.11.1',
      desktopProtocol: 1,
      target: 'windows-x64',
      buildTime: '2026-01-01T00:00:00.000Z',
    })
  })
})

describe('deterministic zip writer', () => {
  it('produces identical bytes for identical inputs regardless of entry order', () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('a') },
      { name: 'b/c.txt', data: Buffer.from('c') },
      { name: 'DeepSeek Harness.exe', data: Buffer.from('exe') },
    ]
    const sorted = entries.toSorted((l, r) => l.name.localeCompare(r.name))
    expect(createZipArchive(entries, 1_700_000_000)).toEqual(
      createZipArchive(sorted, 1_700_000_000),
    )
  })

  it('honors the fixed timestamp so repeated builds share the same bytes', () => {
    const entries = [{ name: 'a.txt', data: Buffer.from('a') }]
    expect(createZipArchive(entries, 1)).toEqual(createZipArchive(entries, 1))
    // Different post-1980 epochs (>= 2 s apart at DOS time resolution) differ.
    expect(createZipArchive(entries, 1_700_000_000_000)).not.toEqual(
      createZipArchive(entries, 1_700_000_030_000),
    )
  })

  it('emits a valid ZIP that readZipEntries round-trips', () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'b/c.txt', data: Buffer.from('world') },
    ]
    const bytes = createZipArchive(entries, 1_700_000_000_000)
    const text = bytes.toString('latin1')
    // The 22-byte end-of-central-directory record is the trailer.
    expect(text.slice(-22, -18)).toBe('PK\u0005\u0006')
    // Every member round-trips through the reader.
    const read = readZipEntries(bytes)
    expect(read.get('a.txt')?.toString()).toBe('hello')
    expect(read.get('b/c.txt')?.toString()).toBe('world')
  })
})

describe('portable staging artifact scans', () => {
  it('excludes source maps from staged artifacts', () => {
    expect(isExcludedArtifact('chunk.js.map')).toBe(true)
    expect(isExcludedArtifact('index.d.ts.map')).toBe(true)
    expect(isExcludedArtifact('runtime.js')).toBe(false)
    expect(isExcludedArtifact('node.exe')).toBe(false)
  })

  it('accepts a clean staged layout', async () => {
    const fixture = await makeDir()
    try {
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'DeepSeek Harness.exe'), 'exe')
      await write(join(stage, 'README.txt'), 'readme')
      await write(join(stage, 'LICENSE'), 'license')
      await write(join(stage, 'THIRD_PARTY_NOTICES.txt'), 'notices')
      await write(join(stage, 'VERSION.json'), JSON.stringify(buildVersionJson({
        dshVersion: VERSION,
        gitCommit: 'a'.repeat(40),
        nodeVersion: 'v24.11.1',
        buildTime: '2026-01-01T00:00:00.000Z',
      })))
      await write(join(stage, 'node/node.exe'), 'exe')
      await write(join(stage, 'node/LICENSE'), 'license')
      await write(join(stage, 'runtime/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: VERSION }))
      await write(join(stage, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'), '#!/usr/bin/env node\n')
      await write(
        join(stage, 'runtime/node_modules/@deepseek-ai/dsh/package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }),
      )
      await expect(
        scanStagedArtifacts(stage, {
          checkoutRoot: join(fixture.root, '..', 'root'),
          expectedDshVersion: VERSION,
        }),
      ).resolves.toBeUndefined()
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('rejects staged text containing the checkout root', async () => {
    const fixture = await makeDir()
    try {
      const root = join(fixture.dir, 'checkout')
      await write(join(root, 'apps/desktop/package.json'), '{}')
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'README.txt'), `${root}\\apps\\desktop`)
      await write(join(stage, 'runtime/package.json'), '{}')
      await expect(
        scanStagedArtifacts(stage, { checkoutRoot: root, expectedDshVersion: VERSION }),
      ).rejects.toThrow(/README\.txt/)
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('rejects staged text containing %USERPROFILE%', async () => {
    const fixture = await makeDir()
    try {
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'README.txt'), 'path is %USERPROFILE%\\x')
      await write(join(stage, 'runtime/package.json'), '{}')
      await expect(
        scanStagedArtifacts(stage, { checkoutRoot: join(fixture.dir, 'workspace'), expectedDshVersion: VERSION }),
      ).rejects.toThrow(/USERPROFILE/)
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('rejects a staged config-document secret assignment (credentials contents)', async () => {
    const fixture = await makeDir()
    try {
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'README.txt'), 'readme')
      await write(join(stage, 'runtime/package.json'), '{}')
      await write(join(stage, 'runtime/node_modules/leaked.yaml'), 'DEEPSEEK_API_KEY: sk-secret123\n')
      await expect(
        scanStagedArtifacts(stage, { checkoutRoot: join(fixture.dir, 'workspace'), expectedDshVersion: VERSION }),
      ).rejects.toThrow(/leaked\.yaml/)
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('rejects a forbidden .env / .credentials.yaml filename anywhere in the stage', async () => {
    const fixture = await makeDir()
    try {
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'README.txt'), 'readme')
      await write(join(stage, 'runtime/package.json'), '{}')
      await write(join(stage, 'runtime/node_modules/.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-secret123\n')
      await expect(
        scanStagedArtifacts(stage, { checkoutRoot: join(fixture.dir, 'workspace'), expectedDshVersion: VERSION }),
      ).rejects.toThrow(/forbidden secret\/config filename/)
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('does not flag a secret-named assignment in library source code', async () => {
    const fixture = await makeDir()
    try {
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'DeepSeek Harness.exe'), 'exe')
      await write(join(stage, 'README.txt'), 'readme')
      await write(join(stage, 'LICENSE'), 'license')
      await write(join(stage, 'THIRD_PARTY_NOTICES.txt'), 'notices')
      await write(join(stage, 'VERSION.json'), '{}')
      await write(join(stage, 'node/node.exe'), 'exe')
      await write(join(stage, 'node/LICENSE'), 'license')
      await write(join(stage, 'runtime/package.json'), '{}')
      await write(
        join(stage, 'runtime/node_modules/@deepseek-ai/dsh/package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }),
      )
      await write(
        join(stage, 'runtime/node_modules/@deepseek-ai/dsh/lib/api.js'),
        'export const cfg = { accessToken: process.env.DEEPSEEK_API_KEY }\n',
      )
      await expect(
        scanStagedArtifacts(stage, { checkoutRoot: join(fixture.dir, 'workspace'), expectedDshVersion: VERSION }),
      ).resolves.toBeUndefined()
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('rejects staged text with the prototype patch marker', async () => {
    const fixture = await makeDir()
    try {
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'runtime/package.json'), '{}')
      await write(join(stage, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'), '// [dsh-patch:global-image]\n')
      await expect(
        scanStagedArtifacts(stage, { checkoutRoot: join(fixture.dir, 'workspace'), expectedDshVersion: VERSION }),
      ).rejects.toThrow(/bin\.js/)
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('rejects a staged runtime CLI whose version differs from the source (npm prototype)', async () => {
    const fixture = await makeDir()
    try {
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'README.txt'), 'readme')
      await write(join(stage, 'runtime/package.json'), '{}')
      await write(
        join(stage, 'runtime/node_modules/@deepseek-ai/dsh/package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' }),
      )
      await expect(
        scanStagedArtifacts(stage, { checkoutRoot: join(fixture.dir, 'workspace'), expectedDshVersion: VERSION }),
      ).rejects.toThrow(/0\.1\.0-rc\.6/)
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('rejects a staged file outside the allowlist', async () => {
    const fixture = await makeDir()
    try {
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'README.txt'), 'readme')
      await write(join(stage, 'runtime/package.json'), '{}')
      await write(join(stage, 'leaked.txt'), 'nope')
      await expect(
        scanStagedArtifacts(stage, { checkoutRoot: join(fixture.dir, 'workspace'), expectedDshVersion: VERSION }),
      ).rejects.toThrow(/leaked\.txt/)
    } finally {
      await teardown(fixture.dir)
    }
  })

  it('rejects a staged symbolic link', async () => {
    const fixture = await makeDir()
    try {
      const stage = join(fixture.dir, 'stage')
      await write(join(stage, 'README.txt'), 'readme')
      await write(join(stage, 'runtime/package.json'), '{}')
      // A junction (Windows) or symlink (elsewhere) inside node_modules.
      const { symlink } = await import('node:fs/promises')
      const kind = process.platform === 'win32' ? 'junction' as const : 'dir' as const
      await mkdir(join(stage, 'runtime/node_modules'), { recursive: true })
      await mkdir(join(fixture.dir, 'external'), { recursive: true })
      await symlink(join(fixture.dir, 'external'), join(stage, 'runtime/node_modules/leaked'), kind)
      await expect(
        scanStagedArtifacts(stage, { checkoutRoot: join(fixture.dir, 'workspace'), expectedDshVersion: VERSION }),
      ).rejects.toThrow(/leaked/)
    } finally {
      await teardown(fixture.dir)
    }
  })
})
