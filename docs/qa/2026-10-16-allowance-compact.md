---
title: Compact allowance page and observation-aligned comparisons
date: 2026-10-16
type: qa
status: browser-verified
---

# Scope and acceptance boundary

The approved desktop change keeps two primary views: allowance history and
consumption comparison. Observation records, reset evidence, complete estimate
history and pagination, interval inspection, cumulative differences, divergence
periods, history playback, and calculation assumptions remain in dialogs. The
obsolete desktop exhaustion forecast has no visible entry. Raw source records,
pricing rules, account attribution, and database schema are preserved.

The existing local scheduler owns the five-minute cadence. The page observes
publications and does not start a collection timer. Manual refresh joins the
existing operation and resets the deadline on settlement. Dialog nodes remain
live; publication does not replace or close their interaction containers.

# Calculation and refresh corrections

- Both directions of quota bracketing require distinct observations. Observed
  and expected movement use the same actual observation endpoints and existing
  whole-bucket inclusion semantics. An unmatched observation is not zero usage.
- Cumulative expected cost ends at the quota observation, excluding later work
  until another quota observation covers it. Cycle anchors are established
  before applying the display cutoff; the display window is not a new cycle.
- Failed dashboard rereads retain the previous result, return a failure outcome,
  expose a bounded diagnostic, and cannot publish a successful display update.
  Native completion signals received while busy coalesce into a pending reread.
- Paginated details retain an existing anchor record across new publications.
  Explicit scope changes close incompatible details and reset their selection.
- The estimate headline still uses the full eligible population. Graph range
  and observation-span controls do not change its statistical denominator.

# Evidence

Source checks, browser rendering, real-data reconciliation and preservation
verification have completed against a normal-profile unsigned Windows candidate.
Native window/menu/tray inspection remains outside this browser-led acceptance.
No installation, signing, publishing, or provider-authoritative billing claim
is part of this acceptance.

- UI gate: 1,016 tests passed on Windows; synthetic tests include single-observation
  refusal, fixed observation endpoints, last-good reread failure, queued native
  completion, pagination retention, and translated actions.
- Dependency boundaries and canonical browser translations passed.
- First candidate preparation correctly refused an omitted surface-manifest
  member. The canonical allowlist and retained closure test were updated; no
  packaging gate was bypassed.
- The browser development reader uses the existing real report through a
  GET-only loopback proxy. Its intentionally refused refresh POST is development
  environment evidence only, not a packaged application failure.

## Browser-led acceptance continuation

The owner requested avoiding desktop manipulation and using the in-app browser.
Browser evidence is therefore the rendered-page acceptance surface; native
window/menu/tray and appearance-settings interaction is not requalified here.
The app itself still runs its ordinary protected profile, loopback companion,
collector and scheduler. Candidate switching used an identity-checked, idle,
task-owned process tree rather than desktop controls; it is not a clean-quit
qualification.

- The first fully observed candidate (build 2026101605) ran for 1,246 seconds,
  with two automatic cycles and one browser-triggered manual refresh. Health,
  snapshot, quota collection and scheduler reported no errors; report cutoffs
  did not regress. Its observation-aligned calculation was independently
  reconciled for 2,235 comparable real-data intervals with no discrepancies.
- Original facts retained unchanged: 28,715 lifecycle facts, 274,289 usage
  events and 389,496 quota occurrences. Integrity and foreign-key checks passed.
- Browser failure injection proved last-good retention but exposed an empty
  error-detail bug: a string validator was passed an Error object. The fix
  preserves the original overview request error and classifies request, timeout,
  parse, validation, expired-report and local-calculation failures without
  projecting raw messages. Normal cancellation is not an error.
- Updated UI gate: 1,016 passed. Local service gate: 301 passed, one explicitly
  skipped. Its previous failure was a one-second polling assumption; a diagnostic
  copy retained that assertion and observed successful completion at 1,289 ms.
  The maintained test now joins the existing completion signal and asserts the
  successful terminal HTTP state; no production timeout was relaxed.
- Public release-site gate: 37 passed, 26 failed. The existing web-release lane
  calls `/usr/bin/git` on Windows. This unrelated portability issue is retained
  as a failed gate, not a desktop UI regression or a passing release claim.
- Final candidate build 2026101607 started normally at 2026-10-15 19:39:22 UTC.
  Its source snapshot is `96c8c38c77dc570e40fbe30f26b7ad90bc25819a`;
  the primary checkout branch and index were not committed or replaced.
  Artifact verification used Node.js 26.2.0 and the reviewed candidate verifier.
  The ASAR SHA-256 is
  `2d4f4167c9439414b2f584009bfa3871f616e246455d2802eea635624802b58a`;
  executable SHA-256 is
  `30a5744865c8e56a8d71cf91eda02950761ad6f5f72a258b4d7a9a94266cdd9d`.
- Startup detailed collection completed successfully at 19:40:34 UTC. A
  subsequent 2,673-second monitored segment recorded eight completed automatic
  cycles, healthy process/snapshot state, no quota or workload errors and no
  report-cutoff regressions. That segment's combined acceptance receipt timed
  out because no manual-refresh evidence had yet been recorded; it is retained
  as an incomplete receipt rather than relabeled as passed.
- The candidate stayed running. At 22:15 UTC the in-app browser's real refresh
  button joined the existing overview operation, which succeeded at
  22:16:01.353 UTC. The next deadline was 22:21:01.354 UTC: five minutes after
  settlement, within one millisecond. This supplementary evidence completes the
  manual action missing from the earlier monitored segment.
- The final candidate's real page opened all eight secondary dialogs. Closing
  observations restored trigger focus; inspecting an observation and returning
  retained page 2 of 74. Light and dark dialogs had readable foregrounds and
  backgrounds; at a 390-pixel emulated viewport the document width and scroll
  width were both 375 pixels, with no dialog overflow. Temporary theme and
  viewport changes are browser-only diagnostic overrides.
- A browser-only intercepted overview GET returned a synthetic 503 with
  `local_index_failed`. The page kept the real 65% value and displayed
  “更新失败 · 已保留上次结果” with “本地索引或计算失败” and a retry action.
  Clearing interception and retrying restored the real report and hid the
  failure notice. No source record, backend response or database was modified
  for this injection.
- Latest real reconciliation covered 6,193 quota observations, 4,869 usage
  buckets and 2,237 comparable intervals, with no observed/expected/residual
  discrepancies. All original facts in the preservation baseline remained
  unchanged; database integrity and foreign keys passed again.
- The supplementary observation ran from 22:14:45 to 22:25:00 UTC. Its next
  automatic operation started at 22:21:01.355 and finished successfully at
  22:24:18.296. Accounting took about 197 seconds; the old result remained usable,
  report cutoffs advanced on completion, and the open observation dialog retained
  page 2 while its total increased from 74 to 75 pages. Escape closed it and
  restored the trigger focus. No service, collection, scheduler or workload
  failure was recorded. The process stayed running between the two monitored
  segments; continuous health coverage during the intervening gap is not claimed.
- Browser interception was cleared, viewport emulation was removed and the
  original theme attribute was restored. The actual application preference was
  never changed. The normal-profile candidate remains running; the supplementary
  monitoring helper was stopped after evidence collection.
- Documentation validation passed across 270 Markdown and 968 source/config
  files. Final preflight passed all 20 tests under normal Windows permissions.
  The sandbox-only attempt failed to initialize a temporary Git repository due
  to filesystem permissions; the identical normal-permission run passed.
