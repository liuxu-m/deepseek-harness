import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import {
  initProfile,
  PROFILES_DIR,
} from '@deepseek-ai/dsh-app-boot'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  installParentControl,
  PARENT_CONTROL_MAX_BYTES,
} from '../src/parent-control.ts'
import { runProfile } from '../src/profile-boot.ts'
import type { ProcessShutdown } from '../src/process-shutdown.ts'

/** A minimal fake ProcessShutdown with observable spy methods. */
function fakeShutdown(): { shutdown: Mock<() => Promise<void>>; interrupt: Mock<(code: number) => void> } {
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

  it('accepts an exactly-at-boundary frame', async () => {
    const input = new PassThrough()
    const shutdown = fakeShutdown()
    installParentControl(input, shutdown)
    // Pad the shutdown JSON with a harmless extra field so the frame's total
    // byte length, trailing \n included, lands exactly on the accepted bound.
    const pad = 'x'.repeat(
      PARENT_CONTROL_MAX_BYTES - Buffer.byteLength('{"type":"shutdown","protocol":1,"pad":""}\n'),
    )
    const frame = `{"type":"shutdown","protocol":1,"pad":"${pad}"}\n`
    expect(Buffer.byteLength(frame)).toBe(PARENT_CONTROL_MAX_BYTES)
    input.end(frame)
    await vi.waitFor(() => expect(shutdown.shutdown).toHaveBeenCalledExactlyOnceWith(0))
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

/** Drop trailing process listeners so a test leaves no global handlers behind. */
function trimProcessListeners(event: 'SIGTERM' | 'SIGINT' | 'unhandledRejection', keep: number): void {
  const listeners = event === 'unhandledRejection' ? process.listeners('unhandledRejection') : process.listeners(event)
  while (listeners.length > keep) process.removeListener(event, listeners.pop()!)
}

describe('runProfile parent-control ordering', () => {
  it('attaches the parent-control listener before the Loader settles', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-pc-order-'))
    const originalHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const originalSigterm = process.listenerCount('SIGTERM')
    const originalSigint = process.listenerCount('SIGINT')
    const originalRejection = process.listenerCount('unhandledRejection')

    // A real empty-bundle profile in the temp home: profile machinery runs
    // without mounting any shipped bundle.
    initProfile(join(home, PROFILES_DIR, 'pc-order'), [])

    const appBoot = await import('@deepseek-ai/dsh-app-boot')
    const shutdown = vi.fn()
    const interrupt = vi.fn()
    const fakeController: ProcessShutdown = { shutdown, interrupt }
    const createShutdown = vi
      .spyOn(await import('../src/process-shutdown.ts'), 'createProcessShutdown')
      .mockImplementation(() => fakeController)
    const heal = vi.spyOn(appBoot, 'healProfilesModuleFallback').mockImplementation(() => {})
    // Keep the Loader pending (never settling) so the window during which the
    // parent's frame arrives is precisely the pre-settle startup window.
    const bootGate = new Promise<Context>(() => {})
    const bootSpy = vi.spyOn(appBoot, 'boot').mockImplementation(() => bootGate)

    const parentControl = new PassThrough()
    const pending = runProfile({
      environment: { get: () => undefined, getFrom: () => undefined },
      profile: 'pc-order',
      patchFiles: [],
      args: [],
      parentControl,
    })
    try {
      // installParentControl runs synchronously before boot() awaits the
      // Loader, so a frame written now — while boot is still pending — must be
      // handled instead of lost in the pre-settle window.
      parentControl.write('{"type":"shutdown","protocol":1}\n')
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledExactlyOnceWith(0))
    } finally {
      bootSpy.mockRestore()
      heal.mockRestore()
      createShutdown.mockRestore()
      trimProcessListeners('SIGTERM', originalSigterm)
      trimProcessListeners('SIGINT', originalSigint)
      trimProcessListeners('unhandledRejection', originalRejection)
      if (originalHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalHome
      rmSync(home, { recursive: true, force: true })
      // The parent-control listener and the runProfile's pending controller
      // were never disposed (boot never settles), so close the stream's end to
      // stop any trailing data/end observers from keeping the loop alive.
      parentControl.destroy()
      // The never-resolving runProfile promise must not surface as an
      // unhandled rejection; attach a no-op handler without awaiting it.
      void pending.catch(() => {})
    }
  })
})
