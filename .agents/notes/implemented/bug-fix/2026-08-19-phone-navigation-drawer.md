# Agent Note: Phone navigation drawer

Status: implemented

English | [中文](2026-08-19-phone-navigation-drawer.zh.md)

## Problem

The desktop sidebar keeps a 56px control rail after collapse. At phone widths that rail permanently reduces the conversation column, producing a narrow reading and composition area. Edge-to-edge Android WebView content also needs the browser safe-area values and a dynamic viewport height.

## Decision

AppFrame renders a phone viewport at 767px or below as a `0px | 1fr | 0px` grid. The sidebar remains mounted and reuses its existing slot content, but opens as a left overlay drawer instead of consuming a grid track. The same narrow-viewport state that controls a collapsed sidebar controls the phone drawer. The menu button, backdrop, and Escape key close or open the drawer without changing the stored desktop sidebar preference.

The Web entry declares `viewport-fit=cover`. The Web shell applies safe-area insets to the document body and uses `100dvh` where the browser supports it. The phone header reserves the menu-button space. Desktop and tablet widths retain the existing resizable three-column layout.

## Alternatives considered

### Keep a narrower permanent rail

Rejected because a smaller rail still removes usable conversation width and makes its touch targets harder to use. A temporary drawer keeps navigation reachable without reducing the reading column.

### Create a separate mobile navigation tree

Rejected because the existing sidebar slot already owns the workspace, session, and settings navigation. Reusing it preserves one navigation state and avoids a second implementation.

### Apply fixed Android status-bar padding

Rejected because status-bar and cutout sizes vary across devices. CSS safe-area environment values describe the active WebView display area.

## Consequences

- Phone users open navigation deliberately and return to a full-width conversation when the drawer closes.
- The remote Web Host delivers this behavior to Android clients after its Web assets are rebuilt; the native Android package is unchanged.
- AppFrame tests cover the zero-width phone grid and keyboard drawer dismissal, while browser acceptance checks the actual rendered drawer and desktop regression.
