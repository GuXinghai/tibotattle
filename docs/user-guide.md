---
title: User guide
date: 2026-09-23
type: guide
status: maintained
---

# TiboTattle user guide

TiboTattle is a local-first desktop application for understanding AI-tool usage,
cost, quota windows, and trends. Local analysis works without an account and
keeps session content on your device. The desktop app sends no usage data: it has no community sharing, contribution upload, or hosted sign-in ([decision](./decisions/2026-10-13-desktop-sharing-removal.md)).

TiboTattle supports Windows x64 only. See [platform support](./reference/platform-support.md)
for the current distribution and its qualification limits.

## Install and first launch

Download the Windows x64 installer from [tibotattle.com](https://tibotattle.com/#download)
or the [latest GitHub release](https://github.com/adamallcock/tibotattle/releases/latest),
then run it. For checksum and signature checks, follow [verify-release.md](./verify-release.md).

Launch TiboTattle after installation. The app bundles its runtime; Node.js and
pnpm are needed only for development, not for installing or using the app.

On first launch, the app explains which local sources it may inspect. Those are
the selected OpenAI Codex session and archived-session directories, the Codex
state database, display-name index and local configuration, and content-free account, quota, and
usage projections from the installed Codex app-server. The shipping refresh
does not read Claude or Gemini sources. TiboTattle derives usage/accounting
metadata; it does not upload prompts, responses, commands, filenames,
credentials, or raw session content.

The first index can take time on a large history. Keep the app open until the
foreground progress completes. Loading, unavailable, stale, or unattributed
states are meaningful; TiboTattle does not replace missing evidence with zero.

## Reading the dashboard

The desktop window has one top row: application menus on the left and native
Windows minimize, maximize and close buttons on the right, without a separate
application-name row. Drag the empty area to move the window; double-click it
to maximize or restore. Menu shortcuts remain available, and closing the window
continues to hide it to the tray. Use **File → Exit** or **Ctrl+Q** to quit.

The window-background image picker remembers the folder of the last confirmed
file selection across restarts. If that folder is unavailable, it uses the
system default. Cancelling the picker leaves the remembered folder unchanged.

Overview contains five cards: remaining weekly allowance over seven days, plan
work hours, seven daily consumption bars, current workload, and actual consumption
relative to expected. It does not show an exhaustion date or countdown.

Completed local setup stays hidden on Overview; setup that still needs attention
remains available. The plan picker marks the current observed plan as **Current**,
and **Refreshed** shows the age of the latest quota observation, not the time the
page was opened. Out-of-date observations keep their explicit warning.

Work hours include the whole task: thinking, tools, tests and necessary waiting.
Parallel tasks count once; time between tasks is excluded. Heavy, medium and light
loads are clustered from recent API-equivalent usage per work hour. Historical
remaining hours use actual quota deductions; current workload uses the last
fifteen minutes of API-equivalent usage and task work time. These are local
analysis estimates under a single-account, continuous-subscription assumption.

Actual consumption relative to expected uses the same observed plan periods as
overview history. A missing plan label after a preceding explicit observation
inherits that period's plan; comparisons using such labels carry the inferred
attribution note. This does not infer an account, cross an explicit plan change,
resolve conflicting observations or prove an uncertain reset. Actual and
expected subtotals use the same accepted intervals. The title's small **Since**
timestamp identifies the startup boundary; the former separate startup and
partial-coverage paragraphs are omitted. Unpaired-interval errors remain in the
diagnostic details. Stored observations remain unchanged.

Only matched task completion/interruption records or a valid reported duration
establish historical task time. An old unfinished task cannot borrow later
tasks' receipts as its ending. Missing endings remain uncertain; independently
proven parallel work can still establish their shared wall-time coverage.
Explicitly conflicting boundaries remain errors. Uncertain time is excluded
from rate estimates and classification, while recorded consumption is retained.
Fresh tasks observed starting during this run can contribute ongoing time.
When a parent task has its own complete start/end pair, a fork's cancellation
does not invalidate that parent's work. Child tasks still retain their own
cancellations; conflicting completions or missing ownership remain explicit.

Classification fits three duration-weighted groups, each with at least three
five-minute bucket samples and at least one minute of total work. Identical
intensities stay together. The fitted boundaries classify both history and
current load; insufficient evidence leaves consumption unclassified. Known
zero-cost work remains eligible. Large values are not automatically removed or
capped. The classes are relative to the recent window, not provider-defined
workload categories, and can change as that window changes.

All overview cards publish together on a five-minute cadence. Manual refresh uses
the same pipeline and restarts the countdown when work settles. First history
preparation can take longer. Missing values remain unavailable; failures name
the affected stage, and retained results keep their original timestamp.

Overview diagnostics appear below the cards. Expand them to inspect unpriced
records, Token components, reasons and runtime-evidence capture status. Unknown
models remain unknown; recorded usage is preserved without guessed prices.
While TiboTattle is open it incrementally retains content-free model and retry
evidence before Codex removes its diagnostic logs. Capture does not change the
dashboard's five-minute publication cadence. Closing TiboTattle stops capture;
it cannot recover upstream logs that have already been removed.

Daily bar totals allocate closed quota changes using priced local usage. Equal
balances update freshness without moving the allocation start; the first lower
balance closes the interval. A later deduction may therefore redistribute
consumption across earlier dates. The unfinished tail does not count as zero
consumption in historical work-hour rates. Reset, account and plan boundaries
remain separate; missing models and prices are not guessed.

Unclassified same-day consumption remains in that day's bar. A cross-day
interval without reliable daily weights appears instead in **Cross-day
unallocated consumption**, at the very bottom of Overview after all cards and
diagnostics. Its collapsed summary separates plans; expand it for times and
reasons. No records means no extra area. At most twenty interval details are
shown, while totals include every interval. Known consumption is never counted
in both places. Observation gaps and resets are not smoothed away.
The relative-consumption chart compares quota deduction with
API-equivalent usage divided by fitted weekly capacity; it does not correct the
current workload rate. Detailed usage, allowance and performance analysis remain
available on their respective pages.

The existing **Current workload** card shows **Short-term load** over the last
fifteen elapsed minutes, using API-price-equivalent amount per evidenced work
hour and the historical light/medium/heavy classifier. Parallel work time counts
once; idle gaps are not working hours. This needs at least one minute of evidenced
work and complete usage and work-boundary coverage. When a grade cannot be fitted
but API intensity is known, its numeric USD/work-hour value remains visible.
Remaining work hours use this short-term intensity and fitted capacity, respecting
plan boundaries. These are estimates, not observed subscription charges.

**Quota consumption trend** uses actual quota decreases over the trailing sixty
minutes, divided by the elapsed time between observations, in percentage points
per hour. It does not use API prices or active work time. Both endpoints must be
inside the window and belong to the current plan period and reset cycle; a shorter
observed span can produce a value without waiting sixty minutes. Unknown plan
labels use the existing marked plan-period projection, with `*` on inferred
values. Conflicts, identity changes,
resets and stale regressions cannot create a cross-boundary decrease. Unchanged
integer readings alone do not establish a measured zero consumption rate.

In this card missing or idle values display `-`, without an explanatory hint;
specific failures remain available in diagnostic details. Completed work leaves
the short-term window naturally. The existing refresh cadence is unchanged and
no process detector or background polling is added. Older saved projections retain
their historical cards as stale until refresh; their recent values are not
reinterpreted under the new windows or units.

The forecast names its pace assessment, estimated run-out, reset countdown and
any time without allowance. Its static timeline represents time until reset, not quota
percentage. Countdown labels use days and hours (less than an hour stays explicit).
Hover, focus or tap an underlined time for the exact timestamp and time zone.
Choose **Forecast basis and assumptions** to open observation coverage, overall and
active rates, and the uninterrupted-use estimate. Unknown amounts have no fill;
stale or earlier observations retain their evidence qualifiers.

All dashboard pages fit the window height. View switches separate related
measurements without changing the selected reporting range or fetching a new
report. Allowance Estimate separates history, forecast, reset details and share
cards; Trends separates activity, comparison, cumulative difference, divergence
periods and exact evidence. Usage and costs shows amount and Token totals with
project, thread and model breakdowns. Search and model filters sit beside the view
and measure controls; the headline remains the full reporting-period total.
Project and thread details open in a dialog; token composition and cache analysis
use separate lightweight entries. Dialogs follow
the global five-minute refresh while preserving navigation and scroll position.
Automatic approval reviews with verified parent relationships are included once
in the owning task family and shown separately from primary and subworker usage
in its details. Reviews without a verifiable parent remain separately labelled
as unlinked automatic reviews; their usage is still included in period totals.
Amount uses recorded speed and the corresponding event-time API price; unknown
speed or missing prices remain explicitly unpriced or partial. The Standard-price
analysis and subscription quota comparison remain separate calculations.
Performance separates speed from response wait. Selections survive report
redraws and language changes. Arrow keys, Home and End also operate each view
switch. Scope, coverage, freshness and failure messages remain available across
measurement views. Tables use short batches with their existing row navigation,
so the complete retained row set remains accessible.

Optional disclosures open in a dialog instead of extending the page. Close it
with **Close** or Escape to return to the originating control. If the owning
report is replaced while a dialog is open, it closes rather than displaying
detached evidence.


- **Overview and trends** summarize locally derived activity and quota evidence.
- **Usage and costs** use the repository’s accounting/pricing contracts. A cost
  estimate is not a provider bill.
- **Quota or allowance views** use provider-reported observations where
  available. Unknown plan, reset, or coverage stays explicit.
- **Source coverage** tells you which local inputs were available. A missing
  source is not “no usage.”

An initial cumulative usage snapshot may include earlier requests that cannot
be assigned a model, time or price. It establishes a baseline; the observed
later subtotal remains available with partial coverage. Unknown prefix evidence
is not zero usage. Source repairs and synthetic checks do not, by themselves,
verify the retained historical ledger or establish a provider bill.

Display windows do not delete older local history. The dashboard may show a
shorter horizon while the local index retains the evidence needed for replay,
corrections, and longer-term views.

Historical model identification and pricing updates require a completed main
**Refresh**. Desktop startup requests this refresh once local analysis is
allowed. Retained session and archived-session logs let the app correct earlier
unrecognized GPT-6.1 Sol and GPT-5.1 Codex Max records without changing token totals.
Codex Max has its own reviewed Standard API price: $1.25 input, $0.125 cached
input and $10 output per million tokens, from its
[official model page](https://developers.openai.com/api/docs/models/gpt-5.1-codex-max).
No unpublished API tier or historical speed mode is inferred. An exact stored
model identity can also be repriced from sufficient preserved token, context
and time evidence. If a record's model became `unknown` and its original log is
gone, the app cannot safely reconstruct that identity; missing evidence and
unsupported historical prices remain explicit. These are local analysis
updates. A repaired model identity does not automatically replace an already
accepted hosted contribution; hosted synchronization requires a compatible
correction contract.

When local history contains more than one plan, **Allowance** separates the
plans instead of averaging Plus and Pro reset estimates together. The plan
selector keeps the headline, history, range, and pace on the same selected population. The newest observed plan is selected even if it does not
yet have enough usable evidence; older-plan estimates remain selectable rather
than being presented as the current plan's allowance.

The calibration history under **Complete details → Allowance API equivalent** draws a **Robust LOWESS** trend alongside
its all-data median reference, raw dots and slope-agreement ranges. It uses only
the selected plan and visible, filtered reset estimates. The headline remains the all-data
median. LOWESS is not a confidence interval or proof that the
provider changed a limit.

LOWESS requires six distinct reset timestamps spanning 14 days. Gaps longer
than 28 days interrupt fitting, and ambiguous duplicate timestamps are excluded
from the fit. Above 250 visible resets, select a shorter range to enable fitting.
Both graphs explicitly label insufficient evidence and preserve raw estimates
instead of extrapolating through unsupported history.
The Allowance window control defaults to **7-day** whenever seven-day evidence
is available. Choose **5-hour** to replace the headline, history graph and reset
table with the selected plan's five-hour capacity history. Pace forecasts remain seven-day-only. A grey five-hour choice is an evidence state,
not a timer: run **Update local usage** so the detailed refresh can rebuild the
local accounting cache. The choice becomes available only when that retained
history contains a plan-specific five-hour reset with enough observed quota
movement to fit; missing evidence is never presented as zero.

These historical estimates are conditional on the locally observed plan, not
proof of which provider account generated every token. Known plan switches and
ambiguous boundary quantities are excluded narrowly; coherent older history is
still useful. **Usage and costs** continues to retain all-plan accounting totals.
The Aggregate and By model community views use a Pro 10x-equivalent weekly
basis. By plan charts each plan's own weekly API-price value on its own scale;
the card shows that value first and the Pro 10x equivalent underneath. The
plan value is the reference estimate divided by 1 for Pro 10x, 2 for Pro 5x,
0.4 for Pro Max 25x, or 10 for Plus. The Pro Max 25x factor assumes the
same Plus baseline as the existing tiers and awaits provider confirmation.
The Pro 10x rename retains the existing Pro history; it does not start a new
account or discard earlier evidence.
This is an estimated API value, not the subscription price, and does not authorize
mixing personal Plus and Pro allowance histories.

Cache analysis shows a conditional API-equivalent estimate based on decreases
between adjacent cache-read token counts. The currently reusable prefix, **C\***,
is unverified: a change in counts does not prove that the requests had the same
prefix, that more input was cacheable, or why the counts changed. The amount is
neither actual avoidable loss nor a lower bound on that loss. It is not a bill,
the lifetime cost of switching models, or a percentage of your allowance.

These diagnostics follow the shared **Reporting period**. The monetary scenario
uses positive decreases in adjacent cache-read counts, capped by the current
non-cache-read input. It reprices that assumed token quantity as cached input
at the current request's model, event date and input-context band, with the
reported speed or the stated speed assumption. This conditional repricing does
not establish **C\*** or reconstruct a request to the previous model. The 50%
threshold only classifies the ratio of cache-read counts; it does not limit which
positive decreases enter the estimate. The switching lens uses a five-minute
window to identify nearby configuration changes. That window is an analysis
choice, not a cache lifetime or TTL.

The allocation assumes ordinary input first, followed by cache-write tokens.
When writes are included, the difference also depends on the write price
category and lifetime. Treating a write as something that could have been a
cache read is a separate assumption, not something proven by precise pricing.

A labelled covered subtotal includes only comparisons with usable ordering and
prices. Sessions whose request order cannot be proven, and comparisons without
prices, remain excluded and disclosed; the subtotal does not establish a
whole-period loss. Older token-usage increments are not individual request
records and do not establish request-level cache evidence. Compaction, context
contraction and insufficient comparison evidence remain excluded. A subtotal
with no priceable comparisons stays unavailable, not a zero-valued placeholder.

Conditional cache repricing uses the same output-representation selection as the
main usage totals: matching combined output is not charged again alongside
text and reasoning output. Missing or contradictory output evidence remains
unpriced; incomplete ordering still limits the result to a covered subtotal.

The **Cache-read counts between turns** memory matrix compares follow-up turns with
unchanged model and settings using its source's time-gap groups. The percentage
above each column is the share whose cache-read token count exceeded half the
previous request's count; **n** is the number of checked follow-ups. This ratio
does not establish that prefix content was reused between those requests.
Light counts use one shared count scale, with partly filled lights for
remainders. Hover, tap, or use the arrow keys to inspect percentages, counts,
adjacent cache-read decreases and conditional Standard API-equivalent estimates.
The model picker filters complete comparison aggregates and retains your choice
when the reporting period changes. Missing
model breakdowns and periods without eligible follow-ups remain explicit;
zero eligible follow-ups does not establish a percentage in either count group.
Local turn comparisons retain their measured 1–6 hour, 1–3 day and 3-day-plus
groups. The community curve uses separate 1–2 and 2–6 hour groups and ends at
seven days. Each chart shows its source's original groups; local long gaps
are not truncated or split to fit the community curve.

The **Thread name** column in both recent cache-drop tables opens the associated
Codex thread. A worker row shows a parent-name link and a separate bracketed
subworker link. Hover a link for the local event time; keyboard users receive
the same time in its accessible description. If a name is missing, the link
uses a shortened thread ID. If attribution cannot be proven, it stays unlinked.
Names are looked up locally and are not included in reports or diagnostics.

## Shared reporting period

The app header's **Reporting period** control offers **24hr**, **7d**,
**30d**, and **All**. Your selection persists across pages and restarts.
Hover over or open the adjacent information control to see the exact dates.
The start and end dates come from the selected accounting
snapshot and apply to historical charts, usage totals, model performance, and
Projects & threads. If matching accounting evidence is unavailable, the page says
so instead of choosing a different period. All available history describes the
evidence retained locally; coverage and indexing notices still qualify it.

Current allowance readings are unaffected.
The Allowance primary chart shows **Weekly API equivalent** by exact quota-change
interval. Select the plan beside TiboTattle and choose Gaussian smoothing (off
or sigma 15/30/60/120/240 minutes). Smoothing changes the displayed curve only;
missing or incompatible evidence remains a gap. The time slider and chart share
one time scale. **Complete details** keeps raw interval amounts and quota
fractions, all pages, observations, reset records and the existing calibration
and comparison tools. The calibration headline inside that dialog remains the
median of its qualifying plan population. The shared five-minute refresh and
manual refresh publish matching chart/detail versions, preserving usable old
results with an explicit failure status when an update fails.
The primary chart retains a previous curve only when a usable interval report
has already been displayed for the same plan and period. An older calibration
summary does not supply that curve: its previous-version label stays beside the
calibration estimate in **Complete details**. If no usable curve is available
while intervals are recalculated, the main chart says so explicitly.
Updating local usage can advance the displayed reporting dates when a new
accounting snapshot becomes available.

## Model performance

Open **Model performance** from the dashboard sidebar, then choose a model
and use the shared **Reporting period** above the page. The 0.1.24 desktop
release includes this page, including on Windows x64. Local timing analysis is
separate from activation of optional hosted performance telemetry.

The page starts in **Standard** mode. Use the **Standard / Fast / Ultrafast** controls to show
only the selected mode; counts, medians, bands and both charts use that same
population. The choice lasts while the page is mounted, including period/model
changes and refreshes. Fast and Ultrafast can have few or no observations. Hollow points
have fewer than five measured turns, and those bins have no percentile bands.
Unknown or mixed modes are excluded from all three views, with their excluded turn
count shown. Older saved measurements without mode evidence stay unclassified.

After the initial dashboard loads, the app prepares all four shared reporting
periods in Standard, Fast and Ultrafast in the background. Once ready, opening the
page or switching either control displays its cached result immediately while
checking for updates. A first history scan may still show progress until its
measurements are ready. Browser results stay in memory only; restarting the app
starts a fresh page cache. Speculative requests pause while the app document is
hidden.

The desktop app does not send performance data. Local Model performance analysis is unaffected.

**Output speed** includes response-timed measurements plus eligible tool-free
turn estimates from older logs. Each turn contributes once: covered response
windows take precedence; otherwise a completed, single-response turn without
tools may use reconciled output tokens divided by its full duration. These
fallback estimates include initial waiting and can be lower than response-timed
speed. The chart identifies how many measurements use each method; its medians
and bands summarize the combined population. Reasoning tokens are included once.
**First-token latency** uses independently available turn timing, so its sample
count can be larger. Missing evidence remains unavailable, never zero.

The plots show daily or weekly statistics: the solid line is the median (P50),
and the dashed straight-segment line is the arithmetic mean of the same measured
turns, with equal weight per turn. Speed means average per-turn token rates, not
total tokens divided by total duration. Percentile bands appear with at least
five observations. The legend toggles each layer; tooltips and detail tables
include both mean and median. Missing dates break all lines and bands.
Older aggregate caches lack means and are rebuilt from retained timing evidence;
means are never inferred from percentiles. Schema-6 caches use a separate
versioned filename so older app instances cannot overwrite them. Prior receipts
are preserved. The underlying timing store and
measurement method are unchanged.

Sweep horizontally anywhere in a chart to inspect the same date across the charts.
Use arrow keys after focusing a chart point, or Escape to dismiss the tooltip.
Empty dates explicitly show no measurements. Expand **About these measurements**
for interpretation and coverage.

These diagnostics cover Codex files on this device across accounts. Tool waits
are excluded from matched output windows, but the estimate is not a provider
benchmark or a billing measure. All reasoning efforts remain included. Opening
the page collects timing in bounded background passes; saved data can appear
before collection finishes. An explicitly requested history pass finishes even after leaving the page;
once complete, the worker stops after its idle lease expires. Later visits resume
from saved checkpoints. Timing failures do not block usage accounting.

## Settings in the main window

Settings is a main-window sidebar category. Sidebar, menu and tray entry points
open the same page; tray customization opens its labeled example preview in
a secondary dialog. Close the preview with its Close button or Escape.

The categories are General & appearance, Tray & panel, Notifications,
Data & diagnostics, and About & updates. Data & diagnostics accepts a positive
whole number of minutes for periodic overview refresh, or `-1` to disable
periodic local refresh. The default is five minutes after the preceding run
settles. Manual refresh, a permission-checked startup freshness check and state
observation remain available. One companion schedule owns collection; there is
no separate hourly desktop maintenance timer.

Notifications accepts one used-allowance percentage from 1 to 100; `-1` disables
usage reminders. There is no master switch. A fresh provider observation must
cross the threshold; the first observation and a changed threshold establish
a baseline without sending a historical reminder. Receipts prevent duplicate
reminders in the same allowance cycle. Test notification is a separate action,
subject to operating-system permission and application notification capability.
Reset notifications are retired: their underlying policy and historical receipts
remain, but production cannot enable or deliver them. Cycle recognition remains
active to rearm used-allowance reminders for a new cycle.

Legacy disabled/off preferences migrate to `-1`; both the old 90% and 80%+90%
modes migrate to 90%. Settings and notification policy use forward-only versions
v5 and v2 respectively, preserving unknown future state instead of overwriting it.

The pause icon above local Refresh cancels current local collection and blocks
automatic, startup, and manual collection until resumed. Its choice survives
restart without changing the configured interval. Resume schedules the next
normal interval; it does not replay missed ticks. Saved reports remain readable
and X keeps its independent refresh schedule. Cancellation settles through the
existing bounded refresh controller before another writer can run.

## Customize the window background

In the Electron app, open **Settings → General & appearance → Window background**. Choose a
solid preset, use the system color palette, or enter a six-digit HEX color or
RGB integers from 0 to 255. Valid changes preview immediately and save locally;
the status reports whether the save succeeded. A solid preset replaces the
current image background. Custom color entry retains a selected image.

Choose a static PNG, JPEG or WebP image through the filtered file picker.
There is no application-imposed byte or pixel limit; the operating system must
be able to allocate and decode the image. The app preserves original image bytes
in independent protected local resources. Moving the source file later does
not break the saved background. Images stay on this device and never enter
usage reports, diagnostics or telemetry. Unsupported or failed imports retain
the last saved background. The file picker can be cancelled safely.

The image covers the entire main window, including the sidebar, centered and
without stretching; resizing may crop its edges. The light overlay affects
only the image and can be adjusted from 0 to 90%. Custom backgrounds use black
text; choose a background and overlay that keep it readable. **Remove** returns
to the selected background color. The page has no background restore-default
button. Removing an imported image never deletes the original source file.

Main-window dropdowns, dialogs and floating hints repeat the same background
at the matching window position, with a subtle blur on the background only.
Their opaque base hides underlying text, including with transparent images.
The selected image overlay is preserved; menu text stays sharp. Native system
menus and the independent tray window retain their own presentation.

## Customize the tray icon and popup

The 0.1.24 desktop release includes tray customization.
Open **Customize menu bar…** from the popup's More menu or choose
**Settings → Tray & panel**. Both entry points open the same main-window
category; **Open preview** shows the secondary preview dialog.

Choose 5-hour remaining, 7-day remaining, both, or icon only. The `5h` and `7d`
labels keep the windows distinguishable. Single-window meters follow that
window; both and icon-only modes let you choose the meter's window. A plain
app icon and a two-meter option are also available. With two meters, the top
is 5-hour and the bottom is 7-day. Unknown evidence is outlined, not zero.

For one window, you can show remaining allowance, reset time, or both. Reset
format is shared with the popup: countdown or local clock time. Both-window
mode keeps just the two remaining percentages to limit width. Windows uses its tray icon, tooltip and popup surfaces; this does not change the
platform qualification status.

Show, hide and reorder Allowances, Weekly pace, Local usage and Cache-read comparison.
Select a 7-day or 30-day popup history range, comfortable or compact spacing,
and which totals to display: tokens, API-equivalent cost and usage changes.
You can hide the usage chart; keep either a chart or a total when Local usage
is enabled. The header, status and essential actions always remain available.

Cache-read comparison uses the dashboard's comparable-follow-up denominator:
the share whose reported cache-read count exceeds half the previous count.
This compares counts; it does not establish which prefix tokens were reused
or what could have been cached. No comparable follow-ups produces an explicit
empty state. Incomplete coverage and retained historical data remain labeled.
API-equivalent cost is a reference estimate, not a subscription charge.

**Emphasize low allowance** is an optional visual cue, off by default. It starts
at 10% remaining, clears after recovery to 12%, and never sends a notification
or changes the selected metric. Stale or reset evidence clears that cue.

Changes apply immediately and survive relaunch. The preview uses labeled
example data, including missing and stale states. **Undo** reverses the last
customization; **Restore defaults** resets only tray preferences. Existing
users retain their prior primary-window behavior until they choose a preset.
New installations default to 7-day remaining with a 7-day meter.

Refreshing preserves valid values while they remain current. An unavailable
window shows a dash in its own slot and never borrows the other window's value.
Changing presentation does not change collection, notifications, contribution,
or dashboard filters. A save failure leaves the previous selection in use;
settings written by a newer app are preserved rather than overwritten.

## Projects and threads (development build)

The **Usage and costs** page includes project, thread and model views.
Open a repository for its thread list, then open a thread in the same dialog for
model and contributor details. Back restores the project page and scroll position.
Worktrees share a repository group;
folders with no identifiable repository appear under **Non-project tasks**.
Missing source context remains **Unassigned**.

Open **Usage and costs** in the dashboard sidebar, or choose
**View → Projects and Threads** in the Electron desktop app.

Search by project or task name, including subworker names, or paste a complete
thread ID or Codex link. Name search covers the full report before pagination.
A matching subworker brings back its task family; a matching project includes
all its tasks. Search result subtotals, token mix and share denominators cover all matching
work before pagination; the page headline retains the global reporting total.
Results update as you type after two characters and a short pause (300 ms).
Deleting the text or shortening it below two characters restores the project
list automatically. Names and search terms stay local.

Short neutral bars beside shares show their relative size. Narrow layouts retain
the numeric share without the bar. Thread details list token components once,
followed by participant and model tables. Output text excludes reasoning.
Combined output stays separate when no split was recorded. Cache writes appear
only where a positive recorded value exists. Missing components remain unknown.

Choose a period and model to compare token and API-equivalent shares. These are
estimates of recorded usage, not subscription charges or quota shares. Omitted
cache-write counts use the explicitly approved zero assumption when the remaining
input counters support it; **Includes assumed counts** distinguishes them from
observed values. Other missing counts remain labelled partial.

The app's main **Refresh** collects new usage and publishes the shared report;
automatic refresh uses the same five-minute cadence. There is no separate detail
refresh button. Failures expose their category and an appropriate Retry action.
Opening another section preserves the selection.
A period switch with the same accounting end bound displays its prepared figures
while validating the report lease. An expired lease or a new accounting bound
requires a new report for those exact dates.
While Projects & threads is visible, a lightweight keep-alive preserves its
cached report without recalculating usage. Reports may be released after five
minutes away from the page; returning automatically rebuilds an expired report.
A fresh refresh can still require accounting work when the underlying cache
is no longer valid.

The app prepares this page and its standard periods after the initial dashboard
loads, using the same accounting snapshot. A warmed report displays immediately
on the first visit or a period switch; drill-down controls wait for
its report to be validated. Changing filters or refreshing the report discards
incompatible warmed results. Preloading does not collect logs or repeat the
underlying accounting calculation.

Projects & threads is included in the 0.1.24 desktop release. See
[platform support](./reference/platform-support.md) for installed qualification
and its remaining limits.

## Refresh, progress, and recovery

On Windows, a detailed update can wait for existing history reports to finish
reading before it replaces the local history index. If publication times out or
fails, the app retains existing results and shows a specific error. Wait for
report loading to finish and retry manually; if the problem persists, restart
TiboTattle. Source files changing during indexing have a separate retry message.
Quota collection and history indexing report their results independently.

Use **Refresh** to update quota, retained history,
and detailed Usage-and-costs and Trends evidence together. A valid
generation-bound accounting cache is reused; a changed generation is
recalculated. There is no separate detailed-accounting button. The app keeps
verified prior figures visible, with their current freshness state, while work
is in progress. If an accounting rebuild exceeds its resource budget, retained
cost figures stay explicitly stale or deferred with their original calculation
time; a later check with no new records does not make them current. Retained
figures from an older index do not supply the current plan's allowance estimate.
If another refresh is already running, the shared controller
keeps that single operation authoritative. Desktop controls follow its progress;
the browser shows an informational notice without starting a second operation.

Startup and frequent automatic quota checks stay light. While the app remains
open it may make one automatic detailed attempt after an hour. Failed,
cancelled, and interrupted detailed attempts count toward that hour so they do
not become a retry loop. After an already-running quick quota check finishes,
you can choose Refresh again to request detailed work.

Completion of local analysis does not imply that every provider quota read
succeeded. When quota collection fails, the dashboard keeps existing usage and
its observation timestamp and reports the quota failure separately. A successful
check with no new observation says so; it does not renew the timestamp. A later
successful quota read clears the quota warning.

On Windows, CLI selection prefers a valid `CODEX_BIN`, then a working `codex.exe`
on PATH, then a verified CLI from the three most recently modified installation
directories below `%LOCALAPPDATA%\OpenAI\Codex\bin`. Desktop discovery is bounded
to five seconds. If Codex cannot be started, confirm that it is installed or set
`CODEX_BIN` to its executable, restart TiboTattle, and refresh again. History
analysis remains available even when live quota collection is unavailable.

In the Electron app, the shell pauses its one-shot schedule only after the
dashboard's local request has been accepted. The dashboard then sends a
content-free heartbeat while that exact quick or detailed pass is active. A
missing heartbeat recovers quickly; an independent 243-minute limit releases
even a continuously renewed pass after the dashboard's 241-minute polling
window. Replacing the dashboard also releases the reservation. Recovery rearms
one timer from the latest saved interval and never starts a second companion
operation while the first remains authoritative.

The Overview timestamp and the menu-bar popup calculate observation age from
the same recorded timestamp and current clock. An open window therefore changes
to stale, qualifies its allowance values, and removes the current pacing claim
without waiting for another response. If a completed dashboard operation still
has an Electron reservation, the freshness card says automatic refresh is
waiting for safety recovery. **Show diagnostics** runs a content-free doctor
with app state, settings categories, timer/watchdog state, and local crash-capture
status. It never includes the lease value, paths, accounts, credentials, session
content, or a native crash dump. You can review and copy the report or prepare
an editable GitHub support issue. Native crash capture is not offered on Windows.
See [support](../SUPPORT.md) before sharing any local diagnostic file.

Under **Allowance → Complete details → Allowance and usage history**, the retained
history view keeps remaining percentage
separate from API-price-equivalent activity. Expand **Detailed comparison of
observed and estimated usage** to inspect the linked **three-hour observed versus
calculated comparison** and **Cumulative drift**.
Warm and cool fills in the comparison show movement above and below the
estimate; the signed difference has its own strip. Cycle drift uses the existing
cycle anchor calculation, not a sum of overlapping three-hour windows.

Hover or tap a chart, or use the history slider, to inspect a shared time across
all views. **Play history** advances that cursor; **Latest** returns to the end
of the displayed range. The selected-time toolbar shows the cursor time in the
local time zone. Replay stops when the page
is hidden and is omitted when reduced motion is enabled. The slider and exact
sample timestamps remain available. Range and zoom controls move the views
together; detailed comparison assumptions and exact evidence remain expandable.

The toolbar readouts show allowance remaining at the selected time and a
three-hour moving average of recorded API-equivalent usage per hour. The spending
rate uses completed usage buckets, independently of whether allowance observations
can be compared. It updates at fifteen-minute boundaries for the selected plan.
The caption names the actual averaging window, which shortens after a coverage
break. Quiet time within known coverage lowers the average, reaching $0 after
three hours without recorded activity. Missing pricing or coverage displays a
dash; the rate does not extend beyond the recorded usage history. Allowance
readings also become unavailable when stale. These amounts are API equivalents,
not subscription charges.

Reset markers distinguish scheduled resets, banked resets, unknown types,
and account-level credit grants or expiry when that evidence is available.
Select a marker to inspect it; nearby events share a numbered marker with every
event listed. Interval observations show both interval ends; scheduled and
provider timestamps retain their precision. Markers use the companion’s existing
reset classifications: schedule updates and comparison recovery points do not
add extra resets. Credit grants and expiries have a separate count; a mixed group
uses an ellipsis instead of a combined reset count. An unknown type means the
evidence does not establish the reset mechanism.
Plan-incompatible allowance events stay excluded.

A material backwards allowance reading also prevents a clean capacity estimate
across its rebound, even when the reported reset schedule is unchanged. It is
shown as conflicting evidence rather than a confirmed reset. A current exact
100% used reading has a distinct exhausted state; it is not treated as missing
pace evidence and does not invent an exhaustion timestamp.

**When usage and allowance disagree** lists sustained divergence periods as compact
rows ranked by their largest signed percentage-point gap. The gap accumulates from the cycle comparison
anchor, not just within the listed period. **View on charts** focuses all views
on that period. **Models & speeds** shows the recorded activity behind the period;
it helps investigate a mismatch but cannot establish its cause. Failed lookups
have a **Retry breakdown** action, and a failed update preserves and labels the
previous successful result.

The exact-window table names the measured span and explains each comparison.
**Comparable** means measured and estimated values cover the same allowance cycle,
not that the values agree. Missing or stale readings, reset or allowance changes,
unavailable pricing, backwards readings and exhausted allowance each have a
specific explanation. Unknown quality stays unknown. Differences are percentage
points of allowance: falling from 60% to 50% remaining is 10 pp used.

Trends compares the selected plan's compatible usage and quota history. Earlier
history on another plan does not disable a usable current-plan fit, and it is
not borrowed into that fit. Ambiguous intervals and plan transitions remain
gaps. Unresolved speed uses the labelled Standard scenario, without pretending
that Standard speed was observed. During refresh, its last compatible plan-specific
history stays visible with the retained calibration. Expanded model/speed details
for unchanged periods stay open and keep their last successful result while
updated details load; temporary lookup failures do not erase that result.

Do not repeatedly relaunch during a detailed pass; that can make progress appear
to restart even when source data is intact.

During a local refresh, **Calculating accounting…** means
the app is calculating and preparing the updated dashboard. It replaces the
file counter: a small number of changed files does not mean all the unchanged
files are being read again. Only the terminal refresh status establishes
completion. A new allowance observation can appear while usage is still being
calculated; the refresh icon stays busy until the run settles. Automatic and
manual runs share the same status. The allowance observation time does not mean
that all historical accounting has finished.

If the dashboard stays blank or reports a schema/index error:

1. Record the exact message and app version.
2. Quit and reopen once, then allow a complete refresh.
3. Do not delete AppData, the unified index, source histories, or
   Credential Manager items as a troubleshooting shortcut.
4. Follow [SUPPORT.md](../SUPPORT.md) and share only sanitized diagnostics.

Maintainers use the preservation-first
[unified-index recovery runbook](./runbooks/local-index-recovery.md). Recovery
is performed against a copy before replacing durable state.

### Secure upgrade

If Electron cannot read a preserved legacy credential, startup can stop with
**Unable to prepare secure storage** and support code
`SECURE_STORAGE_MIGRATION_REQUIRED`. The credential remains preserved. Choose
**Quit** and follow [SUPPORT.md](../SUPPORT.md) with the support code. Do not
delete or reset Windows Credential Manager items or TiboTattle data.

The current Electron app has no self-service credential migration or approval
control. **Retry** repeats the silent readiness check; it does not migrate the
credential.

## Community sharing removed

The desktop app is local-only. Community sharing, contribution upload, performance sharing, share cards, and hosted sign-in were removed on 2026-10-13 ([decision](./decisions/2026-10-13-desktop-sharing-removal.md)). The app sends no usage data, and local analysis works without an account.

Self-service hosted deletion is retired under the
[2026-08-30 source decision](./decisions/2026-08-30-self-service-deletion-retirement.md).
Private hosted erasure is a separate maintainer operation, not a dashboard
control. See [support and privacy-request boundaries](../SUPPORT.md#hosted-history-and-privacy-requests).
This documents the source change, not a deployed-service or installed-release
update; an older app may still show an old deletion control. A failed request
is not evidence that any history was erased.

## Privacy, local data, and uninstall

The exact maintained inventory of local reads, local stores, Windows Credential Manager use,
network destinations, hosted retention, deletion, and uninstall residue is in
[local-data-and-privacy.md](./reference/local-data-and-privacy.md). The public
privacy notice is at `https://tibotattle.com/privacy.html`.

Uninstalling the app does not imply that accumulated local indexes,
preferences, logs, or Credential Manager entries were erased. That separation prevents an
ordinary application replacement from destroying history. Use documented
local erase and identity-reset controls only for their separate effects. None erases hosted history; private owner erasure is separate.
Follow the support guide for intentional cleanup and never remove broad
AppData or Credential Manager locations blindly.

## Updates and help

In Electron, check for updates in **Settings → About**.
A temporary network failure should leave the installed app usable; it does not
prove an update exists or failed to
publish. Verify the current release independently if an update looks stale.

For bugs, diagnostics, privacy questions, and security reporting, start at
[SUPPORT.md](../SUPPORT.md). Security-sensitive reports follow
[SECURITY.md](../SECURITY.md). Do not attach raw session files, databases,
credentials, account identifiers, or private screenshots to a public issue.
