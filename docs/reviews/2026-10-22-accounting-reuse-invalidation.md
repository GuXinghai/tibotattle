---
title: Accounting reuse invalidation investigation
date: 2026-10-22
type: review
status: source-validated
---

# Scope and acceptance boundary

Investigate repeated full accounting rebuilds in the running Windows candidate
and repair only reproduced defects in source. Preserve existing working-tree
changes and the workload-card preview. Live inspection is limited to read-only,
content-free aggregates and artifact code; no real-state migration, rebuild,
application restart, packaging, installation or commit is authorized.

This checkout starts at `94cc26f3a63fc12b726fd47da8a83b44ba27e425`
with pre-existing uncommitted changes. The inspected candidate is
`candidate-short-term-load-cache-20261022`; source tests cannot qualify that
unchanged running artifact.

## Bounded plan

1. Check individual reuse gates against the current artifact and permitted
   aggregate state. Distinguish missing proof, input changes and age expiry.
2. Reproduce capture-only invalidation with synthetic evidence. Verify that
   identical accounting results are rejected because the revision changes.
3. Separate queued runtime evidence from applied ledger changes with the
   smallest forward trigger update, preserving all facts, publication fences,
   origin requirements, cancellation and cache age.
4. Validate capture during a build, repeat refresh reuse, actual model repair,
   existing-v8 forward correction and read-only refusal boundaries using only
   synthetic state. Run focused tests and relevant mechanical checks.

## Runtime observations and limits

The running artifact and source have the same capture implementation and
process-local reuse implementation. The artifact's store code installs
calculation triggers on `runtime_model_evidence`. Its normalized store-module
SHA-256 is
`68d673d1fbfe871b2c18899ecf210625e5dd6e2d16757f4aae1441d32a9530ae`;
the normalized reuse-module SHA-256 is
`039e91f4a32b02d89b829cbc0858bfc7fd57f2acba219a3692122d7261efd485`.

Read-only snapshots observed a changing calculation revision while the
publication sequence remained fixed during a long refresh. The saved cache
had zero fallback, available weekly intervals and the matching publication
generation. Selected-thread row-presence probes, including the native
read-only guard, found no missing rows. These probes selected IDs internally
and returned aggregate presence only; they did not read thread titles,
classification payloads or rollout content. Missing origin rows are therefore
not the confirmed trigger in this observation.

The live API does not retain each rejected proof or expose its exact miss
reason. Individual past misses cannot be reconstructed exhaustively from its
receipt. Live state also contained genuine new usage and source replacements;
such changes legitimately invalidate full accounting. No claim is made that
the correction below eliminates every rebuild or bounds refresh duration.
Private aggregate counts and paths are deliberately not copied into this
record.

## Confirmed failure chain

1. The 30-second capture timer inserts model receipts and its checkpoint. It
   reports `applied: 0` and does not advance the publication sequence.
2. The old receipt-table triggers nevertheless advance `calculation_revision`.
   Accounting does not consume these queued rows; only foreground
   `reconcileRuntimeModelEvidence` uses them to update usage facts.
3. `readProof` includes the calculation revision in its key. A capture during
   accounting makes the before and after keys different. `remember` rejects
   them and retains no process-local calculation.
4. The next refresh misses reuse. Under normal settings, the runner also cannot
   qualify the durable result without the matching process-local proof, so it
   rebuilds again. Capture between refreshes can likewise invalidate an
   otherwise stable retained calculation.

A fully synthetic reproduction inserted one unmatched successful-response
receipt using the real capture function. Publication ID, fingerprint, all
usage facts and the entire fixed-clock accounting cache remained identical;
the revision increased, proof keys diverged and `remember` refused the result.
This confirms the defect independently of the incomplete live miss trace.

## Minimal correction

Only `src/local-index-store.js` changes production behavior. New stores omit
the receipt queue's three calculation triggers. Validated writable opens of
existing v8 stores remove those exact triggers in a short transaction when
present. Read-only opens do not write; a partial failure rolls back all three
changes. Facts, receipts, revision values, publication sequence and physical
schema version are preserved. This source correction was exercised only on
synthetic stores, never on the running profile.

Actual model repairs and conflict retractions still update `usage_event` and
advance the revision and publication. Other fact, quota, origin, speed,
generation, file-identity, fallback and age conditions remain intact. A restart
still requires a first calculation, and reuse does not renew the original
30-minute evaluation clock.

The audit also reproduced conservative invalidation for parser carry metadata
and equivalent rescans containing quota. They are not included in this fix:
the latter requires canonical/admission reconciliation, and neither is needed
to repair the confirmed capture-only defect. Unknown-origin behavior and
unavailable weekly-interval retry policy are also unchanged.

## Synthetic validation

The new regressions failed against the pre-fix behavior. After correction,
the focused files pass **19/19** on Windows x64, Node.js v22.21.1:

```text
node --test --test-concurrency=1 test/local-index-accounting-reuse.test.js test/runtime-model-evidence.test.js test/local-index-store-v7-migration.test.js
```

They cover capture during a calculation, exact equality of complete accounting
results, a subsequent `reused` refresh with the original evaluation time,
genuine usage changes, applied repairs and conflicting-receipt retractions,
existing-v8 trigger correction through both writable entrypoints, read-only
preservation, injected mid-correction failure, retry, idempotency, future-schema
refusal, cancellation and the existing origin/speed/age/file fences.

The focused run also exposed a pre-existing synthetic v5 fixture that merely
relabelled a v8 store while retaining its revision column and triggers. It
failed with the new correction disabled as well. The fixture now constructs
the actual predecessor structure before exercising the existing forward path;
no production downgrade or assertion weakening was added.

`pnpm run architecture:check`, `pnpm run docs:check` and
`pnpm run test:preflight` passed, including the 20 documentation/guidance tests.
Final scoped review found no further safety or compatibility defect. Existing
unrelated edits remain unstaged and preserved. No broad suite or native runtime
performance acceptance is claimed. The running candidate has not been changed,
restarted or repackaged.
