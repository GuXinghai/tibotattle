---
title: Refresh stage timing and bottleneck investigation
date: 2026-10-23
type: review
status: source-and-readonly-validated
---

# Scope and acceptance boundary

Add content-free, bounded, monotonic wall-time diagnostics before optimizing
refresh behavior. Preserve the current dirty checkout, workload preview,
accounting policies, provenance gates, cancellation and publication fences.
No packaging, restart, installation, commit or original-data writes form part
of this work. Synthetic fixtures never contain private session data.

## Plan

1. Measure collector, index refresh, reuse proofs, rebuild, publication and
   snapshot reload separately. Break accounting into scan, corpus preparation,
   composition fitting, interval construction and calibration derivation.
2. Expose only closed stage names, durations and outcome counts in refresh
   status. Treat parent spans as inclusive; overlapping children are not added
   together as though they were sequential.
3. Verify deterministic clock accounting, errors, cancellation, observer
   isolation, run isolation and unchanged complete accounting output with
   synthetic tests. Exercise the actual loopback status boundary.
4. Run the accounting builder read-only against an authorized stable snapshot
   if a consistent measurement is available without mutating original state.
   Return timings and aggregate counters only. Separate these results from
   the historical packaged 377.116-second refresh.

## Implementation

The optional observer is shared by the refresh controller, runner, origin-proof
reader, accounting builder/publication and snapshot builder. Its closed stage
allowlist is defined in `src/local-refresh-timing.js`. Measurements use an
injectable monotonic clock, not provider timestamps or the wall clock used to
select accounting windows. The last accepted run's `timing` receipt is available
from `GET /api/local/refresh`; only completed spans appear and `totalMs` remains
`null` until settlement. Subsequent reads do not alter a running join receipt.

Durations are wall time, not CPU attribution. Parent spans are inclusive and
snapshot reads can overlap. Each stage records calls and failed/cancelled
outcomes; absent/unreached stages stay absent. Durations, fixed names and
outcome counts are the entire contract. Invalid events, diagnostic callback
failures, invalid clocks and callbacks arriving after settlement cannot change
accounting or publication. The receipt is process-local and does not add fields
to the saved accounting cache or modify provenance, age or generation gates.

## Read-only real-data measurement

At approximately 01:06–01:09 JST on 2026-10-23, a standalone Node.js v22.21.1
process called the existing accounting **build** entrypoint, not its refresh or
publish entrypoint. The original index was opened read-only. It used the same
365-day display scan, 13 declared speed windows, source-native behavior and
current index identity. The index remained at generation 21029 throughout.
The calibration corpus contained 278,700 retained usage events and 24,702 weekly
observations. No cache result, raw session data, source paths or identities was
saved or emitted. The timing observer returned only aggregate counters.

| Accounting stage | Wall seconds | Share of accounting build |
| --- | ---: | ---: |
| Plan composition fitting | 39.139 | 37.8% |
| Accounting/index scan including fused history | 18.445 | 17.8% |
| Calibration transition derivation | 17.299 | 16.7% |
| Weekly API interval construction | 13.429 | 13.0% |
| Calibration corpus preparation | 7.935 | 7.7% |
| Final projections and cache assembly | 3.692 | 3.6% |
| Weekly interval origin evidence | 3.518 | 3.4% |
| Corpus completion/generation verification | 0.010 | less than 0.1% |
| **Accounting build parent** | **103.477** | **100%** |

The separate before-build reuse proof took **4.882 seconds**, including
**4.785 seconds** reading origin evidence and **0.091 seconds** reading the
index proof. It was unavailable; timing did not change the refusal policy.
The accounting build and proof together took 108.396 seconds. This measurement
includes normal concurrent activity in the still-running app and is not a
controlled performance benchmark or a claimed packaged refresh duration.

## Snapshot measurement on an isolated copy

After the normal app settled, SQLite's online backup API created transactionally
consistent copies of the index and collector databases under a new owner-only
Windows directory. Both originals were opened read-only; the copied accounting
receipt was checked against the copied index's ID and fingerprint. The same
declared speed evidence and the live aggregate previous-workload DTO were used.
The source snapshot builder and data-store publication then ran against the
copies only. This did not restart, change or inject code into the running app.

| Snapshot stage | Wall seconds |
| --- | ---: |
| **Complete reload and copy-only publication** | **13.718** |
| State preparation | 0.058 |
| Accounting cache reads, two calls | 4.296 |
| Unified index projection | 3.275 |
| Off-main collector projection | 0.935 |

The initial cache read and index projection overlap. The parent additionally
includes assembly, clone/publication checks and persistence to the copied
snapshot store. These child durations are not an additive breakdown of the
13.718-second parent. Protected diagnostic copies were used only for this
measurement, not as test fixtures, and were removed afterward.

## Interpretation and remaining gate

Accounting construction dominates these separately measured components. The
largest individual measured operation is composition fitting; transition
derivation and interval construction are also substantial. Origin-proof reads
are measurable but do not explain several minutes by themselves. This is a
priority order for a subsequent optimization audit, not authorization to skip
provenance checks or change the algorithm in this task.

These two probes do **not** reconstruct the old package's 377.116-second run:
they are distinct executions, under a different runtime and process baseline,
with concurrent app activity. The historical run still proves only its 61.720
seconds of index work and its total. The new source instruments the complete
collector/index/proof/build/publication/reload boundary so a subsequent package
run can resolve the remainder. No new packaged/native run is claimed here.

## Targeted validation

- Four timing unit tests cover inclusive monotonic spans, invalid/negative
  clocks, error/abort identity, callback failures, private/unknown input
  rejection, snapshot isolation, late events and independent successive runs.
- A synthetic complete-cache comparison is exactly equal with timing disabled
  and enabled, including an observer that throws on every event.
- The five focused root files pass **186/186**: timing, refresh orchestration,
  accounting-cache source, reuse proof and companion snapshot contracts.
- Two actual synthetic loopback tests pass **2/2**, covering the new closed
  timing receipt and deferred-startup/manual full/overview publication.
  Instrumentation exposed a startup scheduling race in the latter fixture's
  manual-202 expectation (and a cleanup failure while automatic work was still
  active). Its test-only onboarding precondition now disables automatic work;
  all manual publication assertions remain. Product scheduling is unchanged.
- Architecture validation passes: 608 production files, 2,416 imports and
  zero approved debt edges. Documentation governance passes for 329 Markdown
  files and 998 source/configuration files. Preflight passes, including its
  20 documentation/guidance tests, whitespace checks and root-layout checks.
