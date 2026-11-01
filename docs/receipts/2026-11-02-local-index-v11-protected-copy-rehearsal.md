---
title: Local-index v11 protected-copy live rehearsal
date: 2026-11-02
type: receipt
status: verified
source_commit: dc10efbc
---

# Result and boundary

The owner authorized a read-only copy of the current stable profile's local
index and a writable open of that copy only. The copy migrated from schema 9 to
11, preserved every source and fact row, passed `quick_check`,
`foreign_key_check` and full `integrity_check`, completed the bounded work
projection backfill, and audited both projections to zero. The five original
files remained byte-identical, including WAL and SHM; the original index was
never opened writable.

This receipt proves one protected-copy rehearsal on one Windows x64 host. It
does not prove the first live writable open, an owner-profile phase receipt,
installed-app rendering, release, updater or deployment.

# Source and environment

- Rehearsal date: 2026-11-02 local; the run started at
  2026-11-01T17:55:01Z and took 728,132 ms.
- Code: the `3ce6649d` tree plus the v10->v11 trigger replacement fix. The fix
  is committed as `dc10efbc`; the rehearsal used that code without behavioral
  changes between the run and the commit.
- Host and runtime: Windows x64, Node.js v22.21.1, SQLite 3.50.4 through
  `node:sqlite`.
- Source: the owner's stable profile under
  `%APPDATA%\UsageMonitor\profiles\stable\companion-state`. The copy was placed
  in a separate quarantine directory on a non-system volume.
- Copied files: `local-index-store-v1.sqlite` (306,810,880 bytes), its WAL
  (5,232,432 bytes) and SHM (32,768 bytes), the device salt (32 bytes), and
  `local-collector-state-v1.sqlite` (81,154,048 bytes). The collector file was
  copied but not opened.
- All five source/copy SHA-256 pairs matched immediately after copying. No
  database content was printed.

# Migration and backfill

The copy reported `PRAGMA user_version = 9` and contained 4,219 sources,
550,560 committed usage events, 477,665 quota occurrences and 42,136 work
lifecycle facts.

The first writable open applied the combined v9 -> v10 -> v11 DDL transaction.
After it:

- `PRAGMA user_version` was 11 and the journal mode was WAL.
- `PRAGMA quick_check` returned `ok` and `PRAGMA foreign_key_check` returned no
  rows.
- Every source and fact count above was unchanged.

The bounded maintenance loop used at most eight batches of 20,000 events per
call. It required 44 calls. Both projection watermarks reached `ready`; the
final `work_rollup` held 13,280 rows and `workload_bucket` held 75,050 rows.
`auditWorkRollups` and `auditWorkloadBuckets` both returned zero.

A final read-only inspection returned `PRAGMA integrity_check = ok` after
93,409 ms, no foreign-key violations, and five `work_rollup_*` trigger
definitions that all contain `tier_id`.

# Defect found and corrected

The first attempt on the migrated copy failed before backfill. The v9
`work_rollup_insert` trigger was attached to `usage_event`, so dropping the
derived `work_rollup` table did not remove it. `CREATE TRIGGER IF NOT EXISTS`
then retained the untiered v9 definition, whose `ON CONFLICT` target omitted
`tier_id`; the writer could not prepare any `usage_event` insert and
maintenance surfaced only `local_index_maintenance_failed`.

`applyV10ToV11` now drops all five legacy trigger names (`insert`, `delete`,
`update`, `cursor_advance`, `cursor_retreat`) inside the migration transaction
before installing the tiered v11 definitions. A regression test starts from a
v10 store carrying legacy triggers and verifies the replacement, writer
preparation and source-update preparation. The successful measurements above
come from a fresh copy re-run after this fix.

# Unchanged original

After the rehearsal, all five original files still matched their pre-copy
SHA-256 values. The original database, WAL, SHM, device salt and collector
state were not opened writable or changed. The copy remains isolated for
readback; it is not a replacement for the owner's live store.

# Reader smoke (added after the migration run)

A read-only reader pass ran on the same final copy after the audits. It used the
copy's device salt and an empty synthetic Codex project root, so project labels
are not owner-profile evidence; the event aggregates are.

- `readLocalIndexWorkUsage` returned `status: available`. The `all` period
  contained 550,560 events, matching the committed usage-event count. The 24h,
  7d and 30d periods contained 4,049, 58,450 and 260,430 events.
- `readLocalIndexWorkload` returned `overview-workload-v9` with seven UTC daily
  buckets from 2026-10-25 through 2026-10-31 and nonzero work coverage
  (243,799,133 ms). Its status was `partial` because it explicitly reported one
  `work_boundary_incomplete`, one `quota_reset_ambiguous` and one
  `price_missing` error.

The partial result is the intended representation: those unknowns are surfaced
as bounded errors and are not converted to zero activity. This smoke proves the
copy's reader paths return; it does not qualify the owner profile's project
labels or the installed dashboard.

# What this does not prove

- It does not authorize or perform the first live writable open.
- It does not supply the owner-runtime phase receipt or close profile step 0.
- It does not qualify an installed app, native rendering, packaging, signing,
  updater, public deployment or release.
- It proves only this copy's bytes. A later live index with different bytes
  needs its own protected copy and rehearsal.
