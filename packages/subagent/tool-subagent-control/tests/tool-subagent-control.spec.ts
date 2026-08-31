import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'
import { parkParent } from './park-parent.ts'

/** One scripted response that may wait on a caller-released gate before streaming. */
interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<undefined>
}

/** Adapter whose entries can hold a model call open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const testToolSignal = new AbortController().signal

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setupWith(adapter: MockAdapter | GatedAdapter) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-subagent-control-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  return { ctx, parent, adapter }
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  return setupWith(new MockAdapter(script))
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: unknown,
  signal: AbortSignal = testToolSignal,
) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

/** Wait until a child's Activation released its handle. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

describe('dsh-tool-subagent-control', () => {
  it('registers wait_agent without a static timeout and with optional timeout_ms', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'wait_agent')
    expect(schemas).toHaveLength(1)
    const props = (schemas[0]!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['timeout_ms'])
    expect(ctx.tools.get('wait_agent')?.timeoutMs).toBeUndefined()
  })

  it('returns immediately without consuming an already pending inbox message', async () => {
    const { ctx, parent } = await setup([])
    parent.inbox.append('next-step', createUserMessage({
      content: [{ type: 'text', text: 'already pending' }],
      source: { kind: 'user' },
    }))

    const result = await callTool(ctx, 'wait_agent', {}, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Wait completed.')
    expect(parent.inbox.nextStep).toHaveLength(1)
  })

  it('fails loud without a calling agent', async () => {
    const { ctx } = await setup([])

    const result = await callTool(ctx, 'wait_agent', {})

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('wait_agent requires a calling agent')
  })

  it('returns an abort result when its execution signal is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    const { ctx, parent } = await setup([])

    const result = await callTool(ctx, 'wait_agent', {}, parent, controller.signal)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('tool call aborted before dispatch')
  })

  it('rejects a negative timeout instead of treating it as an immediate timer', async () => {
    const { ctx, parent } = await setup([])

    const result = await callTool(ctx, 'wait_agent', { timeout_ms: -1 }, parent)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('timeout_ms must be an integer from 0 through 3600000')
  })

  it('rejects a non-integer timeout through the tool schema', async () => {
    const { ctx, parent } = await setup([])

    const result = await callTool(ctx, 'wait_agent', { timeout_ms: 1.5 }, parent)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('"timeout_ms" must be an integer')
  })

  it.each([3_600_001, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid timeout_ms value %s',
    async (timeout_ms) => {
      const { ctx, parent } = await setup([])

      const result = await callTool(ctx, 'wait_agent', { timeout_ms }, parent)

      expect(result.isError).toBe(true)
      expect(text(result)).toContain('timeout_ms must be an integer from 0 through 3600000')
    },
  )

  it('returns its normal timeout result when no inbox message arrives', async () => {
    const { ctx, parent } = await setup([])

    const result = await callTool(ctx, 'wait_agent', { timeout_ms: 0 }, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Wait timed out.')
    expect(parent.inbox.hasPending).toBe(false)
  })

  it('does not wake for another agent inbox activity', async () => {
    const { ctx, parent } = await setup([])
    const stranger = ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })
    const pending = callTool(ctx, 'wait_agent', { timeout_ms: 1_000 }, parent)

    stranger.inbox.append('next-step', createUserMessage({
      content: [{ type: 'text', text: 'not for parent' }],
      source: { kind: 'user' },
    }))
    await Promise.resolve()
    expect(parent.inbox.hasPending).toBe(false)

    parent.inbox.append('next-step', createUserMessage({
      content: [{ type: 'text', text: 'for parent' }],
      source: { kind: 'user' },
    }))
    expect(text(await pending)).toBe('Wait completed.')
  })

  it('returns an error on execution cancellation and ignores a later inbox insertion', async () => {
    const controller = new AbortController()
    const { ctx, parent } = await setup([])
    const on = vi.spyOn(parent.ctx, 'on')
    const pending = callTool(ctx, 'wait_agent', { timeout_ms: 1_000 }, parent, controller.signal)

    await vi.waitFor(() => {
      expect(on.mock.calls.some(([event]) => event === 'agent/inbox/inserted')).toBe(true)
    })
    controller.abort(new Error('cancelled by test'))
    const result = await pending
    parent.inbox.append('next-step', createUserMessage({
      content: [{ type: 'text', text: 'after cancellation' }],
      source: { kind: 'user' },
    }))

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cancelled by test')
    expect(parent.inbox.nextStep).toHaveLength(1)
    on.mockRestore()
  })

  it('keeps its parameterized timeout when timeout policy is installed', async () => {
    const { ctx, parent } = await setup([])
    await ctx.plugin(TimeoutPolicy)

    const result = await callTool(ctx, 'wait_agent', { timeout_ms: 0 }, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Wait timed out.')
  })

  it('waits for the calling agent inbox without consuming its inserted message', async () => {
    const { ctx, parent } = await setup([])
    const pending = callTool(ctx, 'wait_agent', { timeout_ms: 1_000 }, parent)
    await vi.waitFor(() => { expect(parent.inbox.hasPending).toBe(false) })
    const message = createUserMessage({
      content: [{ type: 'text', text: 'child settled' }],
      source: { kind: 'user' },
    })

    parent.inbox.append('next-step', message)

    const result = await pending
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Wait completed.')
    expect(parent.inbox.nextStep).toEqual([message])
  })

  it('rechecks inbox after subscription when a message arrives during listener setup', async () => {
    const { ctx, parent } = await setup([])
    const originalOn = parent.ctx.on.bind(parent.ctx)
    const on = vi.spyOn(parent.ctx, 'on').mockImplementationOnce((event, listener) => {
      const dispose = originalOn(event as never, listener as never)
      parent.inbox.append('next-step', createUserMessage({
        content: [{ type: 'text', text: 'during subscription' }],
        source: { kind: 'user' },
      }))
      return dispose
    })

    const result = await callTool(ctx, 'wait_agent', { timeout_ms: 1_000 }, parent)

    expect(text(result)).toBe('Wait completed.')
    expect(parent.inbox.nextStep).toHaveLength(1)
    on.mockRestore()
  })

  it('settles cancellation when its signal aborts during listener setup', async () => {
    const controller = new AbortController()
    const { ctx, parent } = await setup([])
    const originalOn = parent.ctx.on.bind(parent.ctx)
    const on = vi.spyOn(parent.ctx, 'on').mockImplementationOnce((event, listener) => {
      const dispose = originalOn(event as never, listener as never)
      controller.abort(new Error('cancelled during subscription'))
      return dispose
    })

    const result = await callTool(ctx, 'wait_agent', { timeout_ms: 1_000 }, parent, controller.signal)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cancelled during subscription')
    on.mockRestore()
  })

  it('registers send_message once, globally, with the two required parameters', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'send_message')
    expect(schemas).toHaveLength(1)
    const props = (schemas[0]!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['message', 'subagent_id'])
    // The continuable path has no Task, so the schema must not promise one.
    expect(schemas[0]!.description).not.toContain('job_output')
    expect(schemas[0]!.description).not.toContain('job id')
    // Follow-up ordering is model-visible: it cannot redirect the open turn.
    expect(schemas[0]!.description).toContain('next turn')
  })

  it('cold-resumes a settled child and reports the queued next turn', async () => {
    const { ctx, parent } = await setup([textResponse('first answer'), textResponse('second answer')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)

    const result = await callTool(ctx, 'send_message', {
      subagent_id: started.childId,
      message: 'and then?',
    }, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`request accepted for subagent ${started.childId}`)
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeDefined() })

    const child = ctx.agents.get(started.childId)!
    const followUp = child.inbox.nextTurn.at(-1)
    expect(followUp?.source).toEqual({
      kind: 'coordinator',
      form: 'relay',
      senderSessionId: parent.id,
    })
  })

  it('queues behind an open turn instead of joining it', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('first'), textResponse('second')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'long work',
      request: { prompt: [{ type: 'text', text: 'long work' }], parent },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    const result = await callTool(ctx, 'send_message', {
      subagent_id: started.childId,
      message: 'also consider Y',
    }, parent)
    expect(result.isError).toBe(false)

    await ctx.agents.get(started.childId)!.whenIdle()
    const child = ctx.agents.get(started.childId)!
    expect(child.inbox.nextTurn).toHaveLength(1)
    expect(child.inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'also consider Y' }])
  })

  it('reports a delivery failure as an errored, not-delivered result', async () => {
    const { ctx, parent } = await setup([])
    const result = await callTool(ctx, 'send_message', {
      subagent_id: 'no-such-child',
      message: 'hello?',
    }, parent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unavailable')
  })

  it('rejects a caller that is not the child\'s durable direct parent', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    const stranger = ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })

    const result = await callTool(ctx, 'send_message', {
      subagent_id: started.childId,
      message: 'mine now',
    }, stranger)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('another parent session')
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'send_message', { subagent_id: 'x', message: 'y' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('unregisters with its plugin fiber (HMR safety)', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(schema => schema.name === 'send_message')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'interrupt_agent')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'wait_agent')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'send_message')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'interrupt_agent')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'wait_agent')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-control')
    expect(tool.inject).toEqual(['tools', 'subagents'])
    expect(typeof tool.apply).toBe('function')
  })
})

describe('dsh-tool-subagent-control interrupt_agent', () => {
  it('registers interrupt_agent with the single agent_id parameter and current-turn wording', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'interrupt_agent')
    expect(schemas).toHaveLength(1)
    const props = (schemas[0]!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['agent_id'])
    expect(schemas[0]!.description).toContain('current turn')
    expect(schemas[0]!.description).toContain('send_message')
  })

  it('interrupts a running direct child with the parent cause, parking its queue', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('held'), gate: releaseFirst.promise },
      { chunks: textResponse('parked answer') },
      { chunks: textResponse('waking answer') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'long work',
      request: { prompt: [{ type: 'text', text: 'long work' }], parent },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const queued = await callTool(ctx, 'send_message', {
      subagent_id: started.childId,
      message: 'parked follow-up',
    }, parent)
    expect(queued.isError).toBe(false)
    const cancelSpy = vi.spyOn(child, 'cancel')

    const result = await callTool(ctx, 'interrupt_agent', { agent_id: started.childId }, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`interrupt requested for agent ${started.childId}`)
    expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' }, { keepInbox: true })
    releaseFirst.resolve(undefined)
    await child.whenIdle()
    // Parked, not resumed: the queued follow-up waits for a waking send.
    expect(adapter.requests).toHaveLength(1)
    expect(child.inbox.nextTurn).toHaveLength(1)

    const waking = await callTool(ctx, 'followup_task', {
      subagent_id: started.childId,
      message: 'wake up',
    }, parent)
    expect(waking.isError).toBe(false)
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    const prompts = loaded.events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'plugin'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    expect(prompts).toEqual(['long work', 'parked follow-up', 'wake up'])
  })

  it('lets a deep live ancestor interrupt a descendant it did not directly create', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child',
      request: { prompt: [{ type: 'text', text: 'child work' }], parent },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'grandchild',
      request: { prompt: [{ type: 'text', text: 'grandchild work' }], parent: child },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    const cancelSpy = vi.spyOn(grandchildAgent, 'cancel')

    const result = await callTool(ctx, 'interrupt_agent', { agent_id: grandchild.childId }, parent)

    expect(result.isError).toBe(false)
    expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' }, { keepInbox: true })
    releaseChild.resolve(undefined)
    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('rejects self, sibling, and unrelated callers without touching the target', async () => {
    const releaseA = Promise.withResolvers<undefined>()
    const releaseB = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('a'), gate: releaseA.promise },
      { chunks: textResponse('b'), gate: releaseB.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const target = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'target',
      request: { prompt: [{ type: 'text', text: 'a' }], parent },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const sibling = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'sibling',
      request: { prompt: [{ type: 'text', text: 'b' }], parent },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const targetAgent = ctx.agents.get(target.childId)!
    const siblingAgent = ctx.agents.get(sibling.childId)!
    const stranger = ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })
    const cancelSpy = vi.spyOn(targetAgent, 'cancel')

    const self = await callTool(ctx, 'interrupt_agent', { agent_id: target.childId }, targetAgent)
    expect(self.isError).toBe(true)
    expect(text(self)).toContain('cannot interrupt itself')
    const fromSibling = await callTool(ctx, 'interrupt_agent', { agent_id: target.childId }, siblingAgent)
    expect(fromSibling.isError).toBe(true)
    expect(text(fromSibling)).toContain('not a live descendant')
    const fromStranger = await callTool(ctx, 'interrupt_agent', { agent_id: target.childId }, stranger)
    expect(fromStranger.isError).toBe(true)
    expect(text(fromStranger)).toContain('not a live descendant')
    expect(cancelSpy).not.toHaveBeenCalled()

    releaseA.resolve(undefined)
    releaseB.resolve(undefined)
    await waitNoActivation(ctx, target.childId)
    await waitNoActivation(ctx, sibling.childId)
  })

  it('accepts an absent target as a no-op without cold-resuming it', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'settled child',
      request: { prompt: [{ type: 'text', text: 'child work' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)

    const settled = await callTool(ctx, 'interrupt_agent', { agent_id: started.childId }, parent)
    expect(settled.isError).toBe(false)
    expect(text(settled)).toBe(`interrupt requested for agent ${started.childId}`)
    const unknown = await callTool(ctx, 'interrupt_agent', { agent_id: 'no-such-agent' }, parent)
    expect(unknown.isError).toBe(false)
    // No cold resume: the settled target never rematerialized.
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'interrupt_agent', { agent_id: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })
})

describe('dsh-tool-subagent-control parent controls', () => {
  it('registers the six parent control tools with stable parameters', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas()
    expect(schemas.map(schema => schema.name).filter(name => [
      'send_message', 'followup_task', 'steer_agent', 'interrupt_agent', 'close_agent', 'get_agent_status',
    ].includes(name))).toEqual([
      'send_message', 'followup_task', 'steer_agent', 'interrupt_agent', 'close_agent', 'get_agent_status',
    ])
    const properties = (name: string) => {
      const schema = schemas.find(item => item.name === name)
      return Object.keys((schema?.parameters as { properties?: Record<string, unknown> }).properties ?? {}).sort()
    }
    expect(properties('send_message')).toEqual(['message', 'subagent_id'])
    expect(properties('followup_task')).toEqual(['message', 'subagent_id'])
    expect(properties('steer_agent')).toEqual(['agent_id', 'message'])
    expect(properties('interrupt_agent')).toEqual(['agent_id'])
    expect(properties('close_agent')).toEqual(['agent_id', 'cascade'])
    expect(properties('get_agent_status')).toEqual(['agent_id'])
  })

  it('returns structured receipts for followup, steer, close, and status', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn', label: 'child', request: { prompt: [{ type: 'text', text: 'child' }], parent }, signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)

    const followup = await callTool(ctx, 'followup_task', { subagent_id: started.childId, message: 'next' }, parent)
    expect(followup.isError).toBe(false)
    expect(followup.value).toMatchObject({ accepted: true, agentId: started.childId })

    const status = await callTool(ctx, 'get_agent_status', { agent_id: started.childId }, parent)
    expect(status.isError).toBe(false)
    expect(status.value).toMatchObject({ agentId: started.childId, state: 'running' })

    const steer = await callTool(ctx, 'steer_agent', { agent_id: started.childId, message: 'urgent' }, parent)
    expect(steer.isError).toBe(false)
    expect(steer.value).toMatchObject({ accepted: true, agentId: started.childId })

    const close = await callTool(ctx, 'close_agent', { agent_id: started.childId }, parent)
    expect(close.isError).toBe(false)
    expect(close.value).toMatchObject({ accepted: true, agentId: started.childId })
  })

  it.each(['followup_task', 'steer_agent', 'close_agent', 'get_agent_status'])('rejects unknown target for %s', async (name) => {
    const { ctx, parent } = await setup([])
    const args = name === 'get_agent_status'
      ? { agent_id: 'unknown' }
      : name === 'close_agent'
        ? { agent_id: 'unknown' }
        : name === 'steer_agent'
          ? { agent_id: 'unknown', message: 'hello' }
          : { subagent_id: 'unknown', message: 'hello' }
    const result = await callTool(ctx, name, args, parent)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/unavailable|not active|not found|unknown/i)
  })

  it.each(['send_message', 'followup_task', 'steer_agent', 'interrupt_agent', 'close_agent', 'get_agent_status'])('requires a calling agent for %s', async (name) => {
    const { ctx } = await setup([])
    const args = name === 'send_message' || name === 'followup_task'
      ? { subagent_id: 'unknown', message: 'hello' }
      : name === 'close_agent' || name === 'get_agent_status' || name === 'interrupt_agent'
        ? { agent_id: 'unknown' }
        : { agent_id: 'unknown', message: 'hello' }
    const result = await callTool(ctx, name, args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('rejects steering the root agent and defaults close cascade to true', async () => {
    const { ctx, parent } = await setup([])
    const steer = await callTool(ctx, 'steer_agent', { agent_id: parent.id, message: 'no' }, parent)
    expect(steer.isError).toBe(true)
    expect(text(steer)).toMatch(/root|descendant|itself|unauthorized/i)

    const closeTool = ctx.tools.get('close_agent')
    expect(closeTool?.parameters).toBeDefined()
    const cascade = ((closeTool?.parameters as { properties?: Record<string, { default?: unknown }> }).properties ?? {}).cascade
    expect(cascade?.default).toBe(true)
  })
})
