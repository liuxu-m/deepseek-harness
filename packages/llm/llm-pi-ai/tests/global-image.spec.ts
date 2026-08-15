/**
 * The `globalImage` flag gates the llm-pi-ai image branch: when the routed
 * model does not declare image input and the flag is on, `stream` strips
 * image blocks into text placeholders instead of throwing `UNSUPPORTED_CONTENT`.
 * Tool-result inner images become the vision-tool hint. When the flag (or its
 * resolver) is absent, the existing strict refusal is preserved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 2,
  height: 2,
}

/** Direct adapter over the real profile resolver with a fixed key per call. */
function adapterOf(
  globalImage: boolean | undefined,
  providers: Record<string, PiAiProviderProfile> = {},
  apiKey: string | undefined = 'test-key',
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers),
    resolveApiKey: () => Promise.resolve(apiKey),
    ...globalImage === undefined ? {} : { resolveGlobalImage: () => globalImage },
  })
}

const drain = async (adapter: PiAiAdapter, options: Parameters<PiAiAdapter['stream']>[0]): Promise<void> => {
  for await (const _chunk of adapter.stream(options)) { /* drain */ }
}

describe('globalImage strip path (non-image model)', () => {
  beforeEach(() => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
  })

  it('does not throw and delivers the attachment-info placeholder instead of image bytes', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterOf(true, { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } })

    await drain(adapter, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })

    expect(server.requests).toHaveLength(1)
    const content = SERVER_MESSAGE_TEXT(server.requests[0])
    expect(content).toContain('Attachment info')
    expect(content).toContain(IMAGE_REF.attachmentId)
    expect(content).toContain('image/png')
    expect(content).toContain('call the vision tool')
    // No image bytes reach an image-incapable route on the wire.
    expect(content).not.toContain('data:')
  })

  it('replaces tool-result inner images with the vision-tool hint', async () => {
    const server = await mockServer([{ events: textEvents }])
    const adapter = adapterOf(true, { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL: server.url } })

    await drain(adapter, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [
        createUserMessage({
          content: [{
            type: 'tool-result',
            toolCallId: CallId('call-outer'),
            content: [
              { type: 'text', text: 'result text ' },
              { type: 'image', attachment: IMAGE_REF },
            ],
          }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
    })

    expect(server.requests).toHaveLength(1)
    const content = SERVER_MESSAGE_TEXT(server.requests[0])
    expect(content).toContain('result text')
    expect(content).toContain('[Image attachment; use the vision tool to view it]')
    expect(content).not.toContain('data:')
  })

  it('preserves the UNSUPPORTED_CONTENT throw when the resolver is absent', async () => {
    const adapter = adapterOf(undefined, { deepseek: {} })

    await expect(drain(adapter, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('keeps the strict throw when the resolver reports the flag off', async () => {
    const adapter = adapterOf(false, { deepseek: {} })

    await expect(drain(adapter, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: IMAGE_REF }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})

/** Flatten the wire request's user-message text for a text-only stripped context. */
function SERVER_MESSAGE_TEXT(request: unknown): string {
  const messages = (request as { messages: { role: string; content: string }[] }).messages
  return messages.map(message => message.content).join('\n')
}
