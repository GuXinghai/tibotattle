---
title: Dashboard UI restructure with preserved analytical detail
date: 2026-10-13
type: plan
status: planned
---

# Dashboard UI restructuring plan

## Status and authorization boundary

The owner approved the four-entry concept on 2026-10-13 and explicitly required
the implementation to retain details omitted from the preview and valuable
existing design references. This plan defines navigation, presentation, feature
migration, and acceptance criteria. It has not been implemented. Concept approval
confirms the design direction; it is not source, native UI, or release acceptance.

The source investigation baseline is `8b0e5646`; the original plan was committed
as `1bb83bc9`. Recheck the checkout and entrypoints before implementation. Do not
repeat completed copy and dialog changes. Scope covers the Windows Electron
dashboard, visual coordination with Settings, and associated navigation callers.
The public website, Worker, ingestion, pricing, quota algorithms, identity, and
persistent data are outside this restructuring scope. Do not publish, deploy,
or modify real user profiles. This English rewrite is documentation-only and
does not build or restart the application.

The concept establishes layout direction, card treatment, four-entry navigation,
and state presentation. Its fictional projects, models, active hours, period
comparisons, rankings, cache-hit rates, and simplified curves are not feature or
data contracts. Do not introduce metrics without an existing authoritative data
source. Reuse real results; do not derive algorithms from the mockup.

## Goals and invariants

- Four primary destinations: **Overview, Usage & costs, Allowance, Model
  performance**. Settings remains a utility entry. Retain the approved Chinese
  labels: **概览、用量与成本、额度、模型性能**.
- Remove community sharing, contribution, and share cards from the desktop
  product ([owner decision 2026-10-13](../decisions/2026-10-13-desktop-sharing-removal.md),
  superseding this plan's earlier move of sharing controls into Settings).
  Saved opt-outs, receipts, salts, and identities stay untouched on disk. The
  deployed Worker and public site are retired separately. Previous wording:
  existing capabilities
  must continue to own sharing preferences, transition notices, upload capability
  information, and durable opt-outs. This does not remove the public website,
  backend, retained history, or sharing contracts.
- Retain cards, warm neutral surfaces, brand green, model icons, and existing
  formatting. Unify hierarchy and placement without replacing the complete chart
  or control system merely for visual consistency.
- Keep default primary views scannable within ordinary supported desktop windows.
  Expose complex details through explicit views, pagination, or detail surfaces.
  Allow bounded scrolling in small windows or at high display scaling; do not
  crop content or shrink all text to fit.
- Reduce permanent copy while preserving essential qualifications and complete
  details. Missing, stale, partial, failed, unattributed, unavailable, and observed
  zero remain distinct. Display windows do not change retention.
- Do not add calculations, query scope, or network capabilities. Presentation
  changes do not justify old-version compatibility layers or database migrations.

## Design references and preservation

Current source establishes implemented capabilities. The older documents below
provide design rationale; they do not independently establish current behavior.
This plan supersedes conflicting navigation and presentation directions while
retaining valuable interaction and analytical designs.

| Reference | Preserve | Adjust or do not restore |
|---|---|---|
| Owner-approved `tibotattle-concept.html` | Four destinations, light cards, number/text hierarchy, compact statuses, and scenario presentation | Sample data, omitted features, fixed graphics, and demonstration actions are not production specifications |
| [Component reference](../reference/2026-09-13-dashboard-component-reference.md) | Distinct treatments for views and filters; chart-card anatomy; state semantics; regional formatting; native tables; keyboard focus; light/dark themes | Do not restore early liquid allowance tanks, repeated timestamps, or old navigation; reuse only applicable classes |
| [Trends design research](../research/2026-09-13-trends-visual-design-direction.md) | Shared time axis and cursor; allowance/activity tracks; difference area; zero-centered difference strip; event markers; cumulative drift; exact evidence | Sky scenes, day/night decoration, and simultaneous display of every analysis were superseded by later simplification |
| [Model performance design](../design/2026-09-09-model-performance-page.md) | Focused model; P10–P90, P25–P75, and P50; units; measurement coverage; sparse markers; keyboard and hover inspection | Older standalone date controls and long-page layouts do not override the current shared reporting range; do not adopt mockup model rankings |
| [Projects and threads design](../design/2026-09-08-thread-project-usage.md) | Precise table comparison; small share bars; project/worktree/thread hierarchy; unattributed rows; denominators over the entire result population | Reconcile historical naming, search, and worker limitations with current source; do not restore redundant device explanations |
| [Initial simplification](./2026-10-08-dashboard-first-simplification.md) | Static allowance bars; concise explanations; dialogs that retain live DOM nodes; separation of forecast and overview | Replace whole-page proportional scaling; keep retired decoration removed |
| [Single-screen views](./2026-10-08-single-screen-dashboard-views.md) | View switching that retains all detail; pagination; cancellation; retry; scope and selection stability | Replace the seven-page classification and peer-level technical labels with the task structure below |

Retain these references as traceable design rationale. During implementation,
clarify their new applicability where needed. Preserve material with continuing
design value, and prevent old documents and the new navigation from acting as
conflicting operational instructions. External product links remain existing
research leads; this plan does not claim to have reverified those sources.

## Navigation and feature migration inventory

The four destinations correspond to viewing results, locating usage, examining
allowance, and inspecting responsiveness. Overview is the startup destination.
Do not hide the original six destinations behind collapsible groups or a generic
“More analysis” menu.

| Existing page/view | New location | Required capabilities |
|---|---|---|
| overview | Overview | Every real allowance pool; remaining allowance; reset; price; indexing progress; allowance comparison; calculation basis and uncertainty |
| accounting.summary | Usage & costs totals area | Token and monetary totals; speed-pricing and retained-result basis; partial coverage |
| projects.list | Usage & costs default Project dimension | Project/thread grouping; search; sorting; model/scope filters; return and expansion; complete pagination |
| accounting.models | Usage & costs Model dimension | Every model row; component expansion; token/value shares; unavailable/partial prices; separate-allowance markers |
| accounting.components | Totals area: Usage composition | Existing token and price components; mutually exclusive component rules; Standard-rate pricing basis |
| projects.components | Project/thread results: Composition view | Composition within the active filtered scope, without substituting global totals |
| accounting.cache | Usage & costs: Cache analysis | Existing cache matrix; elapsed-time/configuration dimensions; sample counts; availability and explanation |
| accounting.diagnostics | Cache analysis diagnostic detail | Switching associations; large continuity drops; estimated reuse loss; thread links; pagination; observed-versus-inferred distinction |
| trends.activity | Allowance: Allowance changes; Usage provides a usage-trend entry for the same reporting range | Aligned allowance/activity tracks; selected-time readouts; grouping; replay; pan/zoom; reset inspection |
| trends.comparison | Allowance changes: Analyze differences | Observed/calculated lines; difference areas; signs; quality classifications; coverage; fixed comparison window |
| trends.drift | Analyze differences: Cumulative drift chart | Within-cycle accumulation; breaks at resets/gaps; signed direction and units |
| trends.divergence | Analyze differences: Divergence periods | Complete list; pagination; chart localization; model/speed breakdowns; failure retry |
| trends.evidence | Analyze differences: Evidence detail | Exact windows; observed/estimated/difference/quality; all rows; timestamps and measured spans |
| weekly.history | Allowance: Allowance equivalent | Overall median; historical estimates; slope-agreement range; observed-span control; short-observation classification |
| weekly.forecast | Allowance: Usage forecast | Existing forecasts; applicable window; samples and intervals; insufficient-evidence reasons |
| weekly.details | Allowance equivalent: Cycle detail | Complete cycle results; pagination; status and range |
| weekly.share | Removed (owner decision 2026-10-13) | Share-card generation, preview, save/copy, Share view, and global Share button are removed |
| performance.speed/latency | Model performance: Generation speed/First-token latency | Model/mode selection; percentile bands; actual samples; measurement methods; sparse evidence; local recovery behavior |
| community | Removed with all desktop sharing (owner decision 2026-10-13) | No sharing switch, notice, upload, or promotional link remains; saved choices stay on disk unread |

Every capability needs a discoverable entry. Hidden DOM or a surviving backend
response does not demonstrate feature preservation. The Usage trend entry reuses
existing data and interactions and may navigate to the activity track in
Allowance changes. Initially reuse the complete dual-track view. If split into
single tracks, verify matching time, selection, and gaps across both entries;
do not recalculate the series.

## Page structure

### Overview

Retain result cards and a concise comparison. Choose cards from available real
data, not mockup active hours or period comparisons. Distinguish allowance pools
and windows: do not merge Codex and Spark or render unknown values as exhausted
balances. Each card has stable slots for its name, main value, short status,
necessary time/reset information, and detail entry. Long error copy must not
move primary values. Preserve the existing Partial marker beside price and
access to comparison methods and fitted information. Card navigation targets a
specific view and retains the active reporting range.

### Usage & costs

Place totals above the default project table. Project/Model selects the viewing
dimension; retain Project/Thread grouping within the Project dimension. Label
filters and show effective conditions. Grouping, sorting, and view switching
must not all look like identical pills. Project and thread counts may become a
quiet summary row, but their values and definitions remain intact.

Model and project tables retain their respective data owners and scopes. Do not
invent a common aggregation API or silently apply project filters to the global
model table. Explain which filters remain effective on dimension changes, and
preserve each dimension’s selection, pagination, parent position, and recovery.
Keep existing amounts with necessary Partial markers; preserve pricing coverage
in detail. Visible columns must distinguish Token share from Value share.

Usage composition from totals, Composition for project results, and Cache
analysis must be readily discoverable. Complex cache matrices and diagnostic
tables use analytical views rather than small popovers. The two cache-impact
measures no longer have equal visual weight with reporting-period totals.

### Allowance

Retain three task views: Allowance changes, Allowance equivalent, and Usage
forecast. Place window and plan selectors within their actual scope. Allowance
changes retains the main dual-track chart. Analyze differences is a returnable
analytical view with comparison, cumulative drift, and divergence periods.
Evidence tables open on demand without creating three stacked tab levels.

The overall allowance-equivalent median and filtered history chart must not
appear to cover the same population. Use explicit short labels and the active
filter. Preserve the observed-span control’s actual meaning in short windows.
A slope-agreement range is not a confidence interval; a reporting period is not
an allowance reset cycle; the three-hour comparison window is not a date filter.

### Model performance

Retain the focused-model design. Separate model/mode filters from speed/latency
view selection. Preserve layered percentile charts instead of replacing them
with fixed mockup bars, simple averages, or model rankings. Each metric keeps
its own coverage, units, interval, and sparse representation. Measurement detail
retains direct-timing versus estimated-sample distinctions, unknown-mode
exclusions, and existing statistical definitions. Models with available latency
but unavailable generation speed remain inspectable. Model switching, reporting
range changes, preloading, cancellation, and retry must not add unnecessary
repeated reads.

### Settings and detail surfaces

> The sharing and share-card requirements in the next paragraph are superseded
> by the 2026-10-13 removal decision. Settings keeps its other sections.


Settings retains its Electron owner and existing sections; coordinate visuals
without migrating stored state. Show the saved sharing preference separately
from upload capability. Removing Community must preserve required notices and
Keep sharing off actions. Result sharing generates a card; it does not enable
ongoing contribution or create a mockup external link. The global Share action
must select the correct page and share view before focusing its content.

Short explanations use the existing detail dialog. Complex charts/tables use
returnable analytical views. Ordinary detail dialogs have no close button:
clicking outside or pressing Escape dismisses them and returns focus. Retain
live content nodes and update/retry handlers. Do not mechanically apply this
closing behavior to Settings, confirmations, or flows with unsaved input.

## Shared visual and state contract

- Unify system typography and number formatting. Distinguish titles, primary
  values, and supporting text while retaining model identity. Use light card
  borders, moderate radii, and consistent padding. Chart colors keep their
  existing data meaning.
- Keep one reporting-range control in the header: 24 hours, 7 days, 30 days,
  and All. Exact boundaries remain available on demand. Each local window,
  model, mode, and scope has one clear owner. Do not reproduce the mockup’s
  duplicate Settings entries.
- Views use an active underline, filters use labeled inputs, actions use
  buttons, and statuses use short text. Meaning must not depend on color alone.
- Global refresh failures appear beside Refresh as a compact summary, such as
  “Analysis completed, but allowance update failed [Details].” Local chart,
  query, and setting failures stay in their affected region with real retry
  and cancellation behavior.
- Partial pricing retains the amount with “── Partial” to its right; pricing
  and coverage details remain accessible. Keep stale values with nearby
  qualifications. Missing values use “—” with a short reason; only observed
  zero becomes zero.
- Do not restore “Codex usage recorded on this device,” a permanent report
  timestamp, repeated days below the amount, “API-equivalent amount · Not a
  bill,” the long 30-minute-old warning, or the long unknown-model/unpriced
  warning. Necessary pricing basis, freshness, and exact timestamps remain
  accessible without rewriting companion facts.
- Preserve light/dark themes, Chinese/English/Spanish, regional date/money
  formatting, visible focus, and reduced motion. Handle narrow windows through
  wrapping, optional-column reduction, pagination/detail, and bounded local
  scrolling rather than whole-page `zoom`.

## Implementation stages and exit criteria

| Stage | Work | Exit criteria and independent commit boundary |
|---|---|---|
| 0: Inventory | Reconcile this table with current entries, controls, detail, and states; identify existing defects | Record destination and verification for every capability; do not label unimplemented behavior preserved or reinvestigate unrelated platforms |
| 1: Shell | Four destinations; view/filter hierarchy; status slots; removal of Community, sharing/contribution, and share cards | All four destinations and internal navigation/shortcuts work; Settings remains accessible; preserved state untouched; commit shell and removal independently |
| 2: Usage | Compose project/thread and global model views; connect composition and cache analysis | Search, scope, pagination, expansion, and full-population denominators unchanged; diagnostics separated from totals; independent commit |
| 3: Allowance | Compose allowance equivalent and trends; retain all analysis and forecasts | Verify shared time, event localization, complete evidence, and window/filter semantics; independent commit |
| 4: Visuals | Overview/performance cards; common typography; Settings coordination; replace whole-page scaling | Clear defaults and discoverable detail; long states/languages do not shrink text; commit by verified module |
| 5: Acceptance | Focused pagination/state/navigation checks; Windows trial package; manual page-by-page review | Record source, browser, and packaged runtime separately; owner reviews design and detail; release gates remain separate |

Connect every replacement destination completely before removing its old
container. Do not maintain two long-lived UI implementations. Update actual
callers, hashes/view events, menus, and Share actions instead of building
old-version compatibility. Retain a single explicit mapping only where a
current call chain needs it; do not add aliases without callers. Check real
references before removing shared charts, formatting, model visuals, or
measurement components.

Update canonical i18n and regenerate mirrors, including the actual runtime key
allowlist. Align navigation/DOM/feature-contract tests and affected help and
component references. Preserve historical documentation boundaries; do not
rewrite old receipts with later completion claims. Commit verified independent
changes locally as they are completed.

## Acceptance checklist

Feature preservation is the first gate. Every migration row must have an entry,
inspectable results, and its failure path. Merely switching four concept pages
is insufficient. Record genuinely absent data/actions as gaps; do not invent
them from historical design documents.

| Scenario | Required observation or action |
|---|---|
| Normal | Four destinations and clear default results; consistent date/model/window selection; all analysis and detail reachable with return navigation |
| Partial | Amount retained with Partial; inspectable coverage, estimated samples, and chart gaps; no fabricated zero or whole-page concealment |
| Refresh failure | Compact header summary, detail, retained results and necessary qualifiers; local retry independent of other valid results |
| First use/no data | Distinguish no records, no search matches, unavailable capability, and indexing wait; retain valid filters and recovery actions |
| Stale/in progress | Last trustworthy values, actual progress, cancellation, and restart recovery unchanged; old results never presented as newly updated |
| Complex detail | Multi-page project/thread results, worktrees/subworkers, composition, cache matrix, divergence periods, all cycles, and exact evidence accessible |
| Presentation/accessibility | Keyboard/Escape/focus; scaling/narrow windows; light/dark and long translations readable; consistent tooltips, cursors, and event selection |

Start with affected navigation, views, i18n, scope, retained-result, pagination,
and interaction-contract checks. Do not write tests that merely mirror pixel
styling or repeatedly rerun the entire root suite to chase green. Determine
whether each failure reveals a genuine regression. After UI integration, run
`pnpm run product:ui:test`; run `pnpm run architecture:check` for dependency
boundary changes. Documentation requires `pnpm run docs:check` and
`pnpm run test:preflight`. Do not increase timeouts, weaken assertions, or
sacrifice detail to pass checks.

Final visual review targets actual Windows Electron. Use isolated synthetic
profiles for the scenarios and multi-page detail above. Real data is for
owner-controlled local manual viewing only, never automated fixtures, logs,
screenshots, or committed content. Check representative windows and Windows
125%/150% scaling; correct crowding through layout. Update the trial package
only during implementation; this planning handoff does not build it. Source or
browser success does not qualify installation, signing, updating, or release.
Do not publish before critical release gates pass.

## Outstanding gates

- Stage 0 inventory: [capability and caller inventory](./2026-10-13-dashboard-ui-inventory.md).
- No implementation or acceptance of the new navigation and feature migration.
- Share focusing a hidden view was a static path finding; the Share action is
  removed by the 2026-10-13 decision.
- The Usage trend entry and discovery
  of complex analysis still require complete integration.
- Approved concept appearance does not prove production-data density, correct
  measurement scopes, or readable access to every detail.
