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

For the brand/identity transition, the owner-approved
[2026-10-25 scope](../decisions/2026-10-25-usage-only-state-cutover.md) is
usage computation/history continuity only, not whole-profile migration. X,
background, generic Chromium, diagnostics and unrelated retired sharing state
stay untouched at the source. Their migration, reference closure, decryption
or helper-registry rebinding is not a usage-cutover gate. This does not delete
those files or remove X from the product. The broad ownership-review helper in
section 12 is optional bookkeeping, not a required selector or readiness gate
for this narrower bundle.

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
- open a store whose `user_version` is above 9 with a build that does not know
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
| Installed app state root | `%APPDATA%\UsageMonitor\profiles\stable\companion-state` | Stable neutral Electron profile plus `companion-state`; independent of the display name. |
| Standalone CLI state root | `%LOCALAPPDATA%\app-usagemonitor` | Standalone CLI/developer default. Read-only usage explanation selects an existing stable installed store first. `USAGE_MONITOR_STATE_ROOT` is authoritative when explicitly set. |
| Store | `local-index-store-v1.sqlite`, with `-wal` and `-shm` while open | The store. |
| Device salt | `local-unified-index-device-salt-v1` | Same directory as the store. |
| Collector state | `local-collector-state-v1.sqlite` | Not index data, same root. |
| Retired v1 file | `local-unified-index-v1.sqlite` | Read only by the one-time ordinal seed and the retirement check. |
| Codex rollouts | `%CODEX_HOME%` or `%USERPROFILE%\.codex`, under `sessions` and `archived_sessions` | Source of truth. Never modify. |

Resolve the exact root from the failing runtime before touching files. Never
guess between installed, development/qualification and CLI roots. The stable
profile is `%APPDATA%\UsageMonitor\profiles\stable`; its Chromium `sessionData`
is the separate `chromium` child, not part of the index-only copy below.

A profile created under the former product name is preserved original state.
Only the independent, backed-up and validated one-time conversion package may
translate explicitly selected usage keys and activate the usage target. This recovery runbook does not
perform that conversion, enable a former-name compatibility lookup or prove
that real data has migrated. Do not rename an old profile directory into the
new location or merge it with a new profile.

## 2. Classify the symptom

| Code or observation | Meaning | First action |
| --- | --- | --- |
| `local_index_family_mismatch` | Wrong `application_id`, or an unsupported predecessor version. Not a store this build can open. | Preserve. Find where the file came from before anything else. Do not relabel. |
| `local_index_newer_version` | `user_version` above 9. Written by a newer build. | Install the newer compatible build. Do not open it with this build. |
| `local_index_file_invalid` | Not a single-link regular file, a symbolic link, or an unsafe directory. | Check ownership and links. Do not chmod, replace or recreate the file. |
| `local_index_unavailable` | The file cannot be opened or stat'ed. | Check that the file exists, is not locked by another process, and that the disk has space. |
| `local_index_journal_mode_refused` | WAL mode could not be set. | Confirm the store sits on a local volume. |
| `local_index_secret_unavailable`, `local_index_secret_invalid` | The device salt is missing, unreadable or malformed. | Stop. Read section 4 before running anything that writes. |
| `local_unified_index_publication_busy` | A refresh stopped at the write-ahead log hard limit, or a long reader is pinning the log. | Close other readers and retry. Committed facts are valid and resume from their cursor. |
| `local_unified_index_legacy_ordinals_unavailable` | The store has no sources and the retired v1 file named by the seed cannot be read. | Keep the v1 file. Read section 8 before any new store is built. |
| `local_unified_index_generation_invalid` | A refresh committed, but the companion could not describe the result. | Run the audit (section 6) and read `commit_log`. |
| Audit `consistent: false` | Derived tables disagree with the committed facts. | Preserve a copy. Do not patch in place (section 6). |
| Source `deferredTailBytes` diagnostic | The last JSONL line has not finished; committed prefix facts remain readable. | Wait for the original writer to complete the line, then refresh. Do not edit logs or clear the store. |
| Source `quarantine_code` set | One source's facts are withheld. This is a source problem, not a database fault. | Inspect `source_diagnostic` for that source. Retained facts stay. |

## 3. Freeze and preserve

1. Quit Rhetrion completely and confirm that no companion or refresh process
   remains (Task Manager). Do not kill a process that is publishing unless it is
   stuck; a normal shutdown keeps committed sources.
2. Create a new recovery directory inside the state root, for example
   `%APPDATA%\UsageMonitor\profiles\stable\companion-state\recovery-YYYYMMDD-HHMMSS`. It must not
   exist yet. Do not reuse another recovery directory.
3. Copy, without moving or editing the originals:
   - `local-index-store-v1.sqlite`, and `-wal` and `-shm` if they exist;
   - `local-unified-index-device-salt-v1`;
   - `local-collector-state-v1.sqlite`;
   - `local-unified-index-v1.sqlite` if it exists (for the retirement check).

   Copy the sidecars together with the main file. A copy of the main file alone
   is not a copy of the store while a non-empty `-wal` exists.
4. Record the Rhetrion version and source commit, the file sizes and mtimes,
   and SHA-256 digests (`Get-FileHash -Algorithm SHA256`). Keep the record in the
   recovery directory. Do not put paths, digests or account data into a public
   issue.

## 4. Check the device salt first

The salt anchors local join keys and retained historical export pseudonyms.
There is no current hosted delivery command; preserving identity remains required.

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

### Verify an explicit cold database pair

The private tool helper `verifyColdLocalStateBackup` in
`scripts/lib/profile-sqlite-backup.mjs` compares two explicitly supplied,
non-overlapping local roots. It accepts only the fixed current index database
(application ID `0x554d4932`, version 9) with its original device salt, or the
fixed collector database (application ID `0x554d4353`, physical version 1 and
`local-collector-state-v1` marker). It has no standalone command, profile
discovery, copy, conversion, activation or receipt-writing entrypoint. This is
not the verifier for a sidecar-bearing recovery snapshot from section 3, nor
for that section's nested recovery directory: these inputs require a separate
preservation/rehearsal path and must not be altered to make this helper accept.

The existing native frozen-source capability holds both databases, both index
salts and any present empty sidecars through immutable read-only SQLite close
and final revalidation. Backup files must independently pass protected,
owner-only child inspection. The source ACL is never repaired. Nonempty
`-wal`, `-shm` or `-journal`, unsafe links/ACLs, open write handles, missing or
mismatched salts, unknown identities/versions, byte differences and failed
checks refuse verification without modifying either root. Streaming SHA-256
uses 64 KiB reads and a 1 GiB per-database admission limit; salts retain their
32–256 byte limit. Cancellation is checked between streaming chunks and
SQLite statements; a running synchronous SQLite statement is not interruptible
through this helper. SQLite's `quick_check(1)`, foreign-key check and reviewed
fixed-table counts are checked in both copies, followed by final byte/stat and
absent-sidecar revalidation.

The result separates a **private** digest-bearing `report` from a content-free
`summary`. Retain the report only in protected local recovery storage; do not
log or upload it. The summary's scope is explicitly
`index_database_and_salt_only` or `collector_database_only`. Matching salts
prove equality with the explicitly selected source, not that the source salt
is historically correct. Counts and page checks do not establish rollup
correctness, collector semantic validity, whole-profile completeness or a
restart/restore gate. Frozen file handles are not whole-profile writer
exclusion; independent writer exclusion and exact profile ownership remain
prerequisites for a real backup orchestration. Evidence describes the held
pair at verification time, not continued immutability after handles release.

A SQLite close failure never releases frozen handles around an unconfirmed
connection. Unclosed connections and their file/root guards are pinned until
process exit, and further verification in that process is refused. Stop the
isolated verifier and reconcile before retrying; do not activate a target or
treat the failed invocation as a successful backup. No native general
production/path-walk qualification is added by this helper.

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
PRAGMA user_version;                         -- current: 9; retained predecessors keep their original version
SELECT key, value FROM meta
  WHERE key IN ('family', 'parser_version', 'rollup_basis');
  -- family: local-index-store
  -- current parser_version: local-index-rollout-typed-v3+unified-rollout-typed-v22
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
- **The original source ordinals.** Retained quota/export identifiers depend
  on `source.source_ordinal`. A new store assigns fresh ordinals and changes
  those identifiers; it cannot establish continuity with previous receipts.
  This product has no current re-upload command. The only seed in the code is
  the retired v1 file, read while the new store has no sources. A v2 store cannot
  seed another v2 store. Do not rebuild from empty without explicit owner
  authorization.

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
| Device salt | Anchors local joins and retained historical export pseudonyms. | Keep. Never regenerate. Back it up with the store. |
| `source.source_ordinal` values in the live store | Retained quota/export identifiers depend on them, and a rebuild cannot restore them. | Keep the store. |
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

## 11. Profile cutover journal boundary

For the current usage-only transition, any eventual journal binding and recovery
must refer to the exact usage bundle, not an entire profile snapshot. Restore
only its authorized targets while retaining new usage history; never overlay X,
browser or unrelated settings. The existing journal helpers do not yet select
that bundle or implement those physical actions.

The private tool helpers `scripts/lib/profile-cutover-state.mjs` and
`scripts/lib/profile-cutover-operation.mjs` implement only a closed journal
contract and its native-backed persistence. They are not a profile migration,
backup, conversion, activation or restore command, and no runtime selects them.
The existing Windows release-operation store supplies owner-only records,
exclusive SQLite locking and expected-identity atomic replacement. Its native
qualification limits remain unchanged; no ordinary Node write fallback exists.

Journal bindings include the operation, selected profile, source manifest,
source/backup/target root-identity digests, tool digest and candidate digest.
Only the same original preparation evidence can resume an operation. Unknown
schemas, omitted evidence, mismatched bindings, out-of-order acknowledgements,
and a changed retry are refused. An uncertain save blocks further advancement
until the journal is closed and reopened. An exact retry of the most recent
acknowledgement does not append a second step.
The content-free storage summary marks an uncertain save explicitly, and the
private journal getter refuses to expose a potentially stale tip in that state.

Recovery after activation requires acknowledgements for writer exclusion,
archiving and reading back the new target history, then restoration from the
bound original backup without dropping the archive reference. These are report
digest bindings, not validation of the reports themselves. The helpers neither
stop writers nor copy, alter, delete or activate profile data. A real orchestrator
still needs durable mutation intents, actual-resource reconciliation, verified
report contents and all physical backup/conversion/restart/restore gates before
using this journal for real cutover. Never automatically replay a physical action
because its completion acknowledgement is missing.

The hash chain detects inconsistent records, not an authorized writer or the
restoration of an earlier valid journal prefix. Independent retained evidence
and actual-state reconciliation are required. Store the journal only in protected
local recovery storage; log only its content-free summary. Synthetic tests and
native journal durability do not prove a real profile backup or restore.

## 12. Supplied profile-entry ownership review

This broader helper predates the usage-only scope decision. The table below
describes its ownership labels and the evidence it does **not** provide; it is
not the current migration work list. X/background/Chromium entries need no
migration investigation under the selected usage-only scope. Do not recursively
enumerate those trees merely to satisfy this helper's whole-profile labels.

`reviewProfileOwnership` in `scripts/lib/profile-ownership.mjs` is an in-memory
review contract for explicitly supplied relative entries under the current
`pinned_profile` layout. It does not select a profile, enumerate a directory,
read files, inspect ACLs, obtain locks, stop processes or persist a manifest.
It is not a legacy-layout detector. Do not invoke production repositories to
build its input: a nominal read can migrate a pointer or clean up pending
records. Any eventual enumerator must supply independent native handle-bound
completeness, identity and security evidence; ordinary `readdir` plus this
classifier is not that evidence.

The source-backed review boundaries are:

| Owner | Current composition / storage boundary | Outstanding review |
| --- | --- | --- |
| Index and salt | `localCompanionStatePaths` and the fixed cold-pair verifier | Exact source ownership, closed database plus original salt, fact and rollup checks |
| Collector | `localCompanionStatePaths` and `local-collector-state.js` | Cold bytes, checkpoint/record semantics and replay continuity |
| Companion and retained records | `localCompanionStatePaths`, `apps/local/server.js` and fixed retained continuity names | Snapshots, speed baselines, diagnostics, locks and saved opt-outs/identities stay preserved; unfamiliar legacy records require explicit review |
| Desktop settings | `desktop-runtime.js` and the individual settings backends | Closed format conversion and preference parity |
| Background | `desktop-background.js` | Pointer, import journal, picker preference, all referenced chunks and pending generations; no cleanup during inspection |
| X reader | `desktop-x-repository.js` under `desktop-settings/x-reader` | Cache pointer/chunks, pending generations, session registry, pending clear and checkpoints must reconcile without deleting any state |
| X sessions | `desktop-runtime.js` composes protected session stores under `desktop-settings/x-sessions` | Opaque encrypted browser trees, registry/checkpoint closure, physical cold reopen; no cookies or session contents enter this review |
| X import | `desktop-x-import.js` under `desktop-settings/x-import` | Helper bytes, native-host absolute path and both HKCU Chrome NativeMessagingHosts registry views need independent binding review; copying files does not re-register the helper |
| Chromium | `application-profile.js` pins `sessionData` to `chromium` | Opaque browser tree, explicit origin-bound preference conversion and encryption continuity |
| Timing | `apps/local/server.js` composes `inference-timing-v2` | Opaque retained tree until timing identity/content conversion is reviewed |
| Startup / X diagnostics | `desktop-startup-diagnostics.js` and `desktop-x-diagnostics.js` | Local record schemas and preservation; raw crash reports/dumps are not inspected or projected |

Inputs are closed, bounded to 8,192 entries, depth 32 and 2 MiB aggregate
UTF-8 path bytes, and require every non-root parent directory explicitly.
Traversal, alternate streams, reserved names, malformed trees and duplicate
case-folded names refuse with fixed content-free errors. This lexical checking
does not establish Windows canonical-path or alias safety. Known-name type
mismatches, reparse/other entries, sidecars and unknown names produce explicit
blockers rather than disappearing from the count. Dynamic chunk and session
patterns identify a subsystem only; they do not prove chunk ordinal coverage,
registry membership, reference closure, content validity or safe ownership.
Opaque trees likewise remain unverified; an unfamiliar descendant is not
automatically an authorized copy target.

The immutable result contains only total counts, fixed owner/review labels and
blockers: never supplied names, relative paths, session IDs, path digests or
file contents. Do not persist the raw input list as a derived artifact or print
it in errors. Every result is `blocked` with scope `supplied_entries_only`,
including an empty tree or a tree containing only known names. Omitted entries
are unknown, not evidence of absence. Native enumeration, security, writer
exclusion, reference/content checks, external bindings, backup and recovery
remain explicitly unverified and cannot be overridden by input flags.

Electron's single-instance control, the companion-instance lease, the X state
operation lock and per-file frozen reads are different boundaries; none alone
excludes all profile writers. For the usage-only scope, a real orchestrator must
exclude every process able to modify the selected usage bundle and prevent a
new writer throughout preservation and activation. Stopping the shell may stop
its owned X helper too, but X session continuity is not a usage acceptance gate. This contract
neither implements nor proves that exclusion. Credential Manager targets,
provider source folders, registry state, raw crash artifacts and any other
external resources remain outside its file input. They must not be discovered,
copied or rewritten implicitly from preference values.

## 13. Usage-only dependency selection

`selectUsageStateBundle` in `scripts/lib/usage-state-bundle.mjs` selects treatments
from caller-supplied entries relative to one explicit companion-state root.
It performs no filesystem access and does not invoke the broader ownership
helper or the fixed legacy continuity copier. Do not feed it a profile-wide
tree. Unknown entries inside the supplied usage boundary remain blockers;
omitted entries remain unobserved, never evidence of absence.

| Treatment | Selected dependency |
| --- | --- |
| Preserve unchanged bytes | Current index, original device salt, collector database and timestamped speed-mode baseline |
| Retain dated evidence | Authoritative-dashboard and work-usage snapshots; timing source-bound v6, the v5 producer's `model-performance-snapshot-<scope>.json`, and legacy saved snapshots |
| Timing conversion review | Primary `inference-timing-v2/source-<scope>/timing-experiment.sqlite` and sibling `inference-timing-tool-free-v1/source-<scope>/timing-experiment.sqlite`; existing unscoped measurements stay review-only too |
| Legacy preservation review | Retired index, `.current` pointer, immutable historical snapshots, legacy collector records/checkpoints/accounting caches and pending batch journals; no activation or replay |
| Cold sidecar review | Selected database WAL, SHM and rollback journals; these cannot be copied as ordinary closed files |
| Writer exclusion only | Companion, account-observation, collector and collector-migration lock names; never target payloads |

The Windows timing supplement is a **sibling**, not a child of the primary
timing root. Preserve both selected measurement dependencies. Source scopes,
correlation keys, digests, fingerprints, cursors, parser state, pending parser
replay and primary/supplement semantics still require explicit forward conversion
and comparison; selecting a filename establishes none of these. Compressed timing
decoding retains no separate on-disk transcript: its persisted checkpoints belong
to the stores. Unknown historical timing layouts or snapshot generations block
for exact preservation review rather than being discarded or guessed.

The fixed `overview-recovery-20261015` boundary is now explicitly reviewed as
opaque recovery evidence: `local-index-before-workload-v5.sqlite`, its `-wal`
and `-shm`, plus `private-acl-repair-v1.json`,
`private-acl-inheritance-v1.json` and `private-acl-backup-v1.json`. The reviewed
producer saved original descriptors and file identities in these three journals;
their `prepared` status is not proof that a historical ACL action completed.
All six files must be observed together. Missing files, additional children,
other dates and nested lookalikes block selection. Freeze and preserve every
byte, including original sidecars, without opening the archived database in
SQLite or replaying a journal. This does not relax cold-sidecar checks on live
index, collector or timing stores, apply old descriptors to new objects, or
reactivate the archived backend. Protected backup/readback must cover this
exact archive before physical cutover.

The qualification inspector admits historical timing schemas 4/5 only through
the explicit `includeHistoricalTiming: true` option with `timingIdentity:
"legacy"`. It requires the exact three-table/eight-source-column contract and
returns the unrecorded parser version explicitly; unknown tables/columns block.
The lack of a replay table is a property of this verified format, not inferred
missing evidence. This option establishes structural inspection only.
The isolated historical converter must reproduce every saved measurement,
offset and complete parser state under the pinned parser before creating a
new 12/13 store. Parser-version 18 is assigned only to that proven new checkpoint,
never to the old database. Changed model/speed semantics, altered evidence or
unreproducible pending state block conversion. No synthetic fixture proves
that all real historical rows will pass this check.

`USAGE_STATE_CONTROL_INPUTS` identifies two separate settings review inputs:
extract only `codexHomes`, `refreshPaused` and `refreshIntervalSeconds` from
`desktop-settings/desktop-settings-v1.json`, and review the last automatic detailed
timestamp and outstanding reservation in `automatic-refresh-cadence-v1.json`.
That review must prevent an interrupted detailed action from silently becoming a
new attempt. `prepareUsageStateControls` in `scripts/lib/usage-state-controls.mjs`
now projects explicitly decoded controls and cadence into current validated
in-memory target records. All unrelated target preferences originate in current
defaults. Missing pause/cadence evidence and unknown fields refuse; the helper
does not interpret legacy formats, save settings or start observation. Its
`privateTargets` include source paths/reservation identity and must not be logged.
Preserve configured root IDs, order and primary-root semantics; do not resolve or
scan provider paths from them. Unknown source schemas or missing pause evidence
must not fall back to an unpaused default. UI and unrelated preferences do not
enter the target record.

The immutable `privateSelection` contains transient private relative operands;
never print it, persist it as an unprotected manifest or treat it as an activation
list. Only `summary` is content-free: fixed actions, counts and blockers, without
paths, source scopes, digests or file contents. Results always remain `blocked`.
Known unrelated retained records are left untouched and never selected; X,
browser and UI trees are not enumerated. A companion inventory cannot prove
exact selected-source ownership/security, native completeness, exclusion of all
writers, account-observation identity, protected backup, semantic correctness,
durable pre-mutation intents, actual-state reconciliation or history-preserving
activation/recovery. Those remain independent gates before real-state access.

## 14. Pre-mutation usage intent and resource reconciliation

`openUsageCutoverIntent` in `scripts/lib/usage-cutover-intent.mjs` records a
durable intent for one selected usage action before mutation. It is separate
from the completion acknowledgement journal in section 11. Fixed actions cover
usage backup, copy conversion, activation, new-history archiving and restore;
none is physically executed by this helper. Bind the exact bundle selection,
source/target root identities, tool/candidate, preconditions and expected
before/after source, target and staging manifests. Non-restore targets must be
absent; restore additionally requires a preserved new-history archive binding.

Persistence reuses the reviewed native operation store with exclusive locking
and expected-identity atomic replacement. An uncertain save blocks further
reconciliation until reopening. Initialization recovery fills only the same
bound metadata; missing completion never authorizes or retries a physical action.

After any interruption, a separate native inspector must freshly inspect the
entire selected usage/staging boundary. Submit its verified observation and
report digest. Exact before-state is `unchanged`, exact planned after-state is
`applied`, and any partial draft, changed source or unexpected target is
`conflict`. Applied/conflict observations are sticky; exact retries write
nothing, while changed reconciliation is refused. Reopening a saved applied
record still requires fresh inspection before any action; a saved status is
historical evidence, not a current resource observation.

The helper compares **supplied** observations and binds report digests. It
does not authenticate a report, enumerate/inspect real bundle files, exclude
bundle writers, verify backups, check archive contents or perform activation.
Null manifests mean independently proven exact absence, never unavailable or
omitted evidence. Native synthetic interruption/readback tests do not qualify
an inspector for a real usage bundle. A complete production orchestrator still
needs that inspector, durable writer exclusion and the remaining gates in the
[cutover plan](../plans/2026-10-23-rhetrion-brand-identity-and-local-state-cutover.md).

## 15. Isolated selected-usage native qualification

`scripts/lib/usage-bundle-freeze.mjs` is a qualification-only caller, with no
real-state discovery or activation CLI. Its opaque adapter verifies a separately
built native binding, generated manifest and current source/binary hashes under
`.release-build/usage-freeze-native-v1`. General production/path-walk safety
remains disabled. These local receipts are integrity checks, not authenticated
release provenance.

Qualification journals explicitly load the same isolated binding through the
reviewed operation facade's `bindingPath`; the default product binding is not
replaced. Native replacement retries only an uncommitted rename after a
transient sharing/access rejection, at most eight attempts with bounded
backoff. Each retry rechecks the original destination identity and security
while holding the same flushed temporary file and parent. Persistent rejection
or uncertain replacement still fails closed. This does not retry a logical save,
replay a migration action or relax uncertain-persistence blocking.

The explicit source must be a direct child of the explicitly identity-bound
maintenance parent. The protected journal must already exist outside that
parent. Native physical root/ancestor comparisons precede journal writes.
Freeze the necessary parent, selected usage directories and selected files with
durable original-security/identity intents before each ACL mutation. Only
selected timing/private directories are descended; no X/browser/UI tree is
recursively inspected. Parent `DELETE_CHILD` protection is necessary: a deny on
the usage root alone does not prevent renaming it through a writable parent.
No ACE is inherited into unselected children.

Original source policy must contain only recognized current-owner allow ACEs;
inherited owner grants are preserved. Broad/foreign/service/capability grants,
source denies and unknown ACEs refuse without repair. Synthetic SQL fixtures
create product-format databases in a separate newly created private input root,
then use the reviewed native copier to prepare owner-only qualification inputs.
This does not qualify ordinary profile ACLs or authorize their repair.

The owner subsequently approved the narrow legacy-source exception described
in the [usage cutover decision](../decisions/2026-10-25-usage-only-state-cutover.md).
Select `preserve_legacy_usage_v1` explicitly, with the parent descriptor hash
returned by read-only `preflightUsageSourceAcl`. Existing SYSTEM/admin grants
and one consistent account-domain read/execute SID can be retained at the source;
no grant is added, removed or copied to the destination. The default remains
`owner_only`. Different readers, broader principals, reader writes or unknown
ACEs refuse. Preflight hashes/identities are private operands. Reopening binds
the same source policy and original descriptor hash; never substitute a policy
or rewrite an older journal version. Source files, writer exclusion and history
semantics still require their separate checks.

The owner subsequently deferred removal of two historical snapshot logon ACEs
and correction of the snapshot writer until after this migration. Explicit
`preserve_legacy_usage_snapshot_v1` adds only the fixed legacy/v6 snapshot JSON
files directly in the selected primary timing root. Native lease ancestry,
single-link identity and exact original descriptor bind one existing,
non-inheriting logon-session read/execute ACE per file. No databases, controls,
nested lookalikes, other filenames, session writes or multiple logon ACEs are
accepted by this exception. Its private SID is not an account observation.
Record and restore the original source permissions unchanged; create backup and
target files owner-only. Journal contract v4 binds the explicit policy and does
not rewrite older journals. The known ordinary snapshot writer can recreate
extra Windows default grants on later writes: its deferred correction remains
an open limitation, not evidence that target permissions stay owner-only after
application refresh. Permission cleanup is a separate later operation.

After a crash, the deny persists. Reopening binds the same operation nonce,
source/parent identities and original ACLs, then checks actual original/frozen
state. Acquisition is never replayed from a missing acknowledgement. Explicit
reacquisition is required before reading; explicit reverse permission restoration
is separate from data conversion or activation. Changed identities or ACLs
refuse. A persistent SQLite close failure pins all native resources until process
exit, including through GC, and blocks further verification/restoration in that
process. This is a selected-object barrier with live ancestor pins, not a volume
lock against privileged or hostile same-owner ACL/ancestor manipulation.

The `backup` operation requires a separate pre-created protected directory
skeleton and independent protected intent root. Default payload is the entire
selected usage bundle, including retained evidence and sidecars. The only other
fixed payload is `unchanged_bytes`, which leaves timing database/sidecar paths
absent for creation by the separate converter; there is no arbitrary exclusion
list. Copy uses native per-file exclusive creation, bounded buffers, flush and
readback. Native identities establish non-overlap before payload writes. A
reopened backup only hashes/inspects actual files; it never fills missing files,
overwrites conflicts, deletes drafts or authorizes activation. Partial results
are preserved, and missing previously acknowledged files refuse.

`inspectColdSqlite` requires the live barrier and verifies fixed index/collector
identities/versions/markers, page integrity, foreign keys and table counts.
Timing inspection explicitly selects old schemas 10/11 or current schemas 12/13,
validates metadata identity and per-source primary/supplement correlation keys,
and returns only reviewed measurement columns. SQL is immutable/read-only;
connections close before permission restoration, followed by full byte hashing.
Nonempty WAL/SHM refuses. A nonempty rollback journal is accepted only when its
whole 28-byte header is zero under the barrier, as used by committed PERSIST
journals; all bytes are preserved. Nonzero/short headers remain blocked, never
replayed. This distinction follows [SQLite's rollback-journal contract](https://www.sqlite.org/lockingv3.html#hot_journals).
The earlier cold-pair verifier retains its stricter empty-sidecar contract.

Private manifests/reports include paths, hashes and timing keying material and
must stay owner-private. Only the separate count/status summaries are loggable.
Passing synthetic tests proves neither the historical correctness of a selected
salt nor account-observation identity continuity. Real-source security/path
qualification, writer lifecycle/startup integration, exact real-operation
authorization, activation and new-history-preserving recovery remain gates.

`captureControls` adds only the explicitly identity-bound sibling
`desktop-settings` directory and the two reviewed settings/cadence input files
to the same durable barrier. They are excluded from every byte-copy manifest.
Only bounded transient source JSON is returned for the separate version-bound
decoder and usage-only target projection. Missing cadence/pause evidence is
never replaced with defaults. Reopening first reacquires all actual objects;
re-reading settled controls does not replay an ACL mutation. Other settings
files keep their ACLs and contents and can still be written normally.

## 16. Close out

Record the failure code, Rhetrion version and source commit, the preserved
file names and digests, the audit output, the rehearsal comparison, the actions
taken and the remaining gaps. Keep home paths, usernames, account identities and
private evidence out of public issues. If the cause was a mismatch between the
documentation and the code, update
[the store schema reference](../reference/local-index-schema.md), the relevant
tests and this runbook in the same change.
