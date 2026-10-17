---
title: Historical allowance observations independent of comparison eligibility
date: 2026-10-16
type: qa
status: browser-verified
---

# Scope and acceptance

Keep original records, accounting and the existing refresh owner unchanged.
Display positively attributed historical quota observations independently of
matched usage/capacity availability. Keep unmatched comparisons explicitly
unavailable and never borrow another plan's accounting lane.

Implementation and validation sequence:

1. Separate observed quota selection and charting from comparison eligibility.
2. Preserve historical estimates, observation/reset details and explicit missing
   usage/comparison states; retain current-plan calculation safeguards.
3. Run focused regression tests, the UI gate and canonical translation checks.
4. Prepare a new local candidate, retain the previous candidate, and check both
   Plus and Pro Lite against real reports in the in-app browser.
5. Verify preserved facts read-only, record actual runtime and browser results,
   and keep native/installed/release evidence separate.

# Implemented behavior

Historical quota selection now retains positively identified observations from
the existing validated report even when matching priced usage is unavailable.
The quota chart reads observation timestamps directly; the usage chart and
comparison keep their stricter plan, basis, cohort and generation checks. No
other plan's usage or capacity fills a historical gap. The all-plan ledger and
raw records are unchanged.

Missing matching usage is stated only in its own section. Comparison details
retain their contents and explain that matching data is unavailable. Missing
historical-tool totals remain null/“—”, rather than becoming zero. Existing
index/schema failure states remain visible when generic empty-state copy is
suppressed. Historical reset labels use their recorded date, not a live timer.

On plan changes, the shared history cursor rebinds to the remaining visible
chart after obsolete charts are removed. This prevents the newer plan's input
limits from clamping an older plan's timestamp to the wrong interval.

This change uses the existing bounded/sampled quota DTO; it does not turn the
plot or paginated observations into a census of raw records. The existing
sampler can choose different retained points when the indexed population grows.
Initial startup snapshots can omit historical observations while detailed
accounting is still running; the completed report restores them automatically.

# Validation

- Targeted quota/plan/cursor tests and the full UI gate passed; the final UI gate
  recorded 1,019 passed, zero failed. Canonical browser translation parity passed.
- A sandbox-only telemetry mirror test failed to rename its temporary file.
  The same complete UI gate passed under ordinary Windows permissions; no test
  assertion, timeout or production boundary was weakened for that environment.
- Real-data browsing exposed an additional stale cursor range and a missing
  historical total rendered as zero; both were fixed before final acceptance.
  One source assertion was updated to cover both unavailable accounting and an
  unavailable selected-plan usage lane, retaining the newer-schema checks.
- The earlier real-data check retained five Plus estimates and 21 Pro Lite
  estimates. It found Plus observations in 7-day, 30-day and all-history ranges,
  and none in the last 24 hours; Pro Lite had observations in all four ranges.
- Final candidate build 2026101613 uses source snapshot
  `11e0413391188049c2957e6fcb0161f81ad45dd8`, Node.js 26.2.0, Electron 43.5.0 and
  electron-builder 26.15.7. The verified ASAR SHA-256 is
  `67fdad54d75ff4cfea5459a3ead949fe4f3ac52c1b3ca60bdc17fc8982761405`;
  executable SHA-256 is
  `1ce7fb6dbdcea0dfd67c050132f8fcd7ee59f3e3c00f72c29cb30a3f4cf2bc60`.
  The primary branch/index were not committed or replaced. Previous candidates
  remain available. No signing, installation or publication was performed.

# Final runtime and browser evidence

The final candidate started with its ordinary protected profile at
2026-10-16 00:35:49 UTC. Health and the saved snapshot were ready without an
immediate error. Startup detailed collection ran from 00:35:56.215 to
00:37:32.153 UTC and succeeded. The report at 00:37:41 contained 311 plotted
weekly Plus observations in seven days, 420 in thirty days and 524 in retained
history; 24 hours had none. Five Plus and 21 Pro Lite seven-day estimates were
retained. Pro Lite retained its independent matched usage/capacity lane.

The in-app browser connected to this exact running companion, using real data:

- Both plans' two main views and all eight secondary entries per plan opened.
  Plus quota/history and estimates stayed visible; all four comparison dialogs
  stated the missing matching-data reason. Historical tools showed “—” for
  unavailable usage and cost, and no fabricated zero-dollar amount.
- Plus curves appeared in 7-day, 30-day and all-history views. Its empty 24-hour
  range explicitly had no observations and a disabled cursor. Pro Lite quota
  and usage charts appeared in all four ranges; its comparison returned numeric
  actual/expected values after switching back from Plus.
- Both plans' five-hour and seven-day estimate views opened. Light dialog colors
  were RGB 255/255/255 with 17/17/17 text; dark colors were 32/32/32 with
  242/242/242 text. At a 390-pixel viewport, the document and its scroll width
  were both 390, and the dialog and its scroll width were both 351. Escape
  restored the observation trigger focus.
- Temporary browser theme and viewport overrides were removed. The actual
  application appearance preference was never changed. No spontaneous browser
  script errors were recorded. A long browser automation batch timed out; the
  checks were split into smaller batches and completed against the same app.
- A real browser refresh request joined the ongoing scheduled overview operation
  at 00:42:32.170 UTC. It completed successfully at 00:45:46.985, with the next
  deadline exactly 300,000 ms later. Health, snapshot and quota collection had
  no errors, and report cutoffs did not regress. The Plus observation dialog
  remained open at page 2 of 32 with ten rows; Escape restored focus and its
  history curve remained visible.

The final independent current-plan reconciliation checked 2,242 comparable
intervals, their actual observation endpoints, expected movement and residuals,
with no discrepancies. Selecting either plan left all-plan accounting intact.
Read-only preservation verification retained all 29,027 lifecycle facts,
274,968 usage events and 390,175 quota occurrences from this task's baseline
without changes. Database integrity and foreign-key checks passed.

The normal-profile app remains running. This follow-up qualifies the shared
browser page, real-data selection, startup and refresh publication. It does not
claim new native window/menu/tray, installed, signed-release or public-deployment
qualification, or a new fifteen-minute/two-cycle soak receipt for this build.
The earlier compact-page soak belongs to its own artifact and remains separate.
