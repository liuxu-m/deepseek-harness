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
  let parentStopped = false
  const release = Promise.withResolvers<undefined>()
  ctx.effect(() => {
    const disposeSession = ctx.root.on('session/event', (session, event) => {
      if (session.header.parentSession !== undefined) return
      if (event.type === 'turn/end' && event.data.turn === 1) parentStopped = true
      if (event.type === 'subagent/progress' && event.data.state === 'reported') {
        release.resolve(undefined)
      }
    })
    const disposeStep = ctx.root.on('agent/pre-step', async ({ turn, step }, next) => {
      if (parentStopped && turn === 1 && step > 1) {
        await Promise.race([release.promise, Promise.resolve()])
      }
      return next()
    })
    return () => {
      disposeStep()
      disposeSession()
    }
  }, 'code-mode-parent-child-control-fence.listeners')
}
