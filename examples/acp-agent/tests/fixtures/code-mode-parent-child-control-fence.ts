import type { Context } from '@deepseek-ai/cordis'

/** Fixture plugin name. */
export const name = 'code-mode-parent-child-control-fence'

/**
 * Keep the deterministic parent/child control replay in causal order. The
 * fence itself is model-hidden; it only prevents a child settlement from
 * racing the parent's next control step.
 * @param ctx - assembled ACP-agent context.
 */
export function apply(ctx: Context): void {
  let childReported = false
  let childFailed = false
  const releaseReport = Promise.withResolvers<undefined>()
  const releaseFailure = Promise.withResolvers<undefined>()
  ctx.effect(() => {
    const disposeSession = ctx.root.on('session/event', (session, event) => {
      if (session.header.parentSession !== undefined) return
      if (event.type === 'agent/inbox/spliced') {
        if (event.data.inserted.some(message => message.source.kind === 'subagent-report')) {
          childReported = true
          releaseReport.resolve(undefined)
        }
        if (JSON.stringify(event).includes('CONTROL_CHILD_ERROR')) {
          childFailed = true
          releaseFailure.resolve(undefined)
        }
      }
    })
    const disposeStep = ctx.root.on('agent/pre-step', async ({ turn, step }, next) => {
      if (turn === 1 && step === 2 && !childReported) await releaseReport.promise
      if (turn === 1 && step === 3 && !childFailed) await releaseFailure.promise
      return next()
    })
    return () => {
      disposeStep()
      disposeSession()
    }
  }, 'code-mode-parent-child-control-fence.listeners')
}
