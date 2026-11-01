---
title: Refresh notice popover viewport clamp
date: 2026-11-02
type: receipt
status: verified
source_commit: d4f86acf
---

# Result and boundary

The dashboard's "Results need an update → Details" popover was clipped on the
left when the notice sat near the window's left edge. The panel is now clamped
inside the viewport on open and resize, with a left-anchored CSS fallback. The
fix was verified in a packaged development candidate using the isolated
real-data profile. The live index was not used by this UI check.

# Reproduction

At a 958 CSS-pixel viewport the notice summary was at `left: 24px`,
`right: 143.4px`. The old `right: 0` panel was 420px wide, so its computed left
was `-276.6px`; the beginning of the copy was outside the window. The same
geometry reproduced in the packaged Electron window at 1180 CSS pixels.

# Change

- Added `refreshNoticeLeft()` and `positionRefreshNotice()` in
  `apps/web/public/app.js`.
- The panel prefers right alignment to the summary, then clamps its left edge to
  a 16px viewport margin. It is repositioned on `toggle` and on window resize.
- Changed the CSS fallback from `right: 0` to `left: 0` so the common
  left-positioned notice is safe even before the first positioning callback.
- Added a viewport-position regression test in
  `apps/web/test/app-refresh-notice.test.mjs`.

# Verification

- `node --test apps/web/test/app-refresh-notice.test.mjs`: 4 passed.
- Current development package built from `d4f86acf` with Node.js 26.2.0:
  - executable SHA-256:
    `469396770cda7f6d482c62941b791ef65899a3d7a932cc2cc6431607be4a1f31`;
  - ASAR SHA-256:
    `59bf344c47b62200722926f094c8e4bdc4e631a423b4ad41b02cef88278495fa`.
- The packaged Electron renderer was inspected through its loopback-only
  DevTools endpoint. At a 1180x822 CSS viewport, after opening Details, the
  panel measured `left: 16`, `right: 436`, `width: 420`; the panel was fully
  inside the viewport and the copy was readable.
- The visible "Codex folder not found" setup dialog in the development profile
  is expected because that isolated profile has an empty Codex home. It is not
  the notice popover and is outside this fix.

# Boundary

This proves the packaged development renderer and the viewport clamp. It does
not qualify the installed stable app, native rendering, release, updater or
deployment. The live v11 index was not read or written by this UI check.
