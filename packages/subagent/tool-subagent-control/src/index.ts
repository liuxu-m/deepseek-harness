/**
 * The globally named `send_message` and `interrupt_agent` tools: thin
 * model-facing adapters over `ctx.subagents.followup()` and
 * `ctx.subagents.interrupt()`. They perform no lifecycle routing of their own —
 * residency, cold resume, and interrupt authorization belong to the subagent
 * service — and they live apart from the provider-bound
 * `@deepseek-ai/dsh-tool-subagent` instances so multiple delegation tools share
 * one control API.
 * @module @deepseek-ai/dsh-tool-subagent-control
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents']

const DEFAULT_WAIT_TIMEOUT_MS = 120_000
const MAX_WAIT_TIMEOUT_MS = 3_600_000

interface WaitAgentArgs {
  timeout_ms?: number
}

interface WaitAgentResult {
  timedOut: boolean
  message: 'Wait completed.' | 'Wait timed out.'
}

/** Resolve the model request into the bounded wait duration used by the tool. */
function resolveWaitTimeout(args: WaitAgentArgs): number {
  const timeoutMs = args.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer from 0 through ${MAX_WAIT_TIMEOUT_MS}`)
  }
  return timeoutMs
}

/** Resolve when inbox work is pending, its caller-owned deadline expires, or cancellation wins. */
function waitForInbox(agent: Agent, timeoutMs: number, signal: AbortSignal): Promise<WaitAgentResult> {
  if (agent.inbox.hasPending) return Promise.resolve({ timedOut: false, message: 'Wait completed.' })
  signal.throwIfAborted()

  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposeInboxListener: (() => void) | undefined

    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      disposeInboxListener?.()
      signal.removeEventListener('abort', onAbort)
      finish()
    }
    const onAbort = (): void => {
      settle(() => { reject(signal.reason) })
    }
    const onInboxInserted = (): void => {
      settle(() => { resolve({ timedOut: false, message: 'Wait completed.' }) })
    }

    signal.addEventListener('abort', onAbort, { once: true })
    disposeInboxListener = agent.ctx.on('agent/inbox/inserted', onInboxInserted)
    if (signal.aborted) onAbort()
    else if (agent.inbox.hasPending) onInboxInserted()
    else {
      timer = setTimeout(() => {
        settle(() => { resolve({ timedOut: true, message: 'Wait timed out.' }) })
      }, timeoutMs)
    }
  })
}

/**
 * Register the `send_message` and `interrupt_agent` tools.
 * @param ctx - context carrying the tool registry and subagent service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'wait_agent',
    description:
      'Wait until a new message is pending for your next step, or until timeout_ms expires. This does not '
      + 'read, return, or remove the message. When it returns Wait completed., end this step immediately: '
      + 'the message becomes visible in the next step.',
    parameters: {
      timeout_ms: {
        type: 'integer',
        description: `Maximum milliseconds to wait. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timedOut: { type: 'boolean', required: true },
          message: { type: 'string', required: true, enum: ['Wait completed.', 'Wait timed out.'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args: WaitAgentArgs, exec): Promise<WaitAgentResult> {
      const agent = exec.agent
      if (!agent) {
        throw new Error('wait_agent requires a calling agent (exec.agent was undefined)')
      }
      return waitForInbox(agent, resolveWaitTimeout(args), exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'send_message',
    description:
      'Send a message to a background subagent by its subagent id, continuing the same conversation. It '
      + 'becomes the subagent\'s next turn: if it is still working, the message waits until its current turn '
      + 'finishes, so it cannot redirect work already underway. This call returns no answer from the '
      + 'subagent — only confirmation that the message was delivered — so use it to give it more work. A '
      + 'failure means the message was NOT delivered.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The subagent id returned when the background subagent was started.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the subagent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `message queued as the next turn for subagent ${args.subagent_id}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Parent authority requires an exact live calling agent.
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const messageId = await ctx.subagents.followup(
        parent,
        SessionId(args.subagent_id),
        message,
        {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        },
      )
      return { messageId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Request cancellation of a background agent\'s current turn by its agent id. The target may be your '
      + 'direct child or a deeper agent created under you. Only the current turn stops: messages already '
      + 'queued for the agent stay parked until a later send_message, agents it started keep running, and '
      + 'the agent itself stays available for follow-ups. This call returns as soon as the stop request is '
      + 'accepted, so the target may keep running briefly; interrupting an agent that already finished is '
      + 'an accepted no-op.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of the running agent to interrupt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `interrupt requested for agent ${args.agent_id}`,
      }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        // Ancestor authority requires an exact live calling agent.
        throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      }
      // The service authorizes the exact live caller against the target's
      // recorded lineage; the tool adds no authority of its own.
      ctx.subagents.interrupt(SessionId(args.agent_id), { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))
}
