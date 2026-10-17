---
title: Neutral dashboard light and dark appearance validation
date: 2026-10-16
type: qa
status: verified-local-candidate
---

Scope: presentation-only correction for the overview, compact usage rankings,
project/thread reports and auxiliary analysis dialogs. Layout, accounting,
ingestion, refresh policy, source records and database schemas are unchanged.
This is local Windows candidate evidence, not installed or signed-release proof.

## Correction

The overview forced a light colour scheme and literal light surfaces. Compact
usage used literal black text, white inputs and light hover colours. Report
dialogs referenced an undefined panel token and therefore fell back to white
even when their text inherited the dark theme. SVG marks also used literal
black and grey paints.

Shared neutral roles now follow the existing document theme. SVG and inline
workload paints reference those roles, so a theme change does not require a
data refresh or report reconstruction. Workload labels retain red/yellow/green,
with theme-specific readable shades. Search placeholders explicitly use the
muted text role. Cache grid and selection treatments follow the theme while
retaining a 4% selection fill, rather than obscuring the underlying evidence.

## Validation

- Final UI gate: `pnpm run product:ui:test`, 1,007 passed, zero failures.
- Focused appearance/overview/simplification checks: 15 passed. Tests include
  WCAG contrast calculations for text, selected controls and chart marks, and
  theme-relative SVG/inline paints.
- Preflight: 20 passed under normal Windows permissions. Sandboxed attempts
  encountered temporary-file Git/rename restrictions; those are not passing gates.
- Browser with real-system data: 590px viewport, project/thread and model
  details, composition and cache dialogs. No page overflow; narrow layouts
  retain percentage text and hide optional tracks. Cache reuse evidence was
  unavailable in the live report and remained explicitly unavailable.
- Final browser project report: light/dark totals and dimensions were identical.
  Dark dialog surface/text were RGB 32/32/32 and 242/242/242; light values were
  255/255/255 and 17/17/17. The final dark search placeholder was 184/184/184,
  replacing Chromium's insufficient default 117/117/117.
- Actual Electron rendering with real data: light and dark overview, usage
  list, project and thread reports; already-open thread details changed theme
  without losing content. The original `system` appearance preference was restored.
  Final-candidate native startup and usage rendering were additionally inspected.

## Artifact and startup

The primary working tree and its unrelated test changes were preserved. A
separate local QA Git object and ignored checkout provided a clean, exact source
snapshot for the unmodified production candidate preparation gate. No primary
branch or staging-area commit was created.

Final snapshot: `dcf791a048b4b92317410eee97f1971ee0a5a185`.
Build `2026101603`, Node.js 26.2.0, Electron 43.5.0, Windows x64.
Source/dependency/native closure and packaged metadata verification passed.

ASAR SHA-256:
`e098b1309bae49d16b4faf2e86563f30bb0031ff5591194c824b8fb0589c49ee`.
Executable SHA-256:
`b303bdaaf0a1db3a8f163dc9dcf3e4f8884870a5e446d35c0231c9bf19c52f1c`.

The previous app was exited through its normal UI; previous unpacked artifacts
remain available. The final candidate started with the normal real profile at
2026-10-16 02:26:31 JST. Startup refresh completed at 02:27:30 JST. Subsequent
health and published snapshot states were ready, refresh succeeded, with no
reported refresh error. This is a startup/rendering check, not a new 15-minute
soak qualification. The app remains running. No installer was run, and no signing
or publishing was performed.

Read-only preservation validation retained all 28,569 original work lifecycle
facts, 273,963 usage events and 389,170 quota occurrences unchanged. Integrity
and foreign-key checks passed. New normal collection remains additive. Raw
real-system data and rendering captures stay in ignored owner-local QA output.
