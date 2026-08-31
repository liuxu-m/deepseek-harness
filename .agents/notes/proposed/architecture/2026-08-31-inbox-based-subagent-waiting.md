# Agent Note: Inbox-based subagent waiting

Status: proposed

English | [中文](2026-08-31-inbox-based-subagent-waiting.zh.md)

## Problem

Continuable subagents report and settle through their direct parent's Agent inbox, but a parent blocked on that information had no model-visible blocking operation. Polling `list_agents` cannot establish completion and ending a turn without a wait operation leaves scheduling to prompt convention.

## Proposal

`@deepseek-ai/dsh-tool-subagent-control` registers global `wait_agent`. The tool observes only `exec.agent.inbox` and the calling Agent's scoped `agent/inbox/inserted` event. It first checks pending input, subscribes, then synchronously checks again, so a message around subscription is not lost. It never copies or removes a message; agent-loop claims it at the following step boundary.

The optional `timeout_ms` is a safe integer from 0 through 3600000. The tool owns this deadline and `exec.signal`, so it declares no static `ToolDefinition.timeoutMs`; normal expiry returns `Wait timed out.` rather than guard-owned `TOOL_TIMEOUT`. `Wait completed.` tells the model to end its current step because the message contents are not visible until the next one.

The tool remains in the root control plugin to expose it in existing code-pinned compositions without a new Cordis row, accepting the package's existing `subagents` injection even though waiting itself does not inspect that service.

## Alternatives considered

**Reuse experimental Agent Team waiting.** Team activity includes a different roster, mailbox, and task-board model. It would add persistent team state to a continuable-subagent deployment and conflicts on the global tool name.

**Return child output from the wait call.** That duplicates a message already owned by the parent inbox and breaks the single ordering source used by agent-loop.

**Add a separate waiting queue.** A second queue needs durability, ordering, cancellation, and projection rules while the existing inbox already supplies them.

## Acceptance criteria

- Unit tests cover existing and newly inserted inbox messages, timeout, cancellation, cross-Agent isolation, subscription races, disposal, and the timeout-policy composition.
- The generated catalog records normal and experimental `wait_agent` schemas and attributes the normal one to the control package.
- Package documentation states the next-step visibility rule and one-scope duplicate-name limit.
- A Code Mode replay shows parallel delegation followed by inbox-based waiting before the parent consumes the first child report.

## Risks

`wait_agent` can wait until its requested deadline when no useful message will arrive. Persona and Skill guidance must prevent empty waits and must prohibit results-dependent calls in the completed tool step. A deployment must not mount this package with experimental Agent Team in one registry scope.
