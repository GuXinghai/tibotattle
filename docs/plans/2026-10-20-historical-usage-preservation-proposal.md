---
title: Historical usage preservation proposal
date: 2026-10-20
type: plan
status: implemented
---

# Historical usage preservation

Scope: confirmed D4 from the [diagnosis](../reviews/2026-10-20-x-session-and-ingestion-diagnosis.md). Implementation authorized by the owner on 2026-10-20; preserve existing changes and use synthetic scoped validation only. No full tests, real-data mutation, packaging, installation or publication.

Accepted implementation boundaries:

- Distinguish an incomplete append after a verified committed prefix from a
  malformed/replaced prefix. Keep the former's last verified facts and cursor;
  do not publish the incomplete record or advance its cumulative baseline.
- Represent the tail as deferred/unavailable coverage, rather than claiming a
  complete source or converting missing evidence to zero. Quarantine truly
  invalidated evidence under the existing fail-closed policy.
- Finish or retry the append atomically with its facts/cursor/rollups. Prove
  repeated partial reads, completion, crash/restart, rotation and duplicate
  physical files cannot erase earlier facts or double count the resumed record.
- Update the schema/reference/quarantine contract and recovery guidance together.
  Rehearse only on synthetic sources or an isolated copy; do not rewrite logs,
  relabel database versions or manufacture already-deleted observations.

This requires a deliberate refinement of the quarantine contract, not deletion
of its integrity safeguards. The source repair does not perform a separate live historical recovery or mutate source logs.

## Implementation and scoped evidence

Implemented in the working diff on 2026-10-20. Complete newline-terminated
prefixes are published consistently by serial, full-rescan and worker reads.
Unterminated bytes are withheld with `deferredTailBytes`; the cursor, carried
counters and digests cover only complete lines. Unchanged tails skip; later
changes resume only after the existing identity and digest checks. Malformed
complete accounting/header records still quarantine the source.

Store format 7 protects the new cursor meaning from older writers. The reviewed
4/5/6 forward paths retain facts and ordinals; parser typed-v3 causes discovered
old sources to be reparsed. A legacy tail-quarantined source can recover its
complete records from the original log without editing that log. Missing or
invalid original records are not manufactured or promised recoverable.

Node.js 26.2.0 focused validation: 27 tests passed across the six selected tail,
reconciliation and legacy-recovery cases; ten digest/migration cases; and eleven
selected existing completeness, append parity and work-migration checks.
Architecture boundaries and documentation/root-layout/whitespace preflight
passed. No full suite or unrelated surface validation ran.

Tests used disposable synthetic logs and indexes only. No live user-data
migration or recovery, application packaging, launch, installation, commit or
publication occurred. The running old app has not picked up these source
changes. Packaged/runtime acceptance remains a later gate.
