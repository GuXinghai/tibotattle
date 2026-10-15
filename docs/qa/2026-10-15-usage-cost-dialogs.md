---
title: Usage and cost detail dialogs verification
date: 2026-10-15
type: qa
status: verified-local-candidate-with-known-gate-failures
---

This record covers the local Windows candidate for source
`ede1ff221ee1506d5fda823f27adcc98c1a40256`. It does not qualify a signed
release, installed updater, public deployment, or hosted service.

## Implemented behavior

- Two headline totals and project/thread/model rankings replace the dense primary
  tables. Filters and analytical sections are disclosed on demand.
- Project and thread reports retain model components, contribution totals,
  worktrees, links and pagination in a modal. Refresh preserves the selected
  object, navigation, page and scroll position.
- Event-speed API valuation is shared by totals, components, models and project
  reports. Unknown speed and missing published prices remain unpriced. Existing
  Standard-price and quota-analysis metrics keep their separate semantics.
- Derived cache revision v0.19 and saved-work-report revision v2 reject the
  previous pricing results. Original fact tables and source records are retained.
- Query, lease, preload and cancellation failures are classified; real failures
  retain safe diagnostic codes. Accounting failure degrades the global receipt.
- Automatic overview refresh now rebuilds or validates accounting after index
  ingestion. Previously it skipped accounting, so a successful tick could leave
  the Usage page on an older complete report.
- Overview publication also replaces the deferred startup projection. Rebuilding
  accounting alone did not advance the published reporting cutoff.
- Pending ancestor page restoration survives repeated publications while a
  thread is open; fresh cursors are rebuilt instead of reusing expired cursors.

## Source validation

- Focused usage/UI/price tests: 109 passed.
- Final detail-view suite, including two successive publications, HTTP 409
  recovery and retained-result fallback before Back:
  82 passed.
- Refresh controller tests after the cadence and failure changes: 105 passed.
- Architecture check: 578 production files, 2,310 imports, no approved debt edges.
- Final Node.js 26.2.0 Windows local surface gate: 300 passed, one failed, one skipped. The
  failure remains the existing missing `allowance-tanks.js` static route.
- Final normal-permission Windows full UI gate: 986 passed,
  15 failed. Its remaining failure titles were present in the earlier report-time
  validation; this is not a passing full-surface gate.
- The sandbox-only rerun additionally refused a temporary mirror's atomic rename
  with EPERM; the normal-permission run above did not reproduce that failure.
- The default-host local run also failed its bounded startup wait and journal
  cleanup. The same startup/publication checks passed under build Node.js
  26.2.0, as did those checks in the full Node.js 26.2.0 local suite.
- Replay cache/index/price lane: 64 passed, five failed. Four failures assert
  POSIX 0600 mode on Windows; the remaining scan-guard fixture expects a counter
  not populated by that fixture. The local-index work report and new price cases
  passed. No assertions were weakened to hide those failures.
- Preflight under normal permissions: 20 passed. Documentation governance passed.

## Runtime investigation

The first candidate was normally launched with the real default profile. Its
seven-day report reconciled at one exact cutoff: headline, component, model and
project amounts all totalled USD 411.76655734, and tokens all totalled 3045936801.

Observation then reproduced the unchanged reporting cutoff after an automatic
tick. The runner's `overview` mode advanced ingestion but excluded accounting;
the cadence change and regression tests above address that specific cause.

A directory-only candidate exposed a missing `resources/app-update.yml` at
startup. The normal NSIS packaging target supplies this generated configuration;
the complete candidate must be used for the final normal launch. No installer
is executed and no signing or publication is performed.

The final complete package was prepared with Node.js 26.2.0, Electron 43.5.0
and electron-builder 26.15.7. Its ASAR digest is
`e29f84a38f9c41c82151d6e686bb14eff14ab8d9698f7ae1eebfb98d24598a2b`.
Its executable digest is
`70d4397cd0a8040d91599e9bd69bc4744d6497bfff6448de77d479e6f6837779`.

The preceding accounting/publication candidate ran normally with the real
default profile for ten minutes (60 read-only samples). Manual refresh finished
at 12:20:35.961 UTC and scheduled the next tick exactly five minutes later.
That automatic tick finished at 12:26:18.872 UTC and advanced the seven-day
cutoff from 12:20:05.073 to 12:25:47.820 UTC. Health and snapshot remained ready;
refresh and scheduler error codes were null. An open thread stayed selected
and scrolled near the bottom. A later Back check exposed the repeated-publication
ancestor-page bug; that observation prompted the final two-line fix and its
regression test rather than being counted as successful navigation proof.

The intermediate candidate started normally at 12:39:12 UTC with the existing default
profile. Its initial saved report was explicitly dated; an expired saved query
was visibly classified, then replaced when the startup calculation completed.
Neither missing prices nor stale evidence was converted to zero.

At that candidate's 12:42:43.054 UTC cutoff, headline and project totals
both equal USD 424.64476064; model totals equal the same amount and component
totals differ only by binary floating-point display precision (less than
1e-8 USD). All token totals equal 3093108699. The work report retains its
underlying partial-evidence qualifier. A manual overview refresh advanced the
open thread's cutoff and kept its selection, Back path and nonzero scroll.

Preservation verification after the preceding candidate's automatic ticks
confirmed all 688,033 baseline facts unchanged: 27,943 lifecycle facts, 272,441
usage events and 387,649 quota occurrences. SQLite integrity and foreign keys
passed. This verifies original indexed facts, not a separate hash audit of all
raw rollout files; no raw source file was edited by this change.

Native window capture was attempted, but its app-access approval timed out.
Shared-page rendering and interactions are checked against the normally running
packaged companion; they do not constitute captured native-window pixel proof.

That candidate's automatic refresh ran from 12:48:12.368 to 12:49:54.439 UTC.
It advanced the cutoff to 12:48:47.834 UTC and amount to USD 425.38553134,
with null refresh/scheduler errors. Back still returned to page one: recovery
from an expired snapshot independently reset pending page restoration. The
follow-up retains that depth during expiry recovery and anchors ancestors to
the new publication. A further synthetic regression reproduced the same loss
when a saved result was returned before the new result; pending depth is now
retained through that intermediate response as well. The regression failed
before that fix and passed afterward.

## Final package verification

The source and hashes named above identify the follow-up package normally
launched at 12:56:31 UTC, without an isolated profile. Its startup refresh
finished at 12:57:26.414 UTC. Two manual overview requests then completed at
12:59:48.505 and 13:00:36.447 UTC. Both requests used the existing refresh-button
endpoint. The thread stayed open across both publications; Back returned to
project rows 7–12 of 39. Closing restored focus to the original ranking button.

At cutoff 13:00:08.992 UTC, headline, component and project totals equal
USD 427.20071244; model summation differs only below 1e-8 USD. All token totals
equal 3105039832. Partial work-evidence qualifiers remain visible.

The final package was observed for seven minutes (42 read-only samples): health and snapshot
were ready, observation/refresh/scheduler errors and workload issues were absent,
and reporting cutoffs never regressed. The process responded, stderr was empty,
and Windows application events recorded zero crashes since this launch.
Automatic cadence and publication were observed on the preceding candidates
above; the final follow-up's additional publications were manually requested.

The real shared page and modal were inspected at 1440 and 360 pixels. At 360,
the dialog width was about 307 pixels and the page had no horizontal overflow.
The viewport override was reset after inspection. Original-fact preservation
was rerun after the final candidate's refreshes with the same unchanged counts,
valid integrity and foreign keys, and no errors. The final app remains running.
