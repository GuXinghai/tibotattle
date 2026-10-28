---
title: Desktop calculation separation and preservation inventory
date: 2026-10-28
type: plan
status: implementation
---

# Boundary

This inventory describes source contracts, not inspection of a user's profile.
Implementation and validation use disposable synthetic state. It does not
authorize real migration, application activation, backup deletion, or rollback.
The owner's approved scope is to separate ordinary desktop calculation from
research analysis and add an explicit unknown-speed assumption. Independent
research entrypoints remain available.

# Information inventory

| Store / fields | Origin and consumer | Rebuild prerequisite | Preservation rule |
| --- | --- | --- | --- |
| Index `usage_event`, boundaries, token components, model/tier/account/surface dimensions | Ingested facts used by accounting and reports | Original complete retained sources and identical ingestion semantics | Preserve every typed value, including facts whose source is now absent |
| Index quota observations and occurrences | Provider observations used by calibration and quota history | Original observations; a present account snapshot cannot recreate history | Preserve every observation and its provenance |
| Index source paths/presence, offsets, segments, carry state, lineage, diagnostics | Discovery, replay exclusion and attribution | Original files and equivalent parser are insufficient when files have disappeared | Preserve unchanged; no discovery or rescan during conversion |
| Index session identity, salt, work directories, lifecycle/tool facts and runtime model evidence | Joins, continuity and local reports | Some retained evidence has no other surviving source | Preserve unchanged and owner-only; never log payloads or paths |
| Index generations, calculation revision, commits and rollups | Consistent publication and read acceleration | Facts and exact aggregation semantics | Do not change in this migration; a display window is not retention |
| Collector `records` with IDs, digest, kind, observation and insertion times | Durable local usage/quota/tool evidence | Upstream observations may be gone | Preserve all typed columns and rows, not just totals |
| Collector `meta.checkpoint`, `schema_version`, `legacy_refresh_use`, `legacy_migration`, and other admitted meta | Checkpoint/replay, schema and earlier operation evidence | Not safely reconstructible from a new scan | Preserve exact stored values |
| Collector `instance_locks` | Writer exclusion | Operational state, not disposable historical accounting | Refuse non-empty locks; do not clear another writer's state |
| Collector `meta.accounting_cache` v0.25: `history`, `periods`, timelines and intervals | Last completed accounting result, sometimes sole surviving historical projection | Complete indexed facts, pricing and attribution evidence of the original evaluation | Preserve complete original JSON in a new historical envelope before removing its active-key role |
| Cache `generatedAt`, `coveredAt`, `sourceDescriptor`, pricing versions, calibration/validation and diagnostics | Qualify meaning, uncertainty and age | Original evidence/version context | Preserve exact values; never claim a migration is a fresh calculation |
| Saved work-usage snapshot v2 | Bounded anonymous saved reports | Names and sources may no longer exist | Preserve bytes unchanged, including period, observation time, generation, pricing, cells and thread families |
| Authoritative dashboard snapshot v1 | Last completed dashboard | Complete source scope and projection semantics | Preserve bytes unchanged; existing availability rules still govern display |
| Speed declaration windows and persisted settings | User/configuration evidence; interpretation of unknown speed | Not recoverable from a current setting alone | Preserve declaration windows unchanged; settings conversion adds only the new default policy |

The collector database mixes facts, control state and derived output. It must
never be erased or replaced by an empty cache database.

# One-time conversion contract

Only explicit cold source and independent, existing empty protected target
directories are accepted. Source data is held read-only and copied without overwrite. The
converter accepts settings v5 and cache v0.25, produces settings v6 and a
`local-accounting-preserved-history-v1` record, and leaves the active accounting
cache absent until a genuine calculation publishes the new current format.
This is not version relabelling.

The history record preserves the entire original cache JSON string and its
SHA-256 digest. Its bounded new-format summary preserves original history,
period totals, evaluation time, coverage, source and pricing labels for dated
local presentation. Other original timelines, calibration results and
uncertainty remain recoverable from the preserved original string and source
copy. Runtime code must not treat that original string as a current cache.

Conversion changes only the copied settings value and the copied collector
accounting meta keys. All records and other meta are checked for typed-value
equality. Source bytes are checked again after conversion. Indexes, salts,
snapshots and other files remain outside this narrow converter and must be
preserved unchanged by the separate reviewed bundle-copy operation.

Unknown versions, malformed values, hot sidecars, non-empty writer locks,
unsafe links/ACLs, target collisions, identity changes and incomplete earlier
operations refuse conversion. A failed target is retained as incomplete for
inspection; neither source nor existing backups are altered or deleted.
An exact completed target may be verified again, but is not converted again.

# Validation gate

Use isolated synthetic fixtures containing absent rollout sources and surviving
history, records, quota observations, checkpoint/control meta and uncertainty.
Check exact original JSON retention, all non-accounting rows, source hashes,
no-clobber, repeated verification, cancellation/failure and version refusal.
Physical Windows checks use reviewed native source leases and protected SQLite
files, not weakened ACLs or generic filesystem publication. Passing a synthetic
test is not authorization or proof of a real-profile conversion.

The copy entrypoint is `scripts/migrate-desktop-calculation-copy.mjs`, with
`--source-state-directory`, `--target-state-directory`,
`--source-settings-directory` and `--target-settings-directory`. It copies only
the collector database and settings, not an entire profile. It accepts no
activation flag or discovered default source. An incomplete target is retained
and refused on another call; a completed target is checked against its receipt
and source bytes before returning `already_complete`.

Runtime cache publication checks the existing accounting schema before
write-mode preparation and repeats that check in the publication transaction.
A different version refuses with `local_collector_accounting_migration_required`,
so an ordinary refresh cannot overwrite the only old historical cache.
This preflight and the preserved-history reader use the protected SQLite read
facade. A cold WAL header without sidecars is opened in immutable mode, with
main/header/sidecar revalidation before returning; ordinary `readOnly` mode
alone is insufficient because SQLite may create coordination files. A SQLite
close failure keeps native guards pinned rather than exposing a live unguarded
connection.
