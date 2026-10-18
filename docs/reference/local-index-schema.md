---
title: Local Index Store Schema
date: 2026-10-12
type: reference
status: maintained
---

# Local index store schema

This is the maintained reference for the local index store that the companion
reads and writes: `src/local-index-store.js` (DDL, writer, open rules),
`src/local-index-rollup.js` and `src/local-index-work-rollup.js` (aggregates),
`src/local-index-pairing.js` (cache-impact pairs), `src/local-index-refresh.js`
(incremental refresh) and `src/local-index-backend.js` (the companion seam and
`audit()`). The retired unified v1 schema reference is superseded by this file;
its history is in Git. Recovery procedures are in
[the local index recovery runbook](../runbooks/local-index-recovery.md).

Path storage is governed by the accepted
[v2 decision](../decisions/2026-10-12-local-index-v2-and-local-paths.md). The
store holds no prompt, response, reasoning, command, or free text. It does hold
absolute rollout paths, rollout file names and working directories, which are
local-only and never leave the owner-only file.

## Identifiers

| Identifier | Value | Meaning |
| --- | --- | --- |
| File name | `local-index-store-v1.sqlite` | Stable machine path in the state root. The `v1` is a name, not the schema version. |
| `PRAGMA application_id` | `1431128370` (`0x554D4932`) | Format guard. A mismatch fails with `local_index_family_mismatch`. |
| `meta.family` | `local-index-store` | Logical family, written once at creation. |
| `PRAGMA user_version` | `6` | Physical version. A writer migrates 4 or 5 forward transactionally; read-only open requires 6. |
| Parser stamp | `local-index-rollout-typed-v2+unified-rollout-typed-v21` | Reconciles exact response usage with legacy spend; an unverified first-response prefix remains partial evidence. Existing sources reparse once. Original records and retained absent-source facts remain untouched. |
| Telemetry publication parser label | `unified-rollout-typed-v21` | The shared extractor revision fits the existing v1.1/v1.2 wire contract. Internal store stamps and the publication fingerprint retain store provenance; no hosted schema is widened. |
| Commit sequence | `store_state.commit_seq` | Monotonic publication counter. Readers key their caches and the companion generation id off it. |

Fail-closed rules, in the order `openLocalIndexStore` applies them:

- A wrong `application_id` refuses the file with `local_index_family_mismatch`.
  `meta.family` is written at creation; the open path does not re-check it.
- A `user_version` greater than 6 fails with `local_index_newer_version`. The
  file is not opened writable and must not be relabelled.
- A version-4 or version-5 writer adds the missing work and runtime-evidence structures transactionally and advances to 6.
  Refresh first performs a bounded read-only identity inspection accepting only
  the reviewed v4/v5 predecessors or current v6, validates the existing device salt,
  and only then opens the writer. This inspection exposes no database handle or
  old-format projection and makes no schema changes. Missing salt, foreign state,
  and newer versions are refused before any migration or salt creation.
  Earlier versions and read-only version-4/version-5 opens fail with
  `local_index_family_mismatch`; readers never migrate state.
- A writer must see WAL mode after `PRAGMA journal_mode = WAL`, otherwise it
  fails with `local_index_journal_mode_refused`.

The extractor's parser revisions set the meaning of each stored fact. A change
of extractor revision changes the parser stamp. Each source whose stamp differs
is rescanned on the next refresh (reason `parser_version`), and the companion
gives that first refresh the cold-build deadline.

### Reviewed model recognition recovery

When the reviewed model vocabulary gains an identity, sources with committed
unknown-model events and an older `source_diagnostic.modelRecognitionVersion`
are reparsed from their original records. No current or later model setting is
backfilled. The version-1 recovery includes GPT-5.1 Codex Max; it does not change
the store schema or global parser stamp. Known-model-only sources stay untouched.

Recovery shares the existing bounded model-attribution queue: at most eight
sources and 256 MiB per pass, with one larger source allowed to make progress.
The per-source recognition receipt commits with the replacement facts, so
cancellation or restart resumes the queue and still-unknown models do not loop.
The normal foreground refresh drains this queue before publishing. Token
quantities and unresolved speed modes retain their original evidence semantics.

### Runtime model evidence

`runtime_model_evidence` retains content-free native-log receipts: canonical model,
previous model where explicit, kind, timestamp, digest, and device-HMAC thread,
turn and response joins. `meta.runtime_model_capture_v1` commits the log source
identity and read high-water mark atomically with each batch. Neither raw log
bodies nor provider IDs are saved. Existing rollout parser stamps are unchanged;
adding this evidence does not trigger a corpus reparse.

The running companion samples every 30 seconds, up to four batches per tick;
each batch reads at most 1,000 log rows and 8 MiB, with a 1 MiB individual-body
ceiling. Backlog ticks wait one second; three consecutive failures suspend this
timer until a global refresh retries it. No UI report is published by the timer.
Missing logs, capture failures, replacement and observed coverage gaps remain
distinct. Closing the companion stops capture and cannot protect upstream logs
from cleanup while it is closed.

Request context and explicit model-fallback outcomes are retained separately.
Only an exact successful-response receipt with an explicit response model can
repair an unknown model. Time proximity, setting changes, fallback attempts and
compaction compatibility hashes cannot establish it. Runtime repairs carry flag
32; contradictory receipts retract only such repairs and report a conflict.
Model updates maintain the existing rollups transactionally without altering
usage identities, Token fields, pairing, or raw sources. A source reparse clears
the derived flag; retained exact receipts can be reapplied without rereading logs.
Reconciliation runs at the foreground index-publication boundary before the
generation descriptor is read; the capture timer never mutates accounting facts
or changes a report generation in progress.

A repair confined to known response-model gaps uses the separate
`RESPONSE_MODEL_RECOVERY_VERSION`, not a global parser-stamp bump. The version
is committed per source in `source_diagnostic` with its corrected facts. Only
previously unattributed, not-yet-evaluated sources enter the repair queue.

## Tables

| Group | Tables | Purpose |
| --- | --- | --- |
| Catalog and format | `meta`, `store_state`, `commit_log` | Family and parser stamp, rollup basis, the commit sequence, and the newest 100 commit summaries (`kind` is `cold`, `refresh` or `verify`). |
| Dimensions | `model`, `tier_semantics`, `surface_class`, `account_scope`, `session`, `work_directory` | Interned values. Each row is referenced by id from facts. |
| Quota | `quota_observation`, `quota_occurrence` | Canonical quota readings deduplicated across sources, and source-scoped occurrences. |
| Sources | `source`, `source_segment` | One row per rollout ever seen: identity, cursor, digests, carried state and quarantine. |
| Facts | `usage_event`, `usage_event_boundary`, `tool_class_fact`, `work_lifecycle_fact`, `lineage_snapshot` | Typed usage, request boundaries, tool classes, task lifecycle and fork-replay membership. |
| Diagnostics | `source_diagnostic` | Counts per closed diagnostic code, per source. |
| Aggregates | `rollup_context_start`, `usage_rollup`, `work_rollup` | Derived sums maintained by triggers (see below). |
| Cache-impact pairs | `cache_candidate`, `session_positive` | Derived pair and count tables maintained by triggers (see below). |

Reader-only secondary indexes are created after a bulk load and whenever a
store with sources is opened for writing: `usage_event_observed`,
`usage_event_session`, `usage_event_quota` (partial), `usage_event_pairing`
(partial, positive-input requests only), `quota_occurrence_canonical`,
`quota_occurrence_observed` and `quota_observation_series`.

### Key columns

- `session.session_local`, `source.source_local` and `account_scope.scope_local`
  are 32-byte HMAC-SHA-256 values keyed by the device salt, each with its own
  domain label. `session.session_uuid` is recorded only when the provider
  session identifier is strictly UUID-shaped.
- `source.source_ordinal` is unique, non-negative and assigned once per source
  (see Invariants). Hosted quota observation identifiers depend on it.
- `source.file_id` is the exact decimal `device:inode` text, or NULL when the
  platform reports no usable id. NTFS ids can exceed 2^53, so the store never
  compares them as doubles.
- `source.rollout_key` is the rollout file name (the last path segment) and
  `source.path` is the absolute path. Both are local-only.
- `source.presence` is `present` or `absent`. An absent source keeps its row,
  ordinal and facts.
- `source.scanned_bytes` is the commit marker for the source's facts (below).
  `size_bytes`, `mtime_ms`, `ctime_ms` and `birthtime_ms` are the stat tuple
  used to classify the next refresh.

### Facts

- `usage_event` is keyed by `(source_id, source_offset)`, where the offset is
  the end of the JSONL record. `event_key` is the 32-byte event identity, the usage
  `eventId` that hosted contribution uses (plan section 7.5). `reasoning_effort` is an ordinal into the
  append-only list `none, minimal, low, medium, high, xhigh, max, ultra,
  unknown`. `work_directory_id` NULL means unknown.
- Token columns are `tokens_in_uncached`, `tokens_in_cache_read`,
  `tokens_in_cache_write`, `tokens_out_text`, `tokens_out_reasoning`,
  `tokens_out_combined` and `total_input_context`. NULL means unavailable, and
  an unavailable component is never stored as zero. A combined output that
  contradicts its split is stored as extracted and is detectable through rollup
  shape bit 12.
- `usage_event.flags` bits: `1` partial parse, `2` model inherited from a
  logical parent, `4` cache-write count assumed zero, `8` status-only quota
  report with no spend, `16` reconciled per-response usage. Response identities
  use device-local digests and the partial `usage_event_response_identity` index;
  duplicate physical copies do not add spend. A changed quantity under one
  response identity fails with `codex_response_usage_identity_conflict`.
- `quota_observation` is unique on `(observed_at_ms, limit_id, slot)`. When two
  sources report the same tuple, the whole reading with the higher
  `used_percent` wins, then the later `resets_at_ms`, so arrival order cannot
  change the result.
- `quota_occurrence` is keyed by `(source_id, source_offset, slot_order)`.
  `admission` is `admitted`, `held` or `suppressed`. Only `admitted` rows feed
  the settled quota windows.
- `usage_event_boundary` records whether a compaction or turn-context boundary
  precedes an event. The pairing, report, contribution and cache-drop readers
  consult it.
- `tool_class_fact` holds the extractor's tool-category label and source kind
  for each tool event. It holds no command or tool payload.
- `source_diagnostic` holds counts for the closed code vocabulary in
  `src/local-index-store.js` (for example `malformedLines`, `partialLines`,
  `oversizedLines`, `compactionEvents`). Unknown codes are dropped.
  Response counters also retain `responseUsageEvents`, `responseDuplicateCopies`,
  `responseForeignThreadRecords`, `responseModelUnattributed` and
  `responseUnverifiedPrefixTurns`. The latter counts source/turn pairs whose
  first exact response begins after a structurally valid but unverified
  cumulative prefix; only the exact response raw usage is charged.
  `responseModelsRecovered` counts models recovered from request/checkpoint
  evidence; `responseModelRecoveryVersion` records the completed evaluation
  version, including evaluations that remain unknown. Both move atomically
  with the source cursor and facts; cancellation/failure commits neither.

### Response and legacy reconciliation

`token_usage_record.usage` is one response, including separately recorded
compaction and ordinary responses absent from `token_count`. The first response
in a physical turn may start after a nonnegative cumulative prefix; that prefix
is not charged and increments `responseUnverifiedPrefixTurns`. Every later
response must continue the chain exactly. A legacy spend row is suppressed only
when its known per-response components match modern evidence; unmatched overlap
fails visibly. Legacy quota observations and legacy-only turns remain. Identical
Token vectors with distinct response identities are distinct calls. Compaction
checkpoint copies and ancestor responses in forked physical history are not
new calls; cumulative thread/turn snapshots are never summed as spend.

Changed modern files replay their retained prefix atomically. This includes a
first modern append after an earlier legacy publication. Ordinary unchanged
files still skip without a new transaction. Source-local segment hashing covers
the publication pass, independently of the bounded reconciliation prepass.

The established model attribution remains when context and persisted settings
are coherent at the response. A setting written shortly after its context does
not invalidate that existing evidence. Additional recovery only fills gaps.
Ordinary responses can retain a fresh request context frozen before the response,
even when thread settings change while it runs. A context already contradictory
when captured, reused after a setting change, or preceding an unverified first
response prefix cannot prove that attribution. A compaction response can use
its exact checkpoint identity, matching raw/cumulative counters, record/time
order, and the next same-turn replacement context when the checkpoint's prior
model agrees. Different prior/replacement models or observed rerouting remain
unknown when recovery is needed. A checkpoint quantity/turn conflict fails explicitly with
`codex_response_usage_checkpoint_conflict`. Later UI/parent settings never fill
these gaps. Speed attribution remains independently evidenced by the captured
request context; later speed changes are not borrowed.

Unknown models and missing/conflicting evidence remain model `unknown`, with
unknown tier and unpriced amounts; Token counts remain available.
Invalid identities, quantities, timestamps, incomplete
chains, conflicting legacy evidence and exhausted bounds have distinct
`codex_response_usage_*` errors. Raw response/thread identifiers stay only in
scan-local memory, not diagnostics or persisted parser state. Limits are 100,000
distinct responses and 250,000 relevant records per retained source scan.

Supported modern accounting evidence is exact standalone response usage. A
first response may have a valid cumulative total that includes an unobserved
prefix: only that response's raw usage is counted, the prefix is never inferred
as spend, and response-usage coverage remains partial for that source/turn.
Every following response must continue the observed cumulative chain exactly.
Checkpoint history remains opaque. A complete supported compaction envelope
can project only its closed receipt suffix using a 512-byte header and at most
128 KiB of trailing bytes; no replacement history is retained or parsed.
Unsupported/missing/oversized metadata cannot establish a model. Checkpoint
copies are never a second source of additive spend.

Recovery reads at most eight affected sources or 256 MiB of source bytes per
batch (one larger source may progress alone). It does not fan out to other
unchanged files in the same session. The backend drains decreasing batches in
one cancellable update under the existing recovery deadline; stalled progress
fails explicitly. Successfully evaluated unchanged sources skip with no fact
write or content rescan, even if attribution remains unknown. Source content
changes and future recovery-version changes permit another evaluation. Existing
source identity, segment integrity, transaction and replay checks still apply.

### Source state

`work_lifecycle_fact` records cursor-bound task starts, completions and
cancellations, observed time, a device-HMAC task key, session relation and optional
reported duration. It retains no original task ID or content. Facts above a
source cursor are provisional; recovery and source replacement remove them with
the other affected facts. Work includes tools and necessary waiting, and parallel
intervals count once. Inference performance timing remains independent.

Workload policy `task-workload-v5` projects, rather than rewrites, these facts.
Retained unambiguous ancestry identifies copied task boundaries, including
paginated forks; a copied completion must also match the ancestor's reported
duration. New child work remains included, and unsupported/cyclic ancestry does
not establish replay. Complete ordered timestamp boundaries define work even
when the reported timer differs by seconds. Missing starts still require a
valid reported duration; reversed or unpaired conflicting boundaries remain
errors. The projection reports replay and duration-difference counts.
The reader supplements its display-window lookback with committed older facts
for the same tasks in established ancestor sessions. Lookups share the reporting
transaction, use batches of at most 128 task keys and refuse more than 100,000
supplementary candidate facts. Older evidence establishes replay only; output
work intervals remain clipped to the seven-day display range. Missing,
ambiguous or cyclic lineage never justifies deduplication.

Quota consumption is the increase beyond each reset/plan track's previously
observed high watermark. A lower stale snapshot never replaces its pairing
anchor and its rebound cannot be charged again. Relevant pre-window evidence
seeds the watermark without allocating pre-window consumption. Conflicting
same-time readings remain errors and break allocation coverage. Regressed
observations remain in the store, appear as chart gaps and are counted in the
projection's `adjustments`; the latest accepted observation retains its actual
timestamp. This is an observed-consumption policy, not proof that a provider
cannot issue a credit within a reset cycle.

Overview groups committed usage timestamps into five-minute bins without
splitting fifteen-minute display rollups. The `overview-workload-v3` comparison
reports two startup totals in percentage points, without a rolling display
window or relative-ratio curve. Actual consumption sums only within each reset
identity, retaining the high watermark; unmatched usage across reset boundaries
and simultaneous quota conflicts remain explicit. Expected consumption uses
the same covered intervals and the first known capacity frozen for that startup.
The seven-day cards keep their existing range and current-plan filter. Startup
reads extend beyond seven days when necessary. Its startup identity, frozen
capacity and capacity history persist in `private/overview-workload-state.json`
as `overview-workload-state-v3`, including the first accepted startup quota
baseline even when it came from a direct live read. Subsequent refreshes retain
that baseline instead of replacing it with a later indexed occurrence. V1/v2
reads preserve capacity history, while writes are forward-only and refuse an
unknown newer state. The same state
root, using the existing validated Windows protected private boundary. The
outer legacy state directory need not be rewritten. Write failures are visible
publication errors.

The startup comparison reads retained direct `app_server_read` quota snapshots
and their validated reset events through the secure collector facade, in addition
to committed rollout quota and the latest live reading. This bounded private
projection exports no account handles or raw records. It stops at changed/lost
established account continuity; notifications cannot supply reset authority.
Unreadable, malformed or over-budget history produces distinct quota-history
errors. Records, cursors and SQL schemas are never rewritten by this reader.

Cycles are resolved chronologically using explicit matching plan/limit metadata.
Validated `scheduled_reset`, `unknown_reset` and `banked_reset_used` events from
the corresponding direct observation can close a cycle before its old expiry.
The observed interval is evidence of a reset, not proof of its provider cause.
An unused zero window can report observation-time plus seven days repeatedly;
these readings remain one cycle until use/countdown anchors its deadline.
An anchored active cycle retains fixed first-deadline jitter bounds. Natural
renewal without an event still requires the old deadline to have elapsed and
a substantially advanced, plausible new weekly deadline. Retired-cycle cache
readings do not reopen a closed cycle, and high watermarks prevent replays or
stale rebounds from charging the same quota twice.

Unproven changes report `comparison_reset_ambiguous`; usage in an unpaired reset
interval reports `comparison_reset_gap`. Confirmed subtotals are retained, not
cleared. A confirmed reset permits subsequent new-cycle pairs even when the
boundary itself has a gap; ambiguous pairing stops until a confirmed reset.
Missing prices retain the known priced subtotal and remain explicit errors.
`comparison.coverage` is `complete`, `partial` or `unavailable`, and
`confirmedThrough` identifies the last confirmed pair. The UI visibly qualifies
partial subtotals; they are never presented as a complete cumulative total.
The browser accepts retained v2 snapshots and current v3, and refuses unknown
future versions. Private startup state remains v3. Seven-day and current-load
cards keep their existing data and semantics.

`source` carries everything a refresh needs to decide, without reading the
rollout header, what to do with a file:

- Cursor: `scanned_bytes`, `size_bytes`, and the stat tuple.
- Integrity: `head_digest`, `boundary_digest` and `tail_digest` (SHA-256 of the
  first 4 KiB, the 4 KiB before the cursor, and the open tail after the last
  complete segment). `source_segment` holds one SHA-256 per complete 256 KiB
  segment. `verified_at_ms` and `verified_bytes` record the last full
  verification.
- Carried state for the next append: `carry_model`, `carry_effort`,
  `carry_tier_raw`, `carry_tier_observed_at_ms`, the six `carry_total_*`
  counters, `carry_work_directory_id`, `turn_context_seen`,
  `turn_context_pending`, `compacted_at_ms` with `compaction_offset`, and
  `snapshots_persisted`.
- `lineage_json`: the rollout lineage header, so an unchanged source needs no
  header read.
- `quarantine_code`: one of the extraction codes `codex_rollout_content_invalid`,
  `codex_rollout_tail_incomplete` and `codex_rollout_lineage_invalid`, or a
  discovery code `codex_rollout_compression_unsupported`,
  `codex_rollout_filename_identity_mismatch` and
  `codex_rollout_generation_ambiguous`. A quarantined source has no committed
  facts (`scanned_bytes` is 0) and is retried when its stat tuple changes.

## Invariants

- **Commit marker.** `source.scanned_bytes` is the publication point for a
  source. A fact whose `source_offset` is greater than it is provisional. Readers
  ignore it, and a writable open removes it (`repairProvisional`). Because fact
  offsets are record-end offsets, the last complete record can sit exactly at
  `scanned_bytes`.
- **One transaction per advance.** A source's facts, its cursor, its segment
  digests, its diagnostics, its carried state and its derived rows move in one
  `BEGIN IMMEDIATE` transaction. `commit_log` is written in the same transaction.
  A refresh that changes no source opens no write transaction.
- **Single writer, snapshot readers.** Writers take `BEGIN IMMEDIATE`. Readers
  run inside one read snapshot that pins a single `commit_seq`. A long reader
  pins the write-ahead log; see the WAL limits below.
- **Absence is not deletion.** A source that vanishes from disk becomes
  `absent` and keeps every fact. Rollouts are never modified.
- **Ordinals are never reassigned.** A new source takes the next unused
  ordinal, above the maximum already stored. The carried ordinal seed described
  below is reserved before any new source is registered.
- **Append-only closed vocabularies.** Reasoning-effort ordinals, flag bits,
  quarantine codes, diagnostic codes and admission states are part of the
  on-disk format. New values append; existing values never change meaning.
- **Replay-safe rescans.** A source is rescanned when its parser stamp, identity,
  cursor, quarantine state or digests disagree with its stat tuple, or when a
  segment digest or the head, boundary or open-tail digest fails. A rescan
  retreats the cursor before it removes the source's facts, so its counts are
  removed through the triggers and the replacement facts are counted only when
  the cursor advances again.

### Incremental refresh

`refreshLocalIndex` discovers rollouts under `sessions` and `archived_sessions`
below the Codex home, compares each with its catalog row by stat tuple, and
reads only what changed:

| Classification | Action |
| --- | --- |
| New source | Full read, registration with a new ordinal, one commit. |
| Same size, same stat | Skip. |
| Same size, different mtime or ctime | Rescan (`same_size_changed`). |
| Larger, not quarantined | Append from `scanned_bytes` after the head, boundary and tail digests match (`append`). |
| Smaller, or cursor inconsistent | Rescan (`shrink`, `cursor_invalid`). |
| Identity changed (`file_id`, birth time) | Rescan (`identity_changed`). |
| Append candidate whose head, boundary or open-tail digests no longer match, or that cannot be read | Rescan (`boundary_changed`). |
| Compressed representation changed | Rescan (`compressed_changed`). |
| Closed segment digest mismatch (forced or due verification) | Rescan (`segment_mismatch`). |

Closed segments are verified in the background, not on every refresh. A segment
is due when the source has grown since its last verification, has been stable
for 10 minutes, and was last verified at least 24 hours earlier. A source with
at least one complete segment and no quarantine is verified at least every 7
days, whether or not it grew. A forced verification (`verify.force`) checks
every closed segment regardless of age. The companion does not pass it; it is
available to a direct `refreshLocalIndex` call.

Cold builds read new sources in parallel lanes. Those lanes write facts beyond
their cursor before the cursor moves, and `repairProvisional` clears the
leftovers after a crash. Between refreshes, the cursor, the stat tuple and the
digests are the only state that carries over from one refresh to the next.

### Write-ahead log limits

`LOCAL_INDEX_WAL_LIMITS` sets a soft limit of 64 MiB and a hard limit of
1 GiB. The hard limit is lowered to 10 % of free disk when that is smaller, and
never below the soft limit. A refresh checks the log before each write
transaction. At the hard limit it stops starting transactions and returns
`status: "deferred"`. Everything it committed stays valid and resumes from its
cursor. The backend turns a deferred refresh into
`local_unified_index_publication_busy`, which is never reported as a
publication. The store must sit on a local volume; roaming or network profiles
are unsupported for WAL (plan section 14).

## Aggregates

Aggregates are sums of the facts at or below each source's cursor. Triggers keep
them current: an insert or delete on `usage_event` adjusts its group, and an
advance or retreat of `source.scanned_bytes` adds or removes the facts it
crosses. A group whose event count reaches zero is pruned.

### `usage_rollup`

Key: `bucket_ms` (15-minute UTC bucket), `model_id`, `tier_id`, `surface_id`,
`account_scope_id`, `shape`, `ctx_class`.

- `shape` is a bit set: bits 0-5 mark which of the six token columns are NULL,
  bits 6-11 mark which are positive, and bit 12 marks a combined output that
  contradicts its split.
- `ctx_class` is `-1` when total input context is unavailable. Otherwise it is
  the number of price-registry thresholds at or below the total. The thresholds
  are each registry boundary and the token after it (`rollup_context_start`).
- Measures: `events` and the six token sums, with NULL counted as zero inside a
  sum only because the shape key keeps NULL and zero groups apart.

Nothing stored here is a price. The registry fingerprint is kept in
`meta.rollup_basis`. When a writable open finds that the fingerprint differs
from the current registry, the rollups are regrouped from the facts. Rollups
are never regrouped from rollouts.

### `work_rollup`

Key: `day_ms` (UTC day), `session_id`, `work_directory_id` (0 for unknown),
`model_id`, `account_scope_id`, `shape`, `ctx_class`, `prov`.

- `prov` bits: `0` partial parse, `1` cache-write assumed zero, `2` status-only
  quota report.
- Measures: `events`, the six token sums and `last_at_ms`. `last_at_ms` is the
  one non-additive value. A delete that removes a group's latest event clears
  it to NULL, and the reader recomputes it from the day's events.
- It is rebuilt together with `usage_rollup` when the registry basis moves.

### Cache-impact pairs

- `cache_candidate` holds one row per qualifying pair: a positive-input request
  and the offset of its predecessor in the same source. A pair is in the table
  only while both facts are committed.
- `session_positive` counts positive-input requests per `(session_id,
  source_id)`, so a session that spans several sources can be checked without a
  scan.

A source belongs to one session. That makes "the previous request in the
source" the previous request in the session.

### Audit contract

`audit()` on the backend (`src/local-index-backend.js`) compares every derived
table with a fresh derivation from the committed facts, inside one read
snapshot. It is read-only, returns counts only, and never repairs:

| Oracle | Compares | Counts |
| --- | --- | --- |
| `auditRollups` | `usage_rollup` with a regrouping of committed usage events | Rows missing, extra or different, plus rows with `events <= 0` |
| `auditWorkRollups` | `work_rollup` with a regrouping of committed usage events, including `last_at_ms` where stored | Rows missing, extra or different, `last_at_ms` mismatches, and rows with `events <= 0` |
| `auditPairing` | `cache_candidate` and `session_positive` with a regrouping of committed facts | Rows missing or extra in either direction, and rows with `events <= 0` |

The result is `{ status: "audited", commitSeq, rollup, work, pairing,
consistent }`, where `consistent` is true only when all three counts are zero.
A missing or unreadable store returns `{ status: "unavailable", consistent:
false }`. The audit does not create a store, does not take a write lock and does
not change `commit_seq`.

The backend runs a separate maintenance worker after its first completed
ingestion in each process, including a restart after an unclean shutdown, and
at the next completed refresh at least 24 hours after the last successful audit.
Clean restarts also audit; no clean-shutdown marker is inferred. This is an
idle ingestion boundary before generation/accounting reads, not a report path
or an independent timer. Failed or cancelled maintenance remains due.

The worker audits a read snapshot first. On drift it acquires `BEGIN IMMEDIATE`,
rechecks all three oracles under the writer lock, rebuilds only mismatched
derived tables from committed facts and verifies them again. Repair and a
`verify` commit that advances `commit_seq` are atomic, so publication-dependent
caches cannot reuse the pre-repair generation. Clean audits never advance the
sequence. No rollout is read, no source ordinal is changed, and no schema,
salt or absent-source fact is replaced. Cancellation terminates the worker;
SQLite rolls back any uncommitted transaction. Failure preserves the last
committed state and blocks this refresh's downstream publication.

Maintenance returns counts only, with `status: "audited"` or `"repaired"`.
For a repair the counts describe the pre-repair differences and `consistent`
is true only after verification. A missing or incompatible store fails closed.
Before repair, the worker uses the refresher's WAL/free-disk ceiling and reserves
twice the current store page footprint, including WAL frame overhead, under
the writer lock. Insufficient headroom returns
`local_index_maintenance_deferred`, rolls back and leaves maintenance due. This
is a conservative admission budget, not a measured schema-v4 WAL soak result.
SQLite's native lock wait may delay cancellation until its five-second timeout.

## Generation and publication

There is no staged generation, snapshot file or publication pointer. A commit
is the publication. The companion's generation descriptor uses `commit_seq` as
its id and `generation-v2-<64 hex>` as its fingerprint, computed from the
committed snapshot. Projection caches are valid only while that fingerprint is
unchanged.

The derived Work Usage saved-report cache retains the latest covered instant
per reporting period and account scope. Completing an older exact-window query
does not roll back that fallback, either in memory, in queued writes, or after
restart. Older windows remain queryable; authoritative corrections at the same
covered instant may replace their saved projection. The browser retains the
newer visible report and its date when a replacement returns an older saved
fallback, while continuing to poll the replacement or displaying its failure.
No source records or accounting timestamps are rewritten by this ordering rule.

## Compressed Codex histories

Cold `.jsonl.zst` rollouts are read by streaming native Zstandard decompression.
No source is rewritten, and no decoded transcript is written to disk. Canonical
rollout identity does not depend on compression.

- `physicalSize` is the compressed length. `size`, cursors and offsets use
  decompressed JSONL bytes.
- A byte-identical plain and compressed pair collapses to one source, with the
  plain file preferred. A representation change forces a rescan (`compressed_changed`),
  never an append into compressed bytes.
- Limits per stream: 2 GiB compressed, 16 GiB decoded, a 128 MiB decoder window
  (window log 27), 120 seconds, and decoded expansion of at most 4096 times the
  compressed length with a 64 MiB floor. Discovery runs at most two decoders at a
  time and reads at most a 1 MiB metadata prefix. These are refusal ceilings,
  not performance targets.
- Node 22.15.0 and later (and 23.8.0 and later) provide the streaming API. The
  project's minimum, Node 22.13, still imports, and reports
  `codex_rollout_compression_unsupported` for compressed groups. The packaged
  runtime is Node 26.2.0. This is source and runtime compatibility, not
  installed-artifact qualification.
- Truncated input can end with empty output on some native builds. The adapter
  therefore validates frame and block boundaries itself and requires a complete
  JSONL tail.

## Identity and privacy boundary

- The device salt is the file `local-unified-index-device-salt-v1` in the same
  directory as the store. Every local join key and every hosted pseudonym derives
  from it. It is never rotated or regenerated by the store.
- Salt creation is allowed only for a new/empty identity domain. Before salt
  creation, refresh inspects an existing store read-only; registered sources or
  a published commit require `readExistingDeviceSalt`. A carried ordinal map or
  an existing legacy index also requires the preserved salt before v2 creation.
  Missing/malformed salts and incompatible existing files fail without minting
  a new salt or opening the store writable. The store still cannot identify a
  different valid-length salt substituted for the original; recovery must
  verify the preserved salt and its digest before refresh.
- Hosted upload pseudonyms are derived at send time from the export secret and
  the local identity. They are not stored in the store.
- Paths stay in the store. Exports, contributions, diagnostics, logs, crash
  output and snapshots carry no path or working directory. The
  [privacy reference](./local-data-and-privacy.md) describes the boundary.

## Change contract

A change to the store's DDL, closed vocabularies, parser stamp, identity
derivation or derived-table semantics requires, in one change:

- a `user_version` bump when the physical format changes, with the fail-closed
  open rules above and tests for older and newer files;
- a parser-stamp change when general fact meaning changes, and the matching
  extractor revision in `src/codex-usage-vocabulary.js`; a scoped response-model
  repair may instead advance its independently persisted recovery version when
  it demonstrably targets every affected prior source without invalidating
  unrelated history;
- updates to the DDL, writer, readers, audit oracle and rollup keys together,
  with tests that call `audit()` after each mutation;
- the recovery runbook, this reference and the privacy reference, when the
  recovery, identity or path boundary changes.

Do not revive the deleted unified v1 schema as current documentation. Schema
history for the retired physical format remains in Git.
