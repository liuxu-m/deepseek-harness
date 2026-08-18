# Agent Note: Per-profile `User-Agent` override for provider routes

Status: implemented

English | [中文](2026-08-18-per-profile-user-agent-override.zh.md)

## Problem

The mandatory attribution decision (2026-06-21) makes every provider request send the default application identity `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`, and `llm-pi-ai`'s `requestHeaders()` strips any `user-agent` a deployment puts in the profile `headers`. That is correct for public providers. Some internal gateways, however, enforce a specific client-family fingerprint at the HTTP layer *before* the request body is inspected: they reject anything that is not a stock client.

Verified 2026-08-18 against an internal Codex-compatible gateway (`icode.51talk.biz`): requests sent with the harness `user-agent` were refused with 401/403 ("API key is invalid" / "detected abnormal client"). Rewriting only the wire `user-agent` to `codex_cli_rs/<version> (…; arch)` plus adding the `originator: codex_cli_rs` and `OpenAI-Beta: responses=experimental` headers let the exact same pi-ai requests through. Body-level differences (pi-ai's `prompt_cache_key`, `store`, tool-call structure, reasoning fields) did not trigger rejection. So the gate is purely an HTTP client-identity check, and no header the harness sends is configurable per route today.

This obligation is deployment-specific and opt-in. The product-identity mandate should keep applying to every other route.

## Decision

Add one per-profile field to `llm-pi-ai` provider routes: `userAgentOverride?: string`.

- When set, the route's outgoing `user-agent` is exactly that value instead of the default attribution header. Every other header still routes through the existing `headers` field, so a deployment supplies the rest of a client fingerprint (`originator`, `openai-beta`) there.
- When unset, behavior is byte-identical to before: the mandatory `deepseek-harness/<version> (+url)` attribution wins over any profile `headers.user-agent`.
- Empty or newline-containing values are refused at `resolveProfiles` (header-injection guard).
- Discovery (`GET /models`) keeps the default attribution: it is not a model request and needs no client fingerprint.

This is the white-label hook the attribution Agent Note already anticipated (`attributionHeaders(identity)`), now plumbed per provider. It deliberately does not suppress attribution globally and cannot weaken other providers.

## Verification

- `config.spec.ts` asserts a single-line override resolves and empty/newline values throw.
- `adapter.spec.ts` asserts the wire `user-agent` equals the override and sibling headers (`originator`, `openai-beta`) reach the wire; the existing "Harness attribution wins" test still passes unchanged (no override → default UA).
- Wire summary for the icode case (stage 1 = override + originator + OpenAI-Beta) was `POST /v1/responses -> 200` across a full conversation, where the identical request previously drew 403.

## Alternatives considered

**Honor `headers.user-agent` directly.** Rejected as confusing: a header-name collision rule flip would silently change every route that happened to carry a `user-agent`, and the attribution mandate advertises that name as reserved. A dedicated field makes the override an explicit route decision.

**Global `APP_IDENTITY` override (env or setting).** Rejected: changes identity for every provider, not just the gateway that needs it.

**Ship the external rewriting proxy as a Harness plugin.** Rejected for this change: the harness has no outbound-request interception seam; a proxy is process out-of-band, while a config field is visible, editable in the client, and needs no extra process.

## Consequences

Providers see traffic from deployments that opt into an alternate client identity — that is the point; the default stays honest product attribution. Merging stays deterministic: when the override is set, the profile may no longer collide with the single `user-agent` the override owns (the reserved-name filter still drops any duplicate). Porting to a fresh checkout is a config-file change plus the released package.