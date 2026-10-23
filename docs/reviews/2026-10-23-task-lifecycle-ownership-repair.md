---
title: Task lifecycle ownership and cancellation repair
date: 2026-10-23
type: review
status: source-verified
---

Owner-authorized repair follows the [read-only diagnosis](2026-10-23-unclassified-workload-diagnosis.md).
Preserve unrelated dirty changes, actual evidence and the existing card layout.
No real-index mutation, packaging or restart is part of this repair.

Acceptance: one shared workload ownership resolver protects a uniquely completed
ancestor from descendant branch cancellation while retaining real same-session
conflicts, ambiguous ancestry and valid child continuation. Historical buckets,
current load and remaining-work estimates use this one resolver. Raw facts stay
unchanged and quota allocations remain conserved.

Audit the lifecycle normalizer, scanner, checkpoint scanner, index projection,
work-usage rollup and inference timing for analogous assumptions. Where confirmed,
reuse the existing provider lifecycle contract rather than copying terminal lists.
Scanner/checkpoint semantics require forward version changes and matching closed
compatibility declarations; old checkpoints must not resume as new semantics.

Validation: reproduce defects in synthetic fixtures first, then run focused
ownership, index, scanner, checkpoint, compatibility and architecture checks.
Read-only aggregate replay may establish impact separately from synthetic proof.
Do not label unresolved orphan timing or quota-only status intervals as classified.

## Implemented repair and related audit

`task-workload-v12` centralizes the lineage proof and boundary resolution inside
the existing quota-analysis workload owner. The same proof now governs copied
events, descendant cancellation and valid continuation. A unique, chronologically
valid same-session start/completion protects the ancestor's timing. It does not
override a true duplicate start, multiple own terminals, differing completion
durations, an unrelated session or incomplete/reciprocal/cyclic ancestry.
Child-owned tasks retain their cancellations. Suppressed branch cancellation is
not relabeled as a replay copy, and all stored facts remain unchanged.

The local reader is the only persisted-work-fact consumer; historical allocation,
training, current intensity and hours all enter this same analyzer. The work-usage
rollup aggregates usage by session and does not resolve lifecycle endings.
Inference timing hashes session and turn together, rejects fork headers and
handles abort inside that isolated parser state; no analogous cross-session merge
was found there, so those paths were not rewritten.

Two additional lifecycle defects were reproduced: the provider scanner and the
checkpoint scanner recognized only task start/completion, leaving cancellation
open. They now share `CODEX_WORK_LIFECYCLE_EVENT_TYPES` and `codexWorkLifecycle`
with the index extractor. Raw-line admission, kind recognition, validation and
the start/terminal decision use that canonical contract. The scanners keep their
existing source scopes, window bounds and checkpoint add/delete transaction
behavior; malformed cancellation stays diagnostic and cannot close another task.
Versions advance to `codex-log-scan-v13` and
`codex-export-checkpoint-scan-v0.9`, with matching closed compatibility schema
and generator-produced manifests. No live migration or checkpoint modification
was performed.

## Verification and limitations

New synthetic reproductions failed before treatment. Directed tests cover
nested branches, duplicates, input order, own cancellation, real terminal
conflicts, ambiguous ancestry, continuation, complete reader replay, immutable
stored work/usage facts and conserved quota. Cancellation is also tested across
a checkpoint resume, with foreign/malformed/future terminal negative cases.
Final directed-file results: 217 tests executed, 215 passed and the two existing
failures described below remained. The workload/index subset passed all 87 tests;
the compatibility/schema/package/browser subset passed all 69 tests. The other
scanner/checkpoint/provider-boundary subset contributed 59 passes and the two
existing failures. No exclusions or weakened assertions were used to hide them.
Architecture boundaries, generated telemetry check, 20 preflight tests,
documentation governance and whitespace checks passed. Full root/native/release
suites were not run under the owner's directed-validation scope.

Read-only source replay at `2026-10-23T02:15:45.060Z` (11:15:45 Asia/Tokyo),
generation 21362 on both sides, changed unclassified allocation as follows:

| Local date | Running v10 projection | Repaired v12 source replay |
| --- | ---: | ---: |
| October 22 | 14.958653 points | 1.295390 points |
| October 23 | 9.555191 points | 2.190215 points |

`work_boundary_conflict` disappeared for these known branch conflicts. Incomplete
timing, quota observation/reset and price errors remained. This helper uses default
declared-speed inputs: exact monetary valuation and unchanged colored proportions
are not claimed. The results are source replay, not a new native publication.
The running application package remains unchanged. Residual orphan timing and
the quota-only status interval were not filled or reclassified without evidence.
A GET-only preview of the full production browser module graph with real aggregate
data rendered the corrected daily bars and current workload. Diagnostic details
retained the specific remaining codes, with no synthetic replacement values.
The preview was closed afterward; browser evidence does not qualify a native
package or installation.

Two broader directed-file failures were independently reproduced with the relevant
old scanner implementations loaded from the prior verified build in memory:
the provider public-export allowlist already lacks `RESPONSE_MODEL_RECOVERY_VERSION`
and `createResponseUsagePlan`; the legacy-tail upgrade fixture that relabels a modern
synthetic database as version 6 already fails with `local_index_unavailable`.
Those failures were not introduced by this repair. Their assertions were not
weakened, excluded or silently treated as passing; unrelated behavior remains
outside this repair.
