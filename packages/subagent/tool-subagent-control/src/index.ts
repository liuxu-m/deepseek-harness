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
import type {
  SubagentControlResult,
  SubagentStatusSnapshot,
} from '@deepseek-ai/dsh-subagent'

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
    // oxlint-disable-next-line prefer-const -- listener registration can synchronously invoke the callback.
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
    if (settled) {
      disposeInboxListener?.()
      disposeInboxListener = undefined
    }
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
 * Register parent-to-child control tools.
 * @param ctx - context carrying the tool registry and subagent service.
 */
export function apply(ctx: Context): void {
  const requireCaller = (name: string, agent: Agent | undefined): Agent => {
    if (!agent) throw new Error(`${name} requires a calling agent (exec.agent was undefined)`)
    return agent
  }

  const controlSchema = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requestId: { type: 'string', required: true },
        agentId: { type: 'string', required: true },
        accepted: { type: 'boolean', required: true },
        messageId: { type: 'string' },
        effectiveStep: { type: 'string', enum: ['next-step'] },
        previousState: { type: 'string' },
      },
    } as const,
  }
  const renderControlResult = (args: { agent_id?: string; subagent_id?: string }, value: SubagentControlResult) => [{
    type: 'text' as const,
    text: value.accepted
      ? `request accepted for subagent ${args.agent_id ?? args.subagent_id}`
      : `request rejected for subagent ${args.agent_id ?? args.subagent_id}`,
  }]

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
    description: 'Queue a message as the subagent next turn without waking it. Use followup_task to queue and wake it.',
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
      ...controlSchema,
      render: renderControlResult,
    },
    async execute(args, exec) {
      const parent = requireCaller('send_message', exec.agent)
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      return ctx.subagents.queue(
        parent,
        SessionId(args.subagent_id),
        message,
        {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'followup_task',
    description: 'Queue a message for a background subagent and wake it to process the next turn.',
    parameters: {
      subagent_id: { type: 'string', required: true, description: 'The target subagent id.' },
      message: { type: 'string', required: true, description: 'The message to deliver.' },
    },
    output: { ...controlSchema, render: renderControlResult },
    async execute(args, exec) {
      const parent = requireCaller('followup_task', exec.agent)
      return ctx.subagents.followup(parent, SessionId(args.subagent_id), [{ type: 'text', text: args.message }], {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }, signal: exec.signal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'steer_agent',
    description: 'Deliver a message to a running subagent at its next safe step.',
    parameters: {
      agent_id: { type: 'string', required: true, description: 'The target subagent id.' },
      message: { type: 'string', required: true, description: 'The steering message.' },
    },
    output: { ...controlSchema, render: renderControlResult },
    async execute(args, exec) {
      const parent = requireCaller('steer_agent', exec.agent)
      if (SessionId(args.agent_id) === parent.id) throw new Error('steer_agent cannot steer the root or calling agent')
      return ctx.subagents.steer(parent, SessionId(args.agent_id), [{ type: 'text', text: args.message }], {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }, signal: exec.signal,
      })
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
      ...controlSchema,
      render: (args, _value) => [{
        type: 'text',
        text: `interrupt requested for agent ${args.agent_id}`,
      }],
    },
    execute(args, exec) {
      const caller = requireCaller('interrupt_agent', exec.agent)
      // The service authorizes the exact live caller against the target's
      // recorded lineage; the tool adds no authority of its own.
      return Promise.resolve(ctx.subagents.interrupt(SessionId(args.agent_id), { kind: 'ancestor', agent: caller }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'close_agent',
    description: 'Close a subagent and, by default, its owned descendants.',
    parameters: {
      agent_id: { type: 'string', required: true, description: 'The target subagent id.' },
      cascade: { type: 'boolean', default: true, description: 'Close descendants as well; defaults to true.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          requestId: { type: 'string', required: true }, agentId: { type: 'string', required: true },
          accepted: { type: 'boolean', required: true }, closedAgentIds: { type: 'array', items: { type: 'string' }, required: true },
          previousState: { type: 'string', required: true }, noOp: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text', text: `closed ${value.closedAgentIds.length} subagent(s) from ${args.agent_id}`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaller('close_agent', exec.agent)
      const authority = { kind: 'ancestor' as const, agent: caller, cascade: true as const }
      const options = args.cascade === undefined ? undefined : { cascade: args.cascade }
      const result = await ctx.subagents.close(SessionId(args.agent_id), authority, options)
      return { ...result, closedAgentIds: [...result.closedAgentIds] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_agent_status',
    description: 'Read the current status snapshot for an authorized subagent.',
    parameters: { agent_id: { type: 'string', required: true, description: 'The target subagent id.' } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          agentId: { type: 'string', required: true }, parentSessionId: { type: 'string', required: true },
          state: { type: 'string', required: true, enum: ['running', 'idle', 'ready', 'completed', 'failed', 'interrupted', 'closed'] }, pendingMessageCount: { type: 'integer', required: true },
          currentTurnId: { type: 'string' }, phase: { type: 'string' }, lastActivityAt: { type: 'number' },
          lastReport: { type: 'string' }, stopReason: { type: 'string' },
        },
      },
      render: (_args, value: SubagentStatusSnapshot) => [{ type: 'text', text: `subagent ${value.agentId} is ${value.state}` }],
    },
    async execute(args, exec) {
      const caller = requireCaller('get_agent_status', exec.agent)
      return ctx.subagents.status(caller, SessionId(args.agent_id))
    },
  }))
}
