/**
 * Desktop runtime identity: the GET-only `/api/runtime.identity` route that a
 * companion desktop shell probes to decide whether to attach to this Web Host
 * or start its own. The response carries only protocol constants plus the
 * runtime's anonymous instance id and home kind — never an absolute
 * filesystem path — so a loopback caller can classify the host without any
 * machine-specific disclosure.
 * @module @deepseek-ai/dsh-web-app/runtime-identity
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable product identifier a desktop shell matches before attaching. */
export const DSH_RUNTIME_PRODUCT = 'deepseek-harness' as const
/** Desktop compatibility protocol; bumped only on a breaking discovery change. */
export const DSH_DESKTOP_PROTOCOL = 1 as const
/** The identity endpoint path, registered as an exact webServer route. */
export const DSH_RUNTIME_IDENTITY_PATH = '/api/runtime.identity' as const

/** The non-sensitive identity a desktop shell requires to attach. */
export interface RuntimeIdentity {
  product: typeof DSH_RUNTIME_PRODUCT
  desktopProtocol: typeof DSH_DESKTOP_PROTOCOL
  version: string
  instanceId: string
  homeKind: 'default' | 'custom'
}

/** One anonymous instance id chosen at process start for a stable Home lifetime. */
const INSTANCE_ID = randomUUID()

/** The reader for the bundle's own package.json version, fail-loud on a malformed manifest. */
function readManifestVersion(manifestUrl: URL): string {
  const parsed = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8')) as { version?: unknown }
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error('dsh-web-app: package.json must declare a non-empty version')
  }
  return parsed.version
}

/** The production manifest location, resolved through this module's own URL. */
const PACKAGE_URL = new URL('../package.json', import.meta.url)

/** The real version reader that production activation uses. */
const readProductionVersion = (): string => readManifestVersion(PACKAGE_URL)

/**
 * Classify a resolved home as the default (`~/.dsh`) or a custom override.
 * @param explicit - an explicit harness-home override, mirroring resolveDshHome.
 * @param env - the environment used to read `DSH_HOME`.
 * @returns `'default'` when the home equals the bare `~/.dsh` default, else `'custom'`.
 */
export function parseHomeKind(explicit?: string, env: Record<string, string | undefined> = process.env): 'default' | 'custom' {
  const resolved = resolveDshHome(explicit, env)
  const defaultResolved = resolveDshHome(undefined, {})
  return resolved === defaultResolved ? 'default' : 'custom'
}

/**
 * Deterministic-injection seam for tests: the identity reads instance id,
 * package version, and home kind through these hooks, all restored by the
 * specs' `afterEach`. Production always uses the real defaults.
 */
export const internals: {
  instanceId: string
  readVersion: () => string
  homeKind: (env: Record<string, string | undefined>) => 'default' | 'custom'
} = {
  instanceId: INSTANCE_ID,
  readVersion: readProductionVersion,
  homeKind: env => parseHomeKind(undefined, env),
}

/** The current identity snapshot, materialized from the internals seam. */
export function runtimeIdentity(): RuntimeIdentity {
  return {
    product: DSH_RUNTIME_PRODUCT,
    desktopProtocol: DSH_DESKTOP_PROTOCOL,
    version: internals.readVersion(),
    instanceId: internals.instanceId,
    homeKind: internals.homeKind(process.env),
  }
}

/**
 * Mount the identity route over the real webServer. GET answers the
 * no-store JSON; every other method answers 405 with `allow: GET`.
 * The registration is an effect, so fiber disposal removes the exact route.
 * @param ctx - Cordis context carrying the webServer service.
 */
export function registerRuntimeIdentity(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DSH_RUNTIME_IDENTITY_PATH,
    handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' }).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      }).end(JSON.stringify(runtimeIdentity()))
    },
  }))
}

/**
 * Read the non-empty version from a package.json manifest.
 * @param manifestPath - manifest to read; defaults to this bundle's package.json.
 * @returns the non-empty version string.
 * @throws when the manifest is missing/empty or declares no non-empty version.
 */
export function readPackageVersion(manifestPath?: string): string {
  return readManifestVersion(manifestPath === undefined
    ? PACKAGE_URL
    : new URL(pathToFileURL(manifestPath).href))
}
