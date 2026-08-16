# Agent Note: Global image input on the Web profile

Status: implemented

English | [中文](2026-08-14-global-image-web-profile.zh.md)

## Problem

DeepSeek Harness declares image capability as a model property (`inputModalities`) and enforces it in four places: upload admission and model-switch checks in `dsh-host-apiproxy`, the request-time `UNSUPPORTED_CONTENT` check in `dsh-llm-pi-ai`, and the `read_image` capability gate in `dsh-tool-fs`. A pure-text routed model such as `deepseek-v4-flash` therefore cannot receive images in any session, even when an external vision model could describe them.

A user-validated deployment solves this on one machine by patching compiled npm artifacts (`[dsh-patch:global-image]`) and adding a user-level `vision` agent preset that calls MiniMax-M3 through the MiniMax Anthropic-compatible endpoint. The Windows desktop client bundles the current-checkout source and its release rules forbid compiled-artifact patching, so the capability must exist in repository source for the desktop to offer it. The ordinary command-line and browser surfaces keep working against the same Host and the same default Harness home.

## Decision

A single `globalImage` flag service is the one source of truth. `dsh-web-app` (the browser-surface bundle glue) provides `ctx.provide('globalImage', config.globalImage)` with the exported constant `GLOBAL_IMAGE_SERVICE = 'globalImage'`; its schema default is `false`. The `web-runtime` row in `cordis.patch.yml` sets `globalImage: true`, so `dsh --profile web` — the desktop and browser surface — enables the capability by default, and a user patch layer can turn it off. Profiles that do not mount `dsh-web-app` never see the service and keep the existing model-gated semantics.

Three host-side checks gate on the flag instead of duplicating it:

- `dsh-host-apiproxy` upload admission: when the flag is on, an image prompt requires only the durable attachment service; when off, the existing routed-model declaration check stays, rejecting with `MODEL_DOES_NOT_SUPPORT_IMAGES`. The model-switch restriction on sessions that already contain images is skipped when the flag is on.
- `dsh-llm-pi-ai` adapter: a `resolveGlobalImage` resolver mirrors the existing `resolveAttachments` pattern and is wired at plugin apply to `ctx.get('globalImage') === true`. When the routed model does not declare image input and the flag is on, image blocks are stripped into text placeholders carrying the attachment-info JSON (the pinned placeholder constants `STRIPPED_IMAGE_HINT`, `STRIPPED_IMAGE_PREFIX/SUFFIX`), tool-result inner images become a vision-tool hint, and the request proceeds; when the flag is off, the existing `UNSUPPORTED_CONTENT` error is preserved.
- `dsh-tool-fs` `read_image`: when the routed model does not declare image input and the flag is on, the gate requires only the durable attachment service instead of an image-capable model.

The `vision` tool stays a user-level agent preset under `~/.dsh/.agent-presets/vision/` calling MiniMax-M3 with a `MINIMAX_API_KEY` from the managed credentials document; it is not productized into a repository package (v1 scope). The desktop shares the default Harness home with ordinary CLI launches, so the preset, credentials, and settings carry over without a second data layer or synchronization.

The flag partially supersedes two implemented decisions while on. The strict `read_image` route gate from [the minimal read_image tool note](../../implemented/feature/2026-08-10-minimal-read-image-tool.md) becomes attachment-service-gated, and the no-flatten invariant from [Web multimodal image input and durable attachments](../../implemented/feature/2026-07-22-web-multimodal-image-input-and-durable-attachments.md) gains a flag-gated exception that converts image blocks to text placeholders. Both notes stay active and authoritative because their behavior is unchanged while the flag is off; the flag-off path keeps the strict refusal so a text route's durable history never acquires an image block.

Known limitation (deferred): the magic-number sniffing that the user-validated machine carries for extension-less attachment object paths is not ported; the extension-based `imageMediaTypeForPath` resolution is retained.

## Alternatives considered

**Port the changes unconditionally.** This matches the patched machine exactly and needs no config surface. Rejected: it changes model-request semantics for every profile (headless, ACP, JSON-RPC) with no per-profile rollback, and the repository rule keeps opt-in behavior out of shipped defaults.

**Productize the vision tool as a repository package.** A shipped `vision` tool with configurable provider, model, and credential keys would make the desktop work without user setup. Rejected for v1: it adds a provider surface, credential-key wiring, documentation, and snapshots, while the user's validated deployment already works through the user-level preset; the flag service alone unblocks the desktop.

## Testing

The desktop packaged smoke (`scripts/smoke-desktop-portable.ps1` check 11) POSTs an image-bearing prompt through the API gateway and asserts the response is not `MODEL_DOES_NOT_SUPPORT_IMAGES`, proving the Web profile's `globalImage` admission shipped in the bundled runtime. The unit suites pin the flag-off path unchanged: the pre-existing `UNSUPPORTED_CONTENT` and model-declaration assertions pass with the flag absent, so headless and other profiles are unaffected, and the model-switch and admission checks cover the flag-on behavior.

## Consequences

- The strip path changes what a text model actually receives: image bytes become placeholder text, so a session that never calls the vision tool loses the image content silently. The placeholder text instructs the model to call `vision`, which requires the user-level preset and credentials; without them the model sees the placeholder and no image description.
- `dsh-llm-pi-ai`'s adapter has no `Context`, so the flag reaches it through the `resolveGlobalImage` resolver wired at plugin apply; a second divergent knob in any of the three packages would break the single-source invariant the flag service exists to provide.
