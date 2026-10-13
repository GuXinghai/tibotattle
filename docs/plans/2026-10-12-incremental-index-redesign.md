---
title: Incremental index, refresh and reporting redesign
date: 2026-10-12
type: plan
status: closed
---

# Incremental index, refresh and reporting redesign

Status: revision 4, closed for Phases 0 to 2 on 2026-10-12. Phase 0 and Phase 1
are complete and Phase 2 is complete with the gaps recorded in section 13. Phase
3 (cutover and removal) is in progress in the working tree: the companion
composes the v2 store only, and the v1 code, tests and file are being removed.
The open items are listed at the end of section 13 and in section 14. Nothing
here is a release, installed-artifact or deployment claim.

Scope: Codex rollout ingest, the unified index, the replay-safe accounting
cache, and the full report (dashboard projection and work breakdown). Hosted
contribution, the Worker and the browser UI are out of scope except where a
boundary must be kept.

Claim boundary: all measurements come from one Windows 11 machine, source
checkout `cf94e9a8`, Node.js 22.21.1 (the packaged app uses Node 26.2.0), on
private copies of the development and installed profiles. They are single runs
with a warm OS file cache while the development app ran in the background. I/O
figures are bytes requested from the OS, not physical disk bytes. Nothing here
qualifies an installed or signed release.

## 0. Decisions and what changed since revision 1

Recorded decisions:

- **D1.** Option C (a live, in-place WAL store with source-owned facts and
  incremental aggregates) is the approved direction.
- **D2.** Legacy data is not preserved. The v1 index, its stage and snapshot
  files, the accounting cache and other obsolete derived data are discarded, and
  v2 is built only from the original Codex rollouts, which stay untouched. There
  is no migration, no compatibility reader and no rollback to v1.
- **D3.** Local paths and working directories may be stored in the owner-only
  local store. Nothing path-like leaves the machine; export, diagnostics, logs
  and crash reports keep their closed allowlists. Recorded in
  [the decision record](../decisions/2026-10-12-local-index-v2-and-local-paths.md),
  which also amends the root invariant, `SECURITY.md` and the privacy and
  schema references without changing the shipping v1 contract.
- **D4.** The v1 file is deleted under a receipt only when it holds no facts
  from rollout sources absent from disk; otherwise it is kept as an unread
  archive and the owner sees a content-free count.
- **D5.** Legacy accounting mode is removed, subject to the verified
  dependencies in section 11.

Changes in this revision, in the owner's six points:

| # | Issue | Resolution | Section |
| --- | --- | --- | --- |
| 1 | Boundary hashes miss in-place edits | Explicit consistency model, tiered detection, bounded verification, rescan fallback | 4 |
| 2 | Accounting fold unanalyzed | Analyzed: it is **not** an associative fold. Split into three layers | 5 |
| 3 | Rollback and post-cutover data | No rollback (D2). Recovery is rebuild from rollouts. The non-regenerable data is inventoried and protected | 7 |
| 4 | WAL size versus long readers | Measured. Bounded by reader lifetime, with back-pressure that cannot lose data | 8 |
| 5 | No-change refresh writes | Zero write transactions, testable | 9 |
| 6 | Aggregate equivalence | Decomposition argument, deviation register, executable gates | 6 |

Superseded from revision 1: the v1-for-one-release rollback phase, the claim
that accounting could be fed "rollups plus events after a cursor", and the
single "5 s accounting" target.

### 0.1 Phase 0 findings that changed the design

| Finding | Evidence | Design change |
| --- | --- | --- |
| The declared-speed ledger is **not** append-only or monotonic. A same-mode reading extends the newest window's `lastSeenAt` in place, so an event first seen as "unknown" can later resolve to a mode; the 64-window cap drops old windows; the file can be erased | `src/codex-speed-baseline.js:134-144, 277-302` (read directly) | Declared speed is **not** stored or keyed at ingest. It is resolved at read time from the ledger (section 6.1) |
| 46–49 % of events have an unobserved speed, so a per-event read-time resolution would defeat the rollup | Dev 120,672 of 259,078; installed 115,988 of 238,742 | The ledger has at most 64 windows, so at most 128 boundary instants. Rollup rows resolve whole; only buckets whose `[t_min, t_max]` straddles a boundary are read per event |
| All 259,078 event keys of the incrementally maintained index are reproduced by a cold rebuild with the same salt; 668 more exist only because Codex wrote new data meanwhile | Cold rebuild versus incremental dev copy, same salt | Hosted usage `eventId` continuity holds on this corpus (section 7.5) |
| 2,365 of 2,407 sources (98 %) get a different `source_ordinal` in a cold rebuild, and v11/v12 quota observation ids hash `source_ordinal` | Same comparison; `src/local-unified-contribution-attribution.js:200-210` | An ordinal map must be carried across the cutover, or all quota ids change once (section 7.5, decision needed) |
| At the present time the N4 cache-switch deviation is exactly zero on both profiles | Section 6.3 | N4 is quantified, not assumed |
| Legacy mode is selectable only through an undocumented environment variable, but two library defaults are still `legacy` and shared modules import legacy modules | Section 11 | Removal order fixed |

### 0.2 Phase 1 gates

| Gate | Status | Basis |
| --- | --- | --- |
| G1 decision record, D3 | Passed | The decision record and amended guidance |
| G2 speed-baseline mutability | Passed with a design change | Not append-only; read-time resolution (6.1) |
| G3 hosted contribution continuity | Passed by owner decision: Option A | `eventId` reproduces; v11/v12 quota ids depend on `source_ordinal`, so the ordinal map is carried at cutover (7.5) |
| G4 removal dependencies | Passed | Section 11 |
| G5 N4 quantified | Passed | Section 6.3 |
| G6 WAL back-pressure limitations explicit | Passed | Section 8.4 |
| G7 generator and harness with baseline | Passed | Section 2.3 |

Phase 1 is authorized. Phase 1 exit adds four owner conditions, recorded as
gates on cutover (Phase 3), not on Phase 1 start:

| Gate | Condition | Evidence |
| --- | --- | --- |
| C1 | A change to the speed-baseline windows invalidates exactly the affected pricing and aggregation results | Ledger fingerprint is an input of every memoized read result; boundary-bucket test (6.1) |
| C2 | Hosted continuity verified end to end before cutover: typed-v1 sequencing (including a record moving to an earlier sequence), device binding, incremental sync | Continuity test (7.5) run against the fake service and the real engine |
| C3 | The hard WAL limit is fixed only after the rollout rotation rate is measured | Rotation measurement (8.4) |
| C4 | Legacy accounting removal follows the verified order | Section 11.2 |

Status of the cutover gates at closure (2026-10-12): C1 met in Phase 2. C2 met
for the v1.0 engine and at digest level for v1.1/v1.2; the v1.1/v1.2 engine run
is open. C3's limit is implemented and its rotation rate was measured on one
machine. C4 is in progress under Phase 3 gap (a).

## 1. Summary

Every detailed refresh that finds any new Codex output does work proportional
to the whole history three times: ingest (62–71 s, 5 GB read), the accounting
rebuild (184–223 s CPU) and the full report (40–190 s, up to 15.8 GB read). New
data is under 1 % of that work. Causes: whole-file publication, per-generation
bookkeeping, caches keyed by index generation, and no stored working
directories.

Recommended design: one live SQLite file in WAL mode. Each rollout source owns
its facts and advances in one transaction. Aggregates are maintained by
triggers in the same transaction. Working directories are stored at ingest. The
report reads about 10–15 thousand aggregate rows instead of 259 thousand events
and reads no rollout bytes.

Not everything the accounting cache computes can be incremental. Its period and
timeline totals can; its calibration and forecasts are global statistics. They
are recomputed from compact stored inputs, off the critical path, with
content-addressed memoization per reset window.

## 2. Measured evidence

Dataset: 2,406–2,411 rollout files, 12.9 GB, 259k usage events over 323 days,
373k quota occurrences, 264k tool facts. Dev index 477–505 MB.

### 2.1 Baseline costs (from revision 1)

| Operation | Wall | CPU | Read | Write |
| --- | --- | --- | --- | --- |
| Rollout discovery alone | 7.6 s | 10.2 s | 2.43 GB | 0 |
| Ingest, 0.4–34 MB new | 62–71 s | 55–57 s | 5.1 GB | 0.93–0.97 GB |
| Accounting rebuild (in-process) | 184 s (223 s profiled) | 179–231 s | 0.95 GB | 9 MB |
| Report, no work breakdown | 40–50 s | 41–49 s | 0.18 GB | 34 MB |
| Report + work breakdown, new process | 164–190 s | 150–184 s | 15.8 GB | 34 MB |
| Cold full rebuild, 6 lanes | 123 s | 265 s | 25.5 GB | 1.45 GB |

### 2.2 New measurements for this revision

| Question | Measurement |
| --- | --- |
| Do indexed sources vanish from disk? | **No, on this machine.** Dev index: 2,407 sources, 0 absent from disk, 259,078 events. Installed profile: 2,118 sources, 0 absent, 238,742 events. Discarding v1 loses nothing here. |
| What in the collector state cannot be regenerated? | `records` of kind `codex_quota_snapshot` (59 dev, 292 installed rows, span days), `checkpoint`, `legacy_migration`. `accounting_cache` (9 MB) is a pure cache. |
| How large would aggregates be? | 6,016 fifteen-minute buckets; 8,714 rows by (bucket, model, tier, surface, account); 12,634 with a context band; 786 day rows; 67,633 one-minute rows; 2,287 sessions; 87,954 events in the last 30 days. |
| What dominates the accounting rebuild (profile)? | Per-event streaming and projection 82 s inclusive; SQL row scan wrapper 78 s; per-event pricing 33 s; speed-family string classification 13 s; weekly calibration 8.5 s; calibration corpus open 9.9 s; transition miner 4.4 s. Inclusive times overlap. |
| Cost of hashing for verification | Read-only 3–7 GB/s (warm); SHA-1 2.0 GB/s; SHA-256 650 MB/s; BLAKE2b 236 MB/s. Whole 13.8 GB corpus: about 21 s CPU at SHA-256, warm cache. |
| WAL growth with a pinned reader | Synthetic 26 MB database, 288 refreshes: 100 rows/refresh gives 53 MB (0.18 MB/refresh, 2 ms commits); 400 rows gives 200 MB; 2,000 rows gives 1.57 GB, worst commit 341 ms. A `TRUNCATE` checkpoint reports busy while pinned and shrinks the WAL to 0 after release. |
| Cost of trigger-maintained rollups | 260k inserts: 5.7 s with triggers versus 1.4 s plus a bulk `GROUP BY`. Deleting one source: 160 ms versus 33 ms. Triggers add about 16 µs per row. |
| Backup copy cost | `VACUUM INTO` of 505 MB took 37.5 s (not usable). A plain file copy took 1.3 s for 477 MB. |

### 2.3 Synthetic baseline of the shipping v1 store (Phase 0 harness)

Recorded by `scripts/benchmark-local-unified-index-refresh.mjs` on a corpus from
`src/synthetic-codex-rollout-corpus.js` (seed 1, 2,400 files, 259,000 events,
323 days, 2 KiB of filler per event, 725 MB of rollout bytes), Windows 11,
Node.js 22.21.1, with the development app running in the background. One run
with two refresh cycles; each append cycle adds 3 events to each of 8 sources.

| Phase | Wall | CPU | Read | Write | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| Cold build, 6 lanes | 97 s | 138 s | 2.7 GB | 1.3 GB | 999 MB |
| No-change refresh | 4.2–5.1 s | 7.0–7.3 s | 260 MB | 0 | 635 MB |
| Append refresh (24 events) | 29.3–29.4 s | 30.8–31.1 s | 1.76–1.79 GB | 453–469 MB | 687 MB |
| Report, no work breakdown | 55.8 s | 58.0 s | 381 MB | 43 MB | 660 MB |
| Report + work breakdown, cold cache | 59.8 s | 64.3 s | 1.36 GB | 43 MB | 698 MB |
| Report + work breakdown, warm cache | 81.5 s | 86.6 s | 635 MB | 43 MB | 1.32 GB |

The index is 356 MB. Two features of this baseline matter for acceptance:

- **A no-change refresh costs 4–5 s, 260 MB of reads and 7 s of CPU** even
  though nothing changed: discovery's per-file head reads and the preflight.
  The v2 target (section 9) is at most 1 s, 5 MB and zero writes.
- **Appending 24 events costs about 30 s.** The work is the whole-file copy,
  `quick_check` and restamping, not the 24 events.

The warm work-breakdown report was slower than the cold one in this run. It is
a single run on a shared machine and the cause was not investigated, so the
private-corpus figures in 2.1 remain the reference for the work breakdown.

### 2.4 Phase 1 measurements of the v2 store

All figures are counts and timings only. The machine's speed varied by about
3x between runs today (the same generator took 43 s and 127 s), so absolute
times are comparable only inside one table.

**Real Codex home** (2,461 rollouts, 13.3 GB, 261,000 events; the corpus
changed during the runs because Codex was in use):

| Measure | v1 rebuild | v2 cold build |
| --- | --- | --- |
| Wall / CPU | 118 s / 282 s | 99 s / 288 s |
| Index size | 374 MB | 154 MB |
| Peak RSS (6 lanes) | not recorded | 543 MB |
| Peak write-ahead log | not applicable | 4 MB |
| Facts only in v1 | | 0 |
| Facts only in v2 | | 4 events, 5 tool facts, 4 quota occurrences, 3 snapshots, from 2 sources that grew between the runs |
| Facts that differ | | 0 of 261,087 |

A no-change refresh over the real home took 0.9–1.0 s warm; 6 s immediately
after the 13 GB cold build, while the file-metadata cache was cold. 2,460 of
2,462 sources were served from the inspection cache; the two misses were files
Codex was writing.

**Cold-build memory.** The 1.3 GB peak in the first synthetic run was the
harness: it generates the corpus in the same process and the generator keeps
about 350 MB of heap. In a fresh process the cold build of the same corpus
peaks at 458 MB with 3 workers and 528 MB with 6, the main thread's heap
returns to its 16 MB baseline after a collection, and nothing grows with the
number of events. The harness now records `rssStartBytes` so the baseline is
visible.

**File identity.** Section 4.6. Sample of 400,000 files under the profile:
112,061 ids at or above 2^53, 72,901 not exactly representable as doubles,
1,036 distinct files sharing a device and a double, highest sequence 7,528, none
at or above 2^63. Within the Codex home (2,453 files): 1,265 and 971 and 0.
The real v2 store holds 2,462 distinct exact ids, 1,269 of them at or above
2^53, and no two round to the same double.

**Extra I/O of a no-change refresh.** No rollout bytes are read (0 handle
reads); the process reads the catalog and runtime only.

## 3. Why the old design repeats work

Unchanged from revision 1, in short:

- **Work breakdown** re-reads every rollout up to its indexed offset because the
  index stores no working directories. Its cache lives in process memory and is
  keyed by file size, so a file that grew is re-read from byte 0.
- **Discovery** reads about 1 MiB from the head of every rollout on every pass
  (2.4 GB) although an append-only header never changes.
- **An "incremental" pass** copies the whole index, `quick_check`s it, fsyncs
  twice, restamps every tool fact with the new generation id, and appends a full
  per-source bookkeeping set. The installed index holds 94 generations, 4.26M
  diagnostic rows and 673 MB for 239k events; a fresh build of the same data is
  smaller.
- **Every cache** is keyed to the index generation, so any change invalidates all
  derived results, including the 184 s accounting rebuild.

## 4. Consistency model for source files (issue 1)

### 4.1 Assumptions and claim

- **A1.** Codex appends whole lines. A partial trailing line may be observed and
  is never consumed: the cursor stops after the last newline.
- **A2.** Any write updates the file's change time (NTFS `ChangeTime`, POSIX
  `ctime`). Ordinary APIs cannot set it, so a modification that preserves
  size, mtime and ctime together requires privileged or clock manipulation.
- **A3.** A replaced file has a different file identity or birth time.

Claim: after any refresh, v2 equals a cold build of the rollouts on disk,
except for sources in the *deferred* states below. Their divergence is bounded
by the verification interval, and the store exposes the oldest unverified
growth as a diagnostic, so an unknown is never reported as verified.

### 4.2 Stored per source

Exact file id (`file_id`, decimal "device:inode" as text; see 4.6), birth
time, size, mtime, ctime, `scanned_bytes`, a head digest (first 4 KiB), a
boundary digest (the 4 KiB before `scanned_bytes`), an open-tail digest (the
scanned bytes after the last complete segment, under one segment) and a SHA-256
digest per complete 256 KiB aligned segment. Segment digests are computed from
bytes already being read at ingest, so they cost no extra I/O. Segments are
256 KiB, not 4 MiB, because the open tail must stay small enough to re-hash on
every resume: the fuzz test found that an edit inside the newest segment was
invisible to head and boundary windows alone. `verified_bytes` records how
much of the file the last full verification covered.

### 4.3 Detection

| Event | Detected by | When | Action |
| --- | --- | --- | --- |
| Append only | size grew, head, boundary and open-tail digests match | every refresh | resume from `scanned_bytes` |
| Truncate or shrink | size below `scanned_bytes` | every refresh | rescan source |
| Replacement | exact file id or birth time differs | every refresh | rescan source |
| Move to `archived_sessions` | same file id, new path and ctime | every refresh | rescan once; identity and ordinal kept (the rollout name is the key) |
| Compression to `.zst` | new file, same rollout name | every refresh | rescan; facts unchanged (tested) |
| Same-size edit | mtime or ctime changed at equal size | every refresh | rescan source |
| Edit in the head, boundary or open-tail window, or rewrite then regrow | digest mismatch | every refresh | rescan source |
| Mid-file edit **plus** growth | segment digest mismatch | deferred verification | rescan source |
| Edit preserving size, mtime and ctime | not detectable under A2 | manual full verify only | rescan source |
| Compressed source (`.zst`) changed | any stat change | every refresh | rescan source (full) |

Deferred verification: a source whose size grew since its last verification is
re-read and its complete segments compared once the stat tuple has been stable
for two refresh intervals (at least 10 minutes), at most once per 24 hours, and
unconditionally after 7 days even if still active. Reading cost is the file
size per verification, so the whole corpus is read about once, then only
newly settled sessions. The manual "verify history" diagnostic action reads
every byte once (13.8 GB, about 21 s of SHA-256 CPU warm) and is the only way
to find the undetectable row.

### 4.3.1 Discovery-rejected and vanished sources

A source that discovery later rejects (for example a lineage that no longer
resolves) keeps its catalog row and ordinal but loses its facts, and records
the quarantine code, so a rejected source can never leave stale facts behind.
A source that vanishes from disk is marked `absent` and keeps its facts.

### 4.4 Fallback: source rescan

A rescan deletes the source's facts (triggers adjust aggregates), re-derives
from byte 0 and commits in one transaction, so readers see the old or new
state, never a mix. Worst case cost equals the source size. A crash before
commit leaves the previous state, and the next pass repeats the work.

### 4.5 Evidence required

Fuzz: random append, truncate, rotate, same-size edit, boundary edit,
mid-file edit plus growth, and kills at random points, each followed by a
verification pass. After it, the facts and aggregates must equal a cold rebuild.
A separate test demonstrates, by design, that a size/mtime/ctime-preserving
edit is found only by the manual verification action.

### 4.6 File identity (Phase 1 finding)

Node returns `dev` and `ino` as doubles unless asked for BigInt. NTFS file
ids are 64 bits: a 48-bit record number and a 16-bit sequence that increments
whenever a record is reused. A sequence of 32 or more puts the id above 2^53,
where doubles are spaced two or more apart, so adjacent records collapse to one
value. Measured on this machine (counts only, section 2.4): 28 % of all files
under the profile, and 52 % of the rollouts, have ids at or above 2^53; 18 %
and 40 % are not exactly representable; 1,036 pairs of distinct files in the
profile sample share a device and a double.

Consequences found in the code:

- the shared source check (`rollout-source-snapshot.js`, `log-sources.js`)
  compares `dev` and `ino` only when they are safe integers, so for ids at or
  above 2^53 it silently does nothing and relies on birth time, size, mtime and
  ctime. NTFS tunneling can preserve the birth time across a replace by rename,
  and a replacement is usually the adjacent MFT record, which is exactly the
  pair that collides;
- the v1 physical identity token stringifies the same doubles;
- the first v2 draft stored doubles, so it inherited the same ambiguity.

Resolution in v2 (v1 behaviour is unchanged):

- the catalog stores `file_id` as exact text; zero and unavailable ids are
  `NULL` and never match, so such a source is rescanned rather than assumed;
- ids that doubles hold exactly (below 2^53) are formatted without a second
  call; the rest are read once more with BigInt precision and accepted only if
  they round to the id discovery saw. The cost on the real corpus was 75 ms
  per refresh for 1,272 ids;
- opening a source for reading compares the exact id on the descriptor and on
  the path, before the scan and again at verification (an additive check in
  `rollout-source-snapshot.js`, active only when the caller supplies an exact
  id for a double that is not a safe integer);
- an inspection-cache hit made through a rounded inode is re-checked exactly,
  and discovery is repeated without that entry on a mismatch.

Tests: ids that differ only in the low bit are distinguished; an id that
changed or cannot be read yields no identity; opening with a wrong exact id is
refused while the legacy check still passes
(`test/local-index-file-identity.test.js`).

## 5. Accounting fold analysis (issue 2)

### 5.1 Finding

The replay-safe accounting cache is **not** an order-independent fold over
events. It holds three kinds of output with different algebra.

| Layer | Outputs | Algebra | v2 treatment |
| --- | --- | --- | --- |
| A. Additive | period totals, `byModel`, dimension maps, price-card breakdown, speed cells, 15-minute timelines | sums, counts, min/max, set union | rollups, read at report time |
| B. Ordered | quota series and its 10k-row downsampling, plan-era index, usage-interval predecessor, quota run collapse | depend on per-track or per-session order | persisted per-track and per-session state, read-time sampling |
| C. Global statistics | transition mining, composition NNLS fit, weekly calibration, allowance capacity, pace forecast | depend on windows of data and global fits | recomputed from compact inputs, memoized per reset window |

### 5.2 Blockers found and their resolution

| Blocker (source: static reading) | Resolution |
| --- | --- |
| Float sums at dimension, `byModel`, timeline and speed-cell level are fold-order dependent; period totals are exact BigInt | Accumulate exact integers everywhere; round once at output (deviation N1) |
| Retroactive plan eras: a later quota observation can reclassify old events | Eras are computed at read time from the persisted quota series, never stored with events |
| Usage-interval predecessor shifts when an event is deleted or inserted | Per-session predecessor and interval rows are facts owned by the source; a rescan rewrites them in the same transaction |
| Transition miner uses last-of-run predecessor, prefix sums from a window start, first-seen dedupe | Layer C: inputs are compact per-window series; each reset window is a pure function of its inputs |
| Global NNLS and bin voiding, quota downsampling, pace forecast | Layer C or read-time sampling over the persisted series |
| Time-relative cutoffs: `endMs`, 14-day mix, 30-minute reuse age | Evaluated at read time from rollups; staleness disappears (deviation N2) |
| Declared speed baselines are mutable (windows extend in place, cap at 64, can be erased) and are not fingerprinted in the cache | Resolved at read time from the ledger, never stored per event; rows straddling a window boundary are read per event (6.1). The ledger is retained (section 7) |
| Price registry change makes the whole cache unreadable | Aggregates carry a basis fingerprint; a mismatch rebuilds aggregates from stored facts, with no rollout reads |
| Tie order differs between SQL and calibration paths; `source_ordinal` depends on discovery order | One total order: `(observed_at_ms, source_local, source_offset, event_key)`; `source_ordinal` is not an output (deviation N6) |

### 5.3 Where the 184–223 s goes

About 160 s is per-event streaming, attribution, pricing and speed-family
classification, which Layer A removes (about 20× fewer rows, each priced once).
About 30 s is calibration and statistics (Layer C): weekly calibration, miner,
corpus open, rate-limit snapshots. Layer C is not made incremental by algebra.
It is made cheap in three steps:

1. **Lean inputs.** One SQL query returns only the columns it needs, with
   stored per-event `cost_nano` and interval ids, replacing the 78 s row
   wrapper.
2. **Content-addressed memoization.** Each reset window's fit is keyed by a
   digest of its inputs plus the policy-constant version. Only windows touched
   by new or changed data are recomputed; the open window is always recomputed.
3. **Off the critical path.** A worker computes it after commit; the report shows
   Layer A immediately and Layer C with its `commit_seq` ("as of").

Target, to be validated by a Phase 2 prototype before the design is final:
Layer C at most 30 s CPU cold, at most 5 s with memoization, in a worker. If the
prototype misses that, Layer C stays as is and only Layer A changes, which still
removes about 70 % of the cost.

## 6. Equivalence of aggregates (issue 6)

"Proof" here means a decomposition argument whose lemmas are executable
gates. Nothing below is mechanically verified until its gate passes.

### 6.1 Decomposition

For a period P with window `[s_P, now + 5 min]` (both ends inclusive, as in the
current source), every additive output is `Σ φ(e)` over events in the window.
v2 groups events by a key `k`. The decomposition is exact if:

1. **Key completeness.** `φ(e)` depends on `e` only through `k` and its token
   counts. The key must contain: 15-minute bucket, model, tier (service tier and
   *observed* speed), surface, account scope, context band, record shape
   (combined versus split output), and the lineage disposition. The declared
   speed is deliberately **not** in the key (Phase 0, section 0.1): at read
   time the ledger's windows (at most 64, so at most 128 boundary instants)
   classify each row whose observed speed is unknown. A row whose
   `[t_min, t_max]` lies inside one window, or outside all of them, resolves as
   a whole. A row straddling a boundary is split by reading its events, so the
   result equals the current per-event resolution. At most 128 buckets are read
   per event.
   *Gate:* a generated property test perturbs every non-key column of an event
   and asserts the projection is unchanged; the key list is derived from the
   field-access list of the projection functions, not written by hand.
2. **Linearity.** Pricing a rollup row equals the sum of pricing its events.
   The cost library truncates each component at 18 decimal places and the
   pricer enforces at most 9 decimal places on unit prices, with integer token
   quantities. Linearity therefore holds if no component reaches the 18-place
   truncation; this is an inference from reading the code, not a proven fact.
   *Gate:* for every price card, random quantities, assert row pricing equals
   the canonical sum of per-event prices, including the single-addend case,
   which returns the event's price string verbatim. If any card fails, rows for
   that model are priced per event.
3. **Edges.** Whole 15-minute buckets are summed from rollups; the partial
   buckets at the period start and at the future cutoff are read from events
   through the `observed_at` index. 86,400,000 is divisible by 900,000, so a
   bucket never straddles a UTC date and price effective dates stay inside one
   bucket. *Gate:* boundary tests at ±1 ms around every period start, the
   cutoff, bucket edges, UTC midnight and each price-card effective date.
4. **Min/max/distinct.** Carried as columns `t_min`, `t_max` and set unions.

### 6.2 Quota observations

- Canonical observations keep their upsert rule: key `(observed_at_ms, limit_id,
  slot)`, higher `used_percent` wins.
- The per-track series applies the same filter, same-millisecond tie-break and
  validity filter as the current reader, **in the same order** (filter then
  dedupe), so winners are identical. The tie-break comment and the upsert rule
  disagree today for same-millisecond different-slot readings; v2 keeps the
  code's behavior, and a fixture pins it.
- Sampling (at most 10,000 points, per-track budgets by ascending track size,
  index `round(i·last/(max−1))`) is recomputed at read time over the full
  persisted series. It is not incremental on purpose: adding one reading can
  shift sampled points in its own track and reassign budgets across tracks.
  Reading the series is a C-speed scan (about 0.1 s for 357k rows).
- `quotaObservations` remains an unfiltered count.
- *Gate:* random insertion orders and rescans produce output identical to the
  current sampler over the same set.

### 6.3 Cache-switch impact

Candidates are materialized per session at ingest, with premium nanos
precomputed from the same pricer. The current reader filters events to
`observed_at_ms <= now + 5 min` **before** pairing each event with its
predecessor by source offset, so a future-dated predecessor is dropped and the
pair re-formed. Materialized candidates would not re-pair. That difference is
N4.

**Quantification** (the pairing SQL of `readCacheImpacts`, run on private copies
of both profiles on 2026-10-12; counts only):

| Quantity | Dev profile | Installed profile |
| --- | --- | --- |
| Usage events | 259,078 | 238,742 |
| Events dated after `now + 5 min` | **0** | **0** |
| Events dated after the last index completion | 0 | 0 |
| Candidates, current reader at `now` | 20,748 | 19,665 |
| Candidates, materialize-then-filter at `now` | 20,748 | 19,665 |
| Candidates present in only one of the two | **0** | **0** |
| Ordering-gap sessions, current / materialized | 35 / 35 | 31 / 31 |
| Adjacent positive pairs whose timestamp regresses in offset order | 1,630 | 1,586 |
| Largest such regression | 12.96 days | 12.96 days |

So N4 is exactly zero on both corpora at the time a report is read. The
regressions show that offset order and time order really do differ, so the
deviation is reachable in principle, but it needs both a regression and a
predecessor dated more than five minutes ahead of the clock. Evaluating the same
queries *as of* earlier instants (a replay, which the product never does)
differs by up to 18 candidates and by whole gap sessions, because the sentinel
of a gap session sits at its latest event inside the window.

**Bound.** Each event dated after `now + 5 min` can change only its immediate
successor's pairing and its own session's coverage flag, so the number of
affected candidates is at most the number of such events, `F`. The effect on
the premium total is at most the sum of those candidates' premiums, and it
disappears once the clock passes the event.

**Resolution: make N4 zero by construction rather than tolerate it.** At read
time v2 finds the sessions that contain any event dated after `now + 5 min` with
an index seek (`F` rows) and recomputes only those sessions' candidates and gap
sentinels with the current pairing SQL restricted to the session. Gap sentinels
are computed at read time as the session's latest event at or before the limit.
Cost is proportional to `F`, which is 0 today. *Gate:* property tests with
injected future-dated and regressing events, and the differential run asserting
identical candidate and sentinel sets.

### 6.4 Deviation register

| ID | Difference | Direction | Gate |
| --- | --- | --- | --- |
| N1 | Float USD sums become exact integer sums, rounded once at 6 places | Equal except possibly one unit in the sixth decimal | Differential count on corpus; integer and string fields must match exactly |
| N2 | No 30-minute reuse staleness; periods are exact at read time | More accurate | Fixed-`now` comparisons |
| N3 | Plan eras always reflect all quota observations | Equal to a rebuild; fixes stale reuse | Differential after quota insert |
| N4 | Clock-skew predecessor case in cache-switch | None: exact per-session fallback; 0 affected on both corpora | 6.3 |
| N5 | `usageEvents` still counts zero-token rows that periods exclude | Preserved | Counter test |
| N6 | `source_ordinal` is no longer an output; one total order | Deterministic across rebuilds | Rebuild-twice equality |
| N7 | Equal-millisecond rows order by `(source id, offset[, slot order])` where v1 used insertion order | Deterministic; chosen winner of a same-millisecond quota conflict is unchanged on the corpora | Quota differential on a corpus with same-millisecond conflicts |
| N8 | Layer C byte accounting (`usageMetadataBytes`, `estimatedRetainedBytes`) differs: a v2 stamp holds a source id and an offset where v1 held a row id | Budget accounting only; no figure derives from it | Layer differential excludes exactly these two fields |
| N9 | v2 stores no per-event outcome; every contributed record carries `unknown`, and the parser label is rebuilt from event flags with the extractor's parser version | v1.0 digests and v1.1/v1.2 identities and evidence equal on the corpora; a future outcome needs a v2 column | Contribution differential and goldens |
| N10 | The work breakdown's project and worktree dictionaries list only directories carried by facts | Cells and their references are identical | Work differential compares referenced entries |

### 6.5 Differential harness

The v1 implementation at `cf94e9a8` runs once, in a pinned worktree, over (a) a
committed synthetic corpus at 1× and 5× scale and (b) the private corpus, where
only digests of outputs are recorded. Its outputs on the synthetic corpus are
committed as golden fixtures. v1 code is then deleted; v2 tests compare against
the goldens. No v1 code ships.

**Status (Phase 2).** The generator is `test/helpers/generate-local-index-goldens.mjs`;
the fixture is `test/fixtures/local-index-goldens/views.json` (about 0.7 MB,
synthetic, no paths) with a README stating provenance and the rule that it is
never regenerated from the successor. `test/local-index-goldens.test.js`
builds the store from the same corpus and a pinned device salt, then requires
the report at two clocks (with a declared-speed ledger), the work breakdown,
the calibration layer with and without the ledger, and the contribution day
digests and identities to match. Large cache-impact breakdowns are held as
digests; timeline money is held beside a digest of everything else so it can be
compared within N1. Alongside it, the live differential tests run v1 and v2
on the same corpora: `local-index-report`, `-calibration`, `-work-usage`,
`-contribution` and `-contribution-sync`. Both exist because the goldens
cannot be regenerated once v1 is removed, so a corpus the goldens do not reach
needs its own differential before then.

## 7. Recovery, retention and cutover (issue 3)

Rollback to v1 is not supported (D2). The question becomes what v2 can recover,
and what cannot be recovered from rollouts.

### 7.1 Recovery model

v2 cursors advance only inside the transaction that commits the facts they
cover. Any state can therefore be re-derived: dropping the file, or refusing a
commit, loses nothing that is still in a rollout. Cold rebuild takes about
2 minutes here (123 s measured for v1; v2 is expected to be similar).

### 7.2 Non-regenerable data (inventory, from code and the data above)

| Data | Why it cannot be rebuilt from rollouts | Handling |
| --- | --- | --- |
| Facts of rollouts that Codex has since rotated away | The only copy is the index | v2 never deletes by absence; a source missing from discovery keeps its rows and a status of `absent` |
| `codex_quota_snapshot` records in collector state | Captured from live app-server polls | Retained; v2 does not touch the file except to drop `accounting_cache` |
| `checkpoint`, `legacy_migration` in collector state | Capture markers and receipts | Retained |
| `codex-speed-baseline` readings | Timestamped reads of `config.toml`, rewritten on toggle | Retained; also a fingerprinted aggregate input |
| Activity markers, contribution queue, settings, reviews, prepared spool | Consent, acknowledgements, owner decisions | Retained, untouched |
| Device salt | Anchors every pseudonym | Retained; never regenerated (a missing salt blocks cutover) |

Discarded at cutover (derived or obsolete): the v1 index and its stage,
incremental, snapshot and pointer files; `meta.accounting_cache`; the
authoritative-dashboard snapshot; the work-usage snapshot; and the legacy
analysis and archive indexes if legacy mode is removed (section 11).

### 7.3 Cutover safeguard

Before deleting v1, the cutover compares v1's source set with what discovery
sees. If v1 holds facts for sources no longer on disk, the file is renamed and
retained as an unread archive, and the user sees a content-free count. If the
count is zero, which is true for both profiles measured on 2026-10-12, the file
is removed under a receipt naming the exact target. This honors the root
invariant on receipt-backed deletion without carrying a v1 reader.

**Resolved (decision D4, decision record item 3, 2026-10-12):** the conditional
deletion above is accepted. A v1 file with absent sources is retained as an
unread archive, and deleting it is a separate, receipt-backed owner action. No
code in this build performs that deletion; `assessLegacyIndexRetirement` reports
the counts only.

### 7.4 Backup of what cannot be regenerated

If, and only if, v2 holds `absent` sources, a daily copy of the checkpointed
file is kept (plain copy, about 1.3 s for 480 MB, run by the writer while idle).
Otherwise there is no backup, because the file is fully regenerable. Corruption
(`quick_check` failure) with no backup rebuilds from rollouts and reports the
absent history as unavailable, never as zero.

### 7.5 Identity continuity with hosted contribution

Phase 0 measured this directly: a cold rebuild from the same rollouts with the
same salt, compared with the incrementally maintained dev index.

| Identifier | Result | Wire use |
| --- | --- | --- |
| `event_key` (usage `eventId`, v1 and v11/v12) | All 259,078 reproduced; none missing | Yes |
| Quota occurrence identity inputs without the ordinal | All 374,287 reproduced | Input to v11/v12 observation ids |
| `session_local`, `source_local`, `snapshot_local` | Salt- and identity-derived; reproduced with the events | Join facts only |
| `source_ordinal` | **2,365 of 2,407 sources differ** (98 %) | **Hashed into v11/v12 quota observation ids** (`src/local-unified-contribution-attribution.js:200-210`) |
| Chunk `seq` | Positional in `ORDER BY observed_at_ms, event_key`; stable for an identical event set | Yes |

The 668 events found only by the cold rebuild are data Codex wrote after the
dev copy was taken, not a divergence.

Consequences, from static reading of the sync engine and the Worker (not run):

- The hosted store deduplicates on chunk identity and content digest per
  device, stream, day and sequence, with revision supersession, not on
  `eventId`. A re-upload of changed chunks converges without duplicates.
- Identical bytes upload nothing. Changed bytes supersede the changed chunks at
  the next revision.
- A rebuilt index changes the generation fingerprint, so v11/v12 progress is
  re-verified locally and only changed days re-upload.
- Nothing retracts records the rebuilt index no longer has.

**Decision (gate G3, owner, 2026-10-12): Option A.** If `source_ordinal` were
regenerated, every v11/v12 quota observation id would change once, and every day
with quota data would be re-uploaded and superseded. The owner chose to carry
the map. It is a narrow identity-metadata exception to D2, not a requirement to
preserve the v1 index architecture.

- **Option A, chosen: carry the ordinal map.** At the first v2 build,
  read `source_local -> source_ordinal` from v1 (about 2,400 rows, milliseconds),
  keep those values, and allocate new ordinals above the maximum, never
  reassigning. All hosted identifiers stay byte-identical and nothing
  re-uploads. The reader exists only in the cutover step and is deleted with
  v1; when v1 is absent or unreadable the device falls back to regeneration.
  This is a minimal exception to D2: identity-bearing metadata, not index data.
- **Option B, not chosen: drop the ordinal from the identity.** The observation id would be
  derived from `(source_local, source_offset, observed_at_ms, slot_order)`.
  Ids are stable from then on, but every existing quota chunk is re-uploaded
  once, and it changes a wire identity, which needs a telemetry-contract
  compatibility review.

**C2 results (Phase 2).** Hosted continuity was exercised at three levels.

- *Records and digests, against the shipping index on the same rollouts.* v1.0
  chunk and day digests equal v1's for every day (`local-index-contribution`,
  goldens). v1.1 records, per-record attribution and the v1.2 evidence equal
  v1's, including with captured account markers and plan eras (200 markers
  around real adjacent events, with contradicting twins). v1.1 day manifest
  digests are unchanged with the carried ordinal map and some day changes
  without it, so the carry is necessary, not decorative.
- *The real v1.0 sync engine with an ownership-aware fake service*
  (`local-index-contribution-sync`). A first sync lands, the store is deleted
  and rebuilt in reversed discovery order with the carried map: zero uploads,
  no record refused for ownership. An append supersedes only its own day.
- *Not run here: the v1.1/v1.2 engine.* Its device-capability fixture fails on
  this Windows machine at HEAD already (`contribution_device_state_unavailable`;
  POSIX mode bits), so that engine could not be driven. The engine compares one
  manifest digest per day, which is the level the second bullet verified, but
  C2 stays open for v1.1/v1.2 until `test/contribution-v11-local-sync.test.js`
  has a source built from the store and runs. The product is Windows-only
  (decision 2026-10-12), so the run belongs on a Windows host; that host must
  first get past the device-capability fixture failure.

The record-ownership stall (a record that moves to an earlier sequence is
refused by the service while its previous owner is still current) is a
property of the client and Worker protocol, not of the store. v2 produces the
same sequence positions as v1 for an identical event set, so it neither adds
nor removes the hazard.

**Continuity test (Phase 1 gate).** Synthetic rollouts over three days, a fixed
salt, a first sync against the fake service, then delete the index and rebuild
in reversed discovery order. Assert identical day digests, zero uploads, and no
duplicate `eventId` or `observationId` in the current view; then mutate
one event and assert only the shifted chunks take revision 2. Existing helpers:
`test/contribution-v1-chunks.test.js` (`withFixtureIndex`),
`test/contribution-v1-sync-engine.test.js` (`createFakeService`,
`engineOptions`) and `test/contribution-v11-local-sync.test.js`.

## 8. WAL size versus long-running readers (issue 4)

### 8.1 What the experiment shows

Growth under a pinned reader equals the pages written while it is pinned, at
about 1.8 KB per event row including indexes and rollup updates. At 100 events
per refresh this is 0.18 MB per refresh, so a reader pinned for a full day
(288 refreshes) costs 53 MB. A rescan transaction of a 20,000-row source
costs about 5 MB. The WAL never blocks a commit; it only delays reuse. After the
reader ends, `TRUNCATE` returns it to zero.

There is no hard byte cap in SQLite for a pinned WAL: `journal_size_limit`
applies only after a reset. A cap must therefore come from reader lifetime and
writer back-pressure.

### 8.2 Design

1. **Bounded readers.** All in-process readers use one `withReadSnapshot`
   helper. Reports read tens of thousands of rows, taking 1–2 s, instead of
   today's 40–190 s. Reader work runs in a worker with a 10 s deadline; at the
   deadline the worker is terminated, which releases its read mark.
2. **Checkpoints.** `PASSIVE` after each commit, `TRUNCATE` when no reader is
   pinned, `journal_size_limit` of 64 MiB, `wal_autocheckpoint` of 1,000 pages.
3. **Two thresholds (implemented).** A soft limit of 64 MiB reports
   `walPinned`; an unpinned bulk build peaked at 4.1 MB, so any log past it means
   a reader holds a snapshot. A hard limit of `min(1 GiB, 10 % of free disk)`
   (at least the soft limit) stops starting write transactions and the refresh
   returns `status: "deferred"`. The hard limit is twice the 456 MB measured
   for a bulk build under a reader pinned from the start (8.5). Because cursors
   advance only inside commits, the stopped work is re-derived from the
   rollouts later; section 8.4 states exactly what that does and does not
   guarantee.
4. **External readers** (a database browser, a backup tool) are unsupported
   readers. They are detected through the busy checkpoint and reported, not
   killed.
5. **Windows.** WAL needs shared memory and file locking on a local volume. A
   network-redirected profile is detected and fails with an explicit status.

### 8.3 Evidence required

A pinned-reader soak test: 288 refreshes at 100 and 400 events, with and
without a rescan, then release. It must show WAL size within 1.2× of the
pages written, no commit failure, `TRUNCATE` succeeding after release, and the
back-pressure path engaging at the limit with the backlog fully ingested after
release while the rollouts are unchanged.

### 8.4 Limitations of back-pressure, stated explicitly

1. **It defers; it does not free.** Stopping commits stops WAL growth. It
   cannot release a pinned WAL. Terminating readers covers only our own
   workers; an external reader keeps the pin until its owner closes it.
2. **It has one data-loss path.** Deferred facts exist only in the rollouts. If
   Codex deletes a rollout while ingestion is stopped, the unread part of it is
   lost to the index. This is the only way the design loses data that v1 would
   have kept. Its exposure is `stall duration × deletion rate`. Measured
   (8.5): a move to `archived_sessions` and a compression keep identity and
   facts (tested), so only deletion counts, and none was observed in the
   indexed history on this machine. The stall itself needs a reader pinned for
   days at steady state (about 0.27 MB of log per refresh), so the hard limit
   is set by disk and read latency, not by rotation.
3. **Visibility is stale, not wrong.** While stalled, reports read the last
   committed state and carry its age; no partially applied source is visible,
   because a source commits atomically. Quota polls are a separate store and
   continue. The backlog (bytes beyond the cursors, known from `stat`) is
   reported.
4. **Recovery is automatic and unattended.** Each refresh retries the
   checkpoint; the first one that succeeds ends the stall and ingests the
   backlog.
5. **Coalescing helps only at scale.** Measured WAL after 288 refreshes with
   the reader pinned throughout (synthetic, Node 22.21.1):

   | Events per refresh | Commit every 1 | every 6 | every 24 | every 96 |
   | --- | --- | --- | --- | --- |
   | 100 | 53.1 MB | 43.1 MB | 41.1 MB | 12.3 MB |
   | 400 | 200.0 MB | 187.4 MB | 55.1 MB | 21.8 MB |

   Hot rollup and index pages are rewritten once per commit, so only
   large batches (about two hours of refreshes) cut growth substantially. It
   reduces the growth rate; it is not a bound.
6. **A large rescan is a large transaction.** A 20,000-row source is about
   5 MB of WAL. Rebuilding all sources in place is bounded by the same
   limits. Only a corruption rebuild swaps the file, and on Windows that
   needs every reader closed. Our workers are closed and reopened at the
   swap; an external reader blocks it and is reported.
7. **The soft limit is a diagnostic, not a guarantee.** 64 MiB is reached
   after about 240 refreshes of 100 events with the reader pinned throughout
   (8.5), roughly a day; it exists to make the condition visible long before
   the hard limit.

### 8.5 Measured in Phase 1 (v2 store, Node 22.21.1)

| Question | Result |
| --- | --- |
| Peak log, cold build of 2,400 sources, no reader | 4.1 MB (store 140 MB) |
| Peak log, same build, reader pinned from the start | 456 MB, 3.3 times the store; the main file stays at 0.1 MB until release |
| Pinned reader, 288 refreshes of 100 events (4 sources) | log 77 MB (0.27 MB per refresh), no deferral; 0 after release and checkpoint |
| Pinned reader, 288 refreshes of 400 events | log 107 MB, no deferral; 0 after release |
| No reader, 288 refreshes of 100 events | log stays 0; every refresh checkpoints |
| Limit engaged (test, 256 KiB hard limit, pinned reader) | refresh returns `deferred`; after release the next refresh completes and equals a cold build, sequential and lanes |

Rollout lifecycle on the real Codex home (2,459 rollouts, 13.3 GB, counts
only): 2,384 active and 75 archived (3.0 %); none compressed; the oldest has
not been written for 323 days. Half of the archived files were last written
under 20 minutes before their last metadata change, so sessions are archived
soon after they end. A move does not change a source's identity because the
rollout name is the key and discovery reads both roots. The legacy index held
2,407 sources of which 0 were absent from disk (2.2). The observed deletion
rate is therefore zero over 323 days; that is an observation on one machine,
not a guarantee, and the exposure formula in 8.4 stays.

## 9. No-change refresh semantics (issue 5)

A no-change refresh is a pass whose discovery shows every source's stat tuple
equal to the catalog and no verification due. Its contract:

- **Zero write transactions.** The catalog lives in memory after startup (about
  2,400 rows); the walk compares `stat` results to it. No `BEGIN IMMEDIATE`,
  no WAL frame, no fsync, no change to the main file or the `-wal` file.
- **No header reads.** The 1 MiB lineage read happens only for a new source or
  one whose identity or head changed.
- **Freshness is in memory.** "Checked at" is process-local. The persistent
  `commit_seq` changes only when facts change, so the report cache and readers
  key off it and nothing else.
- **Other writers stay separate.** Verification progress, when it runs, is a
  deliberate write at most once per 24 h per source. The collector's
  app-server quota poll and the hourly dashboard snapshot are separate stores;
  the quota poll persists a record per observation and should be changed to
  write only on change (tracked, outside this index).

Gate: hash of the `.sqlite` and `.sqlite-wal` bytes and their mtimes are equal
before and after 100 consecutive no-change refreshes; the writer's counter of
write transactions is zero; discovery reads at most 5 MB.

Status (Phase 1): the zero-write and no-header-read halves pass in tests and on
the real corpus (0 write transactions, 0 handle reads). The catalog is loaded
from the store on every call, about 2,400 rows, so the "in memory after
startup" form needs the long-lived refresher that Phase 3 builds with the
companion; until then each call pays that load and the 1 s target is met warm
(0.9–1.0 s real, 1.2 s synthetic), not cold.

## 10. Recommended architecture (summary of section 7 of revision 1, updated)

### 10.1 Store

- **File:** `local-unified-index-v2.sqlite`, `journal_mode=WAL`,
  `synchronous=NORMAL` (atomic and consistent after a crash; the last commits
  can roll back together with their cursors).
- **Writer:** one, in a worker, serialized by `BEGIN IMMEDIATE`. Ingest no
  longer runs on the main thread on Windows.
- **Publication** is the commit. The stage copy, rename, pointer and snapshot
  cleanup are removed, including the snapshot publication from `71a17b46`.
- **Generations** become a monotonic `commit_seq` with a short summary row per
  refresh, keeping the last 100.

### 10.2 Facts

Usage events, quota occurrences, tool facts, lineage snapshots, diagnostics and
cache-switch candidates carry `source_id`. Resume inserts; rescan deletes and
reinserts. Stored once at ingest: working-directory context, context band,
resolved declared speed, record shape, and the previous positive event in the
session.

### 10.3 Aggregates

- **Rollups** by triggers on insert and delete of fact tables, so no code path
  can forget to maintain them. A property test asserts `rollup == GROUP BY
  facts` after random operation sequences. Cold build uses a bulk `GROUP BY`,
  incremental uses triggers (section 2.2).
- **`usage_rollup`:** key `(15-minute bucket, model, tier, surface, account
  scope, shape, context class)`, integer token sums, event count, `t_min`,
  `t_max`. `shape` is the null-pattern mask of the counters, the positive mask
  and a combined-versus-split conflict bit. The context class is the position
  among the registry's context thresholds (each boundary and boundary + 1), so
  no price is stored and a registry revision rebuilds the table only when a
  threshold moves (the basis is stored beside it).
- **Cursor-aware.** Every aggregate equals the grouping of the facts at or below
  each source's committed cursor (`source.scanned_bytes`); insert, delete,
  cursor-advance and cursor-retreat triggers keep that, so a lane build's
  provisional facts are never counted and no code path can forget a rollup.
  The writer open reconciles the basis; `audit*` functions recompute from
  facts and are the property tests' oracle.
- **`work_rollup`:** per UTC day, session, working directory (0 for unknown),
  model, account scope, shape and context class, with the three provenance bits
  (partial, cache write assumed zero, status only). `last_at_ms` is recomputed
  at read after a delete. Project names resolve at read time over the
  distinct working directories. Whole days come from the rollup and the edge
  days from facts.
- **Cache-switch candidates:** `cache_candidate` and `session_positive`, kept by
  triggers (`local-index-pairing.js`); the exact per-session SQL path is the
  oracle and the fallback for sessions with future-dated positive events (N4)
  and withholds multi-source sessions with the ordering-gap sentinel.
- **Quota series:** not a table. The covering index `quota_observation_series`
  serves the per-track scan and rank sampling at read time (6.2).
- **Basis:** only the registry's context thresholds. Prices, the model
  registry and the declared-speed ledger are applied at read time; the ledger
  is deliberately not a stored column (gate C1, `local-index-speed-ledger`).

### 10.4 Read path

SQL over rollups, edge buckets from events, one pricing call per row, in a
worker over its own read connection, in one read snapshot, keyed by
`commit_seq`. Layer C comes from its memo table.

## 11. Obsolete implementation to remove

Phase 0 traced the dependencies of legacy accounting mode (code reading, not
runtime). Removal happens in Phase 3 together with tests and docs; the
architecture check is the mechanical authority.

### 11.1 Legacy accounting mode: entry points

- **Selection:** the only switch is the undocumented environment variable
  `USAGE_MONITOR_ACCOUNTING_SOURCE_MODE` (`apps/local/server.js:3015`, default
  `unified`), forwarded by `apps/electron/companion-supervisor.js:78` and
  allowed in `apps/electron/desktop-runtime.js:114`. Production and
  qualification launchers already pin it to `unified`. No UI, CLI flag, API
  parameter, persisted setting or automatic fallback selects it.
- **Library defaults still `legacy`** (a caller that omits the option gets it):
  `src/local-companion-data.js:2315`, `src/local-companion-refresh.js:912`,
  `src/replay-safe-accounting-cache.js:578`.
- **CLI:** `collect-once --backfill` (`src/cli.js:213`) triggers the passive
  collector's rollout backfill and does not consult the mode. It needs its own
  decision (remove it, or re-point it at the v2 ingest).
- **API and UI:** the refresh result carries `archiveIndex`, `legacyRefreshUse`,
  the progress kind `archive_index` (`apps/web/public/app.js:11596-11601`) and
  the `recent_7d_*` indexing statuses; `accounting.sourceMode` coerces any
  non-unified value to `legacy` (`src/local-companion-refresh.js:1665-1669`).

### 11.2 Remove, in dependency order

1. Close selection: accept only `unified` in `configuredAccountingSourceMode`,
   drop the allow-list entries, make the three defaults `unified` or required.
2. Strip legacy branches from the refresh runner, the snapshot builder and the
   server (`src/local-companion-refresh.js:1043-1060, 1126-1132, 1259, 1352-1359,
   1459-1480, 1506, 1643-1645, 1667-1669`; `src/local-companion-data.js:2436-2452,
   2532, 2547-2548`; `apps/local/server.js:3320-3326, 3414-3428`).
3. Replay-safe cache: the direct legacy builder default (`:4377`), the legacy
   arms (`:5440-5454, :5497-5531`) and the rebuild child's legacy arm
   (`src/replay-safe-accounting-rebuild-child.js:104-159`); then the imports of
   `src/local-analysis-index.js` (`:16-18`, child `:9`). The import must be cut,
   not just the call, because the shared module imports it.
4. Passive collector: rollout backfill and `recent_7d`
   (`src/passive-collector.js:199-211, 342-360, 1743-1750, 1837-1846,
   2071-2072`).
5. Delete `src/local-analysis-index.js` and `src/local-archive-accounting-index.js`
   with their installer and state-composition entries, and the two legacy
   benchmark scripts.
6. Persisted legacy files last: `local-analysis-index-v2.sqlite` and
   `local-archive-accounting-index-v1.sqlite` with their secrets, under a
   receipt naming exact targets.
7. Vocabulary last: `recent_7d_*` statuses and `archive_index` progress. Keep
   `prospective`, `prospective_only` and the `rollout_index` phase string,
   which unified mode also uses.

### 11.3 Keep (shared with unified mode)

The quota-only collector path and `skipRolloutIngestion`, the collector-state
store and checkpoint, the speed-baseline ledger, `scanCodexLogEvents` (shared
raw scanner; only its legacy default and arm go), the unconditional legacy JSON
migration, `src/local-legacy-report-storage.js` (old report files, unrelated to
accounting), and tolerance for inherited `recent_7d_indexing` checkpoints.

### 11.4 Remove with the v2 cutover

- Unified index stage, snapshot, pointer and recovery-lock publication, the
  off-main ingest wrappers and the generation machinery.
- The work-usage rollout re-read, its metadata cache and its snapshot file.
- The replay-safe accounting cache's streaming build, its child-process
  isolation and its meta-row JSON persistence (Layer C logic is kept).
- `docs/runbooks/unified-index-recovery.md` and
  `docs/runbooks/2026-08-27-local-unified-index-recovery.md`, replaced by one
  rebuild runbook; the schema reference rewritten.

### 11.5 Unverified

Whether any consumer reads `collect-once --backfill` output under the unified
default; the `historyMode: "legacy"` values in discovery (probably unrelated);
the size of the test churn (a broad search matched 61 test files, an
overcount). These are Phase 3 inventory work, not gates.

## 12. Acceptance criteria

Corpora: this machine's copy (about 2,400 rollouts, 12.9 GB, 259k events) and
a committed synthetic generator at 1× and 5×. Timings are p95 over 20 runs from
a committed harness (Phase 0).

**Routine refresh** (10 MB or less appended): wall 3 s or less; CPU 3 s or
less; reads at most 50 MB plus twice the appended bytes; writes at most 20 MB
plus new rows; the 5× corpus within 1.5× of 1×.

**No-change refresh:** section 9 gate; wall 1 s or less.

**Full report** (all periods and the work breakdown): 2 s or less in a new
process; zero rollout bytes read; peak RSS 300 MB or less; 5× within 2× of 1×.

**Accounting:** Layer A within the report budget; Layer C at most 30 s CPU
cold and 5 s memoized, in a worker (to be confirmed by the Phase 2 prototype);
the report never waits for Layer C.

**Growth:** 100 no-change refreshes grow the store by 0 bytes. 100 routine
refreshes grow it in proportion to new facts, with no per-refresh bookkeeping.

**Correctness:**

- v2 facts equal a cold rebuild after any fuzz sequence (4.5).
- v2 projection equals the pinned v1 output: exact on integer and string
  fields, N1 tolerance on rounded USD; all deviations listed in 6.4 only.
- Rollup-priced equals event-priced for every price card (6.1).
- Boundary tests at ±1 ms (6.1) and quota sampling equality (6.2).
- Rebuild twice yields identical output (N6).

**Recovery and concurrency:**

- Kill at random points: no double count, no full rescan on restart.
- Reader in a worker spans 100 refreshes; every refresh commits; every read
  sees exactly one `commit_seq`; WAL soak (8.3).
- Cutover safeguard: v1 is deleted only with zero absent sources, otherwise
  retained with a count (7.3).

**Privacy:** negative tests prove no path or working directory appears in
export, diagnostics, logs or crash output (D3).

## 13. Phases

**Phase 0 – complete (2026-10-12).** Decision record and guidance amended
(D3). Speed-baseline mutability, hosted continuity, removal dependencies and
N4 verified or quantified. Synthetic corpus generator
(`src/synthetic-codex-rollout-corpus.js`) and benchmark harness
(`scripts/benchmark-local-unified-index-refresh.mjs`) added with tests;
baseline recorded in section 2.3. Gate status in section 0.2; all passed.

**Phase 1 – v2 store (authorized 2026-10-12).** Catalog, source-owned facts, the
section 4 consistency model, stored derived columns (working directory,
context band, record shape, previous event), cold build with the existing
parallel extraction lanes, ordinal carry (Option A), fuzz and crash
tests, the rollout-rotation rate measurement (8.4), and the continuity test.
v1 untouched.

**Phase 1 status (2026-10-12, working tree, not committed).** Built beside
v1, which is untouched except for additive changes to the shared extractor
(working-directory tracking) and discovery (an optional inspection cache).
Modules: `src/local-index-identity.js`, `local-index-store.js`,
`local-index-source-digest.js`, `local-index-refresh.js`,
`local-index-worker.js`, `local-index-cutover.js`. The store file is
`local-index-store-v1.sqlite` (renamed from the `local-unified-index-v2`
placeholder, which already names the shipping schema family).

- Passed: cold build equals the shipping rebuild fact for fact, sequentially
  and in lanes; resume equals a cold build; a no-change refresh opens no write
  transaction; discovery of an unchanged corpus makes no header reads; random
  append, truncate, edit, rotate mutations stay equal to a cold build; an
  aborted lane build leaves nothing visible and completes on retry; stored
  working directories equal the metadata traversal for every event; the carried
  ordinal map keeps every quota identity input byte-identical.
- Model changes found by the fuzz test: segments are 256 KiB, and an open-tail
  digest is verified on every resume, because an edit inside the newest
  segment was otherwise invisible. Discovery-rejected sources keep their
  catalog row and ordinal while their facts are removed. File ids exceed 2^53
  on NTFS and doubles are ambiguous there, so identity is the exact decimal
  id (4.6).
- Measured on the section 2.3 synthetic corpus, v1 and v2 back to back in one
  session (the machine was in its slow state, so absolute times are about 3x
  the earlier run): cold build 73 s against 95 s (CPU 126 s against 139 s);
  no-change refresh 3.6–3.7 s and 19 MB read against 4.7–4.8 s and 260 MB, zero
  writes; appending 24 events 3.7–3.9 s, 22 MB read and no measurable write
  against 33–34 s, 1.8 GB read and 453–466 MB written; index 138 MB against
  357 MB. In the fast state the same v2 phases took 22 s cold and 0.6–1.2 s for
  no-change and append, which meets the 1 s target; in the slow state the stat
  walk (3.3 s of the 3.6 s) is the machine, not I/O. In isolation, on a quiet
  machine, a cold build of the same corpus with 6 lanes took 36 s against 89 s
  and peaked at 558 MB against 463 MB: v2 uses about 20 % more memory
  (main-thread heap 246 MB at the peak, all of it collectable) and is 2.5
  times faster. These are not private-corpus figures; the real-corpus figures
  are in 2.4.
- **The 37 failures in the v1 regression run are pre-existing.** Running the
  four affected files (`codex-compressed-rollouts`,
  `local-unified-accounting-source`, `local-unified-index-off-main`,
  `local-unified-index-recovery`) on a clean export of HEAD `cf94e9a8` and on
  the working tree gave the same 116 tests, 72 passing, 37 failing, 2
  cancelled, 5 skipped, with identical failing names. Causes, from the failing
  assertions and the code they reach: (a) the recovery file (20 tests and their subtests) fails
  because `fsync` on a read-only handle is refused on Windows
  (`scripts/local-unified-index-recovery-core.mjs`), a cascade from the first
  prepare step; (b) POSIX mode bits are not meaningful on NTFS, where the
  production checks are deliberately skipped, but tests assert them
  (accounting-source, off-main cleanup, recovery group-readable cases); (c)
  `O_NOFOLLOW` is undefined on Windows, so a symlinked compressed rollout is
  refused with `codex_rollout_source_changed` instead of
  `codex_rollout_content_invalid`; (d) renaming a file that SQLite holds open
  fails with `EBUSY` on Windows (accounting-source, publication-identity
  test); (e) one off-main test hardcodes `/tmp`; two others were attributed
  from the code to a timer that is not held open and to an error sanitiser
  that exists only at the worker boundary, and were not isolated. (a), (b),
  (c) and (d) were reproduced with standalone probes; none of the touched
  modules is on these paths, and the Windows CI lane does not run these files.
  v1 is being removed, so they are not fixed here; the v2 code does not share
  these assumptions (it never fsyncs a read-only handle and does not assert
  mode bits on win32).
- Rollout rotation measured (8.5); the write-ahead log limit is implemented
  with soft and hard thresholds and a deferral result, and tested with a
  pinned reader in both build modes. Gate C3 is met for the limit; the
  deletion rate it relies on is an observation on one machine.
- Guard tests: only the v2 modules may import the store or name the
  work-directory table, and a refresh result is a closed set of tokens,
  numbers and booleans with no path.
- Moved to Phase 2 by decision, because each depends on a read-time basis:
  the context band (model and price-registry dependent), the record shape
  (derivable from the null pattern of the stored counters) and the previous
  event for cache-switch candidates (a window function over the session and
  offset order at rollup time, as v1 does). Quota-only events are stored as
  zero-usage events carrying their quota windows.
- Still open: the long-lived refresher (Phase 3 with the companion); the
  differential gates against v1 output (Phase 2); end-to-end hosted continuity
  with the real sync engine (C2).
- Gates carried to cutover: C1 speed-ledger invalidation, C2 end-to-end hosted
  continuity (needs the Phase 2 reader), C3 limit met for the refresher and to
  be re-checked with the Phase 3 reader lifetimes, C4 removal order.

**Phase 2 – aggregates and reads.** Rollups, quota series, cache-switch
candidates with the per-session future-dated fallback, read-time declared-speed
resolution, read path, Layer C prototype with memoization, differential gates
against the pinned v1 output. Go/no-go on the Layer C targets.

**Phase 2 status (2026-10-12, working tree, not committed; gates not all met).**
At closure, the gaps are the two measured misses below (the 2 s full report and
the Layer C cold CPU target) and the open items in section 14. The entries that
follow are the evidence as recorded on that date.
Modules: `local-index-rollup.js`, `-work-rollup.js`, `-pairing.js`, `-report.js`,
`-calibration.js`, `-work-usage.js`, `-contribution.js`; shared-code changes are
additive row-source refactors (6.5, 7.5, 10.3). v1 is untouched and still the
only reader the app uses.

- Passed: the frozen goldens (6.5); the live v1-versus-v2 differentials on the
  variety corpus; on the real home (261k events) zero differences in every
  period, timeline bucket, quota series, cache impact and work-usage cell at
  two clocks, with money inside N1 and every audit at 0; the weighted rollup
  projection equals the event projection, context classes change only at the
  registry thresholds (each boundary and the next token), and declared-speed
  windows resolve per event across bucket boundaries; contribution v1.0 digests and v1.1/v1.2 identities and evidence equal; C1
  (the speed ledger is read at report time and is part of the Layer C memo
  key) and C2 at the level in 7.5.
- Found by independent review after the differentials passed: a rescan rewrote
  facts under a standing cursor and left the pairing tables short (section 14). The
  differentials did not see it because they build fresh stores; the fuzz test
  now audits every derived table after each mutation.
- Not met, reported as measured: the full report with the work breakdown in a
  new process is about 3.4–5.6 s (1.0 s module load, 2.3–4.6 s report; work
  usage a further 2.3 s of which project resolution through git is about
  1.2 s) against the 2 s gate, on a machine whose first seconds run 2–3 times
  faster than the rest; the report alone is inside the gate only in the fast
  state. Layer C cold is 35–46 s against 30 s CPU, about five times faster
  than v1; the memo serves repeats for an unchanged snapshot, ledger and clock.
- Environment gap: the v1.1/v1.2 sync engine itself cannot run on this Windows
  machine at HEAD (device-capability fixture), so C2 for those versions rests
  on digests and evidence, not on an engine run.
- Integration slices (2026-10-12, same tree): the companion seams are
  implemented over the v2 store. `local-index-companion-source.js` returns the
  envelope the snapshot builder consumes, with a generation descriptor whose id
  is the store's `commit_seq` and whose fingerprint (`generation-v2-<64 hex>`)
  is a function of the committed snapshot only; `local-index-accounting-cache.js`
  builds the replay-safe cache from stored facts through the seams added to
  `replay-safe-accounting-cache.js` (`scan`, `calibrationSource`, `buildCache`),
  fails closed on a generation that moved, and the validator's metered bytes are
  reported by Layer C; `local-index-backend.js` exposes the runner's
  `refreshUnifiedIndex` and `refreshAccounting` seams and the cached projection
  reader's three callbacks, with the cheap generation identity (a few catalog
  aggregates, about 13 ms on the real home) and a validity bound
  (`readLocalIndexReportValidUntil`, tested to be exact up to the instant it
  names). A deferred refresh (log pressure) is reported as
  `local_unified_index_publication_busy`, never as a publication.
- Differentials for the integration: the cache equals v1's apart from build
  identity on the variety corpus; the whole companion snapshot built through
  the real refresh runner and snapshot builder differs from v1's in nine paths,
  all publication identity or the clock derived from it (generation id and
  fingerprint in three places, reader version, index bytes, generated-at, one
  reporting-window end). v1 reads null token components as zero when it scans
  for accounting and v2 keeps that, so pricing coverage matches.
- Composition (2026-10-12, same tree). `apps/local/server.js` selects the
  backend with `USAGE_MONITOR_LOCAL_INDEX_BACKEND` (`v1`, the default, or `v2`;
  v2 requires unified accounting and has no fallback to v1). With `v2` every
  unified-index consumer the server composes reads `local-index-store-v1.sqlite`
  beside the untouched previous index: the cached projection reader, the
  snapshot builder, work usage, the refresh runner (`refreshUnifiedIndex`,
  `refreshAccounting`, the cold-start deadline), the window-breakdown route,
  the cache-drop thread links, the contribution engine and review reads
  (v1.0 through v1.2, with a publication proof read from the store), and the
  accountless scheduler. The device salt is the previous index's file, so the
  hosted identity continues; the ordinal map is read once from the previous
  index while the new store has no source. The boundary test now names one
  allowance (`apps/local/server.js` may import `local-index-backend.js` and
  nothing else).
- Differentials for the new slices: the window breakdown equals v1's; the
  cache-drop links equal v1's for the same cache-drop rows (every row of a
  17-row set resolved identically); the v2 publication proof equals the
  companion's generation fingerprint and moves with a publication; the
  retirement assessment (`assessLegacyIndexRetirement`, read-only, counts only)
  refuses a source the new store lacks and an unreadable file. A server started
  with `v2` serves the overview, the window breakdown and the cache-drop links
  from the v2 store and never creates the previous index
  (`apps/local/local-index-backend.test.mjs`).
- Progress: the refresher reports `{ sources, sourcesScanned, usageEvents }`
  at most every 250 ms through the runner's existing progress contract, and a
  consumer that throws never fails a refresh.
- Found while integrating: the quota rescan inside a refresh scanned all of
  `usage_event` for each dropped observation on a real home; the partial index
  `usage_event_quota` fixed it and a regression test pins the plan.
- Not carried, by decision, and reporting unavailable rather than guessing:
  the development-only historical side-chat gap probe reads the previous index
  and fails closed under `v2`.
- Usage explainer: `src/local-index-usage-explainer.js` supplies the three
  readers (health, allowance movement, work usage) over the v2 store, with the
  same argument objects and result shapes as the previous ones. The
  command-line roots (`src/cli.js`, `apps/local/agent-cli.js`) spread
  `localIndexUsageExplainerOptions(process.env)` into the explainer; under
  `v2` the default store is the v2 file and the secret stays the shared device
  salt. Differentials against the previous readers match on a synthetic corpus
  that reaches the monotonic, non-monotonic and single-observation classes;
  reset-identity-missing is not reached by any corpus.
- Consolidated validation (this checkout, Windows): every `test/local-index-*`
  suite, the explainer and agent CLI suites and `apps/local` companion tests pass
  except tests that fail identically at the unmodified HEAD (device-capability
  and path-separator assertions on this platform);
  `architecture:check` and `docs:check` pass.
- Items this list named before the default flipped, with their state at
  closure: the default has flipped (the selector is gone). The Linux state
  composition and the darwin off-main wrapper are out of scope under the
  Windows-only decision. The Electron marker lists still need the v2 store
  (section 13, Phase 3 gap c). Scheduling the audit and repair is open. The
  v1.1/v1.2 engine run is open (section 7.5). The owner decision in 7.3 is
  resolved by decision D4. v1 removal is the Phase 3 change, under explicit
  authorization.

**Phase 3 – cutover and removal (done in the working tree, 2026-10-13; not yet
published).** Target: the app reads and writes v2 only, safeguarded deletion of
v1, removal of the section 11 code, tests and docs in the same change, and
guidance and privacy documents that describe v2.

Done in the working tree:

- The companion composes only the v2 backend. The `USAGE_MONITOR_LOCAL_INDEX_BACKEND`
  selector recorded in Phase 2 is gone from `apps/local/server.js`, which builds
  `createLocalIndexBackend` directly.
- The v1 modules, the `scripts/rebuild-local-unified-index*.mjs` and recovery-core
  scripts, `src/side-chat-estimates.js` and the v1 test files are removed. The
  shared extractor is `src/local-index-extract.js`. `src/local-index-cutover.js`
  keeps `readLegacyOrdinalMap` and `assessLegacyIndexRetirement` so that other
  installs still upgrade from v1 with their ordinals carried.
- The v1 file on the development machine's real profile was retired on
  2026-10-13 under a content-free receipt, after the assessment reported every
  v1 ordinal carried unchanged into the v2 store and the shared device salt
  present. Only the v1 database was deleted; original Codex data, the device
  salt and the ordinal map are untouched.
- The Electron state markers in `apps/electron/desktop-sharing-installation.js`
  name both `local-index-store-v1.sqlite` and the retired v1 file, so erase and
  reset still reach a v1 file on an install that has not yet been upgraded.
- The schema reference (`docs/reference/local-index-schema.md`), the merged
  recovery runbook (`docs/runbooks/local-index-recovery.md`), the privacy
  reference and the decision record describe the v2 store.
- Platform scope is Windows x64 only (`docs/decisions/2026-10-12-windows-only.md`);
  the Linux and macOS paths named by the section 11 removal list were removed
  with it.

Open at closure (each is a gate, not a claim of completion):

- (d) Audit scheduling and repair is now implemented in the continuation
  working tree; source tests are recorded in the
  [continuation plan](2026-10-13-windows-v2-cutover-continuation.md).
- (e) The continuation now drives both v1.1/v1.2 engines with synthetic device
  capabilities and persistent journals: carried legacy ordinals, reversed
  discovery, zero replay uploads and append-only affected-day uploads. This
  is v2 engine replay evidence, not a new retired-v1 runtime differential or
  real Credential Manager/hosted acceptance; see the continuation plan.
- (f) Installed-artifact, signed-release, updater and hosted-deployment gates
  are separate and not proven by this change.

## 14. Risks and open obligations

- **Hosted continuity depends on the carried ordinal map (Option A).** `eventId`
  and every ordinal-free input reproduce; v11/v12 quota observation ids do
  only because the map is carried (7.5). If v1 is absent or unreadable the ids
  regenerate once. Gate C2 is met for the v1.0 engine and for v1.1/v1.2 at the
  level of day manifest digests; driving the v1.1/v1.2 engine itself is open,
  because its device-capability fixture failed on this Windows machine at that
  closure (7.5). The continuation corrects Windows directory-sync handling
  and the telemetry publication parser label, and drives both successor
  engines with actual synthetic device leases and persistent progress. The
  historical manifest comparison and new engine replay are distinct evidence;
  a retired-v1 runtime differential and real hosted acceptance are not claimed.
- **Parser stamps.** v2 stamps every row with the extractor's current parser
  version and rebuilds the per-row suffix from event flags, so a source that is
  present is always at the current revision, as it is in v1 after a reparse.
  What v1 retains and v2 does not carry: facts of sources whose rollouts no
  longer exist, with their original stamps. The cutover safeguard (7.3) keeps
  v1 in that case and says how many sources are absent. The store's parser
  version now embeds the extractor revision and a test pins the two, so an
  extractor bump cannot leave stale facts.
- **Rollout deletion during a stall is the one new data-loss path (8.4).** On
  this machine moves and compressions preserve facts and no deletion was
  observed in 323 days; the limit is therefore set by disk, and the exposure
  formula remains the way to judge a different machine.
- **Layer C missed its CPU target by a margin.** The v2 layer from stored facts
  takes 35–46 s cold on the real home against the 30 s target, about five times
  faster than v1, and the memo makes a repeat for the same snapshot, ledger and
  clock effectively free. Recommendation for the go/no-go: go, with the target
  restated as "at most 50 s cold, worker only, never on the report path", and
  with the cold figure re-measured on the Phase 3 worker; no persisted copy is
  kept, so a speed-ledger edit or any commit invalidates it by construction.
- **WAL needs a local volume;** roaming network profiles are unsupported and
  must fail explicitly.
- **Trigger bugs.** Mitigated by the group-by property test, the fuzzing and a
  periodic audit (daily when idle and after an unclean shutdown) that
  recomputes sampled buckets and rebuilds the aggregates from facts on
  mismatch, with no rollout reads. Phase 2 has the oracles (`auditRollups`,
  `auditWorkRollups`, `auditPairing`, and a rebuild for each derived table)
  and tests that call them after every mutation of the fuzz sequence;
  the backend exposes one read-only `audit()` over them (one read snapshot,
  counts only). The continuation backend now schedules a separate worker on
  first process refresh and daily thereafter at a completed ingestion boundary;
  it rechecks drift under the writer lock, rebuilds derived tables from committed
  facts and publishes one atomic `verify` commit. Cancellation/failure rolls
  back and remains due. This closes the source implementation gap (d), with
  installed qualification still separate. An independent review of the triggers found the
  one defect worth recording: the pairing tables have no insert trigger, and a
  rescan rewrote facts under the standing cursor, which left them short (12 of
  54 candidate rows and 109 of 500 positive counts after four same-size edits;
  the audit reported 16 differing rows).
  Writers now retreat the cursor before deleting a source's facts, so a rewrite
  is provisional until the next advance counts it, and the fuzz test audits all
  three derived tables after every round. Both audits also treat a stored row
  at or below zero events as a difference, which the group-by comparison could
  not see.
- **Local paths widen what a stolen profile reveals.** Accepted under D3;
  export boundaries are unchanged and tested.
- **Static analysis limits.** The accounting-fold, hosted-sync and legacy
  findings were first read from code. Phase 2 ran the fold and the v1.0
  contribution readers against v2 and compared them with v1 (6.5, 7.5); the
  v1.1/v1.2 engine itself has not been driven on this machine.
- **Synthetic baseline is not the real baseline.** The synthetic corpus has the
  real event count but 0.7 GB of bytes against 13 GB, so ingest and report
  times are not comparable with the private-corpus figures in 2.1.
