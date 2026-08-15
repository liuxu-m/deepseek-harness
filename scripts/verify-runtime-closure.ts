/**
 * Verify that an executable deploy manifest supplies every required workspace
 * peer in its dependency graph. With auto peer installation disabled, a missing
 * root peer can otherwise fail only when Cordis loads the packaged plugin.
 */
import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './release/process.ts'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface WorkspacePackage {
  path: string
  manifest: PackageManifest
}

/** What a successful closure check establishes. */
export interface RuntimeClosureResult {
  /** The deploy manifest's package name, or its repository-relative directory. */
  readonly runtimeName: string
  /** The repository-relative manifest path that was verified. */
  readonly manifestPath: string
  /** The number of workspace packages in the closed dependency graph. */
  readonly packageCount: number
}

/** Workspace locations that may supply a runtime peer or dependency. */
const WORKSPACE_PATTERNS = ['packages/*/*/package.json', 'vendor/*/package.json', 'apps/*/package.json']

/**
 * Verify that every required workspace peer in the manifest's dependency graph
 * is supplied, throwing an {@link Error} whose messages name `runtimeName`.
 * @param root - the repository root.
 * @param manifestPath - repository-relative deploy manifest path.
 * @returns The closed graph's runtime name, manifest path, and package count.
 */
export async function verifyRuntimeClosure(root: string, manifestPath: string): Promise<RuntimeClosureResult> {
  const runtimeManifest = (await readJson(resolve(root, manifestPath))) as PackageManifest
  const runtimeName = runtimeManifest.name ?? dirname(manifestPath)
  const workspace = await loadWorkspacePackages(root)
  const runtimeDependencies = runtimeManifest.dependencies ?? {}
  const parents = new Map<string, string | undefined>()
  const queue: string[] = []

  for (const dependency of Object.keys(runtimeDependencies).sort()) {
    if (!workspace.has(dependency)) continue
    parents.set(dependency, undefined)
    queue.push(dependency)
  }

  const failures: string[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const packageName = queue[index]
    if (packageName === undefined) continue
    const current = workspace.get(packageName)
    if (current === undefined) continue
    const peers = current.manifest.peerDependencies ?? {}
    const peerMeta = current.manifest.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(peers).sort()) {
      if (!workspace.has(peer) || peerMeta[peer]?.optional === true) continue
      if (runtimeDependencies[peer]?.startsWith('workspace:') === true) continue
      failures.push(`${formatChain(runtimeName, packageName, parents)} -> ${peer}`)
    }
    const dependencies = {
      ...current.manifest.dependencies,
      ...current.manifest.optionalDependencies,
    }
    for (const dependency of Object.keys(dependencies).sort()) {
      if (!workspace.has(dependency) || parents.has(dependency)) continue
      parents.set(dependency, packageName)
      queue.push(dependency)
    }
  }

  if (failures.length > 0) {
    const prefix = `verify-runtime-closure: required workspace peers are missing from ${runtimeName} dependencies:`
    throw new Error([prefix, ...failures.map(failure => `  ${failure}`)].join('\n'))
  }

  return { runtimeName, manifestPath, packageCount: queue.length }
}

/**
 * Render the success summary, naming the manifest that closes over how many
 * workspace packages.
 * @param result - the established closure.
 * @returns The single-line success message.
 */
export function formatClosureSuccess(result: RuntimeClosureResult): string {
  return `verify-runtime-closure: ${result.manifestPath} closure passed: ${String(result.packageCount)} workspace packages form a closed runtime dependency graph under ${result.runtimeName}.`
}

async function loadWorkspacePackages(root: string): Promise<Map<string, WorkspacePackage>> {
  const paths = globSync(WORKSPACE_PATTERNS, { cwd: root })
    .sort()
    .map(relative => resolve(root, relative))
  const result = new Map<string, WorkspacePackage>()
  for (const path of paths) {
    const manifest = (await readJson(path)) as PackageManifest
    if (manifest.name !== undefined) result.set(manifest.name, { path, manifest })
  }
  return result
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function formatChain(
  runtimeName: string,
  packageName: string,
  parents: ReadonlyMap<string, string | undefined>,
): string {
  const chain = [packageName]
  let parent = parents.get(packageName)
  while (parent !== undefined) {
    chain.unshift(parent)
    parent = parents.get(parent)
  }
  return [runtimeName, ...chain].join(' -> ')
}

if (isEntry(import.meta.url)) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { manifest: { type: 'string' } },
    allowPositionals: false,
  })
  const root = resolve(import.meta.dirname, '..')
  const manifestPath = values.manifest ?? 'python/sdk-runtime/package.json'
  try {
    const result = await verifyRuntimeClosure(root, manifestPath)
    console.log(formatClosureSuccess(result))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
