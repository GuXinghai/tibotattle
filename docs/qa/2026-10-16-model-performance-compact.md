---
title: Compact model performance verification
date: 2026-10-16
type: qa
status: in-progress
---

# Compact model performance

This record concerns local Windows source and an unsigned local candidate only.
It does not qualify installation, signing, updater delivery or public release.
Existing unrelated working-tree changes and the previous candidate are retained.

## Implementation and artifact

- Compact paired charts, one model/mode toolbar, shared percentile controls and
  one complete paginated modal replace the explanatory stacked layout.
- The server continues to own measurement eligibility, per-turn deduplication,
  speed-mode separation, UTC bins and percentiles. The v5 body and stored format
  are unchanged. Closed runtime diagnostics travel in a separate response header.
- Completed views follow global publication. Pending reads are bounded; selected
  windows are preloaded and other combinations load on demand. Multiple readers
  retain exact independent cutoffs without speculative cache churn.
- Candidate build: **2026101624**, source snapshot
  `944b821f54ee104ebb1e53b47ec051480bb1fc7a`, prepared with Node.js **26.2.0**.
  The production source/ASAR/native resource closure verifier passed. The app was
  launched with its normal real profile, without an isolated user-data directory.

## Verification

Final UI, local, native, browser, real-data conservation and observation receipts
are being finalized separately; no intermediate candidate's elapsed runtime is
counted toward the final candidate's observation gate.

The owner-local receipts are under the ignored
`.release-build/overview-validation/performance-compact` and
`.release-build/overview-validation/performance-compact-checked-runtime` folders.
No real logs, prompts, responses, account identifiers or timing keys were added to
test fixtures or tracked evidence. Tests use synthetic, content-free data.

## Diagnosed conditions and limitations

The existing saved performance receipt has a valid digest and 16 individually
valid v5 snapshots, but its source binding does not match the current configured
source. It is refused and preserved rather than merged into current evidence.
This now has a distinct source-mismatch diagnostic; changed bytes, malformed
structure and invalid digests still report validation failure. Live measurement
loading continues independently of this historical-receipt warning.

Two readers were observed using report cutoffs roughly two seconds apart. Eager
preparation of twelve windows per reader churned the shared twelve-window cache.
The fix preserves the bound and exact cutoffs, warming only the current selection.

The broader additional boundary run has three pre-existing failures in
`test/tool-free-timing.test.js`: the positive sidecar/resume, cancellation and
worker-backfill fixtures are rejected by the Windows parent-directory protection
contract before reaching their intended assertions. The fixture and the relevant
Windows security implementation are unchanged by this work. Their rejection is
not counted as passing coverage, and production permissions were not weakened.

The overview also exposes `work_boundary_conflict` for existing real work evidence.
Its calculation and collection implementation were not changed in this task;
available overview results remain visible alongside the diagnostic. This task
does not repair or relabel those original work records.
