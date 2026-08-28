// Web e2e scenario: phone widths keep the conversation column full-width. The
// hazard: the phone CSS takes the sidebar out of the grid flow (position:
// absolute) and hides the details column (display: none), so source-order
// grid auto-placement drops the center column into the frame's 0-width first
// track — the whole conversation renders inside an invisible zero-width
// column. The frame still reports a correct three-track template and the DOM
// still mounts every message, so a jsdom unit test (no real grid layout) and a
// screen-reader snapshot both pass while a real engine paints a blank page.
//
// The fix pins the center column to the middle track the frame always sizes to
// full width on phones. A real engine is required to observe the placement:
// jsdom never resolves grid item positions, so the scenario drives a real
// browser and records the placement relation, not the pixel values. The
// 900px stop is the control: at that width the frame is the desktop three-column
// layout, the sidebar auto-collapses to its 56px rail, and the center column
// no longer spans the frame — which proves the phone measurement is not
// trivially always-true.
//
// Zero model calls: the hero boot state needs no seeding and mounts no replay
// row. A stray stream fails loud with NO_ADAPTER.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/phone-frame-geometry', import.meta.url))
const GEOMETRY_EXPECTED = join(SNAPSHOT_DIR, 'geometry.expected.md')
const MODE = webSnapshotMode()
/** Phone stop: below the frame's 767px phone breakpoint. */
const PHONE_VIEWPORT = 393
/** Control stop: above 767px, so the three-column desktop layout and its 56px rail apply. */
const DESKTOP_VIEWPORT = 900

/** One viewport stop: whether the frame is in phone mode and the center column fills the frame. */
interface FrameMetrics {
  /** Viewport width the stop was measured at. */
  width: number
  /** The center column's rendered width. Recorded to the golden as the relation, not the number. */
  centerWidth: number
  /** Whether the frame carries `data-phone` — the vacuity guard for the phone claim. */
  phoneGrid: boolean
  /** The center column's content box spans the whole frame (within a rounding pixel). */
  spansFrame: boolean
  /** The conversation scroll container sits inside the center column. */
  conversationInsideCenter: boolean
}

/**
 * Measure the frame placement at the page's current viewport.
 * @param page - the page under test.
 * @param width - the viewport width already applied, recorded with the reading.
 * @returns the relation facts.
 */
function measureFrame(page: Page, width: number): Promise<FrameMetrics> {
  return page.evaluate((viewportWidth) => {
    const center = document.querySelector<HTMLElement>('[data-frame-column="center"]')
    const frame = center?.parentElement
    if (center === null || frame === null) throw new Error('frame center column not in the DOM')
    const centerBox = center.getBoundingClientRect()
    const frameBox = frame.getBoundingClientRect()
    const scroller = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    return {
      width: viewportWidth,
      centerWidth: Math.round(centerBox.width),
      phoneGrid: frame.dataset.phone === 'true',
      spansFrame: Math.abs(centerBox.width - frameBox.width) <= 1,
      conversationInsideCenter: scroller !== null && center.contains(scroller),
    }
  }, width)
}

/**
 * Render the golden body: one line per stop, relations only. Absolute pixels
 * are deliberately absent — the relation survives any engine whose column
 * lands a pixel off, so the golden documents the behavior, not the platform.
 * @param stops - the measured stops, in sweep order.
 * @returns the golden body, without a trailing newline.
 */
function renderGeometry(stops: FrameMetrics[]): string {
  return [
    '# Phone frame center column placement',
    '',
    '| viewport | phone grid | center column spans the frame | conversation scrolls inside the center column |',
    '| --- | --- | --- | --- |',
    ...stops.map(stop => `| ${String(stop.width)}px | ${String(stop.phoneGrid)} | ${String(stop.spansFrame)} `
      + `| ${String(stop.conversationInsideCenter)} |`),
  ].join('\n')
}

describe('web e2e: phone widths keep the conversation column full-width', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[data-frame-column="center"] [data-conversation-scroll]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Resize to a viewport and read the frame once the center column stops moving.
   * The frame eases its grid tracks over `--ds-transition-duration-slow`; a
   * read straight after a resize can report the previous viewport's placement.
   * @param width - viewport width to settle at.
   * @returns the frame's readings at that width.
   */
  const settleAt = async (width: number): Promise<FrameMetrics> => {
    await page.setViewportSize({ width, height: 900 })
    let previous = -1
    await expect.poll(async () => {
      const current = (await measureFrame(page, width)).centerWidth
      const settled = current === previous
      previous = current
      return settled
    }, { timeout: 10_000 }).toBe(true)
    return measureFrame(page, width)
  }

  /**
   * Sweep the stops once per run and hand the SAME readings to every assertion,
   * so the golden and the assertions describe one measurement instead of two
   * runs that could disagree. Memoized: the tests below share one sweep.
   * @returns the stops in {@link PHONE_VIEWPORT}, {@link DESKTOP_VIEWPORT} order.
   */
  let swept: Promise<FrameMetrics[]> | undefined
  const sweep = (): Promise<FrameMetrics[]> => {
    swept ??= (async () => {
      const stops: FrameMetrics[] = []
      for (const width of [PHONE_VIEWPORT, DESKTOP_VIEWPORT]) {
        stops.push(await settleAt(width))
      }
      return stops
    })()
    return swept
  }

  it('pins the center column to the frame at phone widths', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-frame-geometry'))
    const stops = await sweep()
    const phone = stops.find(stop => stop.width === PHONE_VIEWPORT)
    const desktop = stops.find(stop => stop.width === DESKTOP_VIEWPORT)
    if (phone === undefined || desktop === undefined) throw new Error('sweep did not produce both stops')
    // The vacuity guard: the phone claim only applies when the frame is a phone grid.
    expect(phone.phoneGrid).toBe(true)
    // The reported symptom, stated directly: the conversation column is not
    // an invisible zero-width track on a phone.
    expect(phone.centerWidth).toBeGreaterThan(0)
    expect(phone.spansFrame).toBe(true)
    // And the conversation actually lives inside that full-width column.
    expect(phone.conversationInsideCenter).toBe(true)
    // The control shows the measurement distinguishes the phone relation: on
    // desktop the sidebar rail keeps the center column off the frame edge.
    expect(desktop.phoneGrid).toBe(false)
    expect(desktop.centerWidth).toBeGreaterThan(0)
    expect(desktop.spansFrame).toBe(false)
    expect(desktop.conversationInsideCenter).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('matches the committed phone-frame golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-frame-geometry-golden'))
    await compareOrRefreshGolden(GEOMETRY_EXPECTED, renderGeometry(await sweep()), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('commits exactly the fixtures it reads', async () => {
    // No model calls, so no replay log: the golden is the whole inventory.
    await assertFixtureInventory(SNAPSHOT_DIR, ['geometry.expected.md'])
  })

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', () => {
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })
})
