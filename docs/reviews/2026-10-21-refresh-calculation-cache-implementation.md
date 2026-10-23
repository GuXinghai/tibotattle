---
title: Refresh calculation and cache implementation
date: 2026-10-21
type: review
status: implemented
---

# Scope and evidence boundary

Implements the [approved optimization plan](../plans/2026-10-21-refresh-calculation-cache-optimization.md)
after the [investigation](./2026-10-21-refresh-calculation-cache-investigation.md).
This is a source implementation and isolated-validation record for the working
tree based on `94cc26f3`, Windows x64, Node.js 22.21.1. Existing X changes were
preserved. No commit, full suite, packaging, installation, app restart or UI
automation was performed. The running candidate remains unchanged.

## Implemented behavior

### Shared calibration

The composition fitter now exposes bounded consume/finalize stages. Current
and historical plans share one ordered corpus traversal, preserving independent
classification, accumulation order, results and failure receipts. A failed
consumer does not remove successful lanes; a failed shared read refuses all
unfinished fits. Abort and global memory checks still escape. Existing plan
limits, per-plan retained row caps, receipt byte caps and final generation check
remain. No full event array or unbounded task fan-out was added.

Both the replay builder and existing calibration-layer boundary call the same
shared helper. Weekly intervals and transition slices retain their separate
dependency/ownership phases; fusion does not fabricate an all-in-one pass.

### Weighted exact accounting

The index report and accounting scanner share the existing rollup-plus-boundary
traversal. The builder explicitly opts into weighted callbacks; legacy scanner
callbacks remain per-event. Whole safe groups are priced once, with event
counts weighted separately from already summed quantities and money.

Partial evidence, assumed cache writes, output conflicts, oversized groups and
time/baseline boundary buckets conservatively fall back to source events.
There is no new rollup schema, price ledger or approximate-parity tolerance.
Recent, history and future admission bounds stay distinct.

Monetary margins now derive from exact decimal accumulation using the existing
six-place half-up rule. Previously floating-point order could change the final
digit when equivalent rows were grouped. Cache semantics advance from v0.22
to **v0.23** so older results are rebuilt rather than silently mixed. No token,
price-card or partial-evidence assumption is changed.

### Semantic invalidation and guarded reuse

The index advances from v7 to **v8** by adding `calculation_revision` and
transactional semantic-change triggers. The global `commit_seq` and publication
fingerprint remain the reader fence. Earlier readers fail closed. Migration
failure rolls back schema/version changes and can be retried; no version is
relabelled and no application state is reset.

Eligible quota-free and lineage-snapshot-free rescans stage candidate facts in
SQLite TEMP tables. Full-column equivalence retains existing durable facts;
ignored or duplicate appends can advance source metadata/publication without
advancing calculation inputs. Nullable dimension lookups avoid unused duplicate
rows. Any uncertain quota/lineage case follows the established full replay.
A genuine change may therefore require candidate extraction followed by replay;
the modern append checkpoint optimization remains deferred.

The refresh runner keeps one size-bounded process-local proof and cache clone.
It independently checks semantic revision, database identity, applicable speed
windows and known origin evidence. No identity/origin proof is persisted.
Expired or mismatched clones are released before rebuilding. A match preserves
the original evaluation time and age, composes fresh publication metadata,
validates the complete result, rechecks identity/cancellation and uses the
existing atomic cache writer. Same-generation hits avoid rewriting SQLite.

Restart or missing origin evidence forces rebuilding outside the existing
explicitly deferred memory-backoff path. This optimization therefore does not
promise that every metadata-only refresh will hit. It does not invent fresh
window membership, extend cache age or remove current schema/price/coverage gates.

## Isolated data-copy characterization

The earlier owner-protected, consistent v6 backup was backed up again to a
separate experimental file. Only that new copy followed the reviewed writer
migration to v8; `quick_check` returned `ok`. Originals and the running app were
not written. The fixed clock, empty synthetic Codex directory, absent declared
speed windows and CPU-profiling harness match the earlier investigation inputs.

| Work | Earlier candidate reference | Modified source copy |
|---|---:|---:|
| Cache build | 128.20 s | 47.61 s |
| Accounting scan | 42.10 s | 11.63 s |
| Full calibration traversals | 5 | 2 |
| Retained usage rows per traversal | 267,057 | 267,057 |
| Transition slice calls / row visits | 6 / 259,308 | 6 / 259,308 |
| Sampled process peak RSS | 1,239 MiB | 1,257 MiB |

These sequential measurements used different source/schema versions and warm
host caches; they are not a strict end-to-end A/B or installed-app latency
guarantee. Peak memory did not improve in this sample. The optimized build
validated available history and weekly intervals and retained exactly the same
period/history exact decimal money, tokens, event counts, component totals,
pricing coverage and price-card breakdowns as the reference.

Across the full cache, 432 numeric margin cells differed by at most approximately
one millionth of a dollar, reflecting the intentional exact half-up stabilization;
exact period/history ledger values did not change. Source-schema and generation
fingerprints also differ as expected. No tolerance was used in the canonical
event-versus-group parity tests. The timing artifact predates the final
format-only v0.23 stamp and remains an experimental artifact, not a product cache.

## Targeted validation

- Parent integration: 30 tests passed across shared traversal, weighted scanner,
  exact weighted accounting, guarded reuse and v8 migration.
- Existing selected accounting regressions: 11 passed, covering Spark,
  historical cards, exact half boundaries, component aliases, cache version
  rejection and historical plan behavior. No full accounting suite was run.
- Delegated index validation: 41 owning refresh/source/workload/migration tests
  and 35 migration/preservation/consistency tests passed (some overlap).
- Delegated runner/reuse validation: 110 owning tests passed. Negative cases
  include origins/baseline changes, age, identity, cancellation and material
  changes. Parent strengthened clone-release and continued guard coverage.
- Final focused revalidation after hardening: 11 shared-traversal, scanner and
  reuse tests passed.
- `pnpm run architecture:check` passed (606 production files, 2,410 imports,
  zero boundary debt). `pnpm run docs:check` and `pnpm run test:preflight`
  passed, including 20 documentation/guidance tests. Whitespace checks passed.
  These checks do not replace product runtime proof.

The shared-traversal cases cover exact old/new lane parity, consumer and shared
read failures, cancellation, plan-count bounds and a memory guard that fails
after traversal begins. Weighted scanner cases cover callback cancellation,
failure recovery, NULL/partial/conflict/assumed-zero mixtures, context/date/time
boundaries and declared speeds. v8 cases cover interrupted migration rollback,
newer-version rejection, semantic changes, candidate rollback and no durable
usage rewrites on equal candidates.

## Remaining gates

Actual app refresh and Electron/package/installed behavior are unverified for
this working tree. No UI freeze or spinner fix is claimed. The new semantic
triggers' ingestion overhead and large genuine-change candidate/replay overhead
remain unmeasured on live sources. The performance copy did not qualify live
origin-proof hit rate, OS crash timing or cross-process concurrency. These
limits do not weaken the conservative fallback or existing publication fence.
