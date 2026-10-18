---
title: Monochrome desktop app appearance with workload colours as the only hue
date: 2026-10-18
type: decision-record
status: accepted
---

# Monochrome desktop app appearance

## Status and boundary

Owner direction on 2026-10-18: remove the desktop app's tinted background
fills, unify non-workload text on black, and keep the workload
red/yellow/green as the only remaining hue. This is a source decision about
the app's presentation layer. It is not installed-artifact, rendered-surface,
or release evidence; those gates remain separate in
[the documentation index](../README.md).

## Decision

- By default, the desktop app renders on white paper with black text and grey chrome.
  The workload classification (red/yellow/green) is the only colour the app
  keeps.
- The public release site (`body.community-site`), the public tour, and the
  operator console (`body.admin-operator-page`) keep their existing palettes.
- Dark mode remains supported. The dark app inverts to near-black surfaces
  (`#161616`) with near-white ink (`#f2f2f2`) and the same grey chrome.
- Every role is still a CSS custom property. The app-scoped token blocks in
  `apps/web/public/styles.css` —
  `body:not(.community-site):not(.admin-operator-page)` and
  `html[data-theme="dark"] body:not(...)` — and the `--tray-*` roles in
  `apps/web/public/electron-tray-popup.css` stay the single entry point a
  future personalized theme colour or background would override.

## Owner-selected window backgrounds

The owner subsequently accepted custom backgrounds for the entire main window,
including its sidebar, with eight light presets, the system color picker,
HEX/RGB entry, local static raster images, and a light image overlay. The
default appearance remains monochrome; an explicit background choice overrides
background roles and uses black content text, without rewriting the saved
system/light/dark preference. Reset restores that preference's default surfaces.
Workload colors remain semantic. Settings uses the same background presentation;
tray, recovery, public-site and operator surfaces are outside this feature.

Images retain their original bytes and quality. They live as independent,
owner-only protected binary resources, split into bounded chunks within the
existing 1 MiB per-operation limit. A small, separate versioned configuration
stores an opaque resource reference, byte count, MIME type and SHA-256. No
existing settings schema is relabelled. A bounded import journal recovers
interrupted replacements and reclaims only this feature's unreferenced chunks.
The source file is never deleted. Background bytes and filenames never enter
diagnostics, accounting, export or telemetry.

Static PNG, JPEG and WebP imports are limited to 20 MiB, 32 million pixels and
16,384 pixels per dimension, checked before native decode. Unsupported,
animated or undecodable files leave the last saved background intact. Rendering
uses one fixed, centered cover layer and CSS resizing; no re-encoding or
resize-driven disk reads occur. The image-only white overlay defaults to 35%
and ranges from 0 to 90%. Pure-color presets remove the app's current image
reference; color entry preserves it. Reset affects only background state.

Lightweight actions, including Restore default background, use explicit
transparent fills in every interaction state. A borderless button must not
retain an accidental white fill. Color and image backgrounds are separate
rendered acceptance cases, not inferred from tests on the default white page.

## How identity survives without hue

Distinctions that used to be carried by colour now use a greyscale ladder
mixed from the theme ink (`color-mix(in srgb, var(--ink) α, transparent)`), so
one definition flips with the theme and the ordering carries the meaning:

- Trends exclusion bands: five wash steps (.14–.38) with identity ticks at
  roughly twice the wash and legend swatches pinned to the ticks.
- Weekly pace forecast and the tray pace section: on-pace 45%, default 60%,
  over-pace 80%, critical full ink, insufficient/unavailable 30%.
- Quota tanks: healthy through critical run from mid grey to black (light app)
  or mid grey to white (dark app), with stale palest.
- Model and series identity, the cache-reuse matrix, and the settings window
  use the same ink-derived greys.

## Sidebar actions

The owner accepted the sidebar preview on 2026-10-18. Refresh sits immediately
above Settings at the bottom of the navigation column. The refresh icon rotates
during the existing refresh lifecycle and shows only a localized phase summary;
activating it again requests the existing safe cancellation. Reduced-motion
preferences stop rotation without hiding the running state. Settings keeps its
existing desktop bridge.

The redundant fresh-status pill is hidden. Other evidence states and their
notices remain explicit. Only a succeeded refresh followed by a successful
dashboard reload shows “刷新成功” (localized for the selected language), then
clears that summary after three seconds. A new refresh invalidates the previous
timer. Failures, cancellation, degraded results, and reload failures never show
the success message. These presentation rules do not change accounting,
retention, collection, retry, or refresh-lease behavior.

## Preserved behavior

- Workload tokens `--workload-heavy` / `--workload-medium` /
  `--workload-light` and their chart uses are unchanged.
- Site and admin rules, `feature-tour.css`, and `admin.css` are untouched;
  shared rules were rewritten as `color-mix` over the root tokens so the site
  composites to the same pixel colours as before.
- Content-free, local-only rendering, offline behavior, and the presentation
  contracts in `apps/web/AGENTS.md` are unchanged.

## Evidence boundary

Validation for this change is source-level: the `apps/web` and `apps/electron`
test suites pin the app-scoped token blocks, the grey ladders, and the
achromatic-literal contract. Inspecting the rendered dashboard, Settings,
tray popup, and recovery window in the installed Windows app remains a
separate gate.
