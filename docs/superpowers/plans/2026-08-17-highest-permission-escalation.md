# Highest-Permission Escalation Compatibility Implementation Plan

**Goal:** Prevent redundant highest-permission requests from interrupting tool execution while retaining fail-closed escalation for every other invalid request.

**Architecture:** The shared `approveEscalation()` function is the only behavior owner used by shell and filesystem tools. It returns the existing highest mode for the one harmless redundant request before the strict-widening check.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces.

## Task 1: Cover and implement redundant highest-permission handling

**Files:**
- Modify: `packages/sandbox/sandbox/tests/escalation.spec.ts`
- Modify: `packages/sandbox/sandbox/src/escalation.ts`
- Modify: `.agents/notes/implemented/feature/2026-07-06-sandbox.md`
- Modify: `.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md`
- Modify: `.agents/notes/implemented/feature/2026-07-06-sandbox.i18n.yaml`

- [ ] Add a failing test that requests `danger-full-access` while the effective mode is already `danger-full-access`, expects the returned mode, and asserts no approval callback ran.
- [ ] Run `pnpm exec vitest run packages/sandbox/sandbox/tests/escalation.spec.ts` and confirm the new assertion fails because non-widening requests are rejected.
- [ ] Add the exact highest-mode exception in `approveEscalation()` before the strict-widening rejection.
- [ ] Update the owning sandbox Agent Note in both languages and refresh its pairing hash.
- [ ] Re-run the focused test and TypeScript check for the changed sandbox package.
