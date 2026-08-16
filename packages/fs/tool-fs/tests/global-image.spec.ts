/**
 * The `globalImage` flag relaxes the strict `read_image` capability gate in
 * `assertImageCapableRoute`: when the flag is on, a non-image model passes as
 * long as the durable attachment service exists (an external vision tool
 * interprets the image); when the flag is off, the existing model-declaration
 * refusal is preserved. The gate contract is covered directly, and the real
 * `ctx.tools.execute('read_image')` route is covered end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { assertImageCapableRoute } from '../src/read-image.ts'

/** 1x1 red PNG (valid signature, IHDR, IDAT). */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

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

describe('read_image end-to-end globalImage gate', () => {
  let dir: string
  let home: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-read-image-global-'))
    home = await mkdtemp(join(tmpdir(), 'dsh-read-image-global-home-'))
    await writeFile(join(dir, 'red.png'), PNG_1X1)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  async function toolContext(globalImage: boolean): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['visual'], new CatalogAdapter([
      { provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] },
    ]))
    ctx.provide('globalImage', globalImage)
    await ctx.plugin(ToolFs)
    return ctx
  }

  const agent = (model: string) => ({
    options: {},
    session: {
      header: { cwd: dir },
      requestHeader: () => ({ config: { provider: 'visual', model } }),
      append: () => undefined,
    },
  })

  let callCounter = 0
  function readImage(ctx: Context, model: string) {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`img-global-${++callCounter}`),
      name: 'read_image',
      arguments: { file_path: 'red.png' },
      agent: agent(model) as never,
    })
  }

  it('lets a non-image model read through the real route when globalImage is on', async () => {
    const ctx = await toolContext(true)
    const result = await readImage(ctx, 'text-model')
    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('keeps refusing the real route for a non-image model when globalImage is off', async () => {
    const ctx = await toolContext(false)
    const result = await readImage(ctx, 'text-model')
    expect(result.isError).toBe(true)
    expect(result.error?.message ?? '').toContain('does not declare image input')
    await ctx.fiber.dispose()
  })
})
