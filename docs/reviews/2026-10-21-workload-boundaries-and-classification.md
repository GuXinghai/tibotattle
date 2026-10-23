---
title: Task boundary and workload classification repair evidence
date: 2026-10-21
type: review
status: source-verified
---

## Boundary and source identity

Point-in-time source verification on Windows x64, Node.js 22.21.1, based on
`94cc26f3a63fc12b726fd47da8a83b44ba27e425` with pre-existing dirty changes.
Preserves the earlier quota-segment, refresh, accounting and X work. This receipt
records the source gate before subsequent candidate packaging, whose artifact
closure needs separate verification. The product branch and owner index remain
unchanged. No installation or publication is authorized. The user separately
requested starting the existing candidate; that running artifact does not
contain these new source changes.

Current behavior is defined by the implementation and the maintained
[user guide](../user-guide.md) and
[index schema reference](../reference/local-index-schema.md), not this receipt.

## Confirmed defects and repair

An unfinished historical task used later same-session receipts as continuous
work, including time belonging to independent tasks. Policy `task-workload-v8`
no longer counts that interval. A later task start bounds observation ownership,
not an inferred ending. Matching completion/interruption and valid duration
recovery remain the authoritative historical boundaries. Copied ancestor starts
are removed before identifying a new context. Fresh starts observed during the
current run retain provisional ongoing time until a terminal or newer context.

An orphan's uncertain coverage excludes independently proven parallel work,
because parallel wall time is a union. Explicitly conflicting boundaries remain
fail-closed even when another task overlaps. Unknown work and unread usage
history cannot train the classifier, receive colors, or provide current pace.
Consumption evidence and original stored facts remain present.

The old fit required at least three samples per group, then nearest-center
reassignment could produce a single-sample final group. The fit now keeps equal
intensities atomic and returns internal cuts used for both historical and
current classification. Three groups must each retain at least three samples
and one minute of work; otherwise classification is unavailable. The public
center-returning facade remains compatible, its input type documents optional
`complete`, and the v5 output shape is unchanged.
Equal-time records from unrelated sessions cannot establish replay, and a
foreign completion needs explicit ancestry to close a task. The unclassified
legend now uses a neutral label instead of incorrectly claiming ongoing work.

## Extreme-value investigation before treatment

Read-only replay used the same frozen input for the before/after implementations
at `2026-10-21T10:53:16.747Z`, index generation 16418. No raw records, task/session
handles, credentials or source paths were saved in the diagnostic output.

- Counted seven-day work changed from 167.620888 to 81.981607 hours. The latter
  is proven/provisional union coverage under this policy, not proof of the
  user's exact total working time.
- Complete priced training buckets after correction: 833. The three centers
  changed from approximately 0.923/11.371/27.595 to 4.190/14.532/31.377 in the
  existing weighted API-equivalent dollars per work-hour basis.
- The largest retained rate stayed approximately 64.009. Its denominator was
  300 seconds, with 151 receipts across six sessions; all 151 were covered by
  task work in their own established task/lineage groups. The next two highest
  rates also retained full 300-second denominators and own-task coverage.
- The single eligible sub-minute bucket had 5.118 seconds and a rate of about
  8.295, not an extreme high rate.
- Observed, daily, outside-window and unallocated consumption remain conserved
  separately by plan; numerical residuals are below 1e-8 percentage points.

These results establish receipt concentration across parallel work, without
evidence that the highest values are short-denominator artifacts. They do not
prove provider-authoritative quota cost or every upstream receipt's timing.
No new extreme-value rejection, winsorization, cap or guessed correction was
added. Missing terminal evidence remains unresolved; no inactivity timeout or
later unrelated interruption manufactures an ending.

## Focused verification

79 tests passed across:

- `test/overview-workload.test.js` (51): boundary recovery, orphan ownership,
  cancellation, lineage copies, parallel coverage, input order, unknown history,
  equal-value refusal, fitted assignment and quota conservation.
- `test/local-index-workload.test.js` (13): persisted synthetic receipts and
  lifecycle facts remain unchanged; read-only projection does not invent ends.
- `test/quota-analysis-package-boundary.test.js` (3): public facade and runtime
  neutrality.
- `apps/web/test/overview-workload.test.mjs` (12): existing output rendering,
  missing values, diagnostics and preserved v5 compatibility.

Architecture, documentation and preflight checks passed; preflight includes
20 documentation/guidance tests. No full suite was run.
Six i18n foundation tests and both generated-catalog checks also passed after
the neutral unclassified label change.

An isolated hidden Electron 43.5.0 window rendered the actual read-only projected
data through the current renderer and styles: all five cards were present,
with no horizontal overflow. Its screenshot was inspected. This qualifies only
that source-rendering harness, not a new packaged app or installed artifact.
