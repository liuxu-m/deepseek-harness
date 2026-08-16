/**
 * Build the current-checkout desktop runtime closure. Builds the whole
 * workspace, verifies the desktop package's dependency graph closes over every
 * workspace peer, deploys a production-only closure with pnpm, then validates
 * that the staged runtime is current-source: the required artifacts exist at
 * matching versions with no symbolic links and no prototype patch marker.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './process.ts'

/** The desktop deploy root whose dependency graph defines the runtime closure. */
const DESKTOP_PACKAGE = '@deepseek-ai/dsh-desktop'
/** The CLI workspace package that carries the bundled `dsh` binary. */
const CLI_PACKAGE = '@deepseek-ai/dsh'
/** Repository-relative desktop deploy manifest. */
const DESKTOP_MANIFEST = 'apps/desktop/package.json'
/** The prototype replay marker that must never reach the shipped runtime. */
const PATCH_MARKER = '[dsh-patch:global-image]'
/** Default deploy target (`--out` overrides the destination). */
const DEFAULT_STAGE = 'dist/desktop/runtime'

/** Runtime artifacts the staged closure must carry, repository-relative to stage. */
const REQUIRED_ARTIFACTS = [
  `node_modules/${CLI_PACKAGE}/lib/bin.js`,
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/node-pty/prebuilds/win32-x64/pty.node',
] as const

/** Binary-heavy extensions skipped by the patch-marker scan. */
const BINARY_EXTENSIONS = new Set([
  '.node', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2', '.ttf', '.eot', '.ico',
  '.map', '.wasm', '.zip', '.gz', '.exe', '.dll', '.bin', '.icns', '.cur', '.pyc',
])
/** One text artifact is never larger than this, bounding the marker scan. */
const MAX_TEXT_SCAN_BYTES = 2 * 1024 * 1024

let commandRoot = process.cwd()

/**
 * The repository root, derived from this script's location at
 * `scripts/release/` (two levels below the root). Used by the post-deploy
 * restore and validate steps to locate the deploy source and manifests.
 */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

/** Inputs to the pure deploy-plan function. */
export interface DesktopRuntimePlanInput {
  /** The absolute deploy target directory. */
  readonly stage: string
}

/** One ordered command in the {@link planDesktopRuntime} result. */
export interface PlannedCommand {
  /** The executable; `pnpm` maps to the host binary at execution time. */
  readonly command: string
  readonly args: readonly string[]
}

/**
 * The ordered deploy plan: build the whole workspace, verify the desktop
 * closure, then deploy a production-only closure into `stage`. The plan is
 * host-independent (`pnpm`), so it is testable without executing anything.
 *
 * Deploy uses the legacy hoister with `node-linker=hoisted`: pnpm 11 refuses
 * non-injected workspace deploys without `--legacy`, and the hoisted layout is
 * what makes every workspace dependency resolvable from the flat
 * `node_modules` the bundled Host walks (the same flags the SDK exe build
 * uses). `link-workspace-packages` keeps the closure current-source.
 * @param input - the repository root and deploy target.
 * @returns The build, verify, and deploy commands in order.
 */
export function planDesktopRuntime({ stage }: DesktopRuntimePlanInput): PlannedCommand[] {
  return [
    { command: 'pnpm', args: ['run', 'build'] },
    { command: 'pnpm', args: ['run', 'verify-runtime-closure', '--manifest', DESKTOP_MANIFEST] },
    {
      command: 'pnpm',
      args: [
        '--filter', DESKTOP_PACKAGE,
        'deploy', '--legacy', '--prod',
        '--config.node-linker=hoisted',
        '--config.auto-install-peers=false',
        '--config.link-workspace-packages=true',
        stage,
      ],
    },
  ]
}

/**
 * Validate a staged desktop runtime: every required artifact exists with a
 * matching version, no staged text artifact carries the prototype patch
 * marker, and no symbolic link remains. Reports failures with the
 * repository-relative path.
 * @param root - the repository root.
 * @param stage - the deployed runtime directory.
 */
export async function validateDeployedRuntime(root: string, stage: string): Promise<void> {
  for (const artifact of REQUIRED_ARTIFACTS) {
    const absolute = join(stage, artifact)
    if (!existsSync(absolute)) {
      throw new Error(`build-desktop-runtime: staged runtime is missing required artifact ${repoRelative(root, absolute)}`)
    }
  }
  const rootVersion = await readVersion(join(root, 'package.json'))
  const cliVersion = await readVersion(join(root, 'apps/cli', 'package.json'))
  const deployedCliVersion = await readVersion(join(stage, 'node_modules', CLI_PACKAGE, 'package.json'))
  if (rootVersion !== cliVersion || rootVersion !== deployedCliVersion) {
    throw new Error(
      `build-desktop-runtime: version mismatch: root ${rootVersion || '(unset)'}, `
      + `app CLI ${cliVersion || '(unset)'}, deployed ${CLI_PACKAGE} ${deployedCliVersion || '(unset)'}.`,
    )
  }
  const markerHits = await findMarker(stage, PATCH_MARKER)
  if (markerHits.length > 0) {
    throw new Error(
      `build-desktop-runtime: prototype patch marker ${JSON.stringify(PATCH_MARKER)} found in `
      + markerHits.map(path => repoRelative(root, path)).join(', '),
    )
  }
  const remaining = await findSymlink(join(stage, 'node_modules'))
  if (remaining !== undefined) {
    throw new Error(`build-desktop-runtime: staged runtime still contains a link ${repoRelative(root, remaining)}`)
  }
}

/**
 * Replace every file or directory link below `directory` with a real copy of
 * its target, so the staged runtime carries no links. Nested `node_modules`
 * trees are skipped to keep one flat closure, and `.bin` link directories are
 * deleted outright, both matching the SDK runtime. The scan re-runs after every
 * replacement because materializing an ancestor can expose new links in a
 * dereferenced target; the loop only ever recurses into real directories, so a
 * package whose nested `node_modules` links back to itself cannot recurse
 * forever.
 * @param directory - the staged runtime root.
 */
export async function materializeStagedLinks(directory: string): Promise<void> {
  let remaining = await findSymlink(directory)
  while (remaining !== undefined) {
    const relative = remaining
      .slice(directory.length + sep.length)
      .split(sep)
    const binIndex = relative.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(directory, ...relative.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(directory)
      continue
    }
    const source = await realpath(remaining)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(remaining, { recursive: true, force: true })
    await cp(source, remaining, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(directory)
  }
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Return the staged paths whose text content contains `marker`. */
async function findMarker(directory: string, marker: string): Promise<string[]> {
  const hits: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      hits.push(...await findMarker(path, marker))
      continue
    }
    if (!isTextArtifact(path)) continue
    const content = await readFile(path, 'utf8')
    if (content.includes(marker)) hits.push(path)
  }
  return hits
}

/** Whether a file is small enough and not binary-suffixed to scan as text. */
function isTextArtifact(path: string): boolean {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (BINARY_EXTENSIONS.has(extension)) return false
  return statSync(path).size <= MAX_TEXT_SCAN_BYTES
}

/** Turn an absolute path into a normalized `/`-separated repository path. */
function repoRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

async function readVersion(path: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { version?: string }
  return manifest.version ?? ''
}

/** Resolve the plan's host-independent `pnpm` to a shell-free child invocation. */
function pnpmInvocation(args: readonly string[]): { command: string; args: string[] } {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('build-desktop-runtime: npm_execpath is unavailable; invoke through a pnpm package script.')
  }
  // Windows cannot spawn the pnpm.cmd shim directly; the JavaScript entrypoint keeps every host shell-free.
  return { command: process.execPath, args: [entrypoint, ...args] }
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/** Run one command against the repository, inheriting stdio and failing loudly. */
async function run(label: string, command: string, args: readonly string[]): Promise<void> {
  const printable = formatCommand(command, args)
  console.log(`build-desktop-runtime: ${label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: commandRoot,
      stdio: 'inherit',
      // Artifact builds must not mutate or validate a developer's Git hooks.
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', (error) => {
      reject(new Error(`build-desktop-runtime: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`build-desktop-runtime: ${label} failed (${cause}): ${printable}`))
    })
  })
}

/**
 * Restore direct dependencies that pnpm's legacy hoister places beside the
 * deploy source instead of in the target. The desktop manifest lists every
 * runtime peer, so a package-local node_modules tree is omitted to preserve one
 * flat Cordis instance (the same recovery the SDK exe build performs).
 * @param root - the repository root.
 * @param stage - the deployed runtime directory.
 */
export async function restoreLegacyHoists(root: string, stage: string): Promise<void> {
  const manifestPath = join(stage, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const sourceNodeModules = join(root, 'apps/desktop', 'node_modules')
  const restored: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(stage, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(
        `build-desktop-runtime: deployed dependency ${dependency} is absent from both ${repoRelative(root, destination)} and ${repoRelative(root, source)}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(dependency)
  }
  const stillMissing = Object.keys(manifest.dependencies ?? {})
    .filter(dependency => !existsSync(join(stage, 'node_modules', dependency)))
  if (stillMissing.length > 0) {
    throw new Error(
      `build-desktop-runtime: staged dependencies remain missing: ${stillMissing.join(', ')}.`,
    )
  }
  if (restored.length > 0) {
    console.log(`build-desktop-runtime: restored legacy deploy hoists: ${restored.join(', ')}`)
  }
}

/** Run the plan, mapping the host-independent `pnpm` command to the host binary. */
async function runPlan(plan: readonly PlannedCommand[]): Promise<void> {
  for (const step of plan) {
    const command = step.command === 'pnpm' ? pnpmInvocation(step.args) : { command: step.command, args: [...step.args] }
    // The label names the action: `pnpm run build` -> "build", `pnpm run
    // verify-...` -> "verify-...", `pnpm --filter ... deploy ...` -> "deploy".
    const action = step.args[0] === 'run' ? step.args[1] ?? 'run' : step.args[0] === '--filter' ? 'deploy' : step.args[0]
    await run(action ?? step.command, command.command, command.args)
  }
}

function assertStageSafe(root: string, stage: string): void {
  if (stage === root || root.startsWith(stage + sep)) {
    throw new Error(`build-desktop-runtime: refusing to deploy into ${stage}: it contains the repo root.`)
  }
}

async function main(): Promise<void> {
  // `pnpm run desktop:runtime -- --out ...` injects a `--` terminator before the
  // forwarded arguments; drop it so parseArgs sees only real flags.
  const args = process.argv.slice(2).filter(argument => argument !== '--')
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' } },
    allowPositionals: false,
  })
  commandRoot = process.cwd()
  const root = REPO_ROOT
  const stage = values.out === undefined ? resolve(root, DEFAULT_STAGE) : resolve(commandRoot, values.out)
  assertStageSafe(root, stage)
  // pnpm deploy is refused on a non-empty target; clear any prior staging first.
  await rm(stage, { recursive: true, force: true })
  await runPlan(planDesktopRuntime({ stage }))
  await restoreLegacyHoists(root, stage)
  await materializeStagedLinks(stage)
  await validateDeployedRuntime(root, stage)
  console.log(`build-desktop-runtime: ${stage} is a symlink-free current-workspace runtime closure.`)
}

if (isEntry(import.meta.url)) await main()
