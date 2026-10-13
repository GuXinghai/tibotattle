---
title: Local index v2 store and local path storage
date: 2026-10-12
type: decision-record
status: accepted
---

# Local index v2 store and local path storage

Status: accepted, owner-approved 2026-10-12. The v2 store is the only local
index backend the companion composes: `apps/local/server.js` builds it through
`src/local-index-backend.js`, and the v1 backend is retired. The store's
contract is in [the store schema reference](../reference/local-index-schema.md).
Implementation state, measured results and the open gates are in
[the redesign plan](../plans/2026-10-12-incremental-index-redesign.md), sections
0.2, 13 and 14. Acceptance of this decision is not a release claim: source,
installed-artifact, signed-release and deployment evidence remain separate gates.

## Context

A routine refresh that finds any new Codex output re-reads, re-copies or
re-derives work proportional to the whole history, and the full report re-reads
every indexed rollout because the index deliberately stores no working
directory. The previous restriction that the local index hold no path or
filename existed to keep the derived artifact content-free. The same
information is already read from the same local files at report time, so the
restriction costs repeated 13 GB scans without protecting anything that the
rollout files do not already expose to the owner.

## Decision

1. **Direction.** The unified index becomes one live, owner-only SQLite store in
   WAL mode in which each rollout source owns its facts, advances in one
   transaction, and maintains its aggregates by trigger. Rollouts remain the
   source of truth and are never modified.
2. **No legacy preservation.** The v1 index, its stage, incremental, snapshot
   and pointer files, the replay-safe accounting cache and other obsolete
   derived data are not migrated. There is no compatibility reader and no
   rollback to v1. v2 is built only from the original rollouts.
3. **Conditional deletion.** The v1 file is deleted under a receipt naming its
   exact target only when it holds no facts from rollout sources that are
   absent from disk. Otherwise it is retained as an unread archive and the owner
   sees a content-free count. Deleting such an archive stays a separate,
   explicit, receipt-backed owner action.
4. **Local paths.** The v2 store may hold absolute rollout source paths, file
   identity, working directories, and repository or worktree paths.
5. **Identity continuity exception (owner, 2026-10-12).** The one-time cutover
   step reads the `source_local -> source_ordinal` map from v1 and carries it
   into v2, so hosted quota observation identifiers stay byte-identical and
   nothing re-uploads. The map is identity metadata, not index data. The v1
   reader exists only in that step and is removed with v1; if v1 is absent or
   unreadable the ordinals regenerate once.
6. **Legacy accounting mode.** The legacy accounting source mode and its
   pipelines are removed, subject to verification of their remaining
   dependencies and user-facing entry points (the plan lists them).

## What this does not change

- Prompts, responses, reasoning, raw commands, credentials, raw account IDs and
  session content never enter the index. Thread titles, which can contain
  opening-message text, are not authorized by this decision either.
- Paths and working directories never leave the machine through any derived
  artifact: exports, contribution and telemetry, diagnostics, logs, crash
  doctor output, issues, commits and PRs, fixtures, browser storage, API
  payloads beyond the transient display basenames the product already shows,
  and saved snapshots (which keep anonymous aliases).
- The store, its `-wal` and `-shm` sidecars and any backup copy are owner-only,
  covered by local erase, and subject to the existing native owner,
  single-link and reparse-point checks on Windows.
- Hosted pseudonyms keep their device-salt derivation at the export boundary,
  and the device salt is never regenerated.
- Non-regenerable local state is retained: the collector state's
  `codex_quota_snapshot` records, checkpoint and migration receipts, the
  speed-baseline ledger, activity markers, and all contribution settings,
  queues, reviews and prepared sets.
- Rollout files stay untouched. Absent-source facts are never deleted by
  absence.

## Consequences and gates

- Negative tests must prove that no path or working directory appears in any
  export, contribution, diagnostic, log, crash or snapshot output before the
  v2 store ships.
- Hosted contribution continuity across the rebuild must be verified end to end
  before cutover: typed-v1 sequencing, device binding and incremental sync.
- A change to the speed-baseline windows must invalidate exactly the pricing
  and aggregation results it affects.
- The companion reads v1 only for the one-time ordinal seed, while the v2 store
  has no sources. The v1 file is deleted only under decision item 3. No code in
  this build deletes it; `assessLegacyIndexRetirement` reports whether it is
  retirable.
- Guidance and privacy documents describe the v2 store. They were updated in the
  cutover change.
