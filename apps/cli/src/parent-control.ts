import { StringDecoder } from 'node:string_decoder'
import type { ProcessShutdown } from './process-shutdown.ts'

/** Environment variable selecting the parent-shutdown channel. */
export const PARENT_CONTROL_ENV = 'DSH_PARENT_CONTROL' as const
/** The stdin protocol value for the current shake-hand. */
export const PARENT_CONTROL_STDIN_V1 = 'stdin-v1' as const
/** Hard ceiling for one complete parent-control frame, matching the Rust side's write bound. */
export const PARENT_CONTROL_MAX_BYTES = 1024

/**
 * Install the parent-owned shutdown channel: read exactly one JSON frame from
 * `input` and, when it is a valid `{"type":"shutdown","protocol":1}` request,
 * start graceful shutdown. The reader settles on the first complete newline so
 * a second valid frame is rejected; EOF without a frame is inert (the Job
 * Object is the crash backstop).
 *
 * Bounded and fail-loud: a frame over {@link PARENT_CONTROL_MAX_BYTES}, invalid
 * JSON, an unexpected type, or a protocol other than 1 calls `fail` and never
 * escalates inside this module — timeout and escalation stay in
 * {@link ProcessShutdown}. Never calls `process.exit()`.
 * @param input - the stream the parent shell owns (inherited stdin in `bin.ts`).
 * @param shutdown - the process controller whose `shutdown`/`interrupt` handle the request.
 * @param fail - error sink; by default rethrows synchronously.
 * @returns a disposer that detaches every listener.
 */
export function installParentControl(
  input: NodeJS.ReadableStream,
  shutdown: Pick<ProcessShutdown, 'shutdown' | 'interrupt'>,
  fail: (error: Error) => void = (error) => { throw error },
): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let bytes = 0
  let settled = false

  const onData = (chunk: Buffer): void => {
    if (settled) return
    bytes += chunk.length
    if (bytes > PARENT_CONTROL_MAX_BYTES) {
      settled = true
      fail(new Error(`parent control frame exceeds ${PARENT_CONTROL_MAX_BYTES} bytes`))
      return
    }
    buffer += decoder.write(chunk)
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    settled = true
    const line = buffer.slice(0, newline).trim()
    if (line.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      fail(new Error('parent control frame is not valid JSON'))
      return
    }
    if (
      typeof parsed !== 'object' || parsed === null
      || (parsed as { type?: unknown }).type !== 'shutdown'
      || (parsed as { protocol?: unknown }).protocol !== 1
    ) {
      fail(new Error(`unsupported parent control frame: ${line}`))
      return
    }
    void shutdown.shutdown(0)
  }
  const onEnd = (): void => { /* EOF without a frame is inert: the Job Object is the crash backstop. */ }
  const onError = (error: Error): void => { fail(error) }

  input.on('data', onData)
  input.on('end', onEnd)
  input.on('error', onError)
  return () => {
    input.removeListener('data', onData)
    input.removeListener('end', onEnd)
    input.removeListener('error', onError)
  }
}
