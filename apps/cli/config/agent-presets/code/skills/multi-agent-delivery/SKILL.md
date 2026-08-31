# Multi-agent delivery

Use this skill when coordinating continuable child agents from a coding session. The skill is guidance for the parent agent; tool permissions and lifecycle checks remain authoritative.

## Dispatch

- Split independent work and dispatch children in parallel with `subagent` or `subagent_fork`.
- Give each child a narrow objective, acceptance criteria, and a request to call `report` at meaningful milestones and before it finishes.
- Keep the child id and responsibility in the working context so later controls target the intended child.

## Observe and receive

- Use `get_agent_status` for an occasional snapshot when progress is unclear; do not busy-poll.
- Use `wait_agent` only when a running child, expected report, settlement notice, or user input can wake the inbox. It does not inspect child state or consume a message.
- When `wait_agent` returns `Wait completed.`, end the current step immediately. The message is claimed at the next step boundary; do not call dependent tools or write a final conclusion in the same step.
- A `report` is a partial update, not a completed child result. Reconcile it with the child's durable transcript and continue the parent plan.

## Correct and stop

- If a child is off course, call `interrupt_agent` first. Then use `steer_agent` with the corrected objective; steering affects the next safe child step and does not rewrite work already claimed.
- Use `send_message` to queue a normal follow-up without waking a parked child, and `followup_task` to queue and wake it. Direct children are eligible for both; deeper descendants are not.
- Call `close_agent` for abandoned or superseded children. Treat the returned receipt as lifecycle admission, not proof that every child turn has already quiesced.
- Keep independent children running while consolidating reports, and close only after their outputs are no longer needed.

## Parent decision

Record each child’s status, report, and settlement notice in the parent decision. Validate files and tests yourself before presenting a final answer; a child message is evidence to evaluate, not an automatic approval.
