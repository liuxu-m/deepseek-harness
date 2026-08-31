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
  ctx.effect(() => {
    const disposeStep = ctx.root.on('agent/pre-step', async (_step, next) => next())
    return () => {
      disposeStep()
    }
  }, 'code-mode-parent-child-control-fence.listeners')
}
