# Windows Desktop Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Windows x64 portable `DeepSeek Harness.exe` that embeds the existing Web GUI, carries Node and the current-checkout DSH runtime, shares the default `~/.dsh` with CLI launches, and owns a tray-managed background Host without requiring system development tools at runtime.

**Architecture:** The existing `dsh web` Host remains the sole application and data owner. A repository-owned Tauri 2 process probes a non-sensitive Host identity endpoint, attaches to a compatible external Host or starts the bundled CLI under a kill-on-close Windows Job Object, then points WebView2 and ordinary browsers at the same runtime URL. The CLI receives graceful desktop shutdown through an inherited stdin protocol; release scripts deploy the current workspace dependency closure and assemble an offline portable ZIP.

**Tech Stack:** TypeScript, Cordis, Vitest, Node.js 24, Rust 2021, Tauri 2, WebView2, `windows` crate Win32 process APIs, pnpm deploy, PowerShell integration tests, GitHub Actions Windows runners.

**Design authority:** [Repository-owned Windows desktop host](../../../.agents/notes/proposed/feature/2026-08-14-windows-desktop-host.md) and [Global image on the Web profile](../../../.agents/notes/proposed/feature/2026-08-14-global-image-web-profile.md)

---

## File Structure

- `packages/bundle/web-app/src/runtime-identity.ts` — GET `/api/runtime.identity` route owner.
- `packages/bundle/web-app/tests/runtime-identity.spec.ts` — route, non-disclosure, home-kind, release, and method tests.
- `packages/bundle/web-app/src/index.ts` — mounts the identity route and provides the `globalImage` flag service.
- `packages/bundle/web-app/cordis.patch.yml` — the `web-runtime` row sets `globalImage: true`, making the Web profile the default surface for global image capability.
- `packages/host/apiproxy/src/api-proxy.ts` — image admission and model-switch checks gated by the `globalImage` service.
- `packages/host/apiproxy/tests/global-image.spec.ts` — admission gate tests for flag on/off.
- `packages/llm/llm-pi-ai/src/adapter.ts` — strips image blocks into attachment placeholders when the flag is on.
- `packages/llm/llm-pi-ai/tests/global-image.spec.ts` — strip and preserve tests.
- `packages/fs/tool-fs/src/read-image.ts` — `read_image` capability check gated by the flag.
- `packages/fs/tool-fs/tests/global-image.spec.ts` — capability gate tests.
- `apps/cli/src/parent-control.ts` — one-frame stdin shutdown protocol.
- `apps/cli/tests/parent-control.spec.ts` — fragmented, invalid, EOF, timeout, and duplicate tests.
- `apps/cli/src/profile-boot.ts` — installs parent control before boot.
- `apps/cli/src/bin.ts` — enables it only under `DSH_PARENT_CONTROL=stdin-v1`.
- `apps/desktop/package.json` — workspace deploy root and desktop scripts.
- `apps/desktop/src-tauri/**` — `Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `main.rs`, `lib.rs`, `identity.rs`, `discovery.rs`, `paths.rs`, `windows_job.rs`, `supervisor.rs`, `window.rs`, `tray.rs`, `instance.rs`.
- `apps/desktop/src-tauri/tests/discovery.rs` and `tests/supervisor_windows.rs` — Rust fixture tests.
- `apps/desktop/static/startup-error.html` — startup failure page.
- `apps/desktop/icons/icon.ico` and `icon.png` — migrated desktop assets.
- `scripts/release/desktop-node.json` — pinned Node archive.
- `scripts/release/build-desktop-runtime.ts` — current-checkout deploy.
- `scripts/release/build-desktop-portable.ts` — portable ZIP assembly.
- `scripts/release/desktop-runtime.spec.ts` and `desktop-portable.spec.ts` — artifact-plane tests.
- `scripts/smoke-desktop-portable.ps1` — native packaged acceptance.
- `.github/workflows/desktop-portable.yml` — Windows x64 CI.
- `scripts/desktop-workflow.spec.ts` — workflow policy test.
- `apps/desktop/README.md`, `README.zh.md`, `README.i18n.yaml` — reference docs.
- Root `package.json` — `desktop:test`, `desktop:build`, `desktop:runtime`.
- `scripts/verify-runtime-closure.ts` — generalized closure diagnostic.
- `scripts/verify-runtime-closure.spec.ts` — closure regression coverage.
- `.agents/notes/proposed/feature/2026-08-14-windows-desktop-host*` and `2026-08-14-global-image-web-profile*` — moved to `implemented/feature/` only after Task 15 passes.
- `desktop/` — removed only after the replacement passes the acceptance suite.

## Protocol Constants

Use identical values in TypeScript tests, Rust compatibility tests, and release metadata:

```ts
export const DSH_RUNTIME_PRODUCT = 'deepseek-harness' as const
export const DSH_DESKTOP_PROTOCOL = 1 as const
export const DSH_RUNTIME_IDENTITY_PATH = '/api/runtime.identity' as const
```

The Host response:

```ts
export interface RuntimeIdentity {
  product: typeof DSH_RUNTIME_PRODUCT
  desktopProtocol: typeof DSH_DESKTOP_PROTOCOL
  version: string
  instanceId: string
  homeKind: 'default' | 'custom'
}
```

The private parent-control frame is exactly one UTF-8 JSON line:

```json
{"type":"shutdown","protocol":1}
```

Unknown fields, invalid JSON, frames larger than 1 KiB, protocol other than `1`, and a second frame are launcher errors. EOF without a frame does not stop the Host; the Job Object remains the crash backstop.

### Task 1: Add the Web Host identity endpoint

**Files:**
- Create: `packages/bundle/web-app/src/runtime-identity.ts`
- Create: `packages/bundle/web-app/tests/runtime-identity.spec.ts`
- Modify: `packages/bundle/web-app/src/index.ts`
- Modify: `packages/bundle/web-app/package.json`
- Modify: `packages/bundle/web-app/README.md`, `README.zh.md`, `README.i18n.yaml`

- [ ] **Step 1: Write failing response and route tests**

Table-driven tests call the real registered handler and assert exact JSON:

```ts
it('serves a non-sensitive identity to GET only', async () => {
  const route = captureRuntimeIdentityRoute({
    version: '0.1.0-test',
    instanceId: '7b7da8bb-4e74-4660-b324-6df099d101ea',
    homeKind: 'default',
  })
  const response = await invoke(route, { method: 'GET' })
  expect(response.status).toBe(200)
  expect(response.headers).toMatchObject({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  expect(JSON.parse(response.body)).toEqual({
    product: 'deepseek-harness',
    desktopProtocol: 1,
    version: '0.1.0-test',
    instanceId: '7b7da8bb-4e74-4660-b324-6df099d101ea',
    homeKind: 'default',
  })
  expect(response.body).not.toContain(process.env.USERPROFILE ?? '')
})

it.each(['POST', 'PUT', 'DELETE'])('rejects %s', async method => {
  const response = await invoke(captureRuntimeIdentityRoute(defaultFixture), { method })
  expect(response.status).toBe(405)
  expect(response.headers.allow).toBe('GET')
})
```

Add a `DSH_HOME`-set test asserting only `homeKind: 'custom'`, plus a disposal assertion proving `ctx.fiber.dispose()` removes the exact route.

- [ ] **Step 2: Run the focused test and verify the missing module failure**

```powershell
pnpm exec vitest run packages/bundle/web-app/tests/runtime-identity.spec.ts
```

Expected: FAIL because `../src/runtime-identity.ts` does not exist.

- [ ] **Step 3: Implement the identity owner**

```ts
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defaultDshHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export const DSH_RUNTIME_PRODUCT = 'deepseek-harness' as const
export const DSH_DESKTOP_PROTOCOL = 1 as const
export const DSH_RUNTIME_IDENTITY_PATH = '/api/runtime.identity' as const
const INSTANCE_ID = randomUUID()

export function parseHomeKind(explicit?: string, env: Record<string, string | undefined> = process.env): 'default' | 'custom' {
  const resolved = resolveDshHome(explicit, env)
  const defaultResolved = resolveDshHome(undefined, {})
  return resolved === defaultResolved ? 'default' : 'custom'
}

export function runtimeIdentity(): RuntimeIdentity {
  return {
    product: DSH_RUNTIME_PRODUCT,
    desktopProtocol: DSH_DESKTOP_PROTOCOL,
    version: readPackageVersion(),
    instanceId: INSTANCE_ID,
    homeKind: parseHomeKind(),
  }
}

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
```

Implement `readPackageVersion()` by resolving `../package.json` through `import.meta.url`; require a non-empty string and fail during activation on a malformed manifest. Export an `internals` object for deterministic injection of UUID, version, and environment in tests; restore every hook in `afterEach` for coverage. Call `registerRuntimeIdentity()` inside activation after `webServer` injects. Add `@deepseek-ai/dsh-home-paths` to direct dependencies. Add an `internals` seam only if the test cannot inject values otherwise; production activation always mounts the route.

- [ ] **Step 4: Run focused Host tests**

```powershell
pnpm exec vitest run packages/bundle/web-app/tests/runtime-identity.spec.ts packages/bundle/web-app/tests/web-app.spec.ts
```

Expected: PASS with both files green.

- [ ] **Step 5: Update the bilingual package reference and pairing record**

Document endpoint fields, GET-only, `no-store`, and that no absolute Harness home is returned. Re-record:

```powershell
pnpm run verify-translation-pairing --write packages/bundle/web-app/README.md
```

Expected: both README hashes written to the sidecar.

- [ ] **Step 6: Commit**

```powershell
git add packages/bundle/web-app
git commit -m "feat(web): expose desktop runtime identity"
```

### Task 2: Add the inherited CLI shutdown channel

**Files:**
- Create: `apps/cli/src/parent-control.ts`
- Create: `apps/cli/tests/parent-control.spec.ts`
- Modify: `apps/cli/src/profile-boot.ts`
- Modify: `apps/cli/src/bin.ts`
- Modify: `apps/cli/tests/process-shutdown.spec.ts`
- Modify: `apps/cli/README.md`, `README.zh.md`, `README.i18n.yaml`

- [ ] **Step 1: Write failing parser and lifecycle tests**

Use `PassThrough` streams and fake `ProcessShutdown` methods:

```ts
it('requests one graceful shutdown from a fragmented frame', async () => {
  const input = new PassThrough()
  const shutdown = vi.fn(async () => {})
  const dispose = installParentControl(input, { shutdown, interrupt: vi.fn() })
  input.write('{"type":"shut')
  input.write('down","protocol":1}\n')
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledExactlyOnceWith(0))
  dispose()
})

it.each([
  'not-json\n',
  '{"type":"shutdown","protocol":2}\n',
  '{"type":"other","protocol":1}\n',
  `${'x'.repeat(1025)}\n`,
])('fails loud for invalid frame: %s', async frame => {
  const input = new PassThrough()
  const failure = vi.fn()
  installParentControl(input, fakeShutdown, failure)
  input.end(frame)
  await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce())
})
```

Also prove EOF alone is inert, a second valid frame is rejected, disposal removes listeners, and `runProfile` installs the control before the Loader settles.

- [ ] **Step 2: Verify the tests fail before implementation**

```powershell
pnpm exec vitest run apps/cli/tests/parent-control.spec.ts
```

Expected: FAIL because `parent-control.ts` does not exist.

- [ ] **Step 3: Implement the bounded one-frame reader**

```ts
import { StringDecoder } from 'node:string_decoder'

export const PARENT_CONTROL_ENV = 'DSH_PARENT_CONTROL' as const
export const PARENT_CONTROL_STDIN_V1 = 'stdin-v1' as const
export const PARENT_CONTROL_MAX_BYTES = 1024

export function installParentControl(
  input: NodeJS.ReadableStream,
  shutdown: Pick<ProcessShutdown, 'shutdown' | 'interrupt'>,
  fail: (error: Error) => void = error => { throw error },
): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let bytes = 0
  let settled = false

  const onData = (chunk: Buffer): void => {
    if (settled) return
    bytes += chunk.length
    if (bytes > PARENT_CONTROL_MAX_BYTES) {
      settled = true
      fail(new Error(`parent control frame exceeds ${PARENT_CONTROL_MAX_BYTES} bytes`))
      return
    }
    buffer += decoder.write(chunk)
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    settled = true
    const line = buffer.slice(0, newline).trim()
    if (line.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      fail(new Error('parent control frame is not valid JSON'))
      return
    }
    if (
      typeof parsed !== 'object' || parsed === null
      || (parsed as { type?: unknown }).type !== 'shutdown'
      || (parsed as { protocol?: unknown }).protocol !== 1
    ) {
      fail(new Error(`unsupported parent control frame: ${line}`))
      return
    }
    void shutdown.shutdown(0)
  }
  const onEnd = (): void => { /* EOF without a frame is inert: the Job Object is the crash backstop. */ }
  const onError = (error: Error): void => { fail(error) }

  input.on('data', onData)
  input.on('end', onEnd)
  input.on('error', onError)
  return () => {
    input.removeListener('data', onData)
    input.removeListener('end', onEnd)
    input.removeListener('error', onError)
  }
}
```

A second valid frame is rejected because the first newline settles the reader. Never call `process.exit()` here; timeout and escalation stay in `ProcessShutdown`.

- [ ] **Step 4: Wire the channel before profile boot**

Extend `RunProfileOptions` with optional `parentControl`. Immediately after `createProcessShutdown`, install the listener and dispose it with the tree. In `bin.ts`:

```ts
const parentControl = process.env.DSH_PARENT_CONTROL === PARENT_CONTROL_STDIN_V1
  ? process.stdin
  : undefined

await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: invocation.profile,
  patchFiles: invocation.patches,
  args: invocation.args,
  parentControl,
})
```

Reject any non-empty unknown `DSH_PARENT_CONTROL` value before boot so a typo cannot silently disable desktop shutdown.

- [ ] **Step 5: Run focused CLI lifecycle tests**

```powershell
pnpm exec vitest run apps/cli/tests/parent-control.spec.ts apps/cli/tests/process-shutdown.spec.ts apps/cli/tests/args.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Document and commit**

```powershell
pnpm run verify-translation-pairing --write apps/cli/README.md
git add apps/cli
git commit -m "feat(cli): accept parent-owned graceful shutdown"
```

### Task 3: Add the Web profile global image flag service

**Files:**
- Modify: `packages/bundle/web-app/src/index.ts`
- Modify: `packages/bundle/web-app/cordis.patch.yml`
- Create: `packages/bundle/web-app/tests/global-image.spec.ts`
- Modify: `packages/bundle/web-app/tests/web-app.spec.ts`
- Modify: `packages/bundle/web-app/README.md`, `README.zh.md`, `README.i18n.yaml`
- Create: `.agents/notes/proposed/feature/2026-08-14-global-image-web-profile.md`, `.zh.md`, `.i18n.yaml`

- [ ] **Step 1: Write failing service tests**

The `globalImage` service is the single source of truth the three host-side checks read. Test both the schema default and the shipped patch value:

```ts
it('provides globalImage false by default', async () => {
  const ctx = new Context()
  apply(ctx, new Config({ printUrl: false, surfaceContext: false, trustedHosts: [] }))
  expect(ctx.get('globalImage')).toBe(false)
  await ctx.fiber.dispose()
})

it('provides globalImage true from the shipped web profile patch', async () => {
  // Boot the real Loader composition with the web-app cordis.patch.yml row and
  // assert ctx.get('globalImage') === true, proving the Web profile default.
})
```

Also assert `ctx.fiber.dispose()` removes the service.

- [ ] **Step 2: Run the test and verify the missing service failure**

```powershell
pnpm exec vitest run packages/bundle/web-app/tests/global-image.spec.ts
```

Expected: FAIL because `globalImage` is not provided.

- [ ] **Step 3: Implement the flag service and the Web profile default**

Add to `web-app` `Config`:

```ts
/** System-level image capability: images upload regardless of the routed model and are handled by an external vision tool. */
globalImage: z.boolean().default(false),
```

In `apply`, provide the service alongside the existing runtime values:

```ts
ctx.provide('globalImage', config.globalImage)
```

In `packages/bundle/web-app/cordis.patch.yml`, restate the `web-runtime` row config and add `globalImage: true` with a comment naming the external-vision-tool semantics, so `dsh --profile web` (the desktop and browser surface) enables the capability by default and a user patch layer can turn it off.

- [ ] **Step 4: Run the focused web-app tests**

```powershell
pnpm exec vitest run packages/bundle/web-app/tests/global-image.spec.ts packages/bundle/web-app/tests/web-app.spec.ts packages/bundle/web-app/tests/startup.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Document the flag and record the decision**

Update the bilingual web-app README: `globalImage` config, Web profile default, the external-vision-tool contract, and the reversibility via a later patch layer. Create the proposed Agent Note triplet `2026-08-14-global-image-web-profile` describing the system-level image semantics, the single-flag design, the three gated checks, and the deferred magic-number sniffing parity gap. Re-record pairs:

```powershell
pnpm run verify-translation-pairing --write packages/bundle/web-app/README.md
pnpm run verify-translation-pairing --write .agents/notes/proposed/feature/2026-08-14-global-image-web-profile.md
```

- [ ] **Step 6: Commit**

```powershell
git add packages/bundle/web-app .agents/notes/proposed/feature/2026-08-14-global-image-web-profile*
git commit -m "feat(web): add web-profile global image flag"
```

### Task 4: Gate apiproxy image admission on the flag

**Files:**
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Create: `packages/host/apiproxy/tests/global-image.spec.ts`

- [ ] **Step 1: Write failing admission tests**

Focused handler tests through `createApiProxy` (the established apiproxy harness; `client-handler.spec.ts` is a wire-protocol suite over a scripted impl and cannot exercise admission, and the package has no Loader-booted composition precedent). The Loader/app-process REAL-composition proof for this behavior ships in Task 13's packaged smoke (POST an image-bearing prompt against the bundled runtime and assert the admission code is not `MODEL_DOES_NOT_SUPPORT_IMAGES`).

```ts
it('admits an image prompt when globalImage is on, without an image-capable model', async () => {
  ctx.provide('globalImage', true)
  // POST a prompt containing an image block; expect accepted, never
  // MODEL_DOES_NOT_SUPPORT_IMAGES.
})

it('keeps the model gate when globalImage is off', async () => {
  // Existing behavior: non-image model + image prompt -> attachment-error
  // with reason MODEL_DOES_NOT_SUPPORT_IMAGES.
})

it('allows a model switch in a session with images when globalImage is on', async () => {
  ctx.provide('globalImage', true)
  // selectModel to a non-image model succeeds instead of model-unavailable.
})
```

- [ ] **Step 2: Run the tests and verify they fail**

```powershell
pnpm exec vitest run packages/host/apiproxy/tests/global-image.spec.ts packages/host/apiproxy/tests/client-handler.spec.ts
```

Expected: FAIL because the gate does not consult `globalImage`.

- [ ] **Step 3: Gate both check sites**

In `prompt` admission, keep the existing model-declaration check when the flag is off, and require only the durable attachment service when it is on:

```ts
if (hasImage) {
  if (ctx.get('globalImage') === true) {
    if (ctx.get('attachments') === undefined) {
      return err(request, {
        code: 'attachment-error',
        message: 'Image input requires the durable attachment service.',
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      })
    }
  } else {
    const current = selectionFor(agent).current
    const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model)
    if (modelInfo.inputModalities !== undefined && !modelInfo.inputModalities.includes('image')) {
      return err(request, {
        code: 'attachment-error',
        message: `Model "${current.model}" does not support image input.`,
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      })
    }
  }
}
```

In `selectModel`, skip the whole pending-image restriction when the flag is on:

```ts
if (ctx.get('globalImage') !== true
  && (pendingImage || messagesHaveImage(found.agent.session.deriveMessages()))) {
  // existing resolveModelInfo restriction
}
```

- [ ] **Step 4: Run the focused apiproxy tests**

```powershell
pnpm exec vitest run packages/host/apiproxy/tests/global-image.spec.ts packages/host/apiproxy/tests/client-handler.spec.ts packages/host/apiproxy/tests/api-proxy-config.spec.ts
```

Expected: PASS with the flag on and off paths both covered.

- [ ] **Step 5: Commit**

```powershell
git add packages/host/apiproxy
git commit -m "feat(api): gate image admission on the global image flag"
```

### Task 5: Strip image blocks in llm-pi-ai and relax read_image in tool-fs

**Files:**
- Modify: `packages/llm/llm-pi-ai/src/adapter.ts`
- Modify: `packages/llm/llm-pi-ai/src/index.ts` (wire the resolver where `resolveAttachments` is wired)
- Create: `packages/llm/llm-pi-ai/tests/global-image.spec.ts`
- Modify: `packages/fs/tool-fs/src/read-image.ts`
- Create: `packages/fs/tool-fs/tests/global-image.spec.ts`

- [ ] **Step 1: Write failing strip and gate tests**

For llm-pi-ai, with a non-image model and `resolveGlobalImage: () => true`, assert no `UNSUPPORTED_CONTENT` throw, the pi context contains no image blocks, and the placeholder text names the attachment info JSON. Assert the tool-result inner image becomes the `[Image attachment; use the vision tool to view it]` text. With the resolver absent, assert the existing `UNSUPPORTED_CONTENT` throw is preserved.

For tool-fs, with `globalImage` true and the attachments service present, assert `assertImageCapableRoute` passes for a non-image model; with attachments absent it throws the durable-service error; with the flag off the existing model-declaration error is preserved.

- [ ] **Step 2: Run the tests and verify they fail**

```powershell
pnpm exec vitest run packages/llm/llm-pi-ai/tests/global-image.spec.ts packages/fs/tool-fs/tests/global-image.spec.ts
```

Expected: FAIL because neither package consults the flag.

- [ ] **Step 3: Add the adapter resolver and the strip path**

Mirror the existing `resolveAttachments` pattern in the adapter config:

```ts
resolveGlobalImage?: () => boolean
```

In `stream`, restructure the image branch so a non-image model strips instead of throwing when the resolver returns true:

```ts
const globalImage = this.config.resolveGlobalImage?.() === true
const containsImage = options.messages.some(message => contentHasImage(message.content))
let effectiveMessages = options.messages
let attachments: AttachmentStore | undefined
if (containsImage && !model.input.includes('image')) {
  if (!globalImage) {
    throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
  }
  effectiveMessages = stripImageBlocks(options.messages)
} else if (containsImage) {
  attachments = this.config.resolveAttachments?.()
  if (attachments === undefined) {
    throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
}
const context = attachments === undefined
  ? toPiContext({ ...options, messages: effectiveMessages })
  : await toPiContext({ ...options, messages: effectiveMessages }, attachments)
```

`stripImageBlocks` maps every message: image blocks become `{ type: 'text', text: '[The user uploaded an image. Attachment info <JSON>. The current model cannot see image content; if you need to understand it, call the vision tool and pass the attachment info JSON above to the attachment_info parameter.]' }`; `tool-result` blocks with inner images replace them with `[Image attachment; use the vision tool to view it]`. Wire `resolveGlobalImage: () => ctx.get('globalImage') === true` in the plugin apply beside the `resolveAttachments` wiring.

- [ ] **Step 4: Relax the read_image capability gate**

In `assertImageCapableRoute`, when the routed model does not declare image input, pass when the flag is on and the durable attachment service exists:

```ts
if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
  if (ctx.get('globalImage') !== true) {
    throw new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`)
  }
  if (ctx.get('attachments') === undefined) {
    throw new Error(`cannot read "${requestedPath}" as an image: the durable attachment service is unavailable`)
  }
}
```

- [ ] **Step 5: Run the focused tests plus the pre-existing image suites**

```powershell
pnpm exec vitest run packages/llm/llm-pi-ai/tests/global-image.spec.ts packages/llm/llm-pi-ai/tests/adapter.spec.ts packages/llm/llm-pi-ai/tests/convert.spec.ts packages/llm/llm-pi-ai/tests/context.spec.ts packages/fs/tool-fs/tests/global-image.spec.ts
```

Expected: PASS; every pre-existing `UNSUPPORTED_CONTENT` assertion still passes because the resolver defaults to absent.

- [ ] **Step 6: Record the deferred parity gap and commit**

The user-validated machine also carries magic-number sniffing for extension-less attachment object paths (`patch-readimage-sniff.py`). This port keeps the extension-based `imageMediaTypeForPath`; record the gap in the global-image Agent Note's Known Limitations rather than silently dropping it.

```powershell
git add packages/llm/llm-pi-ai packages/fs/tool-fs
git commit -m "feat(llm,fs): global image strip and read gate"
```

### Task 6: Create the Tauri desktop shell and path owners

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/src-tauri/Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`
- Create: `apps/desktop/src-tauri/src/main.rs`, `lib.rs`, `paths.rs`
- Create: `apps/desktop/static/startup-error.html`
- Create: `apps/desktop/icons/icon.ico`, `icon.png`
- Modify: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Add the workspace deploy root and root commands**

```json
{
  "name": "@deepseek-ai/dsh-desktop",
  "version": "0.1.0-rc.5",
  "private": true,
  "type": "module",
  "files": ["src-tauri", "static", "icons"],
  "dependencies": {
    "@deepseek-ai/dsh": "workspace:^"
  },
  "scripts": {
    "cargo:test": "cargo test --manifest-path src-tauri/Cargo.toml",
    "tauri:build": "cargo tauri build --config src-tauri/tauri.conf.json"
  }
}
```

Root scripts:

```json
"desktop:test": "pnpm --filter @deepseek-ai/dsh-desktop run cargo:test",
"desktop:build": "tsx scripts/release/build-desktop-portable.ts",
"desktop:runtime": "tsx scripts/release/build-desktop-runtime.ts"
```

- [ ] **Step 2: Create the minimal Tauri 2 manifest**

Rust 2021; pin through `Cargo.lock`. `tauri.conf.json` declares no initial window; setup creates the WebView only after the Host URL resolves. Set product name/identifier/icon and `bundle.active: false` (v1 is a portable ZIP, no installer).

- [ ] **Step 3: Write path tests before path implementation**

Inline Rust unit tests assert:

```rust
#[test]
fn portable_resources_are_relative_to_the_executable() {
    let exe = Path::new(r"C:\Portable\DeepSeek Harness\DeepSeek Harness.exe");
    let paths = DesktopPaths::from_roots(
        exe,
        Path::new(r"C:\Users\Ada"),
        Path::new(r"C:\Users\Ada\AppData\Local"),
    ).unwrap();
    assert_eq!(paths.node, Path::new(r"C:\Portable\DeepSeek Harness\node\node.exe"));
    assert_eq!(paths.home, Path::new(r"C:\Users\Ada\.dsh"));
    assert_eq!(paths.cwd, Path::new(r"C:\Users\Ada"));
    assert_eq!(paths.logs, Path::new(r"C:\Users\Ada\AppData\Local\DeepSeek Harness\logs"));
}
```

Reject a missing executable parent; never derive writable state from the extraction directory.

- [ ] **Step 4: Implement the minimal shell and local error page**

`main.rs` holds only the GUI-subsystem attribute and `run()`. `lib.rs` installs opener and single-instance plugins. `startup-error.html` accepts escaped title/detail via query params, has Retry/Open logs/Exit buttons wired to Tauri commands, and contains no copy of the React application.

- [ ] **Step 5: Build and test the native skeleton**

```powershell
pnpm install --lockfile-only
pnpm --filter @deepseek-ai/dsh-desktop run cargo:test
cargo tauri build --config apps/desktop/src-tauri/tauri.conf.json --no-bundle
```

Expected: Rust tests pass; `target/release/deepseek-harness-desktop.exe` exists. Machines without the Tauri CLI use `pnpm --filter @deepseek-ai/dsh-desktop exec tauri build --no-bundle` after adding `@tauri-apps/cli` as a dev dependency.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop package.json pnpm-lock.yaml
git commit -m "feat(desktop): add repository-owned Tauri shell"
```

### Task 7: Implement strict Host discovery

**Files:**
- Create: `apps/desktop/src-tauri/src/identity.rs`, `apps/desktop/src-tauri/src/discovery.rs`
- Create: `apps/desktop/src-tauri/tests/discovery.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write compatibility tests against real loopback fixtures**

```rust
assert_eq!(discover(compatible_url)?, Discovery::Attach { base_url: compatible_url, instance_id: "fixture-instance".into() });
assert_eq!(discover(refused_url)?, Discovery::StartDefault);
assert_eq!(discover(non_dsh_url)?, Discovery::StartDynamic);
assert_eq!(discover(incompatible_protocol_url)?, Discovery::StartDynamic);
assert_eq!(discover(custom_home_url)?, Discovery::StartDynamic);
```

Also cover timeout, malformed JSON, redirect, response over 4 KiB, wrong product, and an identity URL containing a query. Never follow redirects or request non-loopback.

- [ ] **Step 2: Run the Rust test**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test discovery
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement strict wire validation**

```rust
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub product: String,
    pub desktop_protocol: u32,
    pub version: String,
    pub instance_id: String,
    pub home_kind: HomeKind,
}

pub fn compatible(identity: &RuntimeIdentity) -> bool {
    identity.product == "deepseek-harness"
        && identity.desktop_protocol == 1
        && identity.home_kind == HomeKind::Default
        && !identity.version.is_empty()
        && !identity.instance_id.is_empty()
}
```

`discover_default()` probes only `http://127.0.0.1:3080/api/runtime.identity` with a two-second connect/read timeout. Refused -> StartDefault; occupied-but-unverified -> StartDynamic. Never kill or reconfigure the listener.

- [ ] **Step 4: Run discovery tests**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test discovery
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop/src-tauri
git commit -m "feat(desktop): discover compatible web hosts"
```

### Task 8: Build the Windows Job Object process owner

**Files:**
- Create: `apps/desktop/src-tauri/src/windows_job.rs`
- Create: `apps/desktop/src-tauri/tests/supervisor_windows.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write Windows-only child containment tests**

Compile a test helper from the current Rust test binary via argument-selected modes. Cover normal exit, a child waiting for the shutdown frame, a child ignoring it, and a child that spawns a grandchild:

```rust
#[test]
fn closing_the_job_reclaims_child_and_grandchild() {
    let mut owned = spawn_fixture("spawn-grandchild").unwrap();
    let child = owned.pid();
    let grandchild = owned.wait_for_reported_grandchild(TIMEOUT).unwrap();
    drop(owned);
    assert!(wait_until_dead(child, TIMEOUT));
    assert!(wait_until_dead(grandchild, TIMEOUT));
}
```

Also force `AssignProcessToJobObject` failure through an injected Win32 function table and assert the suspended child is terminated before handles close.

- [ ] **Step 2: Verify the test fails**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test supervisor_windows
```

Expected: FAIL because `windows_job.rs` does not exist.

- [ ] **Step 3: Implement suspended spawn and Job assignment**

```rust
let job = create_kill_on_close_job()?;
let pipes = InheritedPipes::create()?;
let process = create_process_suspended(command, args, cwd, env, &pipes)?;
if let Err(error) = assign_process_to_job(job.handle(), process.handle()) {
    process.terminate(1);
    process.close_thread_and_process();
    return Err(error);
}
process.resume_primary_thread()?;
```

Set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` via `SetInformationJobObject(JobObjectExtendedLimitInformation)`. Create stdin/stdout/stderr pipes with only child ends inheritable, `CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT`, assign before `ResumeThread`, retain process and Job handles until the child is reaped. Every error path closes handles exactly once and kills a suspended child before returning.

Expose `OwnedProcess` with `pid()`, `write_control_frame()`, `take_stdout()`, `take_stderr()`, `try_wait()`, `wait(timeout)`, `terminate_tree()`. `Drop` closes the Job handle only after signaling log readers; explicit `terminate_tree()` closes the Job then waits for the process handle so cleanup reaches quiescence.

- [ ] **Step 4: Run Windows process tests**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test supervisor_windows -- --test-threads=1
```

Expected: PASS; no fixture PID remains after the process settles.

- [ ] **Step 5: Commit**

```powershell
git add apps/desktop/src-tauri
git commit -m "feat(desktop): contain the bundled host process tree"
```

### Task 9: Implement Host supervision, readiness, and graceful shutdown

**Files:**
- Create: `apps/desktop/src-tauri/src/supervisor.rs`
- Modify: `apps/desktop/src-tauri/src/windows_job.rs`
- Modify: `apps/desktop/src-tauri/tests/supervisor_windows.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write lifecycle tests for owned and attached states**

```rust
pub enum HostSession {
    Attached { base_url: Url, identity: RuntimeIdentity },
    Owned { base_url: Url, identity: RuntimeIdentity, process: OwnedProcess },
}
```

Proof: attached shutdown performs no process op; owned shutdown writes exactly `{"type":"shutdown","protocol":1}\n`, waits up to five seconds, then closes the Job if still alive. Readiness timeout, early exit, malformed URL, and identity mismatch terminate the owned tree before returning an error.

- [ ] **Step 2: Run the focused tests**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test supervisor_windows -- --test-threads=1
```

Expected: FAIL on unresolved `HostSupervisor`/`HostSession`.

- [ ] **Step 3: Implement spawn args and environment**

Free 3080 spawn:

```text
node\node.exe runtime\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --port 3080
```

Occupied-unverified 3080: replace the port with `0`. Environment:

```text
DSH_HOME=<resolved %USERPROFILE%\.dsh>
DSH_PARENT_CONTROL=stdin-v1
DSH_TELEMETRY_DISABLED=<inherit existing value when present>
```

Working directory `%USERPROFILE%`. Build a scrubbed child env from the desktop process but never log names matching `KEY`/`SECRET`/`TOKEN`/`PASSWORD`.

- [ ] **Step 4: Implement readiness and log drains**

Start stdout/stderr drain threads immediately. Append UTF-8-lossy lines to `%LOCALAPPDATA%\DeepSeek Harness\logs\host.log`, rotating at 5 MiB with two retained files. Parse only a line matching `^dsh web: (http://127\.0\.0\.1:\d+)(?: |$)` as a candidate, then GET identity and require same protocol, default home, non-empty instance id. Startup deadline 120 seconds. Write `desktop.log` with timestamps, ownership, selected URL, child exit code, readiness duration, and shutdown outcome. Never write env contents or response bodies.

- [ ] **Step 5: Implement bounded shutdown**

```rust
pub fn shutdown(&mut self) -> Result<ShutdownOutcome, DesktopError> {
    match self.session.take() {
        Some(HostSession::Attached { .. }) | None => Ok(ShutdownOutcome::Detached),
        Some(HostSession::Owned { mut process, .. }) => {
            process.write_control_frame(b"{\"type\":\"shutdown\",\"protocol\":1}\n")?;
            if process.wait(Duration::from_secs(5))?.is_none() {
                process.terminate_tree()?;
                return Ok(ShutdownOutcome::Forced);
            }
            Ok(ShutdownOutcome::Graceful)
        }
    }
}
```

If writing stdin fails because the child already exited, reap it and report its actual exit status rather than forcing a second termination.

- [ ] **Step 6: Run lifecycle tests**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test supervisor_windows -- --test-threads=1
```

Expected: PASS for graceful, forced, attached, early-exit, readiness-timeout.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/src-tauri
git commit -m "feat(desktop): supervise web host readiness and shutdown"
```

### Task 10: Add the window, tray, and single-instance lifecycle

**Files:**
- Create: `apps/desktop/src-tauri/src/window.rs`, `tray.rs`, `instance.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`, `static/startup-error.html`, `tauri.conf.json`

- [ ] **Step 1: Write command-dispatch unit tests**

Pure enum mapping:

```rust
assert_eq!(TrayCommand::parse("open"), Some(TrayCommand::Open));
assert_eq!(TrayCommand::parse("browser"), Some(TrayCommand::OpenBrowser));
assert_eq!(TrayCommand::parse("logs"), Some(TrayCommand::ViewLogs));
assert_eq!(TrayCommand::parse("exit"), Some(TrayCommand::Exit));
assert_eq!(TrayCommand::parse("unknown"), None);
```

Test a `DesktopController` with fake window, opener, and supervisor ports: close requests prevent-close plus hide; Exit calls supervisor shutdown before exit; attached Exit never terminates a child; a second-instance request during startup is remembered and focused after window creation.

- [ ] **Step 2: Verify lifecycle tests fail**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib tray
```

Expected: FAIL because the modules are absent. (Cargo accepts one test-name filter; `--lib tray` targets the unit-test module.)

- [ ] **Step 3: Create the WebView at the resolved URL**

```rust
WebviewWindowBuilder::new(app, "main", WebviewUrl::External(base_url.clone()))
    .title("DeepSeek Harness")
    .inner_size(1280.0, 820.0)
    .min_inner_size(900.0, 620.0)
    .build()?;
```

Allow navigation only to the resolved `http://127.0.0.1:<port>/` origin; external links open through the system browser. The Web content receives no Tauri shell or filesystem capability.

- [ ] **Step 4: Implement close-to-tray and tray commands**

On `CloseRequested`, call `api.prevent_close()` then hide. Open shows/unminimizes/focuses; Open in browser uses the active URL; View logs opens the LocalAppData directory; Exit disables repeat actions, awaits `HostSupervisor.shutdown()`, then exits. On Windows session end, run the same bounded shutdown with a five-second Host grace plus one-second Job wait, never blocking beyond it.

- [ ] **Step 5: Implement single-instance and startup errors**

Install single-instance before setup; a second launch sends no URL payload, only show/focus. On missing WebView2 or runtime, invalid identity, early exit, or readiness timeout, show a system message box when WebView creation is impossible, otherwise open `startup-error.html` with escaped error code and log path. Retry reruns discovery only after the failed owned tree is confirmed dead.

- [ ] **Step 6: Run native checks**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @deepseek-ai/dsh-desktop exec tauri build --no-bundle
```

Expected: tests pass; EXE builds.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop
git commit -m "feat(desktop): add tray-owned window lifecycle"
```

### Task 11: Build the current-checkout desktop runtime closure

**Files:**
- Create: `scripts/release/build-desktop-runtime.ts`
- Create: `scripts/release/desktop-runtime.spec.ts`
- Modify: `scripts/verify-runtime-closure.ts`
- Create: `scripts/verify-runtime-closure.spec.ts`
- Modify: `apps/desktop/package.json`, `package.json`

- [ ] **Step 1: Write failing deploy-plan and closure tests**

```ts
expect(planDesktopRuntime({ root, stage })).toEqual([
  { command: 'pnpm', args: ['run', 'build'] },
  { command: 'pnpm', args: ['run', 'verify-runtime-closure', '--manifest', 'apps/desktop/package.json'] },
  { command: 'pnpm', args: ['--filter', '@deepseek-ai/dsh-desktop', 'deploy', '--prod', stage] },
])
```

Stage fixtures for a symlink, a missing CLI bin, a mismatched root version, and `[dsh-patch:global-image]`; assert each is rejected with its repository-relative path. A valid fixture must materialize every symlink to regular files.

- [ ] **Step 2: Verify tests fail**

```powershell
pnpm exec vitest run scripts/release/desktop-runtime.spec.ts scripts/verify-runtime-closure.spec.ts
```

Expected: FAIL because the runtime builder does not exist.

- [ ] **Step 3: Generalize closure diagnostics**

Keep `--manifest`; derive every error prefix and missing-peer message from `runtimeName`; include `apps/*` in workspace discovery. The success message reports the manifest path and package count.

- [ ] **Step 4: Implement source-plane build then artifact-plane deploy**

```ts
await run('build current checkout', pnpmBin(), ['run', 'build'])
await run('verify desktop closure', pnpmBin(), [
  'run', 'verify-runtime-closure', '--manifest', 'apps/desktop/package.json',
])
await run('deploy desktop closure', pnpmBin(), [
  '--filter', '@deepseek-ai/dsh-desktop', 'deploy', '--prod', stage,
])
```

After deploy require:

```text
runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html
runtime/node_modules/node-pty/prebuilds/win32-x64/pty.node
```

Root `package.json`, `apps/cli/package.json`, and deployed CLI version must match. Scan staged text artifacts for the prototype patch marker and reject any match. Extract symlink materialization into a shared helper only if a second implementation would duplicate the whole traversal; the helper takes explicit source/destination paths and has its own focused tests.

- [ ] **Step 5: Run tests and a real runtime build**

```powershell
pnpm exec vitest run scripts/release/desktop-runtime.spec.ts scripts/verify-runtime-closure.spec.ts
pnpm run desktop:runtime -- --out dist/desktop/runtime
```

Expected: tests pass; deployed CLI bin and Web dist exist with no symlinks.

- [ ] **Step 6: Commit**

```powershell
git add scripts apps/desktop/package.json package.json
git commit -m "build(desktop): deploy the current workspace runtime"
```

### Task 12: Assemble the portable ZIP and provenance metadata

**Files:**
- Create: `scripts/release/desktop-node.json`
- Create: `scripts/release/build-desktop-portable.ts`
- Create: `scripts/release/desktop-portable.spec.ts`
- Create: `apps/desktop/README.txt`
- Modify: `package.json`, `.gitignore`

- [ ] **Step 1: Pin the Node carrier**

```json
{
  "version": "v24.11.1",
  "archive": "node-v24.11.1-win-x64.zip",
  "baseUrl": "https://nodejs.org/dist/v24.11.1"
}
```

Download the ZIP and official `SHASUMS256.txt`; require exactly one checksum line; verify SHA-256 before extraction. Cache under `dist/desktop/cache`. Write tests for wrong checksum, duplicate line, missing node.exe, and offline failure.

- [ ] **Step 2: Verify the portable tests fail**

```powershell
pnpm exec vitest run scripts/release/desktop-portable.spec.ts
```

Expected: FAIL because the builder does not exist.

- [ ] **Step 3: Implement portable staging**

Assemble exactly:

```text
DeepSeek Harness/
  DeepSeek Harness.exe
  README.txt
  LICENSE
  THIRD_PARTY_NOTICES.txt
  VERSION.json
  node/node.exe
  node/LICENSE
  runtime/package.json
  runtime/node_modules/**
```

Exclude npm, Corepack, headers, Rust artifacts, PDB, source maps, `.env`, `.credentials.yaml`, `.git`, caches, prototype scripts. Run the Tauri no-bundle build before copying the EXE. Generate notices through the repository generator.

- [ ] **Step 4: Generate deterministic metadata**

`VERSION.json`:

```json
{
  "product": "deepseek-harness-desktop",
  "dshVersion": "0.1.0-rc.5",
  "gitCommit": "<40 hex from git rev-parse HEAD>",
  "nodeVersion": "v24.11.1",
  "desktopProtocol": 1,
  "target": "windows-x64",
  "buildTime": "<SOURCE_DATE_EPOCH as RFC 3339 UTC>"
}
```

The angle-bracketed values are generated inputs, not literal output. Require a clean commit unless `--allow-dirty`; release CI never passes it. Sort ZIP entries, normalize timestamps from `SOURCE_DATE_EPOCH`, then write `DeepSeek_Harness_Portable_<dshVersion>_windows_x64.zip.sha256`.

- [ ] **Step 5: Add artifact scans**

Scan all staged text and UTF-16 text for checkout root, `%USERPROFILE%`, `.credentials.yaml` contents, key-name assignments, `[dsh-patch:global-image]`, and the npm prototype version. Reject symlinks/junctions and files outside the allowlist. Confirm bundled CLI/root version equals `VERSION.json`.

- [ ] **Step 6: Run tests and build a development archive**

```powershell
pnpm exec vitest run scripts/release/desktop-portable.spec.ts
pnpm run desktop:build -- --allow-dirty
```

Expected: tests pass; ZIP and `.sha256` under `dist/desktop/output`.

- [ ] **Step 7: Commit**

```powershell
git add scripts/release apps/desktop/README.txt package.json .gitignore
git commit -m "build(desktop): assemble the portable Windows archive"
```

### Task 13: Add packaged Windows acceptance coverage

**Files:**
- Create: `scripts/smoke-desktop-portable.ps1`
- Modify: `apps/desktop/src-tauri/tests/supervisor_windows.rs`
- Create: `.github/workflows/desktop-portable.yml`
- Create: `scripts/desktop-workflow.spec.ts`

- [ ] **Step 1: Write the workflow policy test first**

Assert: runs on `windows-2025`; immutable pnpm install; fixed `SOURCE_DATE_EPOCH`; builds; runs the smoke with no network after artifact assembly; verifies the SHA-256 file; uploads ZIP, checksum, and metadata logs.

- [ ] **Step 2: Run the workflow test**

```powershell
pnpm exec vitest run scripts/desktop-workflow.spec.ts
```

Expected: FAIL because the workflow is absent.

- [ ] **Step 3: Implement the packaged smoke script**

Sequential native checks:

1. Verify ZIP hash; extract into a path containing spaces and CJK characters.
2. Create an isolated user-profile directory and empty LocalAppData without setting `DSH_HOME`.
3. Remove Node, npm, pnpm, Cargo, and Git from the child `PATH`.
4. Start `DeepSeek Harness.exe`; wait up to 120s for `desktop.log` to record an owned `127.0.0.1` URL.
5. GET `/api/runtime.identity` (product/protocol/default home), then GET `/` (must contain `window.__DSH_BOOT__`).
6. Start the EXE again; prove one desktop process and one owned Node Host remain.
7. Send `WM_CLOSE` to the main window; prove desktop process and Host still run and browser HTTP still answers.
8. Terminate the desktop process to simulate a crash; wait until its Node PID and reported descendants are gone.
9. Start a compatible external bundled CLI Host on 3080; launch the desktop; prove `desktop.log` records `attached`; close the desktop through the tested controller path; prove the external PID still runs.
10. Start a non-DSH HTTP fixture on 3080; launch the desktop; prove the owned Host uses another loopback port without stopping the fixture.
11. POST an image-bearing prompt for a fresh session through the API gateway and assert the response is not `MODEL_DOES_NOT_SUPPORT_IMAGES`, proving the Web profile's `globalImage` admission shipped in the bundled runtime. When the isolated profile cannot route a model, assert the admission rejection code is the attachment-service error rather than the model gate.
12. Scan extracted files and logs for credentials, source checkout paths, and prototype patch markers.

Tray Exit itself stays covered by the real `DesktopController` plus real child test in `supervisor_windows.rs`; no test-only production IPC endpoint is added.

- [ ] **Step 4: Add the Windows workflow**

One native Windows job:

```powershell
pnpm install --frozen-lockfile
pnpm exec vitest run packages/bundle/web-app/tests/runtime-identity.spec.ts packages/bundle/web-app/tests/global-image.spec.ts packages/host/apiproxy/tests/global-image.spec.ts packages/llm/llm-pi-ai/tests/global-image.spec.ts packages/fs/tool-fs/tests/global-image.spec.ts apps/cli/tests/parent-control.spec.ts scripts/release/desktop-runtime.spec.ts scripts/release/desktop-portable.spec.ts scripts/desktop-workflow.spec.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm run desktop:build
pwsh -NoProfile -File scripts/smoke-desktop-portable.ps1 -Archive (Get-ChildItem dist/desktop/output/*.zip).FullName
```

Cache pnpm, Cargo registry/git, Rust target, and the verified Node ZIP by lockfile/config hash. Upload the release archive for master/manual dispatch; PR uploads with seven-day retention.

- [ ] **Step 5: Run the policy test and native smoke**

```powershell
pnpm exec vitest run scripts/desktop-workflow.spec.ts
pwsh -NoProfile -File scripts/smoke-desktop-portable.ps1 -Archive (Get-ChildItem dist/desktop/output/*.zip).FullName
```

Expected: workflow test passes; smoke reports each case PASS and exits 0.

- [ ] **Step 6: Commit**

```powershell
git add scripts/smoke-desktop-portable.ps1 scripts/desktop-workflow.spec.ts .github/workflows/desktop-portable.yml apps/desktop/src-tauri/tests
git commit -m "test(desktop): verify portable Windows lifecycle"
```

### Task 14: Document the supported desktop distribution

**Files:**
- Create: `apps/desktop/README.md`, `README.zh.md`, `README.i18n.yaml`
- Modify: `README.md`, `README.zh.md`, `README.i18n.yaml`

- [ ] **Step 1: Write the desktop package reference**

Current behavior only: supported Windows/WebView2 baseline, archive layout, build commands, data and log paths, owned-versus-attached rules, close-to-tray and Exit, runtime identity compatibility, unsigned-development warning, and the packaged smoke command. Custom `DSH_HOME`, installers, auto-update, macOS, and Linux are unsupported in v1.

- [ ] **Step 2: Add a concise root entry**

One Desktop subsection linking `apps/desktop/README.md`; do not duplicate lifecycle or packaging details.

- [ ] **Step 3: Re-record both pairs and run doc gates**

```powershell
pnpm run verify-translation-pairing --write apps/desktop/README.md
pnpm run verify-translation-pairing --write README.md
pnpm run verify-md-wrap
pnpm run verify-md-links
pnpm run verify-doc-budgets
```

Expected: all exit 0.

- [ ] **Step 4: Keep the Agent Note proposed until acceptance is green**

Update only factual wording uncovered during implementation. Run:

```powershell
pnpm run verify-translation-pairing --write .agents/notes/proposed/feature/2026-08-14-windows-desktop-host.md
pnpm run verify-agent-note-format
pnpm run verify-agent-note-classification
```

- [ ] **Step 5: Commit**

```powershell
git add README.md README.zh.md README.i18n.yaml apps/desktop .agents/notes/proposed/feature/2026-08-14-windows-desktop-host*
git commit -m "docs(desktop): document portable distribution"
```

### Task 15: Validate the replacement, retire the prototype, and implement the decision records

**Files:**
- Delete: `desktop/`
- Move: `.agents/notes/proposed/feature/2026-08-14-windows-desktop-host.{md,zh.md,i18n.yaml}` to `implemented/feature/`
- Move: `.agents/notes/proposed/feature/2026-08-14-global-image-web-profile.{md,zh.md,i18n.yaml}` to `implemented/feature/`
- Modify: the moved English and Chinese notes to current-state implemented prose.

- [ ] **Step 1: Run the complete focused verification before deletion**

```powershell
pnpm exec vitest run packages/bundle/web-app/tests/runtime-identity.spec.ts packages/bundle/web-app/tests/global-image.spec.ts packages/bundle/web-app/tests/web-app.spec.ts apps/cli/tests/parent-control.spec.ts apps/cli/tests/process-shutdown.spec.ts packages/host/apiproxy/tests/global-image.spec.ts packages/host/apiproxy/tests/client-handler.spec.ts packages/llm/llm-pi-ai/tests/global-image.spec.ts packages/llm/llm-pi-ai/tests/adapter.spec.ts packages/fs/tool-fs/tests/global-image.spec.ts scripts/verify-runtime-closure.spec.ts scripts/release/desktop-runtime.spec.ts scripts/release/desktop-portable.spec.ts scripts/desktop-workflow.spec.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --test-threads=1
pnpm run build
pnpm run desktop:build
pwsh -NoProfile -File scripts/smoke-desktop-portable.ps1 -Archive (Get-ChildItem dist/desktop/output/*.zip).FullName
```

Expected: every command exits 0. Do not continue if the smoke did not exercise owned, attached, occupied-port, close-to-tray, second-instance, browser, and crash-cleanup paths.

- [ ] **Step 2: Remove the prototype only after Step 1 passes**

Delete `desktop/` in one change, then search:

```powershell
rg -n "desktop[/\\](portable|launch|build)|Pake|dsh-patch:global-image|app[/\\]start\.ps1" --glob '!node_modules/**' .
```

Expected: no live build, documentation, or script points at the removed prototype. Historical rationale inside the active note may name Pake as a rejected alternative.

- [ ] **Step 3: Reclassify the Agent Notes after shipped behavior**

Run the `dsh-archive-agent-notes` workflow. Move both triplets to `implemented/feature`, convert proposal/future wording into present-tense runtime facts, remove the acceptance checklist, retain durable rationale and alternatives. Re-record hashes and run note checks:

```powershell
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-14-windows-desktop-host.md
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-14-global-image-web-profile.md
pnpm run verify-agent-note-format
pnpm run verify-agent-note-classification
pnpm run verify-archived-agent-notes
```

Expected: all exit 0; the single-home and SDK-runtime notes remain active and unmodified.

- [ ] **Step 4: Run final static and artifact checks**

```powershell
pnpm run typecheck
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
git diff --check
```

Expected: all exit 0. Record any pre-existing diagnostic outside the touched surfaces rather than weakening a check.

- [ ] **Step 5: Commit**

```powershell
git add -A desktop .agents/notes apps/desktop scripts package.json README.md README.zh.md README.i18n.yaml
git commit -m "feat(desktop): replace the Pake prototype"
```

- [ ] **Step 6: Verify the committed tree**

```powershell
git status --short
git show --stat --oneline HEAD
Get-FileHash dist/desktop/output/*.zip -Algorithm SHA256
Get-Content dist/desktop/output/*.sha256
```

Expected: clean tree; the commit deletes `desktop/`; computed and recorded archive hashes match.

## Implementation Order and Review Boundaries

Tasks 1-2 form the Host protocol boundary. Tasks 3-5 form the global image capability boundary (Web-profile default on, model-gated elsewhere). Tasks 6-10 form the native lifecycle boundary. Tasks 11-13 form the release and packaged-verification boundary. Tasks 14-15 document and complete migration only after all earlier behavior is demonstrated.

Do not combine these boundaries into one unreviewable commit. Preserve red/green test evidence within each task before committing. Do not remove the prototype, move the Agent Notes to `implemented`, or advertise the ZIP until Task 15 Step 1 passes on native Windows.
