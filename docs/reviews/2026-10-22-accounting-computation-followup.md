---
title: Independent accounting reuse and computation follow-up
date: 2026-10-22
type: review
status: source-validated
---

# Scope and acceptance boundary

Follow up the [capture-only invalidation correction](./2026-10-22-accounting-reuse-invalidation.md)
with the owner-requested GPT-6 Astra high independent review. Existing source
changes remain in place. Preserve unrelated concurrent work, workload-card
preview, real data and the running artifact; no commit, packaging, restart or
installation is authorized. All new experiments use content-free synthetic
state, fixed clocks and bounded work.

## Bounded plan

1. Independently verify reuse safety, rejection conditions and the receipt
   trigger correction. Prove query costs with synthetic query plans.
2. Check whether the accounting scan unnecessarily constructs an entire
   presentation report to obtain generation metadata. Establish exact metadata
   and full-cache equivalence before changing that path.
3. Implement only measured, small optimizations at existing owners. Preserve
   provisional/future membership, rollup-basis checks, pricing semantics,
   cancellation, resource limits and snapshot/generation fences.
4. Run focused synthetic regressions and owning mechanical checks. Separate
   component measurements from unperformed native runtime acceptance.

## Confirmed changes

The requested GPT-6 Astra high sub-agent performed independent read-only review
and synthetic experiments, then reviewed the final three production changes.
No additional blocking defect was found in those changes.

1. **Revoke a rejected proof.** Both live generation/file/revision rejection
   branches previously returned `null` while leaving `matches(proof)` true.
   The runner could consequently authorize its ordinary durable-cache fallback
   using that rejected proof. Both branches now discard the process clone;
   ordinary identity-read failures take the same path. `AbortError` propagates.
   Same-generation and metadata-recomposition regressions failed before this
   correction and now require `matches=false`, also after a read exception.
2. **Avoid the metadata prepass's duplicate report calculation.** The accounting
   scan previously built a full report, including pricing, period/timeline,
   quota and cache-impact projections, only to use its generation metadata.
   The report owner now exposes `readLocalIndexReportMetadata`. It sums
   committed whole-bucket event counts and reads the cutoff bucket exactly.
   The original observed-time-bound queries are shared by the two projections.
   Accounting uses this metadata in its existing read snapshot. The complete
   report and actual accounting calculations retain their existing policies.
3. **Use timestamp boundary seeks.** The proof's combined `MIN/MAX` query
   scanned the whole timestamp index. Two scalar subqueries in the same
   statement use separate indexed boundary searches, preserving one snapshot,
   exact bounds and empty-table `NULL` semantics.

No cache schema, index schema, tariff, origin policy, calculation age,
generation condition or resource limit is relaxed. True new usage still
invalidates the calculation. The independent review reproduced additional
conservative invalidation by lifecycle facts; that requires a broader
dependency review and is deferred together with quota replay and incremental
calibration. Workload-card and related preview code are untouched.

## Measurements and validation boundary

All measurements use synthetic state on Windows x64, Node.js v22.21.1.
They are not measurements of the running application.

For 12,000 generated events over 28 days in 12 files, the same indexed store
held 10,574 normalized usage events. Four alternating report/metadata reads at
the fixed clock `2026-09-01T01:00:00.000Z` measured:

| Component | Full report | Metadata projection |
|---|---:|---:|
| Four reads | 296.81, 250.30, 236.67, 233.66 ms | 2.65, 2.55, 2.82, 2.63 ms |

A process-local reference module substituted the original full-report reader
for the metadata reader, using the same index, clock and generation. Two
opposite-order pairs compared the **entire accounting cache** with
`assert.deepEqual`; both matched exactly. Reference builds took 1,969.89 and
1,948.45 ms; optimized builds took 2,177.68 and 1,904.27 ms. These whole-build
results vary and do not establish an overall speedup; the proven saving is the
removed presentation prepass, not a guaranteed refresh duration.

The independent timestamp-query experiment used 250,000 in-memory synthetic
rows and the production index shape, `usage_event_observed(observed_at_ms)`
on the `WITHOUT ROWID` table. Fifty warm reads measured 422.25 ms combined
versus 0.0566 ms split. Query plans changed from a covering-index `SCAN` to
two boundary `SEARCH` operations, with identical results. This microbenchmark
does not imply a comparable whole-refresh acceleration.

The focused accounting-cache and reuse files pass **9/9**. They cover metadata
and full-generation parity with zero/unknown quantities, exact future-cutoff
membership, provisional cursors, incomplete tool provenance, empty history,
invalid clocks and stale rollup basis; they retain existing complete-cache,
weighted/event, generation, cancellation, origin, speed and age regressions.
The independent pre-change review also reran the prior three-file receipt,
reuse and v8-preservation suite: 19/19 passed, with overlapping reuse coverage.

`pnpm run architecture:check`, `pnpm run docs:check` and
`pnpm run test:preflight` passed, including the 20 documentation/guidance tests.
Final scoped review preserved the pre-existing diff and left the staging area
empty. No real data was read or modified in this follow-up, and the running
artifact remains unchanged.
