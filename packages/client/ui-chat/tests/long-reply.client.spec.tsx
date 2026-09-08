// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

/** A text block of `size` characters ending on a line with a queryable marker. */
function textBlock(size: number, marker: string): AssistantMarkdownProps['blocks'][number] {
  return { kind: 'text', text: `${'x'.repeat(Math.max(0, size - marker.length - 1))}\n${marker}` }
}

describe('AssistantMarkdown long-reply fold', () => {
  it('folds a settled over-budget reply at a text-block boundary', () => {
    const reasoning = { kind: 'reasoning', text: 'Inspect the session' } as const
    const first = textBlock(8_000, 'FIRST-PREVIEW')
    const second = textBlock(8_000, 'SECOND-HIDDEN-TAIL')
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[reasoning, first, second]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const row = view.getByRole('button', { name: /长回复已折叠/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    // Reasoning keeps its position in the folded preview; the overflow tail
    // stays out of the DOM until expanded.
    expect(view.getByText('Inspect the session')).toBeTruthy()
    expect(view.getByText(/FIRST-PREVIEW/)).toBeTruthy()
    expect(view.queryByText(/SECOND-HIDDEN-TAIL/)).toBeNull()
  })

  it('expanding restores the full reply', () => {
    const first = textBlock(8_000, 'FIRST-PREVIEW')
    const second = textBlock(8_000, 'SECOND-HIDDEN-TAIL')
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[first, second]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: /长回复已折叠/ }))
    expect(view.getByText(/SECOND-HIDDEN-TAIL/)).toBeTruthy()
    expect(view.queryByText('长回复已折叠')).toBeNull()
  })

  it('trims an over-budget lone block to the preview budget and reports the total', () => {
    const lone = textBlock(13_000, 'LONE-TAIL')
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[lone]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    // 13_000 chars total: the preview truncates to 12_000 and names the total.
    expect(view.getByText(/预览已截断，共 13000 字符/)).toBeTruthy()
    expect(view.queryByText(/LONE-TAIL/)).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /长回复已折叠/ }))
    expect(view.getByText(/LONE-TAIL/)).toBeTruthy()
  })

  it('never folds while streaming, interrupted, or under the budget', () => {
    const big = textBlock(13_000, 'BIG-TAIL')
    const short = { kind: 'text', text: 'a short reply' } as const
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[short]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.queryByText('长回复已折叠')).toBeNull()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[big]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.queryByText('长回复已折叠')).toBeNull()
    expect(view.getByText(/BIG-TAIL/)).toBeTruthy()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[big]}
        streaming={false}
        interrupted
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.queryByText('长回复已折叠')).toBeNull()
    expect(view.getByText(/BIG-TAIL/)).toBeTruthy()
    expect(view.getByText('已停止')).toBeTruthy()
  })
})
