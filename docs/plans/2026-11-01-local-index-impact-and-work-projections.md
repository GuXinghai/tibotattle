---
title: Local index impact manifest and work projections
date: 2026-11-01
type: plan
status: in-progress
---

# Scope and claim boundary

This plan covers the first read-side slice of the local-index refresh redesign:

- persist an impact manifest in the same transaction as a source advance;
- add a day-level `work_rollup` keyed by `tier_id` for work usage;
- add a five-minute `workload_bucket` for overview workload;
- backfill both projections from committed facts, never from rollouts;
- switch readers only after a projection watermark and an audit prove the
  projection complete.

It does not change the parser, source replacement, accounting partition proofs,
quota tracks, lineage components or the current generation/publication fence.
Those are later stages and require separate plans.

Claim boundary: source-level design and implementation planning only. No real
profile is read, migrated, repaired or activated by this plan. Tests use
synthetic stores and sources. The owner's live index is not a test fixture.

The checkout inspected for this plan is `63f078d7` on
`fix/windows-codex-refresh`. Re-verify the checkout before implementation.

Implementation status (2026-11-01): the v10 impact-manifest schema, the
v9 -> v10 conversion helper, the writer's buffered manifest publication and the
serial per-source impact capture are implemented and tested; the historical
v8 -> v9 copy tool now refuses under v11. Cold lane builds, discovery
rejections, presence changes and direct runtime model corrections record
complete per-source changes; only an over-256-source or unattributable
correction falls back to `manifest_complete = 0`. Canonical quota changes
expand to every referencing source, and maintenance bounds the manifest at
50,000 changes with an advancing proven-since floor.

Schema 11 replaces `work_rollup` with the tiered v2 key, adds
`workload_bucket`, installs the full insert/delete/cursor/update trigger matrix,
and adds a bounded, resumable fact-only backfill with per-projection
watermarks. Audit and maintenance understand `pending`, `building`, `ready` and
`stale`; pending projections do not compete with the backfill and readiness is
published once. Work-usage reads exact whole UTC days from `work_rollup` and
falls back to raw events for partial days, cleared `last_at_ms`, a stale basis
or a pending projection. Workload reads non-boundary five-minute buckets and
expands quota/reset, declared-speed, task-boundary, local-midnight, window-edge
and cleared-last buckets to raw events. Differential tests compare both readers
against the raw path, including a cleared last instant.

Current checkout is v11-only. A writable open of a v9 or v10 store performs the
one-time DDL migration chain to v11; read-only older opens still fail closed.
Take a protected copy before the first live writable open, and do not expect an
older build to reopen the upgraded file. The migration contract is recorded in
the [v11 migration decision](../decisions/2026-11-01-local-index-v11-migration.md).

Implementation slices 3 through 8 are complete in the working tree. The
content-free phase receipt (slice 2) and the protected-copy live migration
remain open gates; both need owner-runtime evidence and are not claimed here.

# Verified code facts

These facts decide the plan:

- `store_state.commit_seq` is the atomic publication fence. `generation`
  fingerprints are derived descriptors, not a separate staged generation.
- `usage_rollup` and `work_rollup` are trigger-maintained sums of committed
  facts. `auditRollups`, `auditWorkRollups` and `auditPairing` compare the
  stored derived rows with a fresh grouping.
- `work_rollup` is day-level and omits `tier_id`, so it cannot price a
  mixed-speed day. `readLocalIndexWorkUsage` still groups raw events for that
  reason.
- `readLocalIndexWorkload` reads raw usage events for the seven-day history
  window plus the comparison window and prices each event.
- `work_lifecycle_fact` is small relative to usage events; interval union is
  not the first bottleneck to remove.
- The accounting reuse proof is global: its key includes the global
  `calculation_revision`, all-session origin evidence and admission counts.
  This plan does not change that proof.
- Ordinary runtime currently refuses older store versions. A v10 store needs a
  separate, protected conversion path; it must not auto-migrate at startup
  without an explicit product decision.
- `commit_log` keeps only the newest 100 aggregate summaries. It cannot serve
  as an impact history.

# Decisions

1. Keep `commit_seq` as the publication fence. Add `change_id` and
   `projection_watermark` for invalidation; do not overload `generation`.
2. Persist `source_change`, `impact_partition`, `integrity_gap`,
   `projection_watermark` and `repair_queue` in the same write transaction that
   advances a source.
3. Replace the derived `work_rollup` with a day-level table that adds
   `tier_id` to the key. The old table is reconstructible from `usage_event`;
   no source fact is deleted. The replacement uses raw-event fallback until the
   new table is backfilled and audited; no dual table or double trigger.
4. Add a separate five-minute `workload_bucket`; do not make `work_rollup` a
   five-minute wide table and do not make one table serve both consumers.
   Include `account_scope_id` in the key now; measure the row increase during
   synthetic backfill and record it in the implementation receipt.
5. Backfill both projections from committed `usage_event` facts in bounded,
   resumable batches. Readers use a projection only once it is marked ready
   and audited; boundary and unknown ranges stay on committed facts.
6. Do not store authoritative `priced_usd`. Store token quantities and price
   dimensions; price at read time. A price-revisioned USD column is allowed
   later only as a cache with explicit invalidation.
7. Keep `work_lifecycle_fact` as the interval source for now. Add a
   `work_interval` projection only if profiling shows interval union is
   material after the usage projection lands.
8. Do not change parser, `source_offset`, `source_checkpoint`, accounting cache
   format or lineage semantics in this slice.

# Preserved invariants

L0 is exact append, L1 is a source range, L2 is a lineage/session component,
L3 is a bounded time or plan window and L4 is a global semantic rebuild.

- Strict validation still decides whether facts are trustworthy; the impact
  manifest decides what must be recomputed. They are separate algorithms.
- L0-L3 work may not auto-escalate to a global semantic rebuild. Budget
  exhaustion, queue size or a changed publication id is not an escalation
  reason.
- A change without a bounded impact upper bound produces an `integrity_gap` or a
  component/window fallback; it never becomes a silent zero.
- `usage_event` absence is not proof of inactivity when a gap intersects the
  range.
- Original rollout, quota occurrence and committed facts remain preserved.
  Derived projections may be rebuilt; source evidence is not rewritten.
- Last-good projections remain readable during migration, backfill, repair and
  accounting rebuild.
- A projection is current only when its watermark, basis fingerprint and audit
  agree; a partial or pending projection is explicitly labelled.

# Schema v10

All new tables are `STRICT`; closed vocabularies append only. New indexes are
created with the tables. The migration is forward-only.

## `publication`

One durable row per published commit, including commits with no source change:

```text
commit_seq          INTEGER PRIMARY KEY
committed_at_ms     INTEGER NOT NULL
kind                TEXT NOT NULL
manifest_complete   INTEGER NOT NULL
source_change_count INTEGER NOT NULL
```

`source_change.commit_seq` references it. This is the completeness record that
`commit_log` cannot provide after its 100-row trim.

## `source_change`

One row per published source advance. `commit_seq` is bound by the writer's
commit path; the row is inserted inside the same transaction. See review
correction 14 for the publication-id binding rule.

```text
change_id            INTEGER PRIMARY KEY
commit_seq           INTEGER NOT NULL
source_id            INTEGER NOT NULL REFERENCES source
mode                 TEXT NOT NULL
reason               TEXT
old_file_id          TEXT
new_file_id          TEXT
old_scanned_bytes    INTEGER
new_scanned_bytes    INTEGER
old_size_bytes       INTEGER
new_size_bytes       INTEGER
old_min_at_ms        INTEGER
old_max_at_ms        INTEGER
new_min_at_ms        INTEGER
new_max_at_ms        INTEGER
old_event_count      INTEGER NOT NULL
new_event_count      INTEGER NOT NULL
confidence           TEXT NOT NULL
created_at_ms        INTEGER NOT NULL
```

Closed `mode` values for this slice:

```text
new
append
range_rescan
source_replace
quarantine_gap
presence_changed
semantic_noop
fact_correction
```

Every published commit also has a `publication` row; see review correction 1.
`source_change` is one of possibly several changes in that publication.
Per-fact-kind counts and time bounds live in `change_fact_count`; see review
correction 2a.

`confidence` is `exact`, `bounded` or `unknown`. A metadata-only stat update
that does not publish a source advance does not create a row; `commit_log`
already records the verify/no-op boundary.

## `impact_partition`

Impact rows describe the upper bound of what a change can affect. They may be
coarser than final projection keys; a later stage can refine them.

```text
change_id            INTEGER NOT NULL REFERENCES source_change ON DELETE CASCADE
partition_kind       TEXT NOT NULL
partition_key        TEXT NOT NULL
lower_ms             INTEGER
upper_ms             INTEGER
session_id           INTEGER REFERENCES session
lineage_component_id INTEGER
basis_kind           TEXT NOT NULL
basis_key            TEXT
status               TEXT NOT NULL
PRIMARY KEY(change_id, partition_kind, partition_key, basis_kind)
```

Initial `partition_kind` values:

```text
usage_time_range
work_time_range
session
lineage_component
quota_time_range
accounting_window
coverage
```

Initial `basis_kind` values:

```text
fact_delta
quota_canonical
quota_observation
lineage_snapshot
coverage
```

A time range is a safe upper bound. Bucket-level rows are added only after the
projection readers can prove they use the same key.

## `integrity_gap`

```text
gap_id          INTEGER PRIMARY KEY
source_id       INTEGER NOT NULL REFERENCES source
byte_start      INTEGER NOT NULL
byte_end        INTEGER
event_lower_ms  INTEGER
event_upper_ms  INTEGER
reason          TEXT NOT NULL
confidence      TEXT NOT NULL
created_at_ms   INTEGER NOT NULL
repair_status   TEXT NOT NULL
```

`byte_end` NULL means the gap extends to the then-current EOF. `repair_status`
is `open`, `queued`, `repaired` or `superseded`. A gap is an explicit unknown
input; it is never converted to zero usage or zero activity.

## `projection_watermark`

```text
projection_name    TEXT NOT NULL
partition_key      TEXT NOT NULL
last_change_seq    INTEGER
last_change_id     INTEGER
basis_fingerprint  TEXT
computed_at_ms     INTEGER
status             TEXT NOT NULL
PRIMARY KEY(projection_name, partition_key)
```

`status` is `pending`, `building`, `ready`, `stale` or `deferred`. Backfill uses
one watermark per projection and time range. Incremental trigger maintenance
does not need a per-bucket watermark in this slice; the accounting stage adds
partition-level proofs.

## `repair_queue`

```text
queue_id       INTEGER PRIMARY KEY
scope_kind     TEXT NOT NULL
scope_key      TEXT NOT NULL
lower_ms       INTEGER
upper_ms       INTEGER
priority       INTEGER NOT NULL
reason         TEXT NOT NULL
attempt        INTEGER NOT NULL
next_retry_at_ms INTEGER
status         TEXT NOT NULL
created_at_ms  INTEGER NOT NULL
updated_at_ms  INTEGER NOT NULL
```

`scope_kind` initially includes `projection_backfill`, `usage_time_range`,
`work_time_range`, `session` and `coverage`. The scheduler processes a bounded
number of rows per refresh; an exhausted budget defers work, it does not
upgrade to a global refresh.

## Implemented in v11: work projections

The v10 -> v11 migration adds `work_rollup` v2 and `workload_bucket` and marks
both pending. A bounded, resumable backfill rebuilds them from committed facts;
no reader trusts either table until its watermark is `ready`. A v10 store does
not have these projections.

## `work_rollup` v2

Replace the existing derived table in the v11 migration. The old table is
reconstructible; no source evidence is touched.

```text
day_ms, session_id, work_directory_id, model_id, tier_id,
account_scope_id, shape, ctx_class, prov
```

Measures remain `events`, the six token sums and `last_at_ms`. The triggers,
`rebuildWorkRollups`, `auditWorkRollups` and `pruneEmptyWorkRollups` move with
the new key.

## `workload_bucket`

Five-minute UTC buckets, one row per key:

```text
bucket_start_ms, session_id, model_id, tier_id, account_scope_id,
shape, ctx_class
```

Measures: `events`, the six token sums and `last_at_ms`. No price is stored.
`last_at_ms` is needed to preserve open-task activity when the reader consumes
bucket rows; a delete that removes the latest event clears it, and the reader
recomputes it or expands the affected bucket. `account_scope_id` is included in
the key and the measured row increase is recorded in the implementation
receipt.

The bucket expression uses the existing negative-time handling. `shape` and
`ctx_class` reuse `rollupKeyExpressions`; no second price-classification policy
is introduced.

# Migration and backfill

## Schema conversion

Provide `upgradeLocalIndexV9ToV10(database)` as a connection-only helper:

1. verify application id, family and `user_version = 9`;
2. `BEGIN IMMEDIATE`;
3. create impact tables and indexes;
4. set `meta.impact_manifest_since_change_id`;
5. set `user_version = 10`;
6. `COMMIT`.

No backfill runs inside this transaction. DDL is transactional; a failure
leaves the v9 file untouched. The first writable open uses
`upgradeLocalIndexV9ToV11(database)` to apply both the manifest and work
projection steps in one transaction, so a v9 input never becomes a visible
intermediate v10. Read-only v9/v10 opens remain fail-closed. A protected copy
before that first live writable open is still required. After conversion only
v11 is supported; there is no dual-version runtime.

`upgradeLocalIndexV10ToV11(database)` replaces `work_rollup` with the
v2 key, creates `workload_bucket` and its triggers, and inserts pending
projection watermarks. Its backfill is a derived-projection rebuild, not a
source-fact L4: it must not discover or rescan rollouts, change
`source_offset`, create gaps for unchanged sources or invalidate original
evidence. Only the derived tables and their watermarks move.

The existing source classification (`new`/`skip`/`append`/`rescan`/
`quarantined`) and its reasons stay unchanged in this slice. Manifest `mode`
values are a derived vocabulary over those decisions, not a replacement
classification.

## Backfill protocol

- Work only from committed `usage_event` rows at or below each source cursor.
- Process disjoint time ranges under `BEGIN IMMEDIATE`.
- For each range: delete the range's rows from the target projection, regroup
  all committed facts in that range, insert the result, update the watermark and
  commit. This is exact even if a source append committed before the batch.
- A new append after a batch is handled by the projection triggers.
- A source rescan inside an already-built range is handled by the triggers;
  the range is not reprocessed unless the impact manifest marks it dirty.
- Bound batches by bucket count, bytes read and WAL pressure. On exhaustion,
  leave the watermark and queue row pending and return a deferral.
- Cancellation rolls back the current batch; completed batches remain valid and
  resumable.
- Readers keep the old raw-event path at whole-day/bucket granularity until
  `projection_watermark.status` is `ready` and
  `auditWorkRollups`/`auditWorkloadBuckets` return zero.

Initial backfill may take several refreshes at owner scale. That is acceptable:
quota publication, usage rollups and the last-good workload estimate remain
available while it runs.

# Impact capture

The writer gains one bounded operation, for example:

```text
writer.recordSourceChange({
  sourceId, mode, reason, oldState, newState,
  oldSummary, newSummary, gaps, partitions
})
```

It inserts `source_change`, `change_fact_count`, `impact_partition`,
`integrity_gap` and any `repair_queue` rows in the current transaction. The
publication binding follows the commit-sequence scheme in review correction 14;
`publication.manifest_complete` is final before `COMMIT`.

Refresh calls it for a published source advance, a discovery rejection, a
quarantine transition and a presence change. A direct fact correction outside
refresh uses the same operation with `mode = fact_correction` or marks the
publication `manifest_complete = 0`.

The first version records:

- source mode and reason;
- old/new file identity, size and cursor;
- per-fact-kind counts and observed-time bounds
  (`usage`, `quota`, `tool`, `work`, `lineage_snapshot`, `diagnostic`);
- affected session;
- a time-range impact for usage/work when facts changed;
- a quota time range and canonical-observation keys when quota changed;
- an accounting-window impact when usage facts changed;
- an integrity gap when the changed byte/time range is not exact.

Old-fact summaries are read before `deleteSourceFacts`; new-fact summaries are
read after the replacement facts are inserted and before the cursor commit. The
queries use the `(source_id, source_offset)` clustering and stay bounded to one
source. A source with no facts records zero counts and no time range. A
discovery rejection or presence change records a coverage partition, not a
usage time range, unless facts were also removed.

A full replacement or range rescan is recorded as a bounded full-source impact
even when event count and observed-time bounds are unchanged, because token,
model, tier, flag or diagnostic content can still differ. When quota facts
change, every canonical observation referenced by the old or new summary is
expanded, including an in-place re-rank that keeps the same canonical id.

Phase 1 does not create one row per 15-minute or five-minute bucket. Time ranges
are the safe upper bound; bucket-level impact rows are a later refinement.

# Reader cutover

## Work usage (implemented)

`readLocalIndexWorkUsage` uses `work_rollup` v2 when its watermark is `ready`
and the registry context basis matches:

- a whole UTC day is read only when it lies inside one cut interval and every
  row has an exact `last_at_ms`;
- partial days, cleared last instants and a pending projection fall back to
  committed `usage_event` rows;
- rows are priced with the same `usageProjection` path and the day's stored
  `tier_id`;
- directory discovery also falls back to committed facts while pending;
- an intersecting `integrity_gap` marks the read's facts incomplete rather than
  publishing a complete total.

A differential test compares the v2 read with the raw-event read, including a
cleared `last_at_ms`. No numeric tolerance is used.

## Workload (implemented)

`readLocalIndexWorkload` uses `workload_bucket` when its watermark is `ready`
and the context basis matches:

- non-boundary five-minute buckets are priced at read time and combined with
  `every` for `priced` coverage;
- quota observation/reset, declared-speed, work/task, local-midnight,
  window-edge and cleared-`last_at_ms` buckets are expanded to raw events;
- the existing classifier, interval union and plan/quota policies are unchanged;
- an intersecting `integrity_gap` sets usage coverage to empty for the window
  and adds an explicit `integrity_gap` error, so missing events are not idle;
- a pending projection uses the raw-event path.

The differential test compares bucket and raw reads, including a cleared
`last_at_ms`. Aggregate pricing can reorder binary-float additions; the test
allows only that reordering noise and keeps every structure, string, integer,
coverage flag and classification exact.

## Audit and maintenance

- `audit()` returns `{ rollup, work, workload, pairing, consistent }` plus a
  projection-status block; a `pending`/`building` projection reports pending,
  not consistent or drifted.
- `local-index-maintenance` repairs a `ready` mismatched derived table from
  committed facts under the existing resource gates; it does not compete with
  an active backfill.
- `reconcileRollups` rebuilds `work_rollup` v2 and `workload_bucket` when the
  price-registry context basis moves, and marks their watermarks `building`
  until the rebuild and audit complete.
- A repair advances `commit_seq` and the calculation revision exactly as the
  existing maintenance path does; readers never trust a partial rebuild.

# Acceptance criteria

- A one-source append changes only its own manifest rows and projection
  partitions; unrelated session, time and account partitions keep their hashes.
- `work_rollup` v2 and `workload_bucket` match a fresh grouping of committed
  facts after insert, delete, cursor movement and every key/measure update.
- Work-usage v2 and raw-event reads produce the same totals, coverage, model
  mix, project/thread attribution and unknown-tier handling.
- Workload bucket and raw-event reads produce the same bins, `priced` coverage,
  intervals, classification and plan/quota allocation, including boundary
  expansion cases.
- Backfill never reads a rollout, never double counts an append or rescan and
  resumes after cancellation/WAL deferral.
- Migration failure leaves the v9 copy intact; successful migration preserves
  every source and fact row and records the one-time accounting-cache
  generation change.
- Quota and the last-good workload estimate remain publishable while backfill or
  projection rebuild runs.
- No new table contains a path, raw session UUID or account identifier.

# Tests

Synthetic, content-free fixtures only.

## Schema and migration

- create a v9 store with facts, diagnostic rows and rollups;
- apply `upgradeLocalIndexV9ToV10`, verify source/usage facts unchanged, new
  tables exist, triggers fire, old derived table replacement is transactional;
- interrupt the migration at each step and verify rollback leaves v9 intact;
- verify v11 is refused and read-only v9 is refused;
- verify conversion of a copy does not touch the source.

## Impact manifest

- append one source: exactly one `source_change`, bounded time range, affected
  session, no unrelated partition;
- rescan with segment mismatch: exact or bounded byte range, gap when the upper
  bound is unknown;
- truncate/replace: old facts counted and gap recorded;
- quarantine: facts removed, gap recorded, unknown not zero;
- semantic no-op candidate: zero fact delta, publication still recorded;
- presence change: coverage partition only, no usage range.

## Work projections

- `auditWorkRollups` and `auditWorkloadBuckets` return zero after every
  insert/delete/cursor advance/cursor retreat and every key/measure UPDATE;
- differential equality with a fresh `usage_event` GROUP BY;
- five-minute bucket edges, 15-minute report edges, UTC day edges and local
  timezone midnight edges;
- price effective dates, declared speed windows, task lifecycle boundaries,
  NULL components, partial, assumed-zero and status-only evidence;
- `priced` coverage per bucket; an unpriced group is not zero usage;
- cleared `last_at_ms` recomputation for work usage and workload activity;
- mixed-speed day and unknown-tier work usage.

## Publication and direct corrections

- every published commit has one `publication` row and a manifest-completeness
  value;
- a runtime model correction emits a `fact_correction` change or marks the
  publication incomplete;
- a quota canonical-winner change follows `canonical_observation_id` to
  referencing usage ranges in other sources;
- backfill readiness is published once and does not bump `commit_seq` per
  batch.

## Backfill

- interrupt after every batch and resume without duplicate rows;
- append during backfill, then verify triggers and the next batch do not double
  count;
- rescan during backfill, then verify the changed range is dirty and rebuilt;
- WAL limit, cancellation and restart;
- readers fall back while the watermark is pending and switch only after audit.

## Locality and performance counters

Record and assert:

```text
impact.sourceCount
impact.byteRange
impact.partitionCount
recompute.sourceCount
recompute.bytes
recompute.wallMs
deferred.partitionCount
fallback.scope
```

A one-source append must not change unrelated projection rows. The test compares
old/new partition hashes, not only final totals.

# Validation ladder

Direct test-file execution is allowed while iterating; ordinary isolated runs
use `scripts/run-isolated-tests.mjs` with synthetic homes and state.

1. `node --test test/local-index-impact-manifest.test.js`
2. `node --test test/local-index-rollup.test.js test/local-index-work-usage.test.js`
3. `node --test test/local-index-workload.test.js test/local-index-maintenance.test.js`
4. `node --test test/local-index-store-v7-migration.test.js` plus a new v10
   migration file
5. `npm run test:preflight`
6. `npm run architecture:check`
7. `npm run product:local:test`
8. `npm run docs:check`
9. `npm run test:changed -- --base <review-base>` when a trustworthy base exists

No real-history benchmark, R7 regeneration, packaging, installation or
publication is part of this plan.

# Commit slices

The reviewed sequence is in [Revised commit slices](#revised-commit-slices)
after the plan review corrections.

# Later stages

These are intentionally outside this plan:

- accounting partition proof and per-partition cache receipts;
- quota current-value lane and historical track suffix recomputation;
- persistent lineage component closure;
- variable-length source range replacement, `source_checkpoint`, offline
  rebase, suffix segment/pairing rebuild and incremental response
  reconciliation;
- UI per-component envelopes and per-fragment loading.

# Resolved and remaining decisions

Resolved on 2026-11-01:

1. **v9 -> v10 conversion**: one-time additive DDL migration on the first
   writable open, no backward compatibility. Read-only v9 opens and all older
   versions remain fail-closed; there is no dual-version runtime.
2. **`work_rollup` replacement (v11)**: replace the derived table and fall back
   to raw events while it is empty; no dual table or double trigger.
3. **Account scope in `workload_bucket` (v11)**: include `account_scope_id` and
   record the measured row increase in the implementation receipt.

Remaining:

4. **Backfill owner**: recommend refresh-integrated bounded batches under the
   existing single writer, not a second database writer.
5. **Boundary exactness**: if quota-pair or speed-boundary expansion proves too
   expensive, the reader must stay on the raw path for that case rather than
   accept an approximate allocation.

# Plan review corrections (2026-11-01)

A second pass against the current store and refresh code found these omissions.
They are requirements, not optional follow-ups.

## 1. Publication completeness, not only source changes

`commit_seq` can advance without a source fact change: derived-table repair,
`markPresent`/`markAbsent`, runtime model reconciliation and verification-adjacent
publication. A manifest that only contains `source_change` cannot answer whether
a publication is fully described.

Add a persistent `publication` row for every published commit:

```text
commit_seq          INTEGER PRIMARY KEY
committed_at_ms     INTEGER NOT NULL
kind                TEXT NOT NULL
manifest_complete   INTEGER NOT NULL
source_change_count INTEGER NOT NULL
```

`source_change.commit_seq` references it. `projection_watermark.last_change_seq`
uses the publication fence, while `last_change_id` identifies the last source
change within it. A projection whose watermark predates
`meta.impact_manifest_since_change_id`, or whose required publication is not
`manifest_complete`, must use the bounded fallback path.

`commit_log` remains the bounded display summary. The new publication table is
the durable completeness record.

## 2. Direct fact corrections outside refresh

`local-index-runtime-model-evidence.js` updates `usage_event.model_id` and
`flags` directly; it does not go through a source refresh. `work_rollup`
currently has no model-update trigger, and a new `workload_bucket` would be
stale after the same correction.

Add:

- a `fact_correction` mode for direct fact mutations;
- impact capture for runtime model reconciliation (source, session, time range,
  affected model/tier key);
- update triggers for every mutable column that participates in a projection
  key or measure, at minimum `model_id`, `flags`, `tier_id`, `account_scope_id`,
  `work_directory_id`, `observed_at_ms` and token sums;
- an audit test that mutates each of those columns and repairs both projections.

If a direct mutation path cannot emit a manifest row, it must set
`manifest_complete = 0` for that publication and force bounded projection
fallback. Silence is not allowed.

## 3. Trigger coverage is currently incomplete

The existing `usage_rollup` has a model-update trigger; `work_rollup` has only
insert, delete, cursor-advance and cursor-retreat triggers. Tests already mutate
`usage_event` model, flags, observed time and token columns. The new projections
must not copy that gap.

Add an explicit trigger coverage matrix and tests for:

- insert;
- delete;
- cursor advance/retreat;
- update of every key column;
- update of every summed token column;
- update of `last_at_ms`-relevant time.

`work_rollup` v2 and `workload_bucket` must both survive the same mutation
matrix with audit count zero.

## 4. Quota canonical dependency

A source-local quota occurrence can change the shared canonical
`quota_observation` winner. That can affect usage events in other sources that
reference the same `canonical_observation_id`. A source-only time range is not a
safe impact set for this case.

Add a `quota_observation` impact partition keyed by the canonical observation
id. When a source change adds, removes or re-ranks a canonical observation,
follow the existing `usage_event_quota` index and include the referencing usage
time ranges, possibly across sources. Add a synthetic two-source test.

## 5. Backfill readiness publication

Backfill batches write derived rows and watermarks. They must not bump
`commit_seq` on every batch; that would invalidate accounting and companion
caches repeatedly. They also must not become visible as "ready" without a
publication event.

Choose one:

- a separate `projection_epoch` in `store_state` or `meta`, included in the
  companion cache key; or
- one final `verify`-style publication when a projection becomes ready.

The backfill must publish readiness exactly once, after audit count zero. A
reader that sees `status = building` or a stale epoch stays on the raw path.
Record the chosen mechanism in the schema reference before implementation.

## 6. Audit and maintenance must understand pending projections

During backfill, `work_rollup` may be empty and `workload_bucket` partial.
`auditWorkRollups` would report drift, and `local-index-maintenance` would try
to repair it, competing with backfill.

Add a projection status check:

- `pending`/`building`: audit reports `pending`, maintenance does not repair;
- `ready`: normal audit/repair;
- `stale`: bounded rebuild or raw fallback.

`audit()` must return a stable shape including `workload` and a projection
status, not pretend an empty projection is consistent.

## 7. Workload bucket exactness needs more than quota boundaries

A five-minute bucket can lose exactness at:

- quota consumption-pair boundaries (`usageBetween`);
- declared-speed baseline boundaries;
- task lifecycle boundaries used by `taskWorkIntervals` activity filtering;
- local-timezone midnight for daily plan allocation;
- `last_at_ms` for open-task activity.

Add `last_at_ms` to `workload_bucket` (cleared on delete and recomputed when
needed) and expand boundary buckets to raw events for all four boundary classes.
Do not use `first_at_ms`; it is not additive and is not needed for the current
classifier. Add a fixture for a non-UTC timezone with a local-midnight crossing.

`priced` must be derived per bucket row and then combined with `every`, exactly
as the current event reader does. An unpriced bucket is not zero usage. A Spark
or otherwise unpriced group must not be silently dropped from coverage.

## 8. Work usage day buckets and `last_at_ms`

`work_rollup.last_at_ms` is cleared when the latest event is deleted. The
current work-usage reader uses raw events, so it does not face the null. A v2
reader must recompute a cleared value from the day's committed events or carry
an equivalent exact fallback. Add that case to the differential test.

## 9. v10 changes the companion and accounting generation

`generationIdentity` includes `LOCAL_INDEX_STORE_USER_VERSION`. A v10 bump
changes the generation fingerprint and can make an existing accounting cache a
stale generation. This is expected and must be explicit:

- serve the previous cache only through the existing stale channel;
- do not label it current;
- record the one-time cache rebuild in the migration receipt;
- do not bump `commit_seq` per backfill batch merely to force a reload.

The next read-side milestone after this plan is the accounting partition proof.
Without it, a source fact change still invalidates the whole accounting cache,
even if work projections are local.

## 10. Privacy and closed vocabularies

The new tables must not contain raw source paths, raw session UUIDs, raw account
identifiers or free-form errors. Use numeric store ids and local digests.
`source_change.reason`, `integrity_gap.reason` and `repair_queue.reason` are
closed code vocabularies; unknown values are rejected. `impact_partition`
keys use internal ids and time ranges, never paths.

## 11. Retention and manifest lag

`source_change` is durable, unlike `commit_log`. Define:

- how long change rows are retained;
- what a projection does when its watermark is older than the retained window;
- how `meta.impact_manifest_since_change_id` is advanced.

A projection that cannot prove it has seen every required change must rebuild a
bounded window or its component; it must not assume no impact.

## 12. Migration and documentation surface

The v10 one-time migration needs more than the store helper:

- a new decision record for the one-time v9 -> v10 cutover and the loss of v9
  compatibility;
- updates to `docs/reference/local-index-schema.md`, the recovery runbook and
  the pre-release conversion runbook/tool if a copy step is used;
- updates to tests that hardcode store version 9;
- update `readLocalIndexIdentityBeforeMigration` admission for the one-time
  conversion preflight;
- update `scripts/lib/pre-release-index-conversion.mjs` or provide an explicit
  new conversion entrypoint; do not silently generalize the old v8 tool.

## 13. Profile before and after

The plan still needs a content-free phase receipt:

```text
projection_work / work_aggregate / work_projects
reuse_proof_before / proof_origins
accounting_validate / accounting_publish
index_refresh
```

The observed 10-second and 70-second diagnostics are hypotheses until this
receipt names the phase. If accounting or quota evidence dominates, the work
projection alone will not meet the user-visible target; record that and sequence
the accounting partition proof accordingly.

## 14. Commit-sequence assignment must match the manifest foreign key

`commit_seq` is allocated at `commit()`, but `source_change` rows are inserted
earlier in the transaction. A non-deferred foreign key from
`source_change.commit_seq` to `publication.commit_seq` would fail or force an
unsafe placeholder.

Choose one explicitly:

- a deferred foreign key plus a placeholder updated before `COMMIT`;
- reserve the publication sequence before source work begins; or
- use a separate `publication_id` assigned before source rows and bind
  `commit_seq` to it at commit.

The same rule applies to `impact_partition.change_id`: `change_id` must be
allocated before its child rows, and `publication.manifest_complete` must be
final before the manifest rows become visible.

## 15. Per-fact-kind deltas, not only usage events

A source change can alter usage, quota, tool, work-lifecycle, lineage-snapshot
and diagnostic facts independently. A source-change row with only usage counts
cannot explain a quota or lineage impact.

Add a bounded `change_fact_count` table:

```text
change_id, fact_kind, old_count, new_count,
old_min_at_ms, old_max_at_ms, new_min_at_ms, new_max_at_ms
```

`fact_kind` is a closed vocabulary (`usage`, `quota`, `tool`, `work`,
`lineage_snapshot`, `diagnostic`). Time bounds are NULL when the fact kind has no
observed-time column. Impact partitions are derived from these counts and
bounds, not guessed from `usage_event` alone.

## 16. Queue, watermark and gap crash recovery

`repair_queue` and `projection_watermark` need bounded crash recovery:

- `repair_queue` records `lease_owner` and `lease_expires_at_ms`, or an
  equivalent attempt/next-retry rule; a crashed worker must not strand a row in
  `running`;
- `projection_watermark` records `attempt`, `updated_at_ms` and a lease/defer
  reason; a crashed backfill is reset to `pending`, not left `building`
  forever;
- `integrity_gap.repair_status` rows are addressable by the queue
  (`scope_kind = integrity_gap`, `scope_key = gap_id`);
- merging is allowed only for adjacent ranges in the same source, component,
  account epoch, quota track or projection window; never across components or
  account epochs.

Add indexes for `publication(committed_at_ms)`,
`source_change(commit_seq)`, `source_change(source_id, change_id)`,
`impact_partition(partition_kind, lower_ms, upper_ms)`,
`impact_partition(session_id)`, `impact_partition(lineage_component_id)`,
`integrity_gap(source_id, repair_status)`,
`projection_watermark(status)`,
`repair_queue(status, next_retry_at_ms, priority)` and
`workload_bucket(bucket_start_ms, session_id)`.

## 17. Impact partition scope and lineage

`impact_partition.lineage_component_id` has no source until the component table
exists. In this slice, either leave it NULL and use the existing numeric
`session_id`, or add a bounded component key derived from the current
`lineage_json`. Do not invent a stable component id from a path or session UUID.
Add an optional `account_scope_id` column now so quota/account impacts do not
need a later table rewrite.

## 18. Compressed sources and gap byte semantics

For `.jsonl.zst` sources, `size` and `source_offset` are decompressed JSONL
bytes, while `physicalSize` is the compressed length. `integrity_gap.byte_start`
and `byte_end` must be documented and implemented in decoded byte space;
physical-compressed offsets are not interchangeable. A compressed representation
change is `source_replace`/`quarantine_gap`, never an append.

## 19. Existing usage rollup update coverage

The plan's update-trigger matrix applies to the new projections, but the
existing `usage_rollup` also has only a model-update trigger. If production or
recovery code can update token, observed-time or context columns, the existing
report and accounting rollups can drift. Audit the existing trigger coverage as
part of this slice; either add the missing update trigger or document the
closed set of mutable columns and prove no production path changes them.

## 20. Work-usage snapshot epoch and bounds

The work-usage snapshot carries a `generation` and metadata. If the projection
switches from raw events to v2 without a commit-sequence bump, a browser-saved
report can mix the two paths. Include the chosen projection epoch or readiness
publication in the snapshot generation/metadata. Preserve the existing
capacity bounds: 25,000 sessions, 50,000 cells, 100,000 work facts and the
existing 1,000,000-usage-event ceiling on the underlying workload read.

# Revised commit slices

1. **Plan and decision**: this document plus the one-time v10 migration
   decision.
2. **Profile step 0**: content-free phase receipt for the current symptoms.
3. **Schema v10**: publication/source-change/impact/gap/watermark/queue tables,
   v9 -> v10 migration helper and migration tests. No work projection yet.
4. **Impact capture**: source advances, presence changes, direct fact
   corrections, quota canonical dependencies and publication completeness.
5. **Schema v11 and backfill**: `work_rollup` v2, `workload_bucket`, update
   triggers, audit/maintenance pending-state, backfill readiness publication.
6. **Work usage reader**: v2 when ready, `last_at_ms` recompute, unknown-tier
   fallback, parity tests.
7. **Workload reader**: buckets when ready, boundary expansion, `priced`
   coverage, raw fallback, parity tests.
8. **Docs and conversion**: schema reference, recovery runbook, conversion
   entrypoint, current status and version-hardcoded test updates.

# Implementation receipt (2026-11-01)

Synthetic only. The change was developed on top of `63f078d7`; this receipt
records the reviewed working tree. No live index, owner profile, rollout,
installed artifact, release or deployment was read or migrated.

## Projection row measurement

A fresh synthetic corpus (`variety: true`, 30 files, 3,000 generated events,
21 days, seed 101, no filler, quota rate 1) produced 3,201 committed
`usage_event` rows, 1,273 `work_rollup` v2 rows over 21 UTC days, and 1,797
`workload_bucket` rows over 688 five-minute buckets. Both watermarks were
`ready`.

That generated corpus exercised one account scope, so adding `account_scope_id`
to the key did not change either row count. A controlled store with two
otherwise identical events under two different account scopes measured the
dimension directly: both projections produced 2 rows with `account_scope_id`
and 1 row without it. Each additional account scope in an otherwise identical
key therefore adds one projection row. This bounds the key cost on synthetic
data; it is not a measured owner-store row count.

## Boundary regression

The workload bucket reader expands boundary buckets to raw events. Its shared
raw-event statement was inclusive at the upper bound, so an event exactly on
the next bucket's start was counted by both adjacent expanded buckets. The
statement is now half-open and the non-projection path passes `nowMs + 1`.
`test/local-index-workload.test.js` includes two adjacent boundary buckets
sharing an edge event and asserts the bucket and raw reads agree.

## Post-review corrections

An independent review found five blocking gaps; all are closed in the reviewed
working tree:

- workload bucket expansion now treats the 7-day display edge, the 15-minute
  current edge, the 60-minute trend edge and the comparison start as raw
  boundaries, and expands buckets containing an exact five-minute start event
  so receipt bins are preserved;
- `source_replace` and `range_rescan` record a bounded full-source impact even
  when count and observed-time bounds are unchanged, because token/model/tier/
  flag/diagnostic content can still differ;
- a quota fact change expands every referenced canonical observation, including
  an in-place re-rank that keeps the same canonical id;
- a v9 input applies v9 -> v10 and v10 -> v11 in one transaction; an injected
  failure rolls back to v9 and leaves no intermediate v10;
- modes, reasons, partition kinds, basis kinds, statuses and repair scopes are
  closed vocabularies enforced by the DDL and writer, with a bounded prefix and
  `manifest_complete = 0` instead of an abort above 256 changes.

Observed times may be signed; byte offsets remain non-negative. The
`workload_bucket_observed` index is created by the v11 DDL rather than only on a
later writable open.

## Validation run

Passed on the reviewed working tree:

```text
node --test test/local-index-impact-capture.test.js \
  test/local-index-impact-schema.test.js \
  test/local-index-quota-impact.test.js \
  test/local-index-work-projection.test.js
node --test test/local-index-work-usage.test.js \
  test/local-index-workload.test.js \
  test/local-index-maintenance.test.js \
  test/local-index-store-v7-migration.test.js
node --test test/local-index-backend.test.js \
  test/runtime-model-evidence.test.js \
  test/codex-usage-compatibility.test.js \
  test/pre-release-index-conversion.test.js
npm run test:preflight
npm run architecture:check
npm run docs:check
```

All local-index test files except the goldens were also run together. Three
failures reproduce at `c12deb62` and are not caused by this change:
`local-index-accounting-cache` expects an older stage-name list,
`local-index-boundary` reports three pre-existing import-ledger entries, and
`local-index-usage-explainer` expects an identity field the reader does not
return. They remain open outside this slice.

`test/local-index-goldens.test.js` still reports the same three pre-existing
differences (Standard work identities, usage-report digests and calibration
layers) on a clean `63f078d7` worktree. They are not caused by this change and
were not regenerated here.

Not run: real-index writable open, real migration, native credential
qualification, packaging, installation, signing or publication.

## Remaining gate

Before the first live writable open, take the protected copy described by the
[v11 migration decision](../decisions/2026-11-01-local-index-v11-migration.md)
and verify source/fact equality, `quick_check`, `foreign_key_check`, projection
backfill/audit and last-good quota/workload readability on the copy.
