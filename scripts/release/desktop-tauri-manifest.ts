/**
 * Derive the desktop-tauri runtime deploy manifest from the workspace graph.
 *
 * The Tauri package is the deploy root whose `dependencies` define the runtime
 * closure `pnpm deploy --prod` stages and the portable archive ships. Keeping
 * that list in sync by hand breaks whenever an upstream package is added,
 * renamed, or gains a workspace peer, so this script recomputes it from the
 * runtime entry points and rewrites the manifest's `dependencies` block.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './process.ts'

/** Repository root, derived from this script's location at `scripts/release/`. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

/** The desktop-tauri workspace package whose manifest owns the closure. */
export const DESKTOP_TAURI_DIR = 'apps/desktop-tauri'

/**
 * Runtime entry points the closure must reach: the `dsh` CLI that boots the
 * application, the Web profile layer that composes it, and the built Web
 * frontend assets the CLI serves.
 */
export const RUNTIME_SEEDS = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-web-frontend',
] as const

/** One workspace package discovered through the pnpm workspace globs. */
interface WorkspacePackage {
  /** Manifest path relative to the repository root. */
  readonly path: string
  /** The parsed manifest, narrowed to the dependency maps this script reads. */
  readonly manifest: {
    readonly name?: string
    readonly version?: string
    readonly dependencies?: Record<string, string>
    readonly optionalDependencies?: Record<string, string>
    readonly peerDependencies?: Record<string, string>
    readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>
  }
}

/** The workspace manifest directories, in the order the globs declare them. */
function workspaceDirectories(root: string): string[] {
  const directories: string[] = []
  for (const entry of readdirSync(join(root, 'vendor'), { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(join(root, 'vendor', entry.name))
  }
  for (const group of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(root, 'packages', group.name)
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(groupDir, entry.name))
    }
  }
  for (const entry of readdirSync(join(root, 'apps'), { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(join(root, 'apps', entry.name))
  }
  return directories
}

/**
 * Load every workspace package manifest, keyed by package name.
 * @param root - the repository root.
 * @returns the discovered manifests keyed by their declared package name.
 */
export function loadWorkspace(root: string): Map<string, WorkspacePackage> {
  const byName = new Map<string, WorkspacePackage>()
  for (const directory of workspaceDirectories(root)) {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspacePackage['manifest']
    if (manifest.name === undefined) continue
    byName.set(manifest.name, { path: manifestPath.slice(root.length + 1).split('\\').join('/'), manifest })
  }
  return byName
}

/** The dependency maps this script reads from one manifest. */
function dependencyMaps(manifest: WorkspacePackage['manifest']) {
  return {
    dependencies: manifest.dependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
    peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
  }
}

/** The computed runtime closure: requested workspace packages and external specs. */
export interface ClosureResult {
  /** Workspace package names the deploy manifest must declare. */
  readonly workspacePackages: string[]
  /** External and override-linked specs, keyed by package name. */
  readonly externalSpecs: Map<string, string>
}

/**
 * Walk the workspace graph from {@link RUNTIME_SEEDS}.
 *
 * Traversal follows `dependencies` and `optionalDependencies`; every workspace
 * `peerDependencies` entry is added too, because `auto-install-peers=false`
 * makes an undeclared peer unresolvable at runtime, and `verify-runtime-closure`
 * rejects it. Optional peers stay declared but are not traversed.
 * @param workspace - the loaded workspace manifests.
 * @param seeds - package names the closure must reach.
 * @returns the workspace packages and external specs the manifest must declare.
 */
export function computeClosure(
  workspace: Map<string, WorkspacePackage>,
  seeds: readonly string[] = RUNTIME_SEEDS,
): ClosureResult {
  const declared = new Set<string>()
  const externalSpecs = new Map<string, string>()
  const queue = [...seeds]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const name = queue.shift()
    if (name === undefined || visited.has(name)) continue
    visited.add(name)
    const workspacePackage = workspace.get(name)
    if (workspacePackage === undefined) continue
    declared.add(name)
    const { dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta } = dependencyMaps(workspacePackage.manifest)
    for (const [dependency, range] of Object.entries({ ...dependencies, ...optionalDependencies })) {
      if (workspace.has(dependency)) {
        queue.push(dependency)
        continue
      }
      externalSpecs.set(dependency, range)
    }
    for (const [peer, range] of Object.entries(peerDependencies)) {
      if (!workspace.has(peer)) {
        externalSpecs.set(peer, range)
        continue
      }
      declared.add(peer)
      if (peerDependenciesMeta[peer]?.optional !== true) queue.push(peer)
    }
  }
  return { workspacePackages: [...declared].sort(), externalSpecs }
}

/** The manifest fields this script preserves when rewriting `dependencies`. */
const PRESERVED_FIELDS = ['name', 'description', 'version', 'private', 'license', 'type', 'files'] as const

/**
 * Rewrite the desktop-tauri manifest's dependency block from the closure.
 * @param root - the repository root.
 * @param checkOnly - when true, throw instead of writing a stale manifest.
 * @returns Whether the manifest on disk differs from the computed closure.
 */
export function writeManifest(root: string, checkOnly = false): boolean {
  const manifestPath = join(root, DESKTOP_TAURI_DIR, 'package.json')
  const current = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const workspace = loadWorkspace(root)
  const closure = computeClosure(workspace)
  const dependencies: Record<string, string> = {}
  for (const name of closure.workspacePackages) dependencies[name] = 'workspace:^'
  for (const [name, range] of [...closure.externalSpecs].sort(([a], [b]) => a.localeCompare(b))) {
    dependencies[name] = range
  }
  const next: Record<string, unknown> = {}
  for (const field of PRESERVED_FIELDS) {
    if (current[field] !== undefined) next[field] = current[field]
  }
  next.dependencies = dependencies
  for (const field of ['scripts', 'devDependencies'] as const) {
    if (current[field] !== undefined) next[field] = current[field]
  }
  const rendered = `${JSON.stringify(next, null, 2)}\n`
  const existing = readFileSync(manifestPath, 'utf8')
  if (rendered === existing) return false
  if (checkOnly) {
    throw new Error(`desktop-tauri-manifest: ${DESKTOP_TAURI_DIR}/package.json is stale; run pnpm run desktop:manifest`)
  }
  writeFileSync(manifestPath, rendered)
  return true
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    options: { check: { type: 'boolean' } },
    allowPositionals: false,
  })
  const changed = writeManifest(REPO_ROOT, values.check === true)
  console.log(changed
    ? `desktop-tauri-manifest: rewrote ${DESKTOP_TAURI_DIR}/package.json`
    : `desktop-tauri-manifest: ${DESKTOP_TAURI_DIR}/package.json is current`)
}

if (isEntry(import.meta.url)) await main()
