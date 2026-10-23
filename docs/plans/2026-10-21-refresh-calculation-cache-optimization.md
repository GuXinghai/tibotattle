---
title: Refresh calculation and cache optimization
date: 2026-10-21
type: plan
status: implemented
---

# Scope and decision boundary

Proposed after the [isolated investigation](../reviews/2026-10-21-refresh-calculation-cache-investigation.md).
Source implementation is complete; validation and remaining runtime gates are
recorded in the [implementation review](../reviews/2026-10-21-refresh-calculation-cache-implementation.md).
Preserve all unrelated changes, accounting
semantics, historical evidence, generation fences, cancellation and atomic
last-good publication. Do not change refresh intervals to conceal cost.

Optimize existing boundaries rather than introduce a global cache framework,
another ledger or an unrestricted full-history object cache. Stage the work so
each change has an independent correctness and performance result. The current
checkout now uses store v8 (v7 at investigation time); the running candidate is v6, so source and
artifact validation remain separate gates.

## 1. Share calibration traversal first

Refactor the existing composition fitter into bounded prepare/consume/finalize
stages. Prepare the current and historical plan consumers, feed one ordered
corpus traversal to all of them, then finalize with the same algorithms. Keep
one canonical implementation of plan attribution, pricing, timestamp conversion
and timeline-event projection. A shared derived event may be computed once only
when its inputs are plan-independent; plan-specific classifications stay scoped.
Use the existing calibration-layer boundary where suitable. If its currently
duplicated orchestration is connected, keep one owner rather than leave two
independently evolving calibration pipelines.

The isolated A/B already proves that sharing the stream with the unchanged fit
consumers preserves one population's complete results while reducing that
component from 24.24 to 9.45 seconds. The production refactor still needs failure
and resource proofs; it must not retain a full extra event array or start four
unbounded concurrent jobs.

Preserve each plan's optional-fit failure result. One failed historical fit must
not silently invalidate every other plan, swallow cancellation or turn a failed
fit into zero. Keep the combined retained-memory budget and per-plan row limits.
Verify the corpus generation at completion as today. Weekly origins/intervals
have a later dependency and must not be forced into this pass without a separate
proof. Transition slices retain their existing ownership and bounds.

Acceptance: complete old/new outputs match on synthetic current/historical-plan,
unknown/conflicted attribution, reversed/equal-time, NULL, speed and quota-boundary
cases. Test cancellation and one consumer failure. Compare a protected derived
copy with the same source version and fixed inputs; measure row projections,
passes, phase time and peak RSS, not only elapsed UI refresh time.

## 2. Price aggregate groups through the existing accounting semantics

Expose the existing rollup-plus-boundary-event traversal through its reviewed
owned facade. Feed weighted groups into a shared canonical accounting
accumulator for periods, history and timelines. Do not substitute the current
report's final JSON for replay accounting and do not create a third projection
policy. Preserve separate cached/uncached/output components and exact decimal
money; no aggregate Fast multiplier or inferred known speed.

For evidence classes the current rollup cannot distinguish, conservatively
fall back to source events initially. Extend the rollup key only if measurements
justify it, with a forward schema/basis migration and recovery on a copy.
Required distinctions include partial evidence, cache-write availability and
output conflict. Keep explicit time ranges: windowed totals, unbounded history,
future admission, effective price dates and declared-speed boundaries differ.

Acceptance: old event traversal and new weighted traversal must agree on exact
money strings, coverage, event counts, dimensions and timeline shape. Exercise
NULL/assumed-zero/partial/conflict mixtures within one bucket, context thresholds,
cache proportions, unknown/Spark models, Priority/Ultrafast cards, baseline and
window boundaries and future events. Preserve existing rounding contracts;
do not increase tolerance to make the comparison pass.

## 3. Stop invalidating calculation for metadata-only changes

Keep the global publication sequence as the atomic consistency fence. Introduce
a reviewed calculation-input revision/proof at the existing index/cache
boundary, rather than remove the current generation comparison or stamp an old
whole cache with a new generation ID.

During extraction, stage candidate semantic facts using existing transactional
boundaries. If every relevant fact is unchanged, advance source cursor,
diagnostics/freshness metadata as appropriate without deleting and reinserting
unchanged usage facts. A mere equal token count is insufficient. Changed facts
remain additive/replay-safe corrections and invalidate their dependent results.
All material input changes and the calculation revision must commit atomically;
an older reader must fail closed on newer schema.

Define a small dependency matrix before writing the schema:

- Exact usage/history: all component values and availability, recognition/model,
  tier/declared-speed evidence, pricing registry/semantics, dimensions,
  membership, quarantine and dedup/ownership state.
- Calibration: usage inputs plus admitted quota occurrences, plans and inferred
  era boundaries, resets, origin metadata and physical ordering.
- Cache-impact/work projections: compaction/source/session order, lineage,
  tool/work facts and their coverage; do not infer absent continuity.
- Time-dependent outputs: explicit window membership, future-event admission,
  next validity boundary and current evaluation time. An unchanged database
  does not guarantee unchanged time-window results.

Reuse only validated calculation components under that proof. Compose a new
publication envelope with fresh metadata and the current generation, verify
all component dependencies, then publish atomically. No relabelling an old
artifact, fabricated freshness, persistent ledger-derived cache beyond its
permitted lifetime, or automatic conversion of unavailable data to zero.
Keep the current age/semantics/fallback gates unless a replacement contract
explicitly proves equivalent validity. Reuse existing bounded memo/single-flight
facilities instead of maintaining a parallel cache owner.

Acceptance: metadata-only and duplicate appends avoid calculation rebuild;
genuine usage, quota, model-recovery, speed, ownership and compaction changes do
invalidate the necessary components. Test unchanged inputs with advancing time,
registry/ledger changes, mid-build commits, interrupted writes, restart and
failed rebuild retaining the previous labelled result. Rehearse migrations only
against copies and compare old/new exact outputs.

## Deferred: modern source append checkpoints

Do not remove `response_reconciliation` rescans as a shortcut. A later stage may
persist bounded response/turn/checkpoint state and overlap evidence so modern
appends can reconcile without rereading the prefix. It must prove retroactive
legacy suppression, late model repair, duplicate/conflicting response IDs,
partial tails, shared sessions, forks and cancellation/recovery. Fall back to
the current full rescan whenever the proof is absent. This stage is unnecessary
for delivering and measuring stages 1 and 2.

## Validation and delivery

Run only owning targeted test files, dependency checks if boundaries change,
and documentation/preflight checks. No full suite is needed for iteration.
Keep synthetic fixtures content-free; inspect real derived facts only through
protected read-only originals or consistent copies. Retain aggregate timings,
cache hit/miss reasons and physical-work counts without private paths or IDs.

After each stage, compare the same frozen inputs and source version, then
measure an authorized real refresh separately. Record which work was skipped
and why. Do not promise a total-refresh speedup from a component microbenchmark.
Packaging, opening the app, installed tests and release gates are later work
requiring their own scope; they are not part of this investigation.
