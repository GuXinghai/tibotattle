---
title: Historical Plus and Pro Lite comparison validation
date: 2026-10-16
type: qa
status: validated-local
---

# Scope and implementation

This record covers independently scoped historical-plan comparisons under the
owner's single-account, continuous-subscription assumption, including upgrades
and downgrades. It does not certify account identity or provider billing rules.
Original records and the all-plan accounting fold are unchanged.

The existing calibration corpus now supplies a bounded lane for every observed
historical plan. Each lane uses that plan's existing capacity population, pricing
basis, reset cohort and source generation. The browser never adds these
projections to the all-plan ledger. An unresolved usage interval removes only its
affected comparison bucket and is listed with dates and a bounded reason.

Reliable usage survives an unavailable capacity estimate. Only an explicitly
null fit cohort is permitted for usage-only display; missing or malformed
provenance remains unavailable. Arithmetic still requires a complete matched fit.

Observed quota is retained separately from comparable quota. The existing
calibration compression retains change points and the first/last reading of
unchanged runs; these arrays are not a census of raw log rows. In real browser
acceptance the older generic sampler could omit the historical tail, replacing a
later reading with an earlier one. The complete lane preserves the last actual
observation even when the corresponding final usage bucket cannot be compared.
The raw last Plus weekly observation was independently checked at
2026-10-11T08:14:19.960Z: 84 percent remaining. Earlier sampled readings of 85 or
87 percent are not the final raw observation.

# Source and artifact

Final candidate build 2026101617 uses source snapshot
`cf66291112f8006e9c159869afd94b6a0bd5ac92`, Node.js 26.2.0, Electron 43.5.0
and electron-builder 26.15.7. Packaging and the source/ASAR/executable/native
closure verifier passed. Prior candidates and the normal profile were retained.
No signing, installer activation, publication or remote write was performed.

The ASAR SHA-256 is
`acbeea9023851d7c0e7dd0190a5c1de7eb2957d5f3ff516ca8a81e6752ae7560`;
the executable SHA-256 is
`7e125d5b107d5c8cf7e3b4ceb4e4edee87d547a011a229d7940981fca3fc3232`.
Only final evidence documentation changed after this candidate snapshot.

# Completed checks

- The full UI gate passed 1,023 tests. The final local gate passed 303, failed zero,
  and retained one existing skip. Four focused cache tests cover both switch
  directions, conservation, malformed scopes, cancellation, resource bounds,
  per-plan failure isolation, local ambiguity and independent observation tails.
- Architecture boundaries passed: 579 production files, 2,314 imports and no
  approved debt edges. Canonical browser translation parity passed.
- A real read snapshot independently reconciled every published usage bucket's
  event count, Standard amount and both quota-weighting scenarios. Plus retained
  19,218 events in 592 buckets; Pro Lite retained 200,533 events in 4,879 buckets
  at that snapshot. No cross-plan bucket duplication or amount mismatch occurred.
- The same snapshot retained 1,449 complete Plus quota observations and 6,331
  Pro Lite observations. Comparison-only observations remained a separate subset.
  The plan-specific capacity estimates were 69.136606 and 416.825352 USD
  respectively; these are historical local estimates, not subscription prices.
- The final live report, pinned to cutoff 2026-10-16T02:50:08.826Z, independently
  matched 236 Plus and 2,233 Pro Lite retained comparison points: observed
  movement, weighted expected movement and residual all agreed, without crossing
  excluded intervals. These counts cover each retained lane, not just the visible
  seven-day chart. Plus had 592 usage buckets and 1,449 complete quota readings;
  Pro Lite had 4,883 and 6,349. Selecting either plan left all-plan accounting
  unchanged. Plus's last valid interval was 13 pp observed against
  10.294469763239327 pp expected; Pro Lite's was 12 pp against
  11.04072791618454 pp. Neither selection borrowed the other plan's capacity.
- Earlier candidate 2026101614 ran for 1,169 seconds with two successful automatic
  report refreshes, no report-time regression or refresh failure, and no startup
  stderr. The open Plus observation dialog remained on page two. Its total page
  count changed with the old generic sampling population; this is not evidence
  of an original-record mutation. Complete observations remove that sampler
  dependency from the historical headline and observation list.

# Existing failures and evidence boundary

The frozen local-index golden predates the speed-pricing output fields and
reports the same 314 differences in the prior source snapshot. The broader
replay-cache file passed 61 tests and retained five existing failures: four
Windows-inapplicable POSIX mode assertions and one retired deep-scan option
assertion. Representative failures were reproduced in the prior source snapshot.
These five failures and the golden failure were not repaired or weakened for
this task.
The frozen golden adapter excludes only the newly added observation/gap fields;
its accounting and original comparison values remain exact.

Initial sandbox runs additionally hit native temporary-directory and Git config
write restrictions. The affected scoped gates were rerun with ordinary Windows
permissions and synthetic data; no security assertion was removed.

# Final runtime acceptance

During continued observation, candidate 2026101616 exposed an existing overview
deadline mismatch: the automatic route forced a 60-second total budget even while
performing real unified-index ingestion. A run that spent more than a minute in
that phase timed out before the accounting-work marker could select its longer
reviewed budget. The failed run and its diagnostic are retained; the prior valid
report, comparison lanes and Plus last reading remained available.

The controller now reuses the existing fresh/incremental source-budget selector
for overview work too. It retains a hard deadline measured from the run start;
ordinary progress cannot reset it. Only the existing exact accounting marker can
extend once to its bounded cold-work limit. The complete refresh test file passed
107 tests, including synthetic checks beyond one minute, actual expiry at the
selected bound, cancellation and one-time extension. This is not a new timer or
an unlimited retry policy.

Final candidate 2026101617 started with the normal real profile at
2026-10-16T02:35:16.196Z. A bounded read-only observer completed at 03:00:11.809Z
after 1,495 seconds. Startup indexing/reporting succeeded; stderr was empty and
the process remained alive. The manual browser refresh started at 02:41:30.420Z
and succeeded at 02:44:33.249Z. Two subsequent automatic refreshes succeeded:
02:49:33.343Z to 02:52:30.575Z, and 02:57:30.653Z to 03:00:09.771Z. The next
automatic run began five minutes after each successful publication, including
the manual refresh. No refresh error, report cutoff regression, disappearing
plan lane or incorrect historical tail was detected during this final run.

In-app browser acceptance used real reports. Both plans were checked in quota
history and comparison views, across 24-hour, seven-day, 30-day and all-history
ranges. Plus's empty 24-hour range remained explicitly empty. Observation,
reset, API-equivalent estimate, history, comparison, cumulative, anomaly and
calculation details remained accessible. Unconfirmed intervals opened a separate
dated list; confirmed comparison data stayed visible. Light and dark rendering,
390-pixel reflow and Escape/focus restoration were checked. On the final candidate,
the Plus observation dialog retained page 2 of 77 and its first row across manual
and automatic publication; browser console error count was zero. The temporary
theme override was restored without changing saved settings.

A final read-only integrity and preservation check passed both baselines. All
29,027 original lifecycle facts, 274,968 usage events and 390,175 quota occurrences
from before this task retained identical physical and semantic hashes. The newer
pre-candidate baseline also passed. SQLite integrity and foreign keys passed;
there was no internal-link rebuild or original-fact mutation. Natural appends
were allowed and no real data was copied into test fixtures.

The owner-local ignored evidence directory `.release-build/overview-validation/`
contains final `historical-plan-verified-*` artifact, launch, browser, runtime
reconciliation and observation receipts, plus `historical-plan-complete-preservation.json`.
The failed candidate's observation receipt remains retained separately.
The plan, maintained design and API reference were updated; documentation and
preflight checks passed. Browser rendering and normal Electron process/startup
evidence do not certify native visual rendering, installed application behavior,
signing or public release; those gates were not claimed here.
