---
title: Unified index snapshot publication and report read cost
date: 2026-10-12
type: plan
status: implemented
---

# Unified index snapshot publication and report read cost

Scope: make unified-index publication independent of long report reads on
Windows, and cut the cost of the full report read that made those reads long.
Schema, identity salt, generations, cancellation and the single-file layout on
POSIX are unchanged. Source and development-package evidence do not qualify an
installed or signed release.

## Problem

Windows refuses to replace a file any SQLite connection holds. The previous
design drained readers before replacing the live index and failed with
`local_unified_index_publication_timed_out` after 120 seconds. The full report
read, with the work breakdown, holds the index for longer than that on a large
history (measured 156-171 seconds on a 488 MB index of about 460,000 events), so
refreshes that overlapped it discarded their completed stage. The barrier was
also process- and thread-local and could not see other readers.

## Options considered

1. Longer drain timeout, or cancelling report reads: still couples publication
   to readers and starves one side under frequent refreshes. Rejected.
2. In-place WAL writes: SQLite would version pages, but staged integrity
   checks, generation publication and the immutable-URL readers all assume an
   immutable published file. Too broad a contract change. Rejected.
3. Versioned immutable snapshots named by an atomically replaced pointer.
   Chosen. It needs no reader coordination at all: the operating system's own
   refusal to delete an open file protects every reader in every thread and
   process.

## Design

See "Generation and publication" in
[the schema reference](../reference/unified-index-schema.md). Publication first
attempts the existing rename, so uncontended publications, POSIX, and every
existing consumer keep the single-file layout. Only a Windows sharing refusal
switches to snapshots, after which later publications stay snapshots. All
readers resolve the pointer at open; the in-process reader barrier was removed.

## Report read cost

Profiling the full read on a private copy of a 488 MB index (2,269 indexed
rollouts, 13 GB of rollout history) showed:

- The work breakdown re-reads every indexed rollout to recover each turn's
  working directory, because paths are deliberately not stored in the index.
  Its in-memory directory cache (6 MB for that history) was discarded after
  five idle minutes, so most automatic refreshes rebuilt it from all 13 GB.
  The direct-mode cache now survives idle periods; it remains bounded at
  32 MB and is still discarded on failure, cancellation or scope change.
- Exact decimal costs were re-parsed per event. Totals now accumulate as
  integers and render through the canonical ledger once (`ExactUsdSum`), and
  the work accumulator updates cells in place. Output is unchanged.
- A byte prefilter to skip decoding message lines was measured and rejected:
  every exact variant scanned slower (290-325 MB/s) than `JSON.parse` saved.

Measured on that copy (Node 26.2.0, Windows, warm OS file cache):

| Read | Before | After |
| --- | --- | --- |
| Full report without work breakdown | 45 s | 35 s |
| Full report with work breakdown, first in process | 171 s | 127-137 s |
| Next report in the same process | 171 s (cache discarded when idle) | 74-94 s |

The projection output was compared field by field with the pre-change output:
only the read's own wall time and the live rollout discovery fingerprint, which
moved because Codex was in use, differed.

## Remaining gates

- The first report after start still streams all indexed rollout bytes once.
  Avoiding that needs a persisted, content-free cache of metadata-line offsets,
  a new cache format requiring compatibility review.
- Incremental aggregation across generations would remove most remaining
  per-event work, but needs an exact proof that published rows below the last
  aggregated row are unchanged; not attempted here.
- Abandoned stage files remain retained on Windows, as before.
- Installed and signed releases are not qualified by this source change.
