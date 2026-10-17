---
title: Rolling work ancestry evidence verification
date: 2026-10-16
type: qa
status: complete
---

# Rolling work ancestry evidence verification

Local Windows candidate 2026101625 uses source snapshot
`b6ddc17721c42b9c85654d822e70b4f5f6c54d34`. The predecessor remains available.
This is local source, artifact and runtime evidence; it is not installed,
signed-release or public-deployment qualification.

## Diagnosis and repair

The live report contained four `work_boundary_conflict` groups. Its eight-day
reader boundary excluded earlier original task events while retaining multiple
paginated-fork copies. Explicit retained lineage established the same original
ancestor for the copies. Reading the complete groups removed all four conflicts
without changing the current seven-day work intervals.

The reader now supplements selected task groups with older committed ancestor
facts in the same transaction. Unrelated, provisional, ambiguous and cyclic
evidence does not establish replay. Supplementary queries are bounded. No raw
records, schema, usage rows, quota calculation or analyzer conflict rule changed.

## Verified gates

- Work reader: 8 tests passed, including rolling-window replay, preservation of
  child work, refusal of provisional ancestry and the existing cyclic-lineage test.
- Workload domain and package boundary: 32 tests passed.
- Local surface: 304 tests, 303 passed, 1 skipped, 0 failed.
- Architecture: 579 production files, 2313 imports, zero approved debt edges.
- Preflight: 20 passed after normalizing the new plan's line endings. The initial
  sandbox run lacked access to native protected temporary directories; the work
  reader tests passed under normal Windows permissions.
- Candidate staged with Node 26.2.0; source/ASAR/native closure verification passed.
- Same-cutoff real-data reader comparison: errors changed from four conflicts to
  none; complete coverage and daily projections were equal before and after.
- Original-fact preservation hash checks, integrity and foreign keys passed.
- Normal-profile launch succeeded. In-app browser overview rendered all five
  sections without the conflict alert. No desktop input was used for this check.

Receipts and the screenshot remain owner-local under the ignored validation
directory. Raw records and private identifiers do not enter this document.

## Runtime observation and remaining boundary

Normal-profile launch was at 05:24:17 UTC. Observation completed at 05:39:53 UTC
after 936 seconds. A manual refresh and both subsequent full automatic cycles
completed successfully. The automatic starts were 05:33:32 and 05:39:12 UTC,
five minutes after the preceding completion in each case. The earlier automatic
completion at 05:26:15 UTC is additional evidence, not one of those two cycles.

Workload status remained available; no work errors, refresh failures, generated-time
regression or cumulative-consumption regression were observed. Confirmed consumed
quota increased to one percentage point and remained at one on the following
publication. The candidate process remained alive and stderr stayed empty.

The final in-app browser overview showed the 14:39 GMT+9 observation and no conflict
alert; captured browser console errors were empty. Final Electron visual inspection
was not performed in this repair; browser rendering remains a separate gate.
