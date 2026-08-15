/**
 * The `globalImage` flag gates both apiproxy image-admission check sites:
 * prompt admission and selectModel. When the flag is on, the durable
 * attachment service alone decides image admission (the per-model
 * `inputModalities` restriction is lifted for the whole deployment); when it
 * is off, the non-image model restriction is enforced exactly as before.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`global-image-${String(nextRpc++)}`), payload }
}

class CatalogAdapter extends LlmAdapter {
  constructor(
    private readonly resolveModelInfo: (provider: string, model: string) => LlmResolvedModelInfo,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.resolveModelInfo(provider, model))
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Catalog tests never enter provider streaming.
  }
}

async function harness(): Promise<{ ctx: Context; agent: Agent; sessionId: SessionId }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['image-capable'], new CatalogAdapter((provider, model) => ({
    provider, id: model, name: model, inputModalities: ['text', 'image'],
  })))
  ctx.llm.registerAdapter(['text-only'], new CatalogAdapter((provider, model) => ({
    provider, id: model, name: model, inputModalities: ['text'],
  })))
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id }
}

/** Mount the durable attachment service contract `durablePromptContent` reads. */
function provideAttachments(ctx: Context): void {
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 4,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 4,
      maxImagePixels: 4,
      mediaTypes: ['image/png'],
    },
    validateImage: (_input: { data: Uint8Array }) => Promise.resolve(),
    saveImage: (input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => Promise.resolve({
      attachmentId: `att-${String(input.data[0])}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }),
  } as never)
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'text-only', model: 'plain' }),
  cwd: '/tmp',
})

const PNG_IMAGE = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' }

describe('globalImage prompt admission', () => {
  it('admits an image prompt when globalImage is on, without an image-capable model', async () => {
    const { ctx, agent, sessionId } = await harness()
    ctx.provide('globalImage', true)
    provideAttachments(ctx)
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const admitted = api(ctx)

    const result = await admitted.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ ...PNG_IMAGE }, { type: 'text' as const, text: 'describe' }],
    }))

    expect(result.result).toEqual({ ok: true, value: { accepted: true } })
    expect(followup).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('keeps the model gate when globalImage is off', async () => {
    const { ctx, sessionId } = await harness()
    provideAttachments(ctx)
    const refused = api(ctx)

    const result = await refused.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ ...PNG_IMAGE }],
    }))

    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
    })
    await ctx.fiber.dispose()
  })
})

describe('globalImage selectModel admission', () => {
  it('allows a model switch in a session with images when globalImage is on', async () => {
    const { ctx, agent, sessionId } = await harness()
    ctx.provide('globalImage', true)
    agent.session.append('user/message', {
      id: 'durable-image', role: 'user', source: { kind: 'user' },
      content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
    } as never, { surfaceOp: 'append' })
    const admitted = api(ctx)

    const result = await admitted.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))

    expect(result.result).toEqual({
      ok: true,
      value: { selected: { provider: 'text-only', model: 'plain' } },
    })
    await ctx.fiber.dispose()
  })
})
