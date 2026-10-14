---
title: Dashboard UI restructure Stage 0 inventory
date: 2026-10-13
type: plan
status: in-progress
---

# Dashboard UI restructure: Stage 0 inventory

Stage 0 record for the [four-entry dashboard UI plan](./2026-10-13-dashboard-ui-restructure.md).
It was taken by source reading at `e939620f` on branch `fix/windows-codex-refresh`.
It records where each existing capability lives, where it moves, and how a later
stage verifies it. Line numbers are approximate anchors as of that revision. No
runtime, browser, or packaged inspection is part of this record.

## Current shell

- Seven pages: `overview`, `weekly`, `trends` (`#timeline`), `performance`,
  `method` (`#accounting`), `projects`, `community`. Sidebar links are in
  `apps/web/public/index.html` (~141-147). Hash routing is in
  `apps/web/public/navigation.js` (`PAGE_BY_TARGET`). The `history`, `backend`
  and `data` hashes are aliases for `community`.
- In-page views come from `mountDashboardLayout` in `apps/web/public/app.js`
  (~11690-11900). It injects a `.dashboard-view-switch` segmented group per page
  and toggles `[data-page-view-inactive]` (`display:none !important`). The first
  view is the default. Hidden panels keep their data and are redrawn on resize.
- The `tibotattle:page-view` event selects a view. Its only dispatcher today is
  `focusTrendsPeriod` (divergence "View period" → `trends/activity`).
- `<details>` summaries anywhere in `#main` open as `#overview-details-dialog`.
  The live child nodes move into the dialog and back. It closes on backdrop
  click or Escape.
- Whole-page scaling: `fit()` sets `style.zoom` on the active screen when its
  natural height exceeds the window. The plan requires replacing this in Stage 4.
  Replaced in Stage 4: pages keep their natural size and the window scrolls
  under the sticky topbar and sidebar.
  Tooltip positioning (`model-performance.js`) and the cache-matrix width
  observer run under this zoom.

### Navigation callers to update in Stage 1

| Caller | Location | Targets today |
|---|---|---|
| Sidebar links | `index.html` ~141-147, `styles.css` ~272-278 (icons) | all 7 pages |
| Hash map and tests | `navigation.js`, `apps/web/test/navigation.test.mjs` | aliases incl. `accounting`, `timeline`, `history`, `backend`, `data` |
| Electron View menu | `apps/electron/desktop-menu.js` ~146-149 | weekly, timeline, accounting, projects |
| Tray menu | `apps/electron/desktop-tray.js` ~173-183 | weekly, timeline, accounting |
| Tray popover actions | `desktop-tray-popover.js` ~32-47 → `desktop-lifecycle.js` ~715-730 | weekly, timeline, accounting/usage |
| Section IPC | `desktop-lifecycle.js` → `desktop-command.js` → `preload.cjs` → `apps/web/public/desktop-shell.js` (fixed section map) | sets `location.hash` |
| Share button | `index.html` ~120-126, `desktop-shell.js` `navigateToSharePanel` | `#weekly` + focus `#share-panel` |
| Open Community | `desktop-controller.js` `openCommunity` ← Settings "Manage sharing" | `#community` |
| Windows smoke | `scripts/smoke-electron-windows-normal-candidate.mjs`, `test/electron-windows-normal-candidate.test.js` | `performance`, `projects` |

There are no page keyboard shortcuts. `usagemonitor://open` carries no page target.

## Capability migration inventory

The verification column names the check that must hold at the end of the
stage that moves the capability.

| Existing | Source anchor | Target | Must verify |
|---|---|---|---|
| Overview allowance cards | `renderQuotaCards` | Overview | Codex/Spark/other pools stay separate; "—" for unknown; reset; stale chip. Cards are not interactive today, so card navigation is new work (Stage 4) |
| Overview price + Partial | `renderPricing`, `index.html` ~343 | Overview | Partial badge beside amount; speed/Standard basis; unavailable projection states |
| Indexing progress | `renderHistoryProgress` | Overview | not_started/paused/partial_terminal/aggregate_unavailable phases |
| Allowance comparison | `renderComparison` + calibration disclosure | Overview | observed vs calculated; Insufficient state; calculation notes dialog |
| accounting.summary | `#accounting-summary`, `renderAccounting` | Usage totals | token/value totals; retained stale-serve variant; partial coverage |
| accounting.components | `.accounting-component-grid` | Usage totals → Usage composition | two component bar panels; Standard-rate basis |
| accounting.models | `.accounting-models-panel`, `renderAccountingModels` | Usage, Model dimension | all rows; component expansion (click+keys); Token share vs Value share; four price-cell states; `*` separate-allowance footnote. No user sorting exists today |
| accounting.cache | `#cache-reuse-outcome`, `cache-reuse-matrix.js` | Usage, Cache analysis | 10 elapsed buckets × 2 outcomes; model picker; "Sample" under 10; unavailable/no-evidence |
| accounting.diagnostics | `.advanced-diagnostics` | Cache analysis detail | switch table (incl. estimated lost reuse); continuity table; 6-row pagination; thread links loopback-only, else text |
| projects.list | `work-usage-view.js` | Usage, Project dimension (default) | Projects/Threads grouping; sort tokens/cost/recent; model filter; scope (≥2 scopes); search incl. thread-ID lookup; drill-down + Back restoring page/focus; worktrees; subworkers; cursor pagination incl. nested; coverage notices; cancel |
| projects.components | `.work-usage-mix` | Project results → Composition | composition over the active filtered scope, never global totals |
| trends.activity | `.trends-capacity-panel`, `trends-horizon.js` | Allowance changes (+ Usage trend entry) | aligned tracks; readouts; hour/day/week grouping; replay (reduced-motion stop); pan/zoom/reset; cursor |
| trends.comparison | `.trends-comparison-panel`, `renderTimeline` | Analyze differences | observed/calculated; difference area; confidence/coverage; fixed 3h window (zoom buttons hidden by owner decision 2026-08-06) |
| trends.drift | `.trends-drift-panel`, `renderResiduals` | Analyze differences | cumulative drift; breaks at resets/gaps |
| trends.divergence | `.divergence-panel` | Analyze differences | full list, 4/page; View period → activity localization; lazy model/speed breakdown; retry |
| trends.evidence | `.trends-exact-panel` | Analyze differences → Evidence | all rows, 6/page; exact windows and quality labels |
| weekly.history | `.weekly-hero`, `.weekly-history-panel` | Allowance equivalent | 5h/7d window toggle; plan select; observed-span slider (floor forced to 0 below 7 days); headline median is unfiltered, chart is filtered |
| weekly.forecast | `#weekly-pace-forecast` (inserted by JS) | Usage forecast | forecast, waiting/stale, details disclosure |
| weekly.details | `.weekly-table-panel` | Allowance equivalent → Cycle detail | full unfiltered history, 6/page |
| weekly.share | `#share-panel`, `renderShareCard` | Removed (2026-10-13 decision) | — |
| performance.speed/latency | `model-performance.js` | Model performance | model tabs; standard/fast/ultrafast modes; P10–P90/P25–P75/P50; sparse hollow markers under 5; measured/total turns; unknown-mode exclusion; cancel/retry; 60s cache, preload backoff |
| community | `index.html` ~943-980, `app.js` sharing render/set | Removed (2026-10-13 decision) | see below |

Data owners stay separate. Overview, Accounting, Weekly and Trends share
`LocalCompanionClient.load()`. Projects uses `POST /api/local/work-usage/query`.
Performance uses `GET /api/local/model-performance`. Divergence breakdown uses
`/api/local/timeline/window-breakdown`. Project filters never apply to the
global model table.

## Community and sharing removal (Stage 1)

The owner decided on 2026-10-13 to remove community sharing, contribution and
share cards ([decision](../decisions/2026-10-13-desktop-sharing-removal.md)).
That decision supersedes the earlier proposal to move the sharing switch into
Settings.

Stage 1 removes the following desktop pieces:

- the `#community` page and the Overview transition notice;
- the Settings sharing card;
- the Share button and the share-card view;
- the Electron sharing, download, and hosted sign-in IPC;
- the companion contribution routes and schedulers.

Saved choices and credentials stay on disk, unread. The public website
community files and the Worker are deployed services and stay until a separate
retirement.

## Existing defects found

| Defect | Evidence | Stage |
|---|---|---|
| Share focuses a hidden panel unless the user already chose the Share view | `navigateToSharePanel` sets only `#weekly`. The `share` view stays inactive (`display:none`). The test uses a fake panel | 1; obsolete because Share is removed |
| Share copy says card text is "listed below", but no such element exists; `copyShareCardText` has no caller | `app.js` ~4003, 4100, 4202-4217 | 1; obsolete because share cards are removed |
| Hard-coded English bypasses `t()` | share-card status/toast; usage summary labels (~5356); timeline confidence copy; "Auto review" (`work-usage-view.js`, `app.js`); comparison bar labels `index.html` ~394, 399 | owning stage; 3: comparison bars and confidence copy were already translated through the legacy table except one confidence sentence; the three confidence sentences and the comparison summary cards now use `dashboard.timeline.*`/`dashboard.summary.*` keys. 4: "Auto review" uses `accounting.cacheDropThread.autoReview` |
| Projects top-level unavailable/error has no local Retry (only nested children do) | `work-usage-view.js` ~703, ~1416 | 2; fixed: Retry for error/unavailable only |
| Divergence breakdown offers Retry for 400/404/405 "unavailable" responses that cannot succeed | `data-client.js` ~5796, `app.js` ~6366-6420 | 3; fixed: 400/404/405 and invalid bounds read as `unsupported`, settled for the revision without Retry; transport failures and the companion's own "unavailable" keep Retry |
| Cache-switch API-equivalent cell shows bare "—" where the model table distinguishes four reasons | `app.js` ~9594 vs ~10239 | 2; fixed: "Not priced" with reason (rows carry no pricing status, so the four model-table reasons cannot apply) |
| Accounting model rows have no per-row Partial marker (Projects rows do) | `app.js` ~10389-10544 | 2, record only unless the data supports it |
| Stale comments on page sizes and viewports | `app.js` ~260, ~5383; `index.html` ~537, ~775 | as touched |
| No AbortController in the shared `load()`/`windowBreakdown` path; staleness is token-guarded | `app.js`, `data-client.js` | record only; plan forbids adding capabilities |

## Constraints for later stages

- The activity track cannot be mounted twice. `trends-horizon.js` is a
  singleton with fixed element ids. The Usage trend entry should navigate to
  Allowance changes, not clone the chart (the plan's first option).
- i18n: canonical keys live in `packages/i18n/index.js`. Regenerate with
  `npm run i18n:browser:generate` and `npm run i18n:electron:generate`.
  The runtime allowlist is the prefix filter in `localization.js` (~169-193).
  `nav.` and `community.` are not allowlisted. Sidebar labels are partly literal
  and partly from `LEGACY_TEXT_CATALOG`.
- Tests that encode the seven-page model and need contract updates with
  Stage 1: `navigation.test.mjs`, `desktop-shell.test.mjs`, `lib.test.mjs`
  (`data-nav="community"`), `community-site.test.mjs` (the `index.html` Community
  assertions only), `electron-sharing-ui.test.mjs`,
  `apps/electron/test/desktop-controller.test.mjs` (`openCommunity`), and the
  menu/tray/command/contract tests.
