---
title: Allowance overlap checkpoint evidence follow-up
date: 2026-10-22
type: review
status: investigated
---

# Scope and corrected conclusion

This read-only follow-up adds evidence to the
[interval failure diagnosis](./2026-10-22-allowance-interval-failure-diagnosis.md).
The previous investigation proved which guard blocked ingestion, but did not
establish that the overlap itself was irresolvable. Its source-isolation proposal
is not the preferred correction for the now-supported specific case below.
Other genuinely unresolved sources still need an honest failure/gap policy.

The source has no physical `history_base`, but its own compaction checkpoint
contains the preceding exact response's usage and turn cumulative counters.
The current reconciler does not use this evidence to discharge its later
unverified-prefix overlap guard. This particular rejection is overly conservative.

# Read-only evidence

The private source was opened through the stable-source/decompression entrypoint.
Only accounting structure, fixed-field usage vectors and internal identity
comparisons were examined; no content, paths or provider IDs are recorded here.

| Recorded relation | Result |
| --- | --- |
| Checkpoint compaction response ID equals its retained usage response ID | Yes |
| Checkpoint precedes the first ordinary response in order and time | Yes |
| Checkpoint and first response belong to the same thread and turn | Yes |
| Checkpoint response differs from the first ordinary response | Yes |
| Checkpoint response also occurs among the 12 ordinary modern records | No |
| First response turn cumulative minus checkpoint turn cumulative equals first response raw usage | All six token components |
| Ordinary modern responses paired with subsequent legacy snapshots | 12 |
| Each legacy cumulative delta and latest increment equal its paired modern raw usage | All 12, all six explicit components |
| Paired records have the same instant and are adjacent accounting records | All 12 |

For the failing turn, the checkpoint cumulative total is 241,391 tokens.
The next response adds 80,256, yielding a turn cumulative total of 321,647.
The legacy thread cumulative counters independently advance from 8,832,580
to 8,912,836: the same 80,256. Agreement was checked component by component,
not merely against these displayed total-token figures or timestamps.

These local records support treating the paired ordinary legacy and modern
entries as duplicate observations of the same usage. They do not support
charging both. The first modern prefix is supported by an identity-bound
checkpoint rather than being wholly unexplained.

# Correction boundary

The preferred focused correction is to recognize this exact checkpoint-bound,
component-consistent continuation, with one-to-one legacy matching. Keep the
ordinary ambiguity rejection for absent, unrelated, contradictory, later,
duplicate or incomplete checkpoint evidence. Add synthetic cases before changing
the reconciler; never place this private source in tests.

Checkpoint model/speed attribution, how its own usage should enter the ledger,
other historical prefixes and complete historical prices need separate checks.
This follow-up confirms the local overlap relation, not a provider bill, all
historical amounts, or a repaired native chart. No product code or original
state was changed and no live refresh was requested.
