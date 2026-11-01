---
title: Local-index v11 live writable open
date: 2026-11-02
type: receipt
status: verified
source_commit: dc10efbc
---

# Result and boundary

The owner explicitly authorized the first writable open of the live stable
profile index. The live store migrated from schema 9 to 11 in one transaction,
preserved every source and fact row, completed the bounded work-projection
backfill, reached `ready` on both projections, audited both to zero, and passed
full `integrity_check`. This is a source-level live-store operation on one
Windows x64 host. It is not installed-app, release, updater or deployment
evidence.

# Preconditions

- No Rhetrion, Electron, usage-monitor or companion process was running.
  `codex-usage.exe daemon` was present but held no handle to the three live
  index files; an exclusive-open probe returned `available` for the database,
  WAL and SHM.
- The live database, WAL, SHM, device salt and collector state still matched
  their pre-rehearsal SHA-256 values exactly.
- A byte-identical v9 backup of all five files was written to the quarantine
  volume and re-hashed before the live open. The already-migrated v11 rehearsal
  copy was also retained.

# Live conversion

The live store reported `PRAGMA user_version = 9` with 4,219 sources, 550,560
committed usage events, 477,665 quota occurrences and 42,136 work lifecycle
facts.

The first writable open applied the combined v9 -> v10 -> v11 DDL transaction.
The run started at 2026-11-01T18:18:34Z and took 398,012 ms. After conversion:

- `PRAGMA user_version` was 11 and journal mode was WAL.
- `PRAGMA quick_check` returned `ok`; `PRAGMA foreign_key_check` returned no
  rows.
- Every source and fact count above was unchanged.
- The bounded maintenance loop used at most eight batches of 20,000 events per
  call and required 44 calls.
- `work_rollup` reached 13,280 rows and `workload_bucket` 75,050 rows; both
  watermarks were `ready` and both audits returned zero.
- Full `PRAGMA integrity_check` returned `ok`, no foreign-key violations were
  found, and all five `work_rollup_*` triggers contain `tier_id`.

The live database settled at 312,700,928 bytes with a zero-length WAL and a
32,768-byte SHM sidecar.

# Reader smoke

A read-only reader pass on the live store used the live device salt and an
empty synthetic Codex project root, so project labels are not owner-profile
evidence; the event aggregates are.

- `readLocalIndexWorkUsage` returned `status: available`. The `all` period
  contained 550,560 events, matching the committed usage-event count. The 24h,
  7d and 30d periods contained 4,049, 58,450 and 260,430 events.
- `readLocalIndexWorkload` returned `overview-workload-v9` with seven UTC daily
  buckets from 2026-10-25 through 2026-10-31 and nonzero work coverage. Its
  status was `partial` because it explicitly reported one
  `work_boundary_incomplete`, one `quota_reset_ambiguous` and one
  `price_missing` error.

Those errors are bounded unknown-evidence states, not zero activity. The
installed dashboard, owner project labels and native rendering remain separate
gates.

# Recovery state

The live store is now schema 11 with both projections ready. A byte-identical
v9 copy of the pre-open files and the audited v11 rehearsal copy remain on the
quarantine volume. No restore was performed, so restore mechanics are not
claimed as tested.

# What this does not prove

- It does not supply the owner-runtime phase receipt or close profile step 0.
- It does not qualify an installed app, native rendering, packaging, signing,
  updater, public deployment or release.
- It proves only this live store bytes on this host. A later index with
  different bytes needs its own protected copy and rehearsal.
