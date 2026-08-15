/**
 * The `globalImage` flag relaxes the strict `read_image` capability gate in
 * `assertImageCapableRoute`: when the flag is on, a non-image model passes as
 * long as the durable attachment service exists (an external vision tool
 * interprets the image); when the flag is off, the existing model-declaration
 * refusal is preserved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertImageCapableRoute } from '../src/read-image.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Exact-route fake adapter; `stream` is unreachable in these gate tests. */
class CatalogAdapter extends LlmAdapter {
  constructor(private readonly resolvedModels: LlmModelInfo[]) {
    super()
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const resolved = this.resolvedModels.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: resolved?.name ?? model,
      ...resolved?.inputModalities === undefined ? {} : { inputModalities: [...resolved.inputModalities] },
    })
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('global-image gate tests never stream')
  }
}

async function contextWith(resolvedModels: LlmModelInfo[], globalImage: boolean | undefined): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['visual'], new CatalogAdapter(resolvedModels))
  if (globalImage !== undefined) ctx.provide('globalImage', globalImage)
  return ctx
}

/** A fake calling agent pinned to one routed provider/model. */
function execOn(model: string): ToolExecution {
  return {
    agent: {
      options: { provider: 'visual', model },
      session: { requestHeader: () => ({ config: { provider: 'visual', model } }) },
    },
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

const ATTACHMENTS = { imageLimits: {} } as never

describe('assertImageCapableRoute globalImage gate', () => {
  it('passes for a non-image model when globalImage is on and the attachment service exists', async () => {
    const ctx = await contextWith(
      [{ provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] }],
      true,
    )
    ctx.provide('attachments', ATTACHMENTS)
    await expect(assertImageCapableRoute(ctx, execOn('text-model'), 'a.png')).resolves.toBeUndefined()
  })

  it('throws the durable-service error when globalImage is on but attachments are absent', async () => {
    const ctx = await contextWith(
      [{ provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] }],
      true,
    )
    await expect(assertImageCapableRoute(ctx, execOn('text-model'), 'a.png'))
      .rejects.toThrow('the durable attachment service is unavailable')
  })

  it('keeps the model-declaration error when globalImage is off', async () => {
    const ctx = await contextWith(
      [{ provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] }],
      false,
    )
    ctx.provide('attachments', ATTACHMENTS)
    await expect(assertImageCapableRoute(ctx, execOn('text-model'), 'a.png'))
      .rejects.toThrow('model "text-model" does not declare image input')
  })

  it('keeps passing an image-capable model with the flag off', async () => {
    const ctx = await contextWith(
      [{ provider: 'visual', id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] }],
      false,
    )
    ctx.provide('attachments', ATTACHMENTS)
    await expect(assertImageCapableRoute(ctx, execOn('vision-model'), 'a.png')).resolves.toBeUndefined()
  })
})
