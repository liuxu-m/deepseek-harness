# Agent Note: Global image input on the Web profile

Status: proposed

English | [中文](2026-08-14-global-image-web-profile.zh.md)

## Problem

DeepSeek Harness declares image capability as a model property (`inputModalities`) and enforces it in four places: upload admission and model-switch checks in `dsh-host-apiproxy`, the request-time `UNSUPPORTED_CONTENT` check in `dsh-llm-pi-ai`, and the `read_image` capability gate in `dsh-tool-fs`. A pure-text routed model such as `deepseek-v4-flash` therefore cannot receive images in any session, even when an external vision model could describe them.

A user-validated deployment solves this on one machine by patching compiled npm artifacts (`[dsh-patch:global-image]`) and adding a user-level `vision` agent preset that calls MiniMax-M3 through the MiniMax Anthropic-compatible endpoint. The Windows desktop client bundles the current-checkout source and its release rules forbid compiled-artifact patching, so the capability must exist in repository source for the desktop to offer it. The ordinary command-line and browser surfaces must keep working against the same Host and the same default Harness home.

## Proposal

Add a single `globalImage` flag service as the one source of truth. `dsh-web-app` (the browser-surface bundle glue) provides `ctx.provide('globalImage', config.globalImage)`; its `web-runtime` row in `cordis.patch.yml` sets `globalImage: true`, so `dsh --profile web` — the desktop and browser surface — enables the capability by default, and a user patch layer can turn it off. Profiles that do not mount `dsh-web-app` never see the service and keep the existing model-gated semantics.

Three host-side checks gate on the flag instead of duplicating it:

- `dsh-host-apiproxy` upload admission: when the flag is on, an image prompt requires only the durable attachment service; when off, the existing routed-model declaration check stays. The model-switch restriction on sessions that already contain images is skipped when the flag is on.
- `dsh-llm-pi-ai`: the adapter config gains a `resolveGlobalImage` resolver mirroring the existing `resolveAttachments` pattern, wired at plugin apply to `ctx.get('globalImage') === true`. When the routed model does not declare image input and the flag is on, image blocks are stripped into text placeholders carrying the attachment info JSON, tool-result inner images become a vision-tool hint, and the request proceeds; when the flag is off, the existing `UNSUPPORTED_CONTENT` error is preserved.
- `dsh-tool-fs` `read_image`: when the routed model does not declare image input and the flag is on, the gate requires only the durable attachment service instead of an image-capable model.

The `vision` tool itself stays a user-level agent preset under `~/.dsh/.agent-presets/vision/` calling MiniMax-M3 with a `MINIMAX_API_KEY` from the managed credentials document. The desktop shares the default Harness home with ordinary CLI launches, so the preset, credentials, and settings carry over without a second data layer or synchronization.

This proposal partially supersedes two implemented decisions while the flag is on. The strict `read_image` route gate from [the minimal read_image tool note](../../implemented/feature/2026-08-10-minimal-read-image-tool.md) becomes attachment-service-gated, and the no-flatten invariant from [Web multimodal image input and durable attachments](../../implemented/feature/2026-07-22-web-multimodal-image-input-and-durable-attachments.md) gains a flag-gated exception that converts image blocks to text placeholders. Both notes stay active and authoritative because their behavior is unchanged while the flag is off; the flag-off path keeps the strict refusal so a text route's durable history never acquires an image block.

The magic-number sniffing that the user-validated machine also carries for extension-less attachment object paths is deferred and recorded as a known limitation; this port keeps the extension-based media-type resolution.

## Alternatives considered

**Port the changes unconditionally.** This matches the patched machine exactly and needs no config surface. Rejected: it changes model-request semantics for every profile (headless, ACP, JSON-RPC) with no per-profile rollback, and the repository rule keeps opt-in behavior out of shipped defaults.

**Productize the vision tool as a repository package.** A shipped `vision` tool with configurable provider, model, and credential keys would make the desktop work without user setup. Rejected for v1: it adds a provider surface, credential-key wiring, documentation, and snapshots, while the user's validated deployment already works through the user-level preset; the flag service alone unblocks the desktop.

## Acceptance criteria

- `dsh --profile web` admits an image prompt when the routed model declares no image input, and the rejection code `MODEL_DOES_NOT_SUPPORT_IMAGES` never appears while the flag is on.
- A text-model request through `dsh-llm-pi-ai` carries the attachment-info placeholder instead of image bytes, and a later `vision` tool call can consume the placeholder's attachment info.
- `read_image` succeeds for a non-image model while the flag is on and the attachment service exists, and fails with the durable-service error when it does not.
- Every pre-existing `UNSUPPORTED_CONTENT` and model-declaration assertion passes while the flag is absent, so headless and other profiles are unchanged.
- A user patch layer setting `globalImage: false` restores the original model-gated behavior on the Web profile.
- The desktop packaged smoke proves an image-bearing prompt is admitted by the bundled runtime.

## Risks

The strip path changes what a text model actually receives: image bytes become placeholder text, so a session that never calls the vision tool loses the image content silently. The placeholder text instructs the model to call `vision`, which requires the user-level preset and credentials; without them the model sees the placeholder and no image description.

`dsh-llm-pi-ai`'s adapter has no `Context`, so the flag must reach it through the `resolveGlobalImage` resolver wired at plugin apply; a second divergent knob in any of the three packages would break the single-source invariant the flag service exists to provide.
