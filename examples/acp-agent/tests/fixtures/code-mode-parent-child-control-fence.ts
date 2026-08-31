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
  let parentCompleted = false
  let childStarted = false
  const release = Promise.withResolvers<undefined>()
  ctx.effect(() => {
    const disposeSession = ctx.root.on('session/event', (session, event) => {
      if (session.header.parentSession !== undefined) return
      if (event.type === 'subagent/progress') {
        childStarted = true
        if (event.data.state === 'reported' || event.data.state === 'interrupted' || event.data.state === 'closed') {
          release.resolve(undefined)
        }
      }
      if (event.type === 'turn/end' && event.data.turn === 1) parentCompleted = true
    })
    const disposeStep = ctx.root.on('agent/pre-step', async ({ turn, step }, next) => {
      if (parentCompleted && childStarted && turn === 1 && step > 1) await release.promise
      return next()
    })
    return () => {
      disposeStep()
      disposeSession()
    }
  }, 'code-mode-parent-child-control-fence.listeners')
}
