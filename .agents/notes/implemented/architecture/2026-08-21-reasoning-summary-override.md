# Agent Note: Per-route `reasoning.summary` override

Status: implemented

English | [中文](2026-08-21-reasoning-summary-override.zh.md)

## Problem

The `llm-pi-ai` OpenAI Responses channel defaults `reasoning.summary` to `"auto"` (pi-ai `buildParams`) and the harness exposes no way to change it. Some Codex-compatible gateways (verified 2026-08-21 against the icode.51talk.biz upstream) **only accept `"detailed"`**, returning `400 {"message":"Upstream request failed","type":"upstream_error"}` for `"auto"`.

**Measured wire diff** (rewrite proxy comparing Codex vs harness; every other header/body field identical):

| Source | `reasoning.summary` | Result |
|---|---|---|
| Stock Codex Desktop | `"detailed"` | 200, cached |
| DeepSeek Harness | `"auto"` | 400 upstream_error |

This is not the earlier `userAgentOverride` case (HTTP fingerprints layer): it is a **request-body parameter** rejected by the upstream, which fingerprint spoofing (UA/originator/OpenAI-Beta) cannot mask.

## Key mechanism

Passing `reasoningSummary` through to `streamSimple` at the adapter does not work: pi-ai `buildBaseOptions` (`dist/api/simple-options.js`) forwards a fixed field list and **drops `reasoningSummary`** (the field lives on `OpenAIResponsesOptions` but not `SimpleStreamOptions`, and never reaches `buildParams` at runtime). The correct seam is the **`onPayload` hook**: `openai-responses.js stream()` invokes it after `buildParams` (which sets `summary:"auto"`), and its return value becomes the final `params`.

## Decision

Add an optional `reasoningSummary?: 'auto' | 'detailed' | 'concise' | null` to `llm-pi-ai` provider routes. **Explicit opt-in only**: a profile that sets it installs an `onPayload` rewriting the emitted `reasoning.summary`; one that omits it keeps behavior byte-identical (no `onPayload`, default `"auto"`). An icode route sets `reasoningSummary: detailed` in settings.yaml to match Codex.

## Verification

- `config.spec.ts` asserts legal values (auto/detailed/concise/null) resolve and illegal values throw (schemastery `z.const` enum).
- `sdk-options.spec.ts` mocks `openai-responses.lazy`, asserting the third arg carries `onPayload` when configured and rewrites `summary:'auto'` → `'detailed'`; absent when unset.
- Full package: 220 tests pass, package typecheck passes.
- Live icode: direct gpt session converges to 200 + `cacheReadTokens` hits.

## Alternatives considered

**Globally default `reasoning.summary` to `detailed`.** Rejected: rewrites the body for every openai-responses route (not all accept detailed); keeping the harness default is safest and opt-in only for the gateways that need it.

**Exposing `headers`/`compat` to let deployments inject `reasoning` themselves.** Rejected: `onPayload` is the minimal, type-safe seam; no need to leak pi-ai's internal params shape.

## Consequences

Routes that opt in present `summary:"detailed"` to their upstream — that is the point; the default stays pi-ai's `"auto"`. The field is editable in the client provider config with no process out of band.
