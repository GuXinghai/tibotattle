---
title: Startup comparison reuse of observed plan periods
date: 2026-10-23
type: review
status: source-verified
---

Scope: the owner's request to reuse overview plan observations for the startup
actual-versus-expected comparison. Preserve unrelated uncommitted changes and
real stored evidence. Packaging, restarting, installation and publication are
outside this change.

Acceptance: missing plan labels after an explicit preceding anchor must use the
same marked plan-period projection as overview history. No future backfill,
account inference, explicit plan/family bridging, conflict smoothing or newly
inferred reset authority is allowed. Keep the startup capacity and raw baseline
label unchanged. Both bars must use the same accepted intervals.

The old strict branch used raw labels; a missing label could produce an opaque
cycle, set the comparison's blocked flag and leave subsequent pairs excluded
until a confirmed reset. The shared chronological attribution helper removes
this label-only discontinuity. Other uncertain cycle boundaries retain their
existing refusal policy. The new comparison boolean discloses whether an
accepted pair used inferred attribution; it is not account or billing proof.

Validation on the existing dirty checkout at
`94cc26f3a63fc12b726fd47da8a83b44ba27e425`:

- The missing-label synthetic reproduction failed before the change and passes
  after it: actual seven percentage points and expected six, using the same
  covered intervals and a synthetic capacity of USD 100.
- All 99 directed cases pass across `test/overview-workload.test.js`,
  `test/local-index-workload.test.js`,
  `apps/web/test/overview-workload.test.mjs` and
  `test/quota-analysis-package-boundary.test.js`. Coverage includes direct
  observations, raw baseline persistence, no look-ahead, reversed order,
  duplicate replay, conflicts, account changes and reset authority.
- A separate red/green failure-path case confirms that retaining an old subtotal
  after quota-history read failure also retains its inferred-plan qualification
  and the explicit error.
- Architecture validation passed with zero approved debt edges. Preflight's
  documentation, layout and whitespace checks and 20 cases passed.

Read-only real-index projection used the existing overview's analysis cutoff
`2026-10-23T00:40:13.793Z`. The running v9 result had zero actual points with
partial comparison coverage and a last accepted pair at
`2026-10-22T18:35:12.486Z`. Source v10 produced seven actual points, complete
comparison interval coverage, inferred plan attribution, and a last accepted
pair at `2026-10-23T00:40:12.040Z`. The committed source generations were 21313
and 21319 respectively; this live check is corroboration, not an identical-input
controlled experiment. The synthetic case supplies that control. Other work,
quota and pricing errors remain visible. The diagnostic did not supply the
normal refresh's declared-speed baseline input, so its expected price-equivalent
number is not an independently validated amount.

The complete production HTML/module graph was inspected in a read-only Chrome
preview with these aggregates: the actual cylinder shows seven points and the
inferred-plan note is visible. This proves source browser rendering only. The
preview was closed; the running normal-profile application was not replaced or
restarted. No raw source content was saved as a fixture or diagnostic. No real
index, collector or startup-state writes were performed. Full-suite and packaged
native acceptance were not run for this scoped change.
