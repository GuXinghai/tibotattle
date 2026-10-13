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
| `PRAGMA user_version` | `4` | Physical version. This build opens only 4. |
| Parser stamp | `local-index-rollout-typed-v1+unified-rollout-typed-v19` | Written to `source.parser_version` and `meta.parser_version`. It embeds the shared extractor revision `unified-rollout-typed-v19`, and a test pins the two together. |
| Commit sequence | `store_state.commit_seq` | Monotonic publication counter. Readers key their caches and the companion generation id off it. |

Fail-closed rules, in the order `openLocalIndexStore` applies them:

- A wrong `application_id` refuses the file with `local_index_family_mismatch`.
  `meta.family` is written at creation; the open path does not re-check it.
- A `user_version` greater than 4 fails with `local_index_newer_version`. The
  file is not opened writable and must not be relabelled.
- A `user_version` below 4 fails with `local_index_family_mismatch`. This build
  has no migration from any earlier physical version.
- A writer must see WAL mode after `PRAGMA journal_mode = WAL`, otherwise it
  fails with `local_index_journal_mode_refused`.

The extractor's parser revisions set the meaning of each stored fact. A change
of extractor revision changes the parser stamp. Each source whose stamp differs
is rescanned on the next refresh (reason `parser_version`), and the companion
gives that first refresh the cold-build deadline.

## Tables

| Group | Tables | Purpose |
| --- | --- | --- |
| Catalog and format | `meta`, `store_state`, `commit_log` | Family and parser stamp, rollup basis, the commit sequence, and the newest 100 commit summaries (`kind` is `cold`, `refresh` or `verify`). |
| Dimensions | `model`, `tier_semantics`, `surface_class`, `account_scope`, `session`, `work_directory` | Interned values. Each row is referenced by id from facts. |
| Quota | `quota_observation`, `quota_occurrence` | Canonical quota readings deduplicated across sources, and source-scoped occurrences. |
| Sources | `source`, `source_segment` | One row per rollout ever seen: identity, cursor, digests, carried state and quarantine. |
| Facts | `usage_event`, `usage_event_boundary`, `tool_class_fact`, `lineage_snapshot` | Typed usage events, the boundaries before them, closed tool-category facts and fork-replay membership. |
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
  report with no spend.
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

### Source state

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
| `auditPairing` | `cache_candidate` and `session_positive` with a regrouping of committed facts | Rows missing or extra in either direction |

The result is `{ status: "audited", commitSeq, rollup, work, pairing,
consistent }`, where `consistent` is true only when all three counts are zero.
A missing or unreadable store returns `{ status: "unavailable", consistent:
false }`. The audit does not create a store, does not take a write lock and does
not change `commit_seq`.

Nothing schedules the audit, and nothing repairs a mismatch. The regroup
functions exist: `rebuildRollups` and `rebuildWorkRollups` run when the price
registry basis moves, and `rebuildPairing` rebuilds the pair tables but has no
caller. Until a repair path is wired, a mismatch is reported and preserved, not
corrected in place.

## Generation and publication

There is no staged generation, snapshot file or publication pointer. A commit
is the publication. The companion's generation descriptor uses `commit_seq` as
its id and `generation-v2-<64 hex>` as its fingerprint, computed from the
committed snapshot. Projection caches are valid only while that fingerprint is
unchanged.

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
- `readOrCreateDeviceSalt` creates the salt when the file is missing. The store
  does not compare the salt with existing facts, so a refresh against a store
  whose salt has been lost silently starts a new identity domain. The runbook
  requires the salt to be verified before any refresh of a recovered store.
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
- a parser-stamp change when fact meaning changes, and the matching extractor
  revision in `src/codex-usage-vocabulary.js`;
- updates to the DDL, writer, readers, audit oracle and rollup keys together,
  with tests that call `audit()` after each mutation;
- the recovery runbook, this reference and the privacy reference, when the
  recovery, identity or path boundary changes.

Do not revive the deleted unified v1 schema as current documentation. Schema
history for the retired physical format remains in Git.
