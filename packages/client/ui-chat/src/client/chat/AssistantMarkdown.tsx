import { Fragment, memo, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DisclosureRow,
  IconCodeOutline16,
  JsonBlock,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { AssistantBlock } from '../contract/snapshot.ts'
import { markdownLabels } from '../markdown-labels.ts'
import { ReasoningRow } from './ReasoningRow.tsx'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './AssistantMarkdown.module.css'

export interface AssistantMarkdownProps {
  blocks: readonly AssistantBlock[]
  streaming: boolean
  /** Frozen partial of an aborted turn: rendered with a stopped marker. */
  interrupted?: boolean | undefined
  /** Render consecutive image blocks through the attachment slot. */
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  /** Hide reasoning that belongs to the Turn-level process disclosure. */
  reasoningHidden?: boolean | undefined
  /** Reveal the owning Turn-level process disclosure. */
  revealProcess?: (() => void) | undefined
  /** Resolved prose file mentions for this Assistant's closing turn. */
  mentions?: MarkdownFileMentions | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

// Long settled replies fold to a text-block-boundary preview: when the total
// text length exceeds MAX_FOLD_CHARS and the turn is not streaming or
// interrupted, text blocks accumulate whole up to the cap and the rest hides
// behind a disclosure row. Folding is presentation-only — the full blocks
// array still renders when expanded — and non-text blocks (reasoning/image)
// keep their original position and shape in both preview and full render.

/** Fold a settled reply when its text blocks total more than this many chars. */
const MAX_FOLD_CHARS = 12_000

/** Total length of every text block. */
function textLength(blocks: readonly AssistantBlock[]): number {
  let total = 0
  for (const block of blocks) {
    if (block.kind === 'text') total += block.text.length
  }
  return total
}

/**
 * The block prefix shown while folded, plus whether hidden text remains.
 *
 * Text blocks accumulate whole up to `budget`. A first text block already
 * longer than the budget is itself trimmed to `budget` characters so the
 * preview never renders the full DOM of an over-long single reply (the trimmed
 * tail is markdown-fragmentary, which MarkdownText tolerates exactly as it
 * tolerates streaming prefixes). Non-text blocks in the covered range stay in
 * place.
 * @param blocks - the assistant's content blocks in order.
 * @param budget - the folded-preview character budget.
 * @returns the preview blocks and whether the full text was truncated.
 */
function foldPrefix(
  blocks: readonly AssistantBlock[],
  budget: number,
): { readonly blocks: readonly AssistantBlock[]; readonly truncated: boolean } {
  let used = 0
  const prefix: AssistantBlock[] = []
  let truncated = false
  for (const block of blocks) {
    if (block.kind === 'text') {
      const next = used + block.text.length
      if (prefix.length === 0 && next > budget) {
        // Over-budget first text block: trim it to the budget.
        prefix.push({ kind: 'text', text: block.text.slice(0, budget) })
        truncated = true
        break
      }
      if (next <= budget) {
        prefix.push(block)
        used = next
        continue
      }
      truncated = true
      break
    }
    prefix.push(block)
  }
  return { blocks: prefix, truncated }
}

/** Reasoning block as the Think variant summary row (figma 39:28304). */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks, streaming, interrupted, renderMessageImages,
  reasoningHidden = false, revealProcess, mentions, t,
}: AssistantMarkdownProps) {
  // Stable per locale revision (t identity changes on switch): a fresh object
  // per render would rebuild MarkdownText's component table every chunk.
  const labels = useMemo(() => markdownLabels(t), [t])
  const [expanded, setExpanded] = useState(false)
  const last = blocks.length - 1
  const totalText = textLength(blocks)
  const foldable = !streaming && interrupted !== true && totalText > MAX_FOLD_CHARS
  // Tool-call heads render as tool rows in the chat view's grouping pass, so
  // a node that is only those heads (or empty) would paint an empty root
  // between tool groups — skip the shell unless something visible remains.
  const hasVisible = streaming
    || interrupted === true
    || blocks.some(block => block.kind !== 'tool-call')
  const renderBlocks = (visible: readonly AssistantBlock[]): ReactNode[] => {
    const rendered: ReactNode[] = []
    for (let i = 0; i < visible.length; i++) {
      const block = visible[i]
      if (block === undefined) continue
      switch (block.kind) {
        case 'text':
          rendered.push(
            <MarkdownText
              key={i}
              text={block.text}
              streaming={streaming}
              labels={labels}
              fileMentions={mentions}
            />,
          )
          break
        case 'reasoning':
          rendered.push(
            <ProcessReasoning
              key={i}
              hidden={reasoningHidden}
              reveal={revealProcess}
            >
              <ReasoningRow text={block.text} running={streaming && i === last} t={t} />
            </ProcessReasoning>,
          )
          break
        case 'image': {
          // Consecutive image blocks share one gallery so several images tile
          // into rows instead of each opening a one-image group of its own.
          // Keyed by the group's FIRST block index: a streaming append that
          // extends the group then only grows `images` instead of remounting
          // the gallery under a shifted key.
          const start = i
          const group = [block]
          while (i + 1 < visible.length) {
            const next = visible[i + 1]
            if (next === undefined || next.kind !== 'image') break
            group.push(next)
            i += 1
          }
          rendered.push(
            <Fragment key={start}>
              {renderMessageImages({
                images: group.map(({ attachment }) => ({ attachment })),
                align: 'start',
              })}
            </Fragment>,
          )
          break
        }
        // Grouped into tool rows by ChatView; hasVisible above skips an empty shell.
        case 'tool-call':
          break
        default:
          rendered.push(
            <JsonBlock
              key={i}
              label={t('message.unknownBlock')}
              payload={block.block}
              truncatedLabel={total => t('json.truncated', { total })}
            />,
          )
      }
    }
    return rendered
  }
  if (!hasVisible) return null

  // Folded preview: non-text blocks keep their position; the text blocks
  // under the budget render, and the truncated marker sits beside the fold.
  if (foldable && !expanded) {
    const { blocks: prefix, truncated } = foldPrefix(blocks, MAX_FOLD_CHARS)
    return (
      <div className={css.root} data-folded="true">
        <DisclosureRow
          icon={<IconCodeOutline16 size={14} />}
          title={t('message.longReply.folded')}
          open={false}
          expandable
          expandOnRowClick
          onToggle={() => setExpanded(true)}
          collapsedContent={(
            <span className={css.foldMarker}>
              {truncated
                ? t('message.longReply.truncated', { total: totalText })
                : t('message.longReply.expand')}
            </span>
          )}
        >
          {null}
        </DisclosureRow>
        <div className={css.body}>{renderBlocks(prefix)}</div>
      </div>
    )
  }

  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {renderBlocks(blocks)}
        {interrupted && <span className={css.stopped}>{t('message.stopped')}</span>}
      </div>
    </div>
  )
})

function ProcessReasoning({ hidden, reveal, children }: {
  hidden: boolean
  reveal?: (() => void) | undefined
  children: ReactNode
}) {
  const ref = useSearchableHidden(hidden, reveal ?? NOOP)
  return <div ref={ref} data-turn-process-inline={hidden || undefined}>{children}</div>
}

const NOOP = (): void => {}
