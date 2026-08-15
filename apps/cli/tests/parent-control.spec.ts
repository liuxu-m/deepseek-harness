import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installParentControl,
  PARENT_CONTROL_MAX_BYTES,
} from '../src/parent-control.ts'

/** A minimal fake ProcessShutdown with observable spy methods. */
function fakeShutdown(): { shutdown: vi.Mock<() => Promise<void>>; interrupt: vi.Mock<(code: number) => void> } {
  return { shutdown: vi.fn(async () => {}), interrupt: vi.fn<(code: number) => void>() }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('installParentControl', () => {
  it('requests one graceful shutdown from a fragmented frame', async () => {
    const input = new PassThrough()
    const shutdown = fakeShutdown()
    const dispose = installParentControl(input, shutdown)
    input.write('{"type":"shut')
    input.write('down","protocol":1}\n')
    await vi.waitFor(() => expect(shutdown.shutdown).toHaveBeenCalledExactlyOnceWith(0))
    dispose()
  })

  it.each([
    'not-json\n',
    '{"type":"shutdown","protocol":2}\n',
    '{"type":"other","protocol":1}\n',
    `${'x'.repeat(PARENT_CONTROL_MAX_BYTES + 1)}\n`,
  ])('fails loud for invalid frame: %s', async (frame) => {
    const input = new PassThrough()
    const failure = vi.fn()
    installParentControl(input, fakeShutdown(), failure)
    input.end(frame)
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce())
  })

  it('is inert on EOF without a frame', async () => {
    const input = new PassThrough()
    const shutdown = fakeShutdown()
    const failure = vi.fn()
    installParentControl(input, shutdown, failure)
    input.end()
    await new Promise(resolve => input.on('close', resolve))
    expect(shutdown.shutdown).not.toHaveBeenCalled()
    expect(failure).not.toHaveBeenCalled()
  })

  it('rejects a second valid frame after the first settles the reader', async () => {
    const input = new PassThrough()
    const shutdown = fakeShutdown()
    installParentControl(input, shutdown)
    input.write('{"type":"shutdown","protocol":1}\n')
    input.write('{"type":"shutdown","protocol":1}\n')
    await vi.waitFor(() => expect(shutdown.shutdown).toHaveBeenCalledExactlyOnceWith(0))
    // The reader settles on the first newline, so later frames can never
    // shut down a second time; let the event loop drain to be sure.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(shutdown.shutdown).toHaveBeenCalledOnce()
  })

  it('detaches every listener when disposed', async () => {
    const input = new PassThrough()
    const shutdown = fakeShutdown()
    const dispose = installParentControl(input, shutdown)
    dispose()
    input.write('{"type":"shutdown","protocol":1}\n')
    await vi.waitFor(() => expect(input.listenerCount('data')).toBe(0))
    expect(shutdown.shutdown).not.toHaveBeenCalled()
  })
})
