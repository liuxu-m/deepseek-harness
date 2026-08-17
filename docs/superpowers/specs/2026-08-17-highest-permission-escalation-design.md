# Highest-Permission Escalation Compatibility Design

## Goal

Let a model execute an already fully permitted command when it redundantly supplies `sandbox_permissions: "danger-full-access"` and a justification.

## Decision

`approveEscalation()` recognizes only the exact combination of an effective `danger-full-access` mode and a requested `danger-full-access` mode as redundant metadata. It returns the existing mode without requesting approval. Every other non-widening target remains an error, and every lower-mode escalation continues through approval.

## Verification

The shared escalation unit test proves this exception returns the existing mode and makes no approval request. Existing non-widening assertions prove that the fail-closed behavior remains intact.
