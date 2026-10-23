---
title: Forward-only refresh diagnostic packaging
date: 2026-10-23
type: review
status: completed
---

This record covers the owner's requested diagnostic additions, normal-profile
Windows package, orderly replacement and first measured refresh. It does not
backfill old runs or change accounting, reuse eligibility, workload preview,
index schemas, installation, signing, publication or release qualification.
The API authority is [API surface](../reference/api-surface.md).

## Acceptance boundary

Before packaging, finish closed process-local rejection reasons for before and
after origin proofs, process-cache lookup and proof retention. Distinguish
missing retained state, unknown origins, input/generation changes, expiration,
invalid cache and live identity fences without retaining source identifiers or
raw errors. Record bounded stage durations through final snapshot build, clone
and persistence. Observers must not affect results or cancellation.

Use synthetic targeted tests and the owning local companion gate. Verify the
new ASAR against the exact staged runtime closure and ZIP payload, preserving
all unrelated worktree changes. Only then quit an existing normal app, if any,
and launch the new normal-profile app. Capture the new refresh from its start;
join an automatic startup refresh rather than enqueueing duplicate work.

## Evidence boundary

The earlier measurements in [stage timing](./2026-10-23-refresh-stage-timing.md)
remain separate historical probes. They do not establish the duration or cause
of this package's first refresh. New timings and rejection reasons will belong
only to the newly observed run. A local unsigned package is not an installed,
signed, updater-qualified or published release.

## Pre-package validation

The five targeted source files pass 187/187, and the synthetic loopback
diagnostic route test passes. Architecture and preflight pass. The broader
local gate reports 328 passed, 9 failed and 1 skipped (338 total), so that
gate is not green. All nine failures reproduce when the tests import the
previous normal package's staged server instead of the current server.
One fixture emits a new wall-clock timestamp on each overview read while
asserting complete equality. Eight shared-work tests expect completed work
projections to be cached despite the existing explicit exclusion of work
usage from that cache's proof. This diagnostic-only task preserves those
proof fences and records the pre-existing failures without weakening tests.

## Verified normal package and launch

The local unsigned Windows x64 package is version **0.1.27**, build
**2026102301**, using the normal `com.usagemonitor.local` application identity.
Its source base is `94cc26f3a63fc12b726fd47da8a83b44ba27e425` with the owner's
uncommitted changes. All 2,204 source inputs remained unchanged during the
build. The staged manifest and archive agree for 775 manifested files and
776 archive files, including both native modules. ZIP members match the
unpacked EXE, ASAR and native payloads.

ASAR SHA-256: `35d986dc4e0676cdb7c22ae7fddd0717bbf7e45c2bc1a6794b9781b736655d3c`.
ZIP SHA-256: `dc6029b539b24dac54dd7a2a847e36c1636d5a3ee49235ddc8ef96017389ea79`.

No previous app was running immediately before launch, so no quit operation
was necessary. Main PID 25824 launched the new package; companion PID 83892
owns both the normal-profile lock and its loopback listener. Health reports
ready, real local evidence, no remote upload and a ready snapshot. An ordinary
window exists. No isolated profile, smoke-control environment or test package
was used. The workload-preview source hash and modification time are unchanged.

## First measured refresh

The app's automatic startup refresh ran from **2026-10-23 01:44:57.701** to
**01:47:17.547 JST**, succeeding in **139.846 seconds**. The observer joined
that run and submitted no duplicate refresh. Quota publication and usage
settlement both succeeded. All completed stage counters report zero failures
and cancellations. The table groups sequential parent operations; nested
stage durations are not added a second time.

| Operation | Wall seconds |
| --- | ---: |
| Quota collection and publication | 13.904 |
| Index refresh wrapper | 35.556 |
| Before/after reuse proofs | 11.571 |
| Accounting rebuild | 64.903 |
| Final snapshot reload | 13.791 |
| Setup and remaining orchestration | about 0.122 |
| **Entire run** | **139.846** |

Within accounting, composition fitting took 23.588 seconds, scanning 13.366,
transition derivation 9.675, weekly intervals 7.629, corpus opening 4.814,
weekly origin reads 2.991 and final projections 2.425. The snapshot's builder
took 13.735 seconds, clone 0.055 and persistence call less than 0.001. A short
persistence call does not prove a disk write; the existing writer may skip
an ineligible or rate-limited retained receipt.

The index worker's own receipt reports 27.997 seconds, while its parent
wrapper reports 35.556; they are different boundaries. It scanned 25 sources,
including 7 rescans, read 223,428,684 bytes and inserted 6,674 usage events.
Accounting used generation 21066, matched its generation fingerprint and
reported zero raw-source fallback. The index still explicitly reports partial
tool provenance; successful accounting is not a claim of complete tool data.

Both proof phases report `origins_unknown`; lookup and retention consequently
report `proof_unavailable`. Thus this result was not retained as process-local
proof-backed reusable calculations. Missing origins can prevent later reuse,
but this pass also changed real usage inputs: the evidence does not establish
that its rebuild was unnecessary. No origin fence was removed or relaxed.

Across 23 status observations, no request failed or timed out; the slowest
observed response was 4.134 seconds. This samples the local control route and
does not prove every native renderer request was responsive. These first-run
numbers do not reconstruct the earlier six-minute execution or constitute a
controlled before/after optimization benchmark.

The artifact directory retains content-free `ARTIFACT-RECEIPT.json`,
`ZIP-RECEIPT.json`, `SOURCE-STABILITY.json`, `LAUNCH-RECEIPT.json`,
`REFRESH-OBSERVATIONS.json` and `REFRESH-RECEIPT.json`. The normal app remains
running. No install, commit, signing, publishing or manual real-index rewrite
was performed.
