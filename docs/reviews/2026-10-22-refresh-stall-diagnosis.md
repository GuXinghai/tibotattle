---
title: Packaged refresh and performance-page stall diagnosis
date: 2026-10-22
type: review
status: runtime-observed
---

# Scope and evidence boundary

Read-only diagnosis of the owner's normal-profile Windows x64 package, build
`0.1.27 / 2026102205`, on 2026-10-22, approximately 23:43–23:58 JST. This
record does not qualify an installed or signed release. No product source,
running package, settings or original database was modified by this diagnosis.
The workload-card preview and all pre-existing uncommitted changes remain
untouched. Only synthetic reproduction code was added under the ignored
`.release-build/overview-validation/` directory.

Acceptance boundary: distinguish a nonterminating job from slow completed work,
identify observable reuse refusals, and reproduce the performance-page recovery
behavior without replaying private sessions in tests. Do not infer a past
exception from a generic error label.

## Completed work rather than one continuous stuck refresh

The observed overview refresh started at 23:42:21.075 and succeeded at
23:48:38.191 JST: **377.116 seconds**. Quota was published separately at
23:42:30.611. Its receipt reports 3,835 discovered sources, 3,814 skipped,
21 scanned, 18 rescanned, 309,436,331 scanned bytes and 61,720 ms index work.
Accounting reports `refreshStatus: rebuilt`, not `reused`. The remaining elapsed
time includes accounting, proof reads and dashboard snapshot publication; these
substeps have no individually retained duration receipt, so the remainder must
not all be labelled accounting CPU time.

The next automatic refresh began at 23:53:43.227. The scheduler arms five minutes
after settlement and permits only one writer. A persistent-looking updating
label therefore does not establish that the startup job never completed.
Four subsequent health samples returned HTTP 200 in 19–156 ms. One earlier
status request took substantially longer; this inspection does not establish
that control-plane latency remains bounded throughout every phase.

## A specific reuse gate currently refuses the proof

`src/local-index-accounting-reuse.js` requires explicit origin evidence for
every selected session. At generation 20926, the origin reader returned 3,748
entries, of which 3,747 were known and one unknown; `readProof` returned `null`.
The saved cache matched that generation, was less than ten minutes old, had
zero fallback and available weekly intervals. Thus expiration and unavailable
weekly intervals were not the observed refusal at that instant.

A later independent read again found exactly one unknown origin among 3,752
sessions. This session had one source row and zero usage-event rows. No IDs,
source paths or session content were emitted or saved. This is a candidate for
reviewing the proof's dependency set, **not** evidence that unknown provenance
may safely be converted to a normal origin. Its other source facts and the
calculation dependency boundary require verification before changing the gate.

The old calculation-revision triggers on queued runtime-model receipts were
absent. Genuine new/replaced usage events also advanced the next generation to
20950, independently invalidating generation-bound results. The missing-origin
gate is a demonstrated current refusal; exact reasons for every historical
miss cannot be reconstructed because the runner does not retain miss reasons.

## Performance-page failure can outlive service recovery

The exact seven-day, Standard, shared-cutoff request returned HTTP 200 with a
valid schema and matching end time. The page's failure path stops foreground
polling. A synthetic DOM reproduction using the existing test harness proved:

1. A valid chart is retained after a synthetic service failure.
2. No retry timer remains after rejection.
3. Service recovery alone produces no new request.
4. Explicit retry recovers and clears the error.

The reproduction is a source-level DOM test, not a native renderer interaction.
The running ASAR's page, worker, accounting-reuse and origin-reader modules
were byte-identical to the inspected source.

The timestamp appended to the error is `payload.updatedAt`: the old measurement
timestamp, **not** the failed request's time. Therefore the screenshot's 23:35
does not establish a refresh running since 23:35. The original request's HTTP
status/underlying exception was not retained; the synthetic 503 is a failure
injection and must not be reported as the original runtime error.

The performance worker also emitted `timing_source_recovery_failed` during
observation. Its fixed classification covers a source changing during recovery
or an unavailable recovery source; the exact affected source and cause were not
traced in this read-only pass. Both current timing stores later had all 3,841
source rows at parser version 18, replay version 0 and rebuild kind `none`.
Their checked-source counters reset when a new periodic discovery pass begins;
this is not proof of a parser upgrade or full historical reread on each pass.
One subsystem's successful refresh does not erase the other's diagnostic.

## Remaining work

Review bounded recovery for transient performance requests, distinguish failure
time from measurement freshness, and retain closed, content-free cache-miss
reasons. Audit whether sessions without consumed calculation facts need to
invalidate the entire proof. Preserve origin, generation, age, cancellation and
publication fences. Any source correction needs synthetic targeted regressions;
application of that correction to the normal running package is a separate gate.
