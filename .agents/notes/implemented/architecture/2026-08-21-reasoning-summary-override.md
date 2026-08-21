# Agent Note: Per-route `reasoning.summary` / `context` alignment

Status: implemented

English | [中文](2026-08-21-reasoning-summary-override.zh.md)

## Problem

The `llm-pi-ai` OpenAI Responses channel defaults `reasoning.summary` to `"auto"` (pi-ai `buildParams`) **and omits `reasoning.context`**, and the harness exposes no way to change either. A Codex-compatible gateway/upstream (verified 2026-08-21 against the icode.51talk.biz upstream) **requires `summary:"detailed"` AND `context:"all_turns"`**, returning `400 {"message":"Upstream request failed","type":"upstream_error"}` for the harness shape.

**Measured wire diff** (rewrite proxy capturing full bodies — the decisive artifact):

| Source | `reasoning` object | Result |
|---|---|---|
| Stock Codex Desktop | `{ context: "all_turns", effort: "high", summary: "detailed" }` | 200, cached |
| DeepSeek Harness (before fix, `summary:"auto"`) | `{ effort: "high", summary: "auto" }` (no `context`) | 400 upstream_error |
| DeepSeek Harness (after `summary:"detailed"` only) | `{ effort: "high", summary: "detailed" }` (still no `context`) | **400** — confirming `context` is the hard requirement |

So `reasoning.summary` alone was a red herring; the missing `reasoning.context: "all_turns"` is what the upstream enforces. This is not the earlier `userAgentOverride` case (HTTP fingerprints layer): it is a **request-body parameter** rejected by the upstream, which fingerprint spoofing (UA/originator/OpenAI-Beta) cannot mask.

## Key mechanism

Passing `reasoningSummary` through to `streamSimple` at the adapter does not work: pi-ai `buildBaseOptions` (`dist/api/simple-options.js`) forwards a fixed field list and **drops `reasoningSummary`** (the field lives on `OpenAIResponsesOptions` but not `SimpleStreamOptions`, and never reaches `buildParams` at runtime). The correct seam is the **`onPayload` hook**: `openai-responses.js stream()` invokes it after `buildParams` (which sets `summary:"auto"` and no `context`), and its return value becomes the final `params`.

## Decision

Add an optional `reasoningSummary?: 'auto' | 'detailed' | 'concise' | null` to `llm-pi-ai` provider routes. **Explicit opt-in only**: a profile that sets it installs an `onPayload` that rewrites `reasoning.summary` to the configured value **and adds `reasoning.context: "all_turns"`**; one that omits it keeps behavior byte-identical (no `onPayload`, pi-ai default). An icode route sets `reasoningSummary: detailed` in settings.yaml, which brings both `summary` and `context` into alignment with Codex.

## Verification

- `config.spec.ts` asserts legal values (auto/detailed/concise/null) resolve and illegal values throw (schemastery `z.const` enum).
- `sdk-options.spec.ts` mocks `openai-responses.lazy`, asserting the third arg carries `onPayload` when configured and that it rewrites `summary:'auto'` → `'detailed'` **and sets `context:'all_turns'`**; absent when unset.
- Full package tests + package typecheck pass.
- Live icode: after deploy, direct gpt session must converge to 200 (no `upstream_error`) + `cacheReadTokens` hits.

## Alternatives considered

**Globally default `reasoning.summary` to `detailed` (+ context).** Rejected: rewrites the body for every openai-responses route (not all accept it); keeping the harness default is safest and opt-in only for the gateways that need it.

**Exposing `headers`/`compat` to let deployments inject `reasoning` themselves.** Rejected: `onPayload` is the minimal, type-safe seam; no need to leak pi-ai's internal params shape.

## Consequences

Routes that opt in present `reasoning { context:"all_turns", summary:"detailed" }` to their upstream — that is the point; the default stays pi-ai's `{"effort"}`/`"auto"` shape. The field is editable in the client provider config with no process out of band.

## Addendum (2026-08-21): the actual blocking field is `max_output_tokens`

After `reasoning {context, summary}` were aligned and the gateway **still** returned `400 upstream_error`, an offline field-by-field experiment (same model `gpt-5.6-terra`, same key, wire through a capture proxy) isolated the true blocker:

| variant | result |
|---|---|
| Codex shape, **no `max_output_tokens`** | 200 |
| + `max_output_tokens` = 64 / 2048 / 32768 | **400** (all three) |
| minus `text`/`stream_options`/`tool_choice`/`parallel_tool_calls` | 200 |
| minus `reasoning.context` | 200 |
| harness shape (with `max_output_tokens`) | 400 |

So the icode upstream rejects **any** request carrying `max_output_tokens`, regardless of value; Codex omits it. `reasoning.summary`/`context`/`text`/`stream_options` turned out to be irrelevant (V4/V5 still 200).

**Final fix:** add an opt-in profile boolean `omitMaxTokens?: boolean`; when true, the same `onPayload` hook deletes `params.max_output_tokens`. The icode routes set `omitMaxTokens: true` (plus keep `reasoningSummary: detailed` for parity). `reasoning.context` wiring is retained (harmless, Codex-aligned) but no longer claimed as the blocker.
