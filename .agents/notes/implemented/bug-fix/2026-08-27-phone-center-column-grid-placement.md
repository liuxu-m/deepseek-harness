# Agent Note: Phone frame pins the center column to the full-width middle track

Status: implemented

English | [中文](2026-08-27-phone-center-column-grid-placement.zh.md)

## Problem

At phone widths (at or below the frame's 767px breakpoint) the conversation rendered as a blank page in a real browser engine, while the DOM was fully mounted and unit tests passed. The center column's content box resolved to 0px width inside the three-track frame, so every message and the composer drew inside an invisible column. The report came from a phone accessing the GUI over a Tailscale HTTPS serve; a desktop viewport was unaffected.

The root cause sits in the [phone navigation drawer](../bug-fix/2026-08-19-phone-navigation-drawer.md) decision. To make the sidebar an overlay on phones, `.frame[data-phone] .sidebarCol` becomes `position: absolute` and `.detailsCol` becomes `display: none`. The frame's inline grid template is always `0px minmax(0, 1fr) 0px` on phones, and the source order of the three column children is sidebar → center → details. On desktop, where the sidebar stays in flow, source-order auto-placement puts the center column in the middle track by luck of ordering. On phones the sidebar leaves the grid flow and the details column stops being a grid item, so the center column becomes the only in-flow grid item and auto-placement drops it into the **first (0-width) track**. The layout intent — a full-width conversation with a temporary drawer — was never realized at the placement level.

The defect shipped unreported because the coverage could not see it. The existing `app-frame.client.spec.tsx` asserts `frame.dataset.phone` and the `grid-template-columns` inline string, and jsdom never performs real grid layout, so it cannot observe which track a grid item actually lands in. The web e2e scenarios ran at desktop viewport widths, which never trigger the phone breakpoint.

## Decision

Add an explicit grid placement for the center column inside the phone media query, alongside the existing `[data-phone] .sidebarCol` rule:

```css
.frame[data-phone] .centerCol {
  grid-row: 1;
  grid-column: 2;
}
```

The frame already sizes the middle track to `minmax(0, 1fr)`, which resolves to the full frame width on phones, so placing the center column in the middle track pins the conversation to full width. The placement is now explicit rather than source-order-dependent, so any future reordering of the frame children cannot silently re-break the phone layout.

The three column divs gain a stable `data-frame-column="sidebar|center|details"` attribute so browser acceptance can select them by behavior hook instead of hash-suffixed class names.

Browser acceptance coverage is added: `apps/web/tests/phone-frame-geometry.e2e.ts` sweeps a phone stop (393px) and a control stop (900px), records a relation-only golden, and asserts that at the phone stop the frame carries `data-phone`, the center column is non-zero and spans the frame, and the conversation scroll container sits inside it. The 900px control stop is the desktop three-column layout where the sidebar auto-collapses to its 56px rail, so the center column no longer spans the frame — proving the phone measurement is not trivially always-true.

## Alternatives considered

### Make the frame a single-track grid on phones
Instead of pinning the center column, set the frame's `grid-template-columns` to a single `100%` track when `data-phone` is set. The track layout is an inline style owned by `AppFrame.tsx` (`cols`), so this requires a component branch rather than a CSS rule, and the three-track template is also the desktop contract the component always writes. A CSS-only placement keeps the fix in one place and does not fork the component's column math for a second layout.

### Keep the sidebar in-flow with zero width on phones
Letting the sidebar remain a grid item (width 0, translated off-screen) would preserve auto-placement order. It removes the overlay-drawer design the phone note chose — the floating drawer with its shadow, backdrop, and edge-to-edge safe-area handling — and reintroduces the narrow-content hazard that note fixed. The overlay approach is the shipped decision; the defect was only the placement that decision left implicit.

### Insert an empty grid-item spacer before the center column
A sibling spacer in the grid flow would restore the source order without CSS placement. It couples the layout to DOM ordering, is invisible in the accessibility tree unless handled, and re-introduces exactly the ordering fragility the explicit placement removes.

## Consequences

- Phone widths now show a full-width conversation with the session content and composer visible, matching the [Android remote client](../feature/2026-08-18-android-remote-client.md) statement that "at phone widths the shared Web UI keeps the conversation full-width."
- The grid placement is explicit and tested against real-engine placement; the relation-only golden documents behavior, not pixels, so it survives platform sub-pixel differences.
- The `data-frame-column` attributes are a testing hook only — they add no runtime behavior and change nothing about how the columns render.
- The phone-grid claim in the phone-navigation-drawer note ("AppFrame tests cover the zero-width phone grid") remains misleading at the unit level: jsdom cannot assert real placement, so the browser e2e is the actual coverage. This note's Testing surface is that e2e.

## Related

- [Phone navigation drawer](../bug-fix/2026-08-19-phone-navigation-drawer.md) — introduces the overlay-drawer phone grid this note fixes at the placement level.
- [Android remote client](../feature/2026-08-18-android-remote-client.md) — states the full-width conversation promise at phone widths.
