---
title: Worker timeout phase diagnosis
date: 2026-10-13
type: investigation
status: partial
---

# Worker timeout phase diagnosis

Snapshot: `fix/windows-codex-refresh`, source revision `f75958a8`, Windows x64,
Node `22.21.1`, Worker Vitest `4.1.11`, disposable local workerd/D1 fixtures.
No credentials, real participant data, remote resources or deployments were
accessed. This is a local cause diagnosis, not hosted or release qualification.

## Result

The remaining 16-owner five-second timeout occurs before publication. It
combines 16 real synthetic enrollment/upload/delivery journeys with 32 cold
owner/metric calculations. The two publication functions complete in tens of
milliseconds and meet the original member-count, inline query snapshot and
250-statement assertions when measured independently. Cold work is dominated
by many awaited local D1 calls, not one slow publication query.

The original test, timeout, setup location and assertions remain unchanged.
An ephemeral diagnostic copy prepared the same cohort in a separate hook to
make publication measurable after the original workflow's timeout point. Its
passing result is explicitly not a pass of the original whole-workflow gate.
The diagnostic copy was removed; no Worker production or retained test diff
was introduced.

## Measurements

The control probe recorded these wall times. Aggregate phase values overlap
with their nested owner/scope/kernel values; do not sum both levels.

| Phase | Wall time | D1 calls | Statements |
| --- | ---: | ---: | ---: |
| 16 fixture journeys | 2,441 ms | 2,128 | 3,904 |
| 16 cold fits, including census/scope | 2,164 ms | — | — |
| 16 cold model calculations, including census/scope | 2,161 ms | — | — |
| Fits kernel subset | 2,014 ms | 1,488 | 1,696 |
| Model kernel subset | 2,012 ms | 1,488 | 1,696 |
| Model publication | 23 ms | 14 | 14 |
| Preview publication | 33 ms | 14 | 16 |
| 100 serial trivial D1 reads | 115 ms | 100 | 100 |
| 100 awaited resolved Promises | 0 ms at timer resolution | 0 | 0 |
| 32 warm cached results, including census/scope | 605 ms | — | — |

Cold preparation took 6,766 ms with instrumentation. The first phase probe
recorded 7,648 ms and publications of 21/26 ms. Earlier uninstrumented phase
evidence reached cold preparation in about 5.64 seconds; diagnostic overhead
and local latency vary. None of these measurements changes the five-second
test limit or establishes production CPU time.

The two cold kernel subsets execute exactly 106 statements across 93 D1 calls
per owner/metric. Their combined await time was 3,679 ms out of 4,026 ms wall
time. Available D1 result metadata reported 402 ms of SQL duration. `first()`
returns a scalar without result metadata, so that SQL-duration sum is incomplete;
milliseconds are also rounded. Await time includes dispatch, scheduling,
serialization and database execution. The residual is not a CPU measurement.
The trivial-read control establishes a local serial-call floor of approximately
1.15 ms per call with SQL duration reported as zero at metadata resolution.

## Code-level explanation

- The fixture performs enrollment, device authentication, typed admission,
  manifest/domain activation, delivery draining and daily aggregation separately
  for every owner. This is substantive prerequisite work, not publication.
- The test's `compute()` helper repeats the whole owner census and scope capture
  for each of 32 calls. Warm results still pay those checks; their 605 ms total
  is substantially below cold acquisition/checkpoint work.
- `computeStorageGraphResult()` advances bounded v1.1 acquisition/finish/usage
  phases and promotes resumable successors. `saveStorageHistoryCheckpoint()`
  reads owner authority, checks the current head, creates and validates a stage,
  verifies retained parts, batches payload/head writes, and rechecks the head.
  Repeated head/stage checks are observable round trips. The probes counted
  1,408 history-checkpoint-family statements across the cold workload; warm
  cache reuse adds none of those statements. Their safety purpose must survive
  any optimization: erasure fences, exact-head CAS and crash recovery.
- Additional repeated reads concern collection controls, source state, device
  authority, owner revisions and typed manifest/membership proofs. The probe
  found many small calls, not a single outlier that explains the timeout.
- `STORAGE_V11_PREPARED_FOLD` is false. Enabling a separate algorithm or retiring
  stored checkpoints solely to shorten this test would be an unjustified change.
- The production runtime forwards query/deadline budgets to one selected
  owner/day/metric advance. `runStorageAnalyticsPass()` defaults to a 20-second
  window and 900 statements, with resumable deferral. It can make multiple
  advances while those budgets permit; it does not require all 32 cold results
  and both publications to finish inside this test's five-second timer.

The graph computation, checkpoint storage, publication source and this test are
unchanged between `cf94e9a8` and the snapshot revision. This excludes a diff in
those files as the Windows v2 cause; it does not prove historical timing parity
across dependencies, hardware or test-runner versions.

## Other previously timed-out cases

Existing focused evidence, not repeated here: the original 1,000-contributor
600-second scale gate passed in 314.064 seconds. Its seeding, cold and history
phases cost approximately 127.745, 91.811 and 83.824 seconds; original work bounds
remain in force. The 1,025-contributor case spent about 23.038 of 23.544 seconds
provisioning fixtures within its 30-second limit. Daily-storage and typed-v1.1
focused cases also passed under unchanged deadlines. Earlier full-suite failures
are not sufficient to establish a current product regression, and no full-suite
retry was needed for this diagnosis.

## Action boundary

Do not increase the timeout, move setup in the retained gate, reduce the owner
count or remove authority/checkpoint assertions merely to obtain green. The
original 16-owner workflow remains unqualified. A publication defect is not
established by that timeout; local serial D1 overhead and prerequisite work are
established contributors. Production latency, CPU and deployed scheduler
throughput remain unmeasured.

If optimization is pursued, target bounded reductions in round trips at
checkpoint transitions while preserving transaction/CAS, erasure and race
semantics. Use exact result and crash/replay invariants as acceptance criteria,
not this fixture's elapsed time alone. No production optimization was made in
this diagnostic request.

Local raw evidence and the content-free generator are retained only under the
ignored `.usage-monitor/` directory: `worker-deep-phase-diagnostic.txt`,
`worker-deep-controls-diagnostic.txt` and `worker-timeout-diagnostic.mjs`.
Their transient startup errors (owning-directory resolution and migration
branding of instrumented D1 proxies) were diagnostic harness issues; the
successful measurements use the correct Worker directory and native migration
objects. They are not product failures.
