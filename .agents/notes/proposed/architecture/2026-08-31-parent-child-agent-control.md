# Agent Note: Parent-child agent control workflow

Status: proposed

English | [中文](2026-08-31-parent-child-agent-control.zh.md)

## Problem

Continuable child agents can outlive the parent step that started them. Without a shared coordination workflow, a parent cannot distinguish queued work from an awake follow-up, correct a running child safely, or close abandoned descendants while retaining durable evidence for SDK and UI consumers.

## Proposal

The shipped `code` preset installs the parent control tools and the child-scoped `report` channel, plus a bundled `multi-agent-delivery` skill. The persona and skill direct the parent to dispatch independent work in parallel, request milestone reports, use status snapshots instead of busy polling, wait only for expected inbox messages, and end the current step immediately after `Wait completed.`.

Parent controls have distinct scheduling semantics: `send_message` queues without waking, `followup_task` queues and wakes, and `steer_agent` delivers corrective context at the next safe step. `interrupt_agent` stops only the current turn and preserves queued work and descendants. `close_agent` closes a child subtree under direct-parent or ancestor authority. Durable control, progress, report, and settlement observations remain available to SDK and UI projections without exposing private child prompts or complete transcripts.

The bundled skill root is resolved from the preset's `baseUrl`, so the same composition works from the shipped install and a copied local preset. A local `code-pinned` override is verification-only and is not part of the repository or release artifact.

## Alternatives considered

**Rely on tool descriptions only.** Rejected because the step-boundary rule after `wait_agent` and the interrupt-then-steer ordering are behavioral guardrails that must remain visible in the persona and reusable skill.

**Expose one generic child message operation.** Rejected because queueing, waking, steering, interruption, and closure have different lifecycle effects and authority checks; collapsing them encourages accidental wakeups or false completion assumptions.

**Stream complete child transcripts to the parent.** Rejected because reports and lifecycle notifications provide bounded, selected evidence while durable child sessions remain the recovery record.

## Acceptance criteria

- The shipped `code` preset loads `tool-subagent-report` and resolves its bundled skill directory through `baseUrl`.
- Persona and skill describe parallel dispatch, milestone reports, status snapshots, wait step boundaries, interrupt-then-steer correction, and explicit close behavior.
- English and Chinese package/subsystem documentation describe control distinctions, authority, persistence, report limits, and SDK/UI notification behavior.
- Generated tool catalogs and their source assertions include every shipped control schema without duplicate-source ambiguity.

## Risks

The experimental Agent Teams package defines overlapping global tool names. Deployments must select one control package per registry scope; catalog generation may still show both package sources. A stale local preset can omit the shipped skill or report row, so release verification must exercise the shipped path rather than treating the local override as an artifact.
