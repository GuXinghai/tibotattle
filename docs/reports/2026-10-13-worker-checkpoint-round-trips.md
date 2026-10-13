---
title: Worker checkpoint round-trip optimization
date: 2026-10-13
type: investigation
status: partial
---

# Worker checkpoint round-trip optimization

Local source change: `6103c40f`, compared with `ac2cf15a`. Windows x64,
Node `22.21.1`, Worker Vitest `4.1.11`, synthetic workerd/D1 state only.
No remote writes, credentials, publication or schema migration. This follows
the [timeout diagnosis](./2026-10-13-worker-timeout-diagnosis.md); it does not
change the original five-second test deadline or establish release readiness.

## Change and preserved boundaries

`saveStorageHistoryCheckpoint()` observes active owner authority and the
expected head in one SQL snapshot. Stage insertion, active-stage validation and
bounded retained-part metadata reads share one D1 batch. Part metadata reads
are fenced by the same active stage. The subsequent payload batch retains its
authority/terminal triggers and exact-head CAS, followed by the original head
read. The replay short circuit and private multi-page cursor remain intact.

`loadStorageHistoryCheckpoint()` reads head and eligible stage with a left join,
preserving the head digest when authority is unavailable. Retired heads cannot
expose stage bytes. Every part is still verified, and completed assembly still
requires the final live head/authority fence. Resumed pages retain one read per
page. No checkpoint format, generation hash, namespace, retention rule, write
ceiling or privacy/erasure trigger changed.

The small cold-save path changes from seven round trips to four; a complete
single-page load changes from four reads to three. Physical SQL statements
inside a batch are still individually counted by the existing invocation meter.

## Same-workload comparison

The same content-free phase probe executed 16 synthetic owners and 32 cold
fits/model computations. One optimized run was followed by one run importing
temporary original graph/checkpoint modules from `ac2cf15a`, with identical
instrumentation, fixture sizes, assertions and query limits. Those temporary
modules and the diagnostic test copy were removed after measurement.

| Cold kernel total | Original | Optimized | Difference |
| --- | ---: | ---: | ---: |
| D1 calls | 2,976 | 2,496 | 480 fewer, 16.1% |
| SQL statements | 3,392 | 3,232 | 160 fewer, 4.7% |
| Wall time | 2,692 ms | 2,428 ms | 264 ms lower in this sample |
| Per owner/metric calls | 93 | 78 | 15 fewer |

The workload performs five cold checkpoint saves per owner/metric, making the
three-call saving per save observable across all 32 computations. Publication
query snapshots remain model=14/preview=16; all original member-count and
publication statement assertions pass in the independent diagnostic.

The trivial D1 control took 71 ms for 100 reads in the baseline and 64 ms in
the optimized run. Fixture provisioning remained close (2,223 vs 2,239 ms).
Cold wall time decreased approximately 9.8%, but local transport also varied;
do not attribute the entire timing difference to code or extrapolate it to
production. The stable outcome is the measured reduction in actual calls and
statements for the same workload. Warm-cache timings were 353/366 ms and are
not an improvement claim. The retained five-second whole-workflow test was not
rerun to obtain green.

## Focused validation

- Checkpoint store: 17/17 pass, including v1/v1.1/effective round trips, paged
  staging/loading, immutable retained bytes, lost part-response replay,
  corrupted cursors, owner withdrawal, bounded retirement and anti-resurrection.
- New metadata-batch boundaries: committed metadata response loss resumes with
  no partial head; a late CHECK-constraint failure rolls the whole batch back;
  withdrawal or competing promotion between metadata verification and payload
  CAS refuses the stale write. The runtime-constraint rollback case also passed
  its focused final check after strengthening the initial fixture.
- Graph integration: unchanged-head checkpoint failure, newer-head deferral and
  retained tombstone cases pass 3/3. Concurrent claim/direct fallback passes.
  Promoted-page response-loss recovery passes with its original head/result
  assertions. Its old "first batch" injection initially hit the newly added
  metadata batch; the fixture now identifies the actual head-promotion statement
  rather than relying on call order. No assertion was weakened.
- TypeScript, workspace-package copy guard and architecture pass. The complete
  Worker suite was not repeated; this is scoped source/recovery evidence, not a
  complete cross-surface or deployed qualification.

Raw local evidence stays ignored under `.usage-monitor/`:
`worker-checkpoint-optimized-phase.txt`, `worker-checkpoint-baseline-control.txt`,
`checkpoint-batch-store-validation.txt`, `checkpoint-batch-promoted-replay.txt`
and related focused receipts. No payloads or owner identities were printed.

Remaining performance costs include repeated source/authority checks, typed
quota/usage acquisition and durable framing. Further changes must preserve
their race and erasure fences; this change does not enable prepared-fold modes,
remove checkpoints or introduce concurrent owner writes.
