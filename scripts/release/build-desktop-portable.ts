/**
 * Assemble the portable Windows archive: build the Tauri executable and the
 * runtime closure (or reuse already-built ones), verify and extract the pinned
 * Node carrier, stage the exact portable layout, scan it for leaks, write
 * deterministic provenance metadata, and emit a deterministic ZIP plus a
 * SHA-256 file.
 *
 * Pure helpers (carrier parsing, checksums, the ZIP writer/reader, the build
 * plan, version assembly, and the artifact scans) are separated from the thin
 * entry orchestrator guarded by {@link isEntry} so the beside test can exercise
 * them without running the pipeline.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { capture, isEntry } from './process.ts'

/** The desktop workspace package that owns the Tauri shell and runtime. */
const DESKTOP_PACKAGE = '@deepseek-ai/dsh-desktop'
/** The CLI workspace package that carries the bundled `dsh` binary. */
const CLI_PACKAGE = '@deepseek-ai/dsh'
/** Default portable stage directory (`--stage` overrides). */
const DEFAULT_STAGE = 'dist/desktop/stage'
/** Default cache directory for the downloaded node carrier (`--cache` overrides). */
const DEFAULT_CACHE = 'dist/desktop/cache'
/** Default output directory for the ZIP and SHA-256 (`--out` overrides). */
const DEFAULT_OUTPUT = 'dist/desktop/output'
/** Default runtime closure directory (`--runtime` overrides). */
const DEFAULT_RUNTIME = 'dist/desktop/runtime'
/** The Tauri executable built by `tauri build --no-bundle`, repo-relative. */
const DEFAULT_EXE = 'apps/desktop/src-tauri/target/release/deepseek-harness-desktop.exe'
/** Repository-relative carrier pin. */
const NODE_CARRIER_REL = 'scripts/release/desktop-node.json'
/** The display name the portable layout gives the built executable. */
const PORTABLE_EXE_NAME = 'DeepSeek Harness.exe'
/** The prototype replay marker that must never reach the shipped archive. */
const PATCH_MARKER = '[dsh-patch:global-image]'
/** Target platform recorded in VERSION.json and the archive filename. */
const DESKTOP_TARGET = 'windows-x64'
/** The desktop controller protocol version, bumped only on wire breaks. */
const DESKTOP_PROTOCOL = 1
/** The product identity recorded in VERSION.json. */
const PRODUCT = 'deepseek-harness-desktop'

/** Binary and source-map extensions skipped by the leak scan. */
const BINARY_EXTENSIONS = new Set([
  '.node', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2', '.ttf', '.eot', '.ico',
  '.exe', '.dll', '.wasm', '.zip', '.gz', '.pdb', '.map', '.icns', '.cur', '.pyc',
])
/** One text artifact is never larger than this, bounding the leak scan. */
const MAX_TEXT_SCAN_BYTES = 4 * 1024 * 1024

let commandRoot = process.cwd()

/** The repository root, two levels above `scripts/release/`. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

/** The pinned node carrier: version, archive filename, and base URL. */
export interface NodeCarrier {
  readonly version: string
  readonly archive: string
  readonly baseUrl: string
}

/** Synthetic inputs to {@link buildVersionJson}; the angle-bracketed plan values. */
export interface VersionInput {
  readonly dshVersion: string
  readonly gitCommit: string
  readonly nodeVersion: string
  readonly buildTime: string
}

/** One file to write into the deterministic ZIP. */
export interface ZipEntry {
  /** Archive-relative, `/`-separated path with no leading slash. */
  readonly name: string
  readonly data: Buffer
}

/**
 * Whether a staged artifact must never ship: source maps (`.map`) carry
 * absolute source paths and bloat the archive; the plan excludes them, along
 * with PDB, headers, and other debug artifacts.
 * @param name - the file basename or archive-relative name.
 */
export function isExcludedArtifact(name: string): boolean {
  return name.endsWith('.map')
}

/**
 * Read the pinned node carrier from `scripts/release/desktop-node.json`.
 * @param root - the repository root.
 * @returns the pinned version, archive, and base URL.
 */
export function loadNodeCarrier(root: string): NodeCarrier {
  const manifest = JSON.parse(readFileSync(join(root, NODE_CARRIER_REL), 'utf8')) as Record<string, unknown>
  const { version, archive, baseUrl } = manifest
  if (
    typeof version !== 'string' || version.length === 0
    || typeof archive !== 'string' || archive.length === 0
    || typeof baseUrl !== 'string' || baseUrl.length === 0
  ) {
    throw new Error(`build-desktop-portable: ${NODE_CARRIER_REL} must set version, archive, and baseUrl.`)
  }
  return { version, archive, baseUrl }
}

/**
 * Parse an official Node.js `SHASUMS256.txt` and require exactly one checksum
 * line for the named archive.
 * @param text - the complete checksum file contents.
 * @param archive - the archive filename to look up.
 * @returns the matching line's digest, lower-cased.
 */
export function parseChecksums(text: string, archive: string): string {
  const matches: string[] = []
  for (let line of text.split(/\r?\n/)) {
    line = line.trim()
    if (!line.endsWith(`  ${archive}`) && !line.endsWith(` *${archive}`)) continue
    const digest = line.slice(0, 64)
    if (digest.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(digest)) {
      throw new Error(`build-desktop-portable: checksum line for ${archive} does not carry a 64-hex digest.`)
    }
    matches.push(digest.toLowerCase())
  }
  if (matches.length !== 1) {
    throw new Error(`build-desktop-portable: expected exactly one checksum line for ${archive}, found ${matches.length}.`)
  }
  return String(matches[0])
}

/** Lower-case hex SHA-256 of a buffer. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Fail unless `data` hashes to `expectedHex` under SHA-256.
 * @param data - the downloaded artifact bytes.
 * @param expectedHex - the lower-case hex digest from the checksum file.
 */
export function verifySha256Against(data: Buffer, expectedHex: string): void {
  const actual = sha256Hex(data)
  if (actual !== expectedHex.toLowerCase()) {
    throw new Error(
      `build-desktop-portable: SHA-256 of the node archive (${actual.slice(0, 12)}…) does not match the pinned checksum (${expectedHex.slice(0, 12)}…).`,
    )
  }
}

/**
 * Download and verify the pinned Node archive, caching it under `cacheDir`
 * keyed by the carrier version. A cached archive that still verifies against
 * the freshly fetched checksum file is reused. Any network failure fails loud.
 * @param carrier - the pinned carrier.
 * @param cacheDir - the per-version cache directory.
 * @param fetchImpl - fetch implementation, injectable for hermetic tests.
 * @returns the verified cached archive path and its digest.
 */
export async function downloadNodeArchive(
  carrier: NodeCarrier,
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ zipPath: string; digest: string }> {
  await mkdir(cacheDir, { recursive: true })
  const zipPath = join(cacheDir, carrier.archive)
  const checksumsUrl = `${carrier.baseUrl}/SHASUMS256.txt`
  let checksumsText: string
  try {
    const checksumsResponse = await fetchImpl(checksumsUrl)
    if (!checksumsResponse.ok) {
      throw new Error(`HTTP ${checksumsResponse.status} fetching ${checksumsUrl}`)
    }
    checksumsText = await checksumsResponse.text()
  } catch (error) {
    throw new Error(`build-desktop-portable: node checksum download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const digest = parseChecksums(checksumsText, carrier.archive)
  if (existsSync(zipPath)) {
    const cached = await readFile(zipPath)
    if (sha256Hex(cached) === digest) {
      return { zipPath, digest }
    }
    await rm(zipPath)
  }
  let zipData: Buffer
  try {
    const response = await fetchImpl(`${carrier.baseUrl}/${carrier.archive}`)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${carrier.archive}`)
    }
    zipData = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new Error(`build-desktop-portable: node archive download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  verifySha256Against(zipData, digest)
  await writeFile(zipPath, zipData)
  return { zipPath, digest }
}

/**
 * Extract `node.exe` and its LICENSE from a carrier zip into `destNodeDir`,
 * failing loud when either is absent. Only these two members are copied, so
 * npm, Corepack, headers, and the rest of the distribution never reach the
 * stage.
 * @param zipPath - the verified carrier zip.
 * @param destNodeDir - the staged `node/` directory.
 * @returns the resolved node.exe and LICENSE paths.
 */
export async function resolveNodeArtifacts(
  zipPath: string,
  destNodeDir: string,
): Promise<{ nodeExe: string; license: string }> {
  const entries = readZipEntries(await readFile(zipPath))
  const byName = new Map<string, Buffer>()
  for (const [name, data] of entries) byName.set(basename(name), data)
  const nodeExe = byName.get('node.exe')
  if (nodeExe === undefined) {
    throw new Error(`build-desktop-portable: carrier zip ${basename(zipPath)} contains no node.exe.`)
  }
  const license = byName.get('LICENSE')
  if (license === undefined) {
    throw new Error(`build-desktop-portable: carrier zip ${basename(zipPath)} contains no LICENSE.`)
  }
  await mkdir(destNodeDir, { recursive: true })
  await writeFile(join(destNodeDir, 'node.exe'), nodeExe)
  await writeFile(join(destNodeDir, 'LICENSE'), license)
  return { nodeExe: join(destNodeDir, 'node.exe'), license: join(destNodeDir, 'LICENSE') }
}

/** One ordered command in a {@link planPortableBuild} result. */
export interface PlannedCommand {
  /** The executable; `pnpm` maps to the host binary at execution time. */
  readonly command: string
  readonly args: readonly string[]
}

/** Inputs to the pure build-plan function. */
export interface PortablePlanInput {
  /** The desktop workspace package name. */
  readonly package: string
  /** The runtime closure directory, repo-relative. */
  readonly runtimeStage: string
}

/**
 * The ordered assembly plan: run the Tauri no-bundle executable build, then
 * deploy the runtime closure. The `--out` on `desktop:runtime` matches the
 * deploy target the builder stages.
 * @param input - package identity and runtime stage.
 * @returns the exe-build and runtime commands in order.
 */
export function planPortableBuild({ package: pkg, runtimeStage }: PortablePlanInput): PlannedCommand[] {
  return [
    { command: 'pnpm', args: ['--filter', pkg, 'exec', 'tauri', 'build', '--no-bundle'] },
    { command: 'pnpm', args: ['run', 'desktop:runtime', '--', '--out', runtimeStage] },
  ]
}

/**
 * Render the deterministic `VERSION.json` object.
 * @param input - generated metadata substitute.
 * @returns the exact provenance document.
 */
export function buildVersionJson(input: VersionInput): Record<string, unknown> {
  return {
    product: PRODUCT,
    dshVersion: input.dshVersion,
    gitCommit: input.gitCommit,
    nodeVersion: input.nodeVersion,
    desktopProtocol: DESKTOP_PROTOCOL,
    target: DESKTOP_TARGET,
    buildTime: input.buildTime,
  }
}

/**
 * Pack a millisecond epoch into the ZIP DOS time/date fields. Timestamps before
 * the DOS minimum (1980-01-01) clamp to that minimum, which is the same
 * behaviour archive tools use for pre-1980 source epochs.
 */
function dosDateTime(timestampMs: number): { time: number; date: number } {
  const ms = Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : 0
  const date = new Date(ms)
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()))
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >>> 1)
  const dstDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  return { time, date: dstDate }
}

/** Table-based CRC-32, the ZIP checksum. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Encode an ordered list of entries as a deterministic ZIP. Entries are sorted
 * by name before writing, every timestamp comes from one fixed epoch, and no
 * volume/disk or variable extra fields are emitted, so identical inputs produce
 * identical bytes regardless of insertion order. Compression is raw DEFLATE.
 * @param entries - every file to archive.
 * @param timestampMs - the fixed DOS timestamp for every entry.
 * @returns the complete ZIP bytes.
 */
export function createZipArchive(entries: readonly ZipEntry[], timestampMs: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const { time, date } = dosDateTime(timestampMs)
  const localRecords: Buffer[] = []
  const centralHeaders: Buffer[] = []
  const UTF8_FLAG = 0x0800
  const METHOD_DEFLATE = 8
  let offset = 0

  for (const entry of sorted) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(entry.data, { level: 9 })
    const crc = crc32(entry.data)
    const compressedLength = compressed.length
    const unpackedLength = entry.data.length

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(METHOD_DEFLATE, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(compressedLength, 18)
    local.writeUInt32LE(unpackedLength, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(METHOD_DEFLATE, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(compressedLength, 20)
    central.writeUInt32LE(unpackedLength, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    // Each local header is immediately followed by its data, in central-directory order.
    localRecords.push(local, compressed)
    centralHeaders.push(central)
    offset += local.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralHeaders)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localRecords, centralDirectory, end])
}

/**
 * Read every file member of a ZIP into a name-to-data map. Only store and
 * deflate methods are supported, which covers the nodejs.org carrier and our
 * own writer; anything else fails loud.
 * @param data - the ZIP bytes.
 * @returns an insertion-ordered map of archive-relative name to payload.
 */
export function readZipEntries(data: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  let offset = 0
  while (offset + 30 <= data.length) {
    if (data.readUInt32LE(offset) !== 0x04034b50) break
    const method = data.readUInt16LE(offset + 8)
    const flags = data.readUInt16LE(offset + 6)
    const compressedLength = data.readUInt32LE(offset + 18)
    const unpackedLength = data.readUInt32LE(offset + 22)
    const nameLength = data.readUInt16LE(offset + 26)
    const extraLength = data.readUInt16LE(offset + 28)
    const name = data.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    if ((flags & 0x0008) !== 0) {
      throw new Error(`build-desktop-portable: streaming data-descriptor ZIP entry ${name} is unsupported.`)
    }
    const payloadStart = offset + 30 + nameLength + extraLength
    const compressed = data.subarray(payloadStart, payloadStart + compressedLength)
    let payload: Buffer
    if (method === 0) {
      payload = compressed
    } else if (method === 8 && unpackedLength === 0) {
      payload = Buffer.alloc(0)
    } else if (method === 8) {
      payload = Buffer.from(inflateRawSync(compressed, { maxOutputLength: unpackedLength }))
    } else {
      throw new Error(`build-desktop-portable: unsupported ZIP method ${method} for ${name}.`)
    }
    if (!name.endsWith('/')) entries.set(name, payload)
    offset = payloadStart + compressedLength
  }
  return entries
}

/** Repository-relative path with `/` separators for readable errors. */
function repoRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

/** Options for the staged-artifact leak scan. */
export interface ScanOptions {
  /** The checkout root path that must never appear in staged content. */
  readonly checkoutRoot: string
  /** The expected bundled CLI/root dsh version (`VERSION.json.dshVersion`). */
  readonly expectedDshVersion: string
}

/**
 * A secret-named key assigned a value in a config-document shape:
 * `DEEPSEEK_API_KEY=`, `SECRET: value`, `BOT_TOKEN = "..."`. It is only applied
 * to config-document files (`.yaml`, `.yml`, `.env`, `.toml`, `.properties`,
 * `.ini`, `.conf`, `.cfg`), never to library source code where secret-named
 * identifiers and the package's own credential-format documentation are
 * legitimate. The bound before the running key name excludes `process.env.X` /
 * `obj.X` property reads, and a non-empty value is required.
 */
const SECRET_ASSIGNMENT = /(?:^|[^\w.])([A-Za-z_][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)\s*[:=]\s*\S/m

/** Config-document extensions that carry credential/key-value content. */
const CONFIG_DOCUMENT_EXTENSIONS = new Set([
  '.yaml', '.yml', '.env', '.toml', '.properties', '.ini', '.conf', '.cfg',
])

/** File basenames that are never allowed to ship, wherever they appear. */
const FORBIDDEN_BASENAMES = new Set(['.credentials.yaml', '.env'])

/** Decode staged bytes as UTF-8 or UTF-16 (LE), else undefined when binary. */
function decodeText(data: Buffer): string | undefined {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return data.subarray(2).toString('utf16le')
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return data.subarray(3).toString('utf8')
  }
  if (data.includes(0)) return undefined
  return data.toString('utf8')
}

/**
 * Validate the staged portable layout and scan staged text for leaks, rejecting
 * the archive when any rule fails. The allowlist is structural: five top-level
 * files, `node/` limited to `node.exe` and `LICENSE`, and `runtime/` limited to
 * `package.json` plus the open-ended `node_modules/` closure. Scan scope is
 * calibrated in {@link walkAndScan} so the pre-built closure's bundler paths
 * and package documentation are not mistaken for leaks.
 * @param stage - the portable stage root.
 * @param options - checkout root and expected dsh version.
 */
export async function scanStagedArtifacts(stage: string, options: ScanOptions): Promise<void> {
  const { checkoutRoot, expectedDshVersion } = options
  const checkoutVariants = new Set([checkoutRoot.replace(/\\/g, '/'), checkoutRoot.replace(/\//g, '\\')])
  const offenders: string[] = []
  const push = (rel: string, why: string) => { offenders.push(`${rel}: ${why}`) }

  const rootEntries = await readdir(stage, { withFileTypes: true })
  const topLevelFiles = new Set<string>()
  for (const entry of rootEntries) {
    const abs = join(stage, entry.name)
    const stat = await lstat(abs)
    if (stat.isSymbolicLink()) {
      push(repoRelative(stage, abs), 'top-level symbolic link')
      continue
    }
    if (stat.isFile()) {
      if (!['DeepSeek Harness.exe', 'README.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'VERSION.json'].includes(entry.name)) {
        push(repoRelative(stage, abs), 'outside the top-level allowlist')
      }
      topLevelFiles.add(entry.name)
    }
  }
  for (const required of ['DeepSeek Harness.exe', 'README.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'VERSION.json']) {
    if (!topLevelFiles.has(required)) push(required, 'missing required top-level file')
  }

  const nodeDir = join(stage, 'node')
  if (existsSync(nodeDir)) {
    const nodeFiles = new Set((await readdir(nodeDir)).filter(name => !name.startsWith('.')))
    for (const nodeFile of nodeFiles) {
      if (!['node.exe', 'LICENSE'].includes(nodeFile)) push(`node/${nodeFile}`, 'outside the node allowlist')
    }
    for (const required of ['node.exe', 'LICENSE']) if (!nodeFiles.has(required)) push(`node/${required}`, 'missing required node artifact')
  } else {
    push('node', 'missing node directory')
  }

  const runtimeDir = join(stage, 'runtime')
  if (existsSync(runtimeDir)) {
    for (const entry of await readdir(runtimeDir, { withFileTypes: true })) {
      const abs = join(runtimeDir, entry.name)
      const stat = await lstat(abs)
      if (stat.isSymbolicLink()) push(repoRelative(stage, abs), 'symlink under runtime')
      if (entry.isFile() && entry.name !== 'package.json') push(repoRelative(stage, abs), 'outside the runtime allowlist')
    }
    if (!existsSync(join(runtimeDir, 'package.json'))) push('runtime/package.json', 'missing')
    if (!existsSync(join(runtimeDir, 'node_modules'))) push('runtime/node_modules', 'missing')
  } else {
    push('runtime', 'missing runtime directory')
  }

  const stagedCliVersion = await stagedRuntimeCliVersion(join(stage, 'runtime'))
  if (stagedCliVersion !== expectedDshVersion) {
    push(
      `runtime/node_modules/${CLI_PACKAGE}/package.json`,
      `bundled CLI version ${JSON.stringify(stagedCliVersion)} != ExpectedDshVersion ${JSON.stringify(expectedDshVersion)}`,
    )
  }

  await walkAndScan(stage, stage, checkoutVariants, push)

  if (offenders.length > 0) {
    throw new Error(`build-desktop-portable: staged artifact scan rejected ${offenders.length} item(s):\n  ${offenders.join('\n  ')}`)
  }
}

/** Read the staged runtime's bundled CLI version, or undefined when absent. */
async function stagedRuntimeCliVersion(runtimeDir: string): Promise<string | undefined> {
  const manifestPath = join(runtimeDir, 'node_modules', CLI_PACKAGE, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: string }
  return manifest.version
}

/**
 * Recursively scan a directory for links and leaks.
 *
 * Scope is calibrated so a clean closure passes while a genuine leak fails:
 * the prototype marker is scanned in all text; `.env`/`.credentials.yaml`
 * filenames are rejected wherever they appear; secret-document assignments
 * (`API_KEY=`, `SECRET: value`) are checked only in config-document files; and
 * the checkout root plus `%USERPROFILE%` are checked only in this task's
 * assembly-written top-level/`node/` files and the runtime `package.json`
 * manifests. The unpacked `node_modules` JavaScript closure is not scanned for
 * the checkout root because the bundler embeds the deploy root in generated
 * `#region` markers, and its own package READMEs legitimately document the
 * credential format, so a content scan there would reject a clean build.
 */
async function walkAndScan(
  stage: string,
  directory: string,
  checkoutVariants: Set<string>,
  push: (rel: string, why: string) => void,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const abs = join(directory, entry.name)
    const rel = repoRelative(stage, abs)
    const stat = await lstat(abs)
    if (stat.isSymbolicLink()) {
      push(rel, 'symbolic link (or junction)')
      continue
    }
    if (stat.isDirectory()) {
      await walkAndScan(stage, abs, checkoutVariants, push)
      continue
    }
    if (!stat.isFile()) continue
    if (FORBIDDEN_BASENAMES.has(entry.name)) {
      push(rel, 'forbidden secret/config filename')
      continue
    }
    if (isExcludedArtifact(entry.name)) {
      push(rel, 'excluded debug artifact (source map)')
      continue
    }
    const extension = rel.slice(rel.lastIndexOf('.')).toLowerCase()
    if (BINARY_EXTENSIONS.has(extension)) continue
    if (stat.size > MAX_TEXT_SCAN_BYTES) continue
    const data = await readFile(abs)
    const text = decodeText(data)
    if (text === undefined) continue
    if (text.includes(PATCH_MARKER)) {
      push(rel, 'contains the prototype patch marker')
    }
    const isAssemblyScoped = isAssemblyScannedPath(stage, abs)
    const isManifest = entry.name === 'package.json'
    if (isAssemblyScoped || isManifest) {
      if ([...checkoutVariants].some(variant => text.includes(variant))) push(rel, 'contains the checkout root')
      if (text.includes('%USERPROFILE%')) push(rel, 'contains %USERPROFILE%')
    }
    if (CONFIG_DOCUMENT_EXTENSIONS.has(extension)) {
      // GitHub Actions workflow YAML under a package's `.github/` references
      // `${{ secrets.X }}` placeholders by design; those are not leaked values.
      const segments = rel.split('/')
      if (!segments.includes('.github')) {
        if (SECRET_ASSIGNMENT.test(text)) push(rel, 'assigns a secret-named key a value')
      }
    }
  }
}

/**
 * Whether a staged file is one this task wrote and therefore must stay free of
 * machine-specific paths: the five top-level files and the two `node/` members.
 */
function isAssemblyScannedPath(stage: string, abs: string): boolean {
  const rel = repoRelative(stage, abs)
  const directTopLevel = new Set(['DeepSeek Harness.exe', 'README.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'VERSION.json'])
  if (directTopLevel.has(rel)) return true
  return rel === 'node/node.exe' || rel === 'node/LICENSE'
}

/**
 * Confirm the bundled CLI version equals the source dsh version, so an
 * npm-published prototype copy cannot slip into the archive.
 * @param runtimeDir - the staged `runtime/` directory.
 * @param expectedDshVersion - `VERSION.json.dshVersion`.
 */
export async function confirmBundledVersion(runtimeDir: string, expectedDshVersion: string): Promise<void> {
  const manifestPath = join(runtimeDir, 'node_modules', CLI_PACKAGE, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`build-desktop-portable: bundled CLI manifest missing at runtime/node_modules/${CLI_PACKAGE}/package.json.`)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: string }
  if (manifest.version !== expectedDshVersion) {
    throw new Error(
      `build-desktop-portable: bundled ${CLI_PACKAGE} version ${JSON.stringify(manifest.version)} does not equal VERSION.json.dshVersion ${JSON.stringify(expectedDshVersion)} (an npm-published prototype copy must not reach the archive).`,
    )
  }
}

/** Recursively copy a directory tree, rejecting links and `.bin` shim dirs. */
async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    if (entry.isFile() && isExcludedArtifact(entry.name)) continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    const stat = await lstat(from)
    if (stat.isSymbolicLink()) {
      throw new Error(`build-desktop-portable: runtime closure holds a link at ${from}; rebuild with a symlink-free deploy.`)
    }
    if (stat.isDirectory()) {
      await copyTree(from, to)
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }
}

/** Read the `version` field from a repository package.json. */
async function readVersion(path: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { version?: string }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`build-desktop-portable: no version in ${path}.`)
  }
  return manifest.version
}

/** The release gate: a clean working tree unless `--allow-dirty`. */
function assertCleanTree(root: string, allowDirty: boolean): void {
  if (allowDirty) return
  const status = capture('git', ['status', '--porcelain'], { cwd: root })
  if (status.trim() !== '') {
    throw new Error('build-desktop-portable: working tree is dirty; commit before a release or pass --allow-dirty.')
  }
}

/** Map a host-independent `pnpm` into a shell-free child invocation (Windows-safe). */
function pnpmInvocation(args: readonly string[]): { command: string; args: string[] } {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('build-desktop-portable: npm_execpath is unavailable; invoke through a pnpm package script.')
  }
  return { command: process.execPath, args: [entrypoint, ...args] }
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/** Run one command against the repository, inheriting stdio and failing loud. */
async function run(label: string, command: string, args: readonly string[]): Promise<void> {
  const printable = formatCommand(command, args)
  console.log(`build-desktop-portable: ${label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: commandRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        CI: 'true',
        // The desktop EXE must link the MSVC runtime: the GNU toolchain (the
        // rustup default on Windows) produces a binary that depends on MinGW
        // runtime DLLs absent from target machines. Pin the MSVC host
        // toolchain so a rustup default cannot silently change the ABI.
        ...(process.platform === 'win32'
          ? { RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc' }
          : {}),
      },
    })
    child.once('error', (error) => {
      reject(new Error(`build-desktop-portable: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`build-desktop-portable: ${label} failed (${cause}): ${printable}`))
    })
  })
}

/** Resolve the deterministic build timestamp from SOURCE_DATE_EPOCH. */
function resolveTimestamp(allowDirty: boolean): number {
  const raw = process.env.SOURCE_DATE_EPOCH
  if (raw !== undefined && raw !== '') {
    const epoch = Number(raw)
    if (!Number.isInteger(epoch) || epoch < 0) {
      throw new Error(`build-desktop-portable: SOURCE_DATE_EPOCH=${raw} is not a non-negative integer.`)
    }
    return epoch * 1000
  }
  if (allowDirty) {
    console.log('build-desktop-portable: SOURCE_DATE_EPOCH unset; dev archive uses the current time (--allow-dirty).')
    return Date.now()
  }
  throw new Error('build-desktop-portable: SOURCE_DATE_EPOCH is required for a deterministic release archive; set it or pass --allow-dirty for a dev build.')
}

/** Collect every staged file into timestamped ZIP entries under the archive root folder. */
async function collectStageFiles(stage: string): Promise<{ entries: ZipEntry[]; root: string }> {
  const entries: ZipEntry[] = []
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const abs = join(directory, entry.name)
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const stat = await lstat(abs)
      if (stat.isSymbolicLink()) {
        throw new Error(`build-desktop-portable: staged link ${name} reached ZIP collection; scans should have rejected it.`)
      }
      if (stat.isDirectory()) {
        await walk(abs, name)
        continue
      }
      if (isExcludedArtifact(entry.name)) continue
      entries.push({ name, data: await readFile(abs) })
    }
  }
  await walk(stage, '')
  const root = 'DeepSeek Harness'
  return {
    entries: entries
      .map(entry => ({ name: `${root}/${entry.name}`, data: entry.data }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    root,
  }
}

/** Assemble the portable stage on disk. */
async function assembleStage(input: {
  root: string
  stage: string
  exe: string
  runtimeStage: string
  carrier: NodeCarrier
  nodeZip: string
  gitCommit: string
  timestampMs: number
}): Promise<void> {
  await rm(input.stage, { recursive: true, force: true })
  await mkdir(input.stage, { recursive: true })

  await copyFile(input.exe, join(input.stage, PORTABLE_EXE_NAME))
  await copyFile(join(input.root, 'apps/desktop/README.txt'), join(input.stage, 'README.txt'))
  await copyFile(join(input.root, 'LICENSE'), join(input.stage, 'LICENSE'))
  await copyFile(join(input.root, 'THIRD_PARTY_NOTICES.md'), join(input.stage, 'THIRD_PARTY_NOTICES.txt'))

  await resolveNodeArtifacts(input.nodeZip, join(input.stage, 'node'))

  await mkdir(join(input.stage, 'runtime'), { recursive: true })
  await copyFile(join(input.runtimeStage, 'package.json'), join(input.stage, 'runtime/package.json'))
  await copyTree(join(input.runtimeStage, 'node_modules'), join(input.stage, 'runtime/node_modules'))

  const dshVersion = await readVersion(join(input.root, 'package.json'))
  const versionJson = buildVersionJson({
    dshVersion,
    gitCommit: input.gitCommit,
    nodeVersion: input.carrier.version,
    buildTime: new Date(input.timestampMs).toISOString(),
  })
  await writeFile(join(input.stage, 'VERSION.json'), `${JSON.stringify(versionJson, null, 2)}\n`)
}

/** The main entry: resolve flags, run build steps, stage, scan, zip, hash. */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(argument => argument !== '--')
  const { values } = parseArgs({
    args,
    options: {
      'allow-dirty': { type: 'boolean', default: false },
      'skip-runtime': { type: 'boolean', default: false },
      'skip-exe': { type: 'boolean', default: false },
      stage: { type: 'string' },
      cache: { type: 'string' },
      out: { type: 'string' },
      runtime: { type: 'string' },
    },
    allowPositionals: false,
  })
  commandRoot = process.cwd()
  const root = REPO_ROOT
  const allowDirty = values['allow-dirty']
  const timestampMs = resolveTimestamp(allowDirty)
  const stage = resolve(commandRoot, values.stage ?? DEFAULT_STAGE)
  const cache = resolve(commandRoot, values.cache ?? DEFAULT_CACHE)
  const outDir = resolve(commandRoot, values.out ?? DEFAULT_OUTPUT)
  const runtimeStage = resolve(commandRoot, values.runtime ?? DEFAULT_RUNTIME)
  if (stage === root || root.startsWith(stage + sep)) {
    throw new Error(`build-desktop-portable: refusing to stage into ${stage}: it contains the repo root.`)
  }

  const carrier = loadNodeCarrier(root)
  const gitCommit = capture('git', ['rev-parse', 'HEAD'], { cwd: root })
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) throw new Error(`build-desktop-portable: git HEAD is not a 40-hex commit (${gitCommit}).`)
  assertCleanTree(root, allowDirty)

  const needsExe = !values['skip-exe']
  const needsRuntime = !values['skip-runtime']

  if (needsExe) {
    const exePlan = pnpmInvocation([
      '--filter', DESKTOP_PACKAGE, 'exec', 'tauri', 'build', '--no-bundle',
    ])
    await run('tauri no-bundle build', exePlan.command, exePlan.args)
  }
  const exePath = resolve(root, DEFAULT_EXE)
  if (!existsSync(exePath)) {
    throw new Error(`build-desktop-portable: tauri executable not found at ${repoRelative(root, exePath)}; run without --skip-exe.`)
  }

  if (needsRuntime) {
    const runtimePlan = pnpmInvocation([
      'run', 'desktop:runtime', '--', '--out', relative(commandRoot, runtimeStage),
    ])
    await run('runtime deploy', runtimePlan.command, runtimePlan.args)
  }
  if (!existsSync(join(runtimeStage, 'package.json')) || !existsSync(join(runtimeStage, 'node_modules'))) {
    throw new Error(`build-desktop-portable: runtime closure missing at ${repoRelative(root, runtimeStage)}; run without --skip-runtime.`)
  }

  const { zipPath: nodeZip } = await downloadNodeArchive(carrier, cache)

  await assembleStage({
    root,
    stage,
    runtimeStage,
    exe: exePath,
    carrier,
    nodeZip,
    gitCommit,
    timestampMs,
  })

  const dshVersion = await readVersion(join(root, 'package.json'))
  await confirmBundledVersion(join(stage, 'runtime'), dshVersion)
  await scanStagedArtifacts(stage, { checkoutRoot: root, expectedDshVersion: dshVersion })

  const { entries } = await collectStageFiles(stage)
  await mkdir(outDir, { recursive: true })
  const zipName = `DeepSeek_Harness_Portable_${dshVersion}_${DESKTOP_TARGET}.zip`
  const zipBytes = createZipArchive(entries, timestampMs)
  const zipPath = join(outDir, zipName)
  await writeFile(zipPath, zipBytes)
  await writeFile(`${zipPath}.sha256`, `${sha256Hex(zipBytes)}  ${zipName}\n`)

  console.log(`build-desktop-portable: wrote ${repoRelative(root, zipPath)} and its .sha256 into ${repoRelative(root, outDir)}.`)
}

if (isEntry(import.meta.url)) await main()
