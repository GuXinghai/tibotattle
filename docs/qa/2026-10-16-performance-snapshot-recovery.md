---
title: Performance snapshot isolation and retained history verification
date: 2026-10-16
type: qa
status: complete
---

# Performance snapshot isolation and retained history verification

This record covers source/cache behavior and pre-launch verification. Per the
owner's latest instruction, post-launch browser, Electron and extended runtime
acceptance are handed to the owner rather than performed by the agent.

## Diagnosis

The legacy snapshot is intact but belongs to a different source identity. The
current timing store retains 2,080 parser-zero source records and 8,365 associated
turns. None of those sources match current discovered path digests, the retained
local-index path catalog or current discovered physical file identities. All
2,080 physical identities match sources in the preserved older-source timing
store. This establishes retained old evidence, not a recoverable current path.
The native Windows identity comparison matched 745 current-file positive
controls; ordinary Node stat identities were not used as proof of absence.
It does not establish whether the unavailable raw files were moved or deleted.
No disk-wide search or guessed reassignment was performed.

The prior worker scanned current files to completion but marked the entire
projection stale because unavailable old sources still required parser repair.
The controller could not save such results, so its old-source cache diagnostic
could never recover. Retrying current discovery cannot reparse unavailable inputs.

## Changes and preservation

- Source-specific v5 cache files isolate future writes. Matching legacy caches
  remain a read-only fallback; current-cache corruption cannot bypass validation
  through fallback. Legacy cache bytes and old timing records stay preserved.
- Finished scans with only unavailable historical gaps can persist explicitly
  stale v5 results. Their counts and flags survive restart. Unfinished repairs
  and failed scans cannot replace settled saved results.
- The worker reports `timing_history_unavailable` separately from parser repair
  still in progress. Successful cache recovery clears cache failures while the
  historical gap remains visible. No parser version is relabeled as repaired.
- No raw-record, database schema, pricing, percentile or speed-mode change.

## Pre-launch evidence

- Focused worker/cache/domain verification: 47 passed.
- Focused browser behavior: 57 passed.
- Full UI gate: 1,024 passed.
- Local surface: 304 tests, 303 passed, 1 skipped, no failures.
- Architecture: 579 production files, 2,313 imports, zero approved debt edges.
- Canonical browser locale mirror check passed.
- Documentation preflight: 20 passed. Original accounting/work/quota fact hashes,
  database integrity and foreign keys all passed read-only preservation checks.
- Protected real-data copy: actual worker scanned 745/745 currently discoverable
  files, completed 12 period/mode combinations and saved the new source cache.
- 637 bins matched direct projection and independently recomputed sample counts
  and P10/P25/P50/P75/P90 values; zero mismatches.
- The 2,080 old source rows and 8,365 turns had identical hashes in the original
  and verified copy. The legacy snapshot stayed byte-identical. Cache roundtrip
  preserved statistics and stale flags without promoting them to completeness.

Owner-local receipts and the protected copy are untracked. Real records do not
enter test fixtures, this document or commits.

Windows candidate 2026101626 was prepared with Node 26.2.0 from source snapshot
`51244c4a2040b92d68a29f67e139a6e7f38a3d05`. Its source/ASAR/native-byte closure
passed; ASAR SHA-256 is
`9b1dbda13ce3fa12358fd5fbdeafe3c214c69b4757c7563a729aa054d1879f71`.
The prior candidate remains preserved. No signing, installation or publication
was performed. The old candidate's in-flight accounting refresh was allowed to
finish before switching. Normal-profile launch occurred at 14:01:03 UTC with
build 2026101626, without an isolated profile. Subsequent behavior, browser and
Electron rendering, and continued runtime acceptance are handed to the owner
and deliberately not claimed as verified. No post-launch data/API inspection
or observation timer was performed.
