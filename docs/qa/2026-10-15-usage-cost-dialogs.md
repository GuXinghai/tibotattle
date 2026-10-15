---
title: Usage and cost detail dialogs verification
date: 2026-10-15
type: qa
status: in-progress-local-runtime
---

This record covers the local Windows candidate for source
`7f53737bcfb86a96fcccb066ba8c9c1d5692189a`. It does not qualify a signed
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

## Source validation

- Focused usage/UI/price tests: 109 passed.
- Refresh controller tests after the cadence and failure changes: 105 passed.
- Architecture check: 578 production files, 2,310 imports, no approved debt edges.
- Normal Windows local surface gate: 297 passed, one failed, one skipped. The
  failure remains the existing missing `allowance-tanks.js` static route.
- Normal Windows full UI gate before the final cadence-only change: 986 passed,
  15 failed. Its remaining failure titles were present in the earlier report-time
  validation; this is not a passing full-surface gate.
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

The final complete package's ASAR digest is
`8baf9eb9e169c6ee7cb6af9d57d3264b47f346e59c037245c1a784a1843785ce`.
Its executable digest is
`01feb111745484fb85d13a5b3dddad921097a8ea8659ffc1c23be23634ca6c47`.

Native window capture was attempted, but its app-access approval timed out.
Shared-page rendering and interactions are checked against the normally running
packaged companion; they do not constitute captured native-window pixel proof.

Final complete-package launch, sustained observation, and original-fact
preservation results will be recorded here after those checks finish.
