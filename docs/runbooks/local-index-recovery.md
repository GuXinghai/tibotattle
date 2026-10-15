---
title: Local Index Recovery
date: 2026-10-12
type: runbook
status: maintained
---

# Local index recovery

For inherited Windows ACL state, the explicit
[continuity-copy tool](./2026-10-13-windows-legacy-acl-copy.md) preserves a fixed
bundle into a separate protected root without changing original ACLs, salt or
sharing choices. Its partial destination must not be activated as a whole
profile. Unsupported archives and open database sidecars require a separate
preservation plan.

Use this runbook when the local index store will not open, a refresh keeps
failing, the audit reports drift, or the store file is missing or damaged. The
store is derived from the Codex rollouts, but three kinds of state in it or next
to it cannot be rebuilt from rollouts. Preserve first, rehearse on a copy, and
change nothing in place.

The store's schema and invariants are in
[the local index store schema](../reference/local-index-schema.md). The
storage boundary for paths is in
[the v2 decision](../decisions/2026-10-12-local-index-v2-and-local-paths.md).

## Hard prohibitions

Do not:

- edit `application_id`, `user_version`, `meta.family` or `meta.parser_version`
  to make a reader accept a file;
- delete, truncate, vacuum or overwrite the live store, its `-wal` or `-shm`
  sidecars, or the device salt;
- use **Erase local data** or **Reset identity and device** as a diagnosis or
  repair;
- open a store whose `user_version` is above 5 with a build that does not know
  that version, or open any store writable with an older build;
- copy the store without its sidecars, or copy it without the device salt;
- hand-edit `usage_rollup`, `work_rollup`, `cache_candidate` or
  `session_positive` to make the audit pass;
- look for a rebuild script: there is none. The store is rebuilt from the
  original Codex data by the refresh itself, never by a hand-run script;
- delete the retired `local-unified-index-v1.sqlite` as a repair. Its deletion
  has its own gate (section 9).

## 1. Locations on Windows

| Item | Location | Notes |
| --- | --- | --- |
| Installed app state root | `%APPDATA%\TiboTattle\companion-state` | Electron user-data directory plus `companion-state`. |
| Standalone CLI state root | `%LOCALAPPDATA%\app-usagemonitor` | The CLI uses this root when the installed store is absent. `USAGE_MONITOR_STATE_ROOT` overrides both and is authoritative. |
| Store | `local-index-store-v1.sqlite`, with `-wal` and `-shm` while open | The store. |
| Device salt | `local-unified-index-device-salt-v1` | Same directory as the store. |
| Collector state | `local-collector-state-v1.sqlite` | Not index data, same root. |
| Retired v1 file | `local-unified-index-v1.sqlite` | Read only by the one-time ordinal seed and the retirement check. |
| Codex rollouts | `%CODEX_HOME%` or `%USERPROFILE%\.codex`, under `sessions` and `archived_sessions` | Source of truth. Never modify. |

Resolve the exact root from the failing runtime before touching files. Never
guess between the installed and CLI roots.

## 2. Classify the symptom

| Code or observation | Meaning | First action |
| --- | --- | --- |
| `local_index_family_mismatch` | Wrong `application_id`, or an unsupported predecessor version. Not a store this build can open. | Preserve. Find where the file came from before anything else. Do not relabel. |
| `local_index_newer_version` | `user_version` above 5. Written by a newer build. | Install the newer compatible build. Do not open it with this build. |
| `local_index_file_invalid` | Not a single-link regular file, a symbolic link, or an unsafe directory. | Check ownership and links. Do not chmod, replace or recreate the file. |
| `local_index_unavailable` | The file cannot be opened or stat'ed. | Check that the file exists, is not locked by another process, and that the disk has space. |
| `local_index_journal_mode_refused` | WAL mode could not be set. | Confirm the store sits on a local volume. |
| `local_index_secret_unavailable`, `local_index_secret_invalid` | The device salt is missing, unreadable or malformed. | Stop. Read section 4 before running anything that writes. |
| `local_unified_index_publication_busy` | A refresh stopped at the write-ahead log hard limit, or a long reader is pinning the log. | Close other readers and retry. Committed facts are valid and resume from their cursor. |
| `local_unified_index_legacy_ordinals_unavailable` | The store has no sources and the retired v1 file named by the seed cannot be read. | Keep the v1 file. Read section 8 before any new store is built. |
| `local_unified_index_generation_invalid` | A refresh committed, but the companion could not describe the result. | Run the audit (section 6) and read `commit_log`. |
| Audit `consistent: false` | Derived tables disagree with the committed facts. | Preserve a copy. Do not patch in place (section 6). |
| Source `quarantine_code` set | One source's facts are withheld. This is a source problem, not a database fault. | Inspect `source_diagnostic` for that source. Retained facts stay. |

## 3. Freeze and preserve

1. Quit TiboTattle completely and confirm that no companion or refresh process
   remains (Task Manager). Do not kill a process that is publishing unless it is
   stuck; a normal shutdown keeps committed sources.
2. Create a new recovery directory inside the state root, for example
   `%APPDATA%\TiboTattle\companion-state\recovery-YYYYMMDD-HHMMSS`. It must not
   exist yet. Do not reuse another recovery directory.
3. Copy, without moving or editing the originals:
   - `local-index-store-v1.sqlite`, and `-wal` and `-shm` if they exist;
   - `local-unified-index-device-salt-v1`;
   - `local-collector-state-v1.sqlite`;
   - `local-unified-index-v1.sqlite` if it exists (for the retirement check).

   Copy the sidecars together with the main file. A copy of the main file alone
   is not a copy of the store while a non-empty `-wal` exists.
4. Record the TiboTattle version and source commit, the file sizes and mtimes,
   and SHA-256 digests (`Get-FileHash -Algorithm SHA256`). Keep the record in the
   recovery directory. Do not put paths, digests or account data into a public
   issue.

## 4. Check the device salt first

The salt is the root of every local join key and of every hosted pseudonym.

- It must be the file in the same directory as the store, 32 to 256 bytes, and a
  single-link regular file. Symbolic links and multi-link files are refused.
- If the store has sources and the salt is missing, stop. Do not run a refresh.
  Current refresh refuses missing or malformed salts before opening existing
  identity-bearing state writable. Legacy cutover also requires the original
  salt before v2 creation. Restore the salt from the preserved copy or a backup;
  do not create a replacement.
- If no salt exists anywhere and the store has sources, the identity change is an
  owner decision, not a recovery step. Record it and stop.
- Salt creation is allowed only for fresh/empty identity state with no published
  commit, registered sources, carried ordinal map or legacy index. A different
  valid-length salt cannot be recognized automatically; verify the preserved
  salt's checksum before rehearsal.

## 5. Inspect the copy read-only

### Preserve fact content across internal quota-ID rebuilds

For a v5 index, capture a baseline **before** the operation under review, then
verify against the same baseline. These explicit inspection commands open the
index read-only, use one SQLite snapshot, never migrate it, and refuse to
overwrite the baseline:

```powershell
node scripts/verify-local-index-preservation.mjs capture --index <index-copy> --baseline <new-local-baseline>
node scripts/verify-local-index-preservation.mjs verify --index <index-copy> --baseline <saved-local-baseline>
```

Keep the baseline in protected local recovery storage. It contains counts,
hashes, internal source numbers and frozen cursors, never paths or payload rows;
do not upload it. Live read-only inspection is possible when explicitly needed;
normal refresh may continue and append evidence outside the frozen scope.

The check retains every column of `usage_event`, `quota_occurrence` and
`work_lifecycle_fact` within each original source cursor. For the two quota
foreign keys only, it compares the linked observation's unique identity
`(observed_at_ms, limit_id, slot)` instead of its physical integer ID. A changed
physical hash with an unchanged semantic hash reports `internalLinksRebuilt`,
not a source-data failure. NULL remains distinct from a reference, and a
missing target fails. Original occurrence percentages, plans, timestamps and
all token/work fields remain hashed. Canonical winner values are derived from
all observations and may change as new evidence arrives; they are not original
occurrence content and are not frozen by this check. Other dimension-ID
changes remain failures and need investigation.

Verification exits nonzero for missing records, unexpected records inside the
old prefix, changed facts or logical associations, missing/changed sources,
regressed cursors, dangling references, failed integrity checks, incompatible
schema, or invalid baseline. Structured errors distinguish these classes;
unknown underlying I/O errors are content-free `preservation_read_or_write_failed`.
This is an index-fact check, not an independent raw-log byte audit. A source
change that produces the same indexed facts requires retained source-byte
digests to detect; do not claim raw-byte preservation from this check alone.

Legacy complete-row-hash baselines cannot establish logical association
identity by themselves. They fail with `preservation_baseline_unsupported`.
Retain them and establish a separate, explicitly recorded content-preservation
proof before adopting a semantic baseline. Never resolve a failure by simply
capturing current data over the old baseline, ignoring foreign keys, or using
ID-gap/order guesses as a routine acceptance rule.

### Inspect identifiers and integrity

Open only the copy, with a read-only SQLite client such as Node's `node:sqlite`
opened with `readOnly: true`. Run:

```sql
PRAGMA query_only = ON;
PRAGMA quick_check;
PRAGMA application_id;                       -- expect 1431128370
PRAGMA user_version;                         -- expect 5 (a retained v4 copy stays v4)
SELECT key, value FROM meta
  WHERE key IN ('family', 'parser_version', 'rollup_basis');
  -- family: local-index-store
  -- current parser_version: local-index-rollout-typed-v2+unified-rollout-typed-v19
SELECT commit_seq FROM store_state;
SELECT seq, committed_at_ms, kind, sources_changed
  FROM commit_log ORDER BY seq DESC LIMIT 5;
SELECT presence, COUNT(*) FROM source GROUP BY presence;
SELECT COUNT(*) FROM source WHERE quarantine_code IS NOT NULL;
```

Record the exact output. `quick_check = ok` proves page-level consistency. It
does not prove that the derived tables match the facts (section 6) or that every
rollout is covered.

## 6. Audit the copy

The audit is a backend function, not a command. From the checkout, with Node
22.13 or newer:

```js
import { createLocalIndexBackend } from "./src/local-index-backend.js";

const backend = createLocalIndexBackend({
  indexFile: "<absolute path to the copied store>",
  secretFile: "<absolute path to the copied salt>",
});
console.log(backend.audit());
```

`audit()` opens the store read-only, reads one snapshot and returns counts:

- `status: "audited"` with `consistent: true` means the rollups, work rollups and
  cache-impact pairs match the committed facts at `commitSeq`.
- `consistent: false` with non-zero `rollup`, `work` or `pairing` means drift.
  Keep the copy. Record the counts and `commitSeq`. Do not patch the tables
  manually. The backend's next first/daily completed refresh runs off-thread
  atomic repair from committed facts; rehearse that path on the copy first.
- `status: "unavailable"` means the file is missing or cannot be read.

## 7. Rehearse on the copy

Rehearse every step on the copy first. Refresh only the copy, never the live
store:

1. Create the backend with the copy's store path and copied salt, then call
   `backend.refreshUnifiedIndex({ codexHome })`. The refresh reads only new and
   changed sources. Absent sources keep their facts.
   Before returning the generation, the first completed refresh audits the
   derived tables in a worker and repairs drift atomically from committed facts.
   A repair advances `commit_seq` with a `verify` commit; a clean audit does not.
2. Run the audit again.
3. Compare before and after: source count, `presence` counts, usage event count,
   earliest and latest `observed_at_ms`, quota observation count and quarantine
   count.

A `publication_busy` result means the write-ahead log reached its hard limit,
usually because a long-lived reader is pinning it. Close other readers and retry.
`local_index_maintenance_deferred` similarly preserves the store when there is
not enough WAL/disk headroom for a derived-table rebuild. Do not delete sidecars
to force it through. Release readers and retry; the unsuccessful audit stays due.

To re-verify every closed segment against its stored digest, which catches an
edit inside already-verified bytes, call `refreshLocalIndex` from
`src/local-index-refresh.js` with `verify: { force: true }` against the copy. The
backend does not pass that option. The check reads every closed segment, so it
is slow.

## 8. Rebuild from source (last resort)

Use this only when the store cannot be read or repaired, the copy cannot be made
consistent, and the rollouts still exist. It is an identity-changing action.

A rebuild creates a new, empty store in a new recovery directory with the
preserved salt. It re-reads every rollout that still exists. It cannot restore:

- **Facts of absent sources.** Rollouts that have rotated away exist only in the
  old store. Count them from the copy with `presence = 'absent'` before any
  rebuild, and report them as unavailable, never as zero.
- **The original source ordinals.** Hosted quota observation identifiers depend
  on `source.source_ordinal`. A new store assigns fresh ordinals, which changes
  every v11 and v12 quota identifier once and re-uploads each day with quota data
  (the plan's section 7.5). The only seed in the code is the retired v1 file, read
  while the new store has no sources. A v2 store cannot seed another v2 store.
  Do not rebuild from empty without explicit owner authorization.

If that authorization exists, create the rebuilt store path under the recovery
directory, create a backend for it with the preserved salt, call
`refreshUnifiedIndex({ codexHome })`, audit it, and compare its counts with the
copy.

Replacing the live store with a rebuilt store is not a supported operation in
this build. No apply command exists. Do not copy a candidate over the live file.
That step needs a reviewed change and the owner's authorization.

## 9. Keep these, and never delete them as a repair

| Item | Why it matters | Handling |
| --- | --- | --- |
| Device salt | Anchors local joins and hosted pseudonyms. | Keep. Never regenerate. Back it up with the store. |
| `source.source_ordinal` values in the live store | Hosted quota identifiers depend on them, and a rebuild cannot restore them. | Keep the store. |
| Facts of absent sources | Their rollouts are gone. The store is the only copy. | Keep. Never delete by absence. |
| `local-collector-state-v1.sqlite` | Quota snapshots and checkpoints come from live polls. | Keep. Outside the index. |
| Retired `local-unified-index-v1.sqlite` | Its facts are the only copy of any source absent from the new store. | Keep until section 10 says it is retirable and the owner authorizes deletion. |

Rebuildable from rollouts that still exist: the rollups, the cache-impact pairs,
the source cursor and digest state, and all other facts.

## 10. The retired v1 file

The app does not read `local-unified-index-v1.sqlite`, except for the one-time
ordinal seed while the store has no sources. Whether the file can be retired is
decided by `assessLegacyIndexRetirement({ legacyIndexFile, indexFile })` in
`src/local-index-cutover.js`. It is read-only and returns counts only:

- `absentSources` and `absentEvents`: sources in the v1 file that are not in the
  store, and their events;
- `shortfallSources` and `shortfallEvents`: sources whose store count is lower
  than the v1 count;
- `retirable`: true only when both source counts are zero.

Keep the file when `retirable` is false, and record the counts. Deleting it is a
separate, receipt-backed owner action, and no code in this build performs it. An
unreadable file is never treated as retirable.

## 11. Close out

Record the failure code, TiboTattle version and source commit, the preserved
file names and digests, the audit output, the rehearsal comparison, the actions
taken and the remaining gaps. Keep home paths, usernames, account identities and
private evidence out of public issues. If the cause was a mismatch between the
documentation and the code, update
[the store schema reference](../reference/local-index-schema.md), the relevant
tests and this runbook in the same change.
