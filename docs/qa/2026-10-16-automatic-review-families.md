---
title: Automatic review family attribution real-profile validation
date: 2026-10-16
type: qa
status: verified-local-candidate-with-known-test-failures
---

Scope: owner-approved local Windows usage-display correction. Source logs,
ledger facts, event prices, database schemas and refresh cadence are unchanged.
This is unsigned local-candidate evidence, not installed or signed-release proof.

## Implemented behavior

The usage-only resolver verifies review classification against bounded local
session headers, including compressed and legacy headers. It follows explicit
worker ancestry without reading task titles or transcript content. Missing,
conflicting, inaccessible, cyclic or internal terminal parents stay unlinked.
The pre-existing navigation ancestry facade keeps its original contract.

Review cells participate once in task-family aggregation before filters,
ranking and pagination. Detail contributions partition primary, subworker and
automatic-review usage; they do not add to the family total. Exact worker
queries retain their original scope. Unlinked reviews receive an explicit
localized label and have no navigation link to the internal review thread.
Saved anonymous reports keep their existing schema and disabled detail access.

## Candidate identity

Runtime source: `90547968960619db0020cece51e1fe64cdb2e77e`.
Local build: `2026101601`, Windows x64, Node.js 26.2.0,
Electron 43.5.0, electron-builder 26.15.7.

ASAR SHA-256:
`212058281965c0282a7d02c55824545b0e554a0c1b3111509413bdff6ca2e329`.
Executable SHA-256:
`880381899150f04d010a09ce24b4daf8c86bb1f13a3e022782822000025ab853`.

The prior usable candidate remains on disk. Source closure, native dependency
bytes and packaged metadata were verified. The full NSIS pipeline supplied the
updater configuration; its installer was not executed. An initial launch
encountered the still-running prior single instance. Its exact path was checked,
that prior candidate's process tree was stopped, and the new candidate started
normally at 2026-10-15 16:01:07 UTC with the real profile.

## Validation and retained failures

- Final normal-permission UI gate: 1,005 passed.
- Focused reporting and UI: 109 passed; final reporting-only check: 24 passed.
- New relation and existing guardian-navigation checks: passed.
- Production Windows metadata and local-index invariant checks: 10 passed.
- Architecture: 578 production files, 2,311 imports, no approved debt edges.
- Preflight: 20 passed; canonical browser translations regenerated and checked.

The expanded local gate had 298 passes, three failures and one skip. Two failures
also reproduce with pre-change production modules from `c3833b61`: a retired
allowance-tank asset remains in a test's asset list, and a search assertion still
expects the global total instead of the matching-result subtotal. The current
dashboard does not import those retired tank modules. A Windows temporary-DB
cleanup race caused the third failure; its focused rerun passed. No assertion
was weakened or unrelated test rewritten.

The broad metadata file has six Windows-specific failures that also reproduce
with the pre-change module: a Node-open spy cannot observe native handle opens,
POSIX chmod is mistaken for Windows permissions, and four repository assertions
expect POSIX paths on Windows. The production Windows parity tests pass.

A sandbox-only UI run refused a temporary generated-mirror rename with EPERM.
The final normal-permission run above passed; sandbox refusal is not a passing
gate or a product regression.

## Real data

All 534 available raw review headers agree with their thread-store guardian
classification. Of those, 522 have verified accessible parent relationships;
12 legacy records lack a reliable parent. The current all-history report
contains 735 task families, including 10 explicitly unlinked reviews with usage
in that report's retained scope. These are different coverage boundaries.

The fixed-cutoff stored-fact comparison preserves amount, Token and event
totals in all four periods. It checks 1,035 family rows, contribution partitions,
model filtering and linked-review removal from the first-level ranking.
All 690,812 frozen original lifecycle/usage/quota facts remain unchanged, with
valid SQLite integrity and foreign keys.

The normal running seven-day report at 2026-10-15 16:03:16.658 UTC reconciles
exactly to `468.46453844` USD and 3,251,412,225 tokens across five projects and
48 task families, with 95 model rows and 99 contribution rows. Thirty-five
families contain automatic-review contributions. Search subtotals, all pages,
parent/model/participant sums and global headline totals agree. Linked internal
review titles do not remain as first-level task names.

## Rendered and runtime checks

Browser inspection confirmed the real parent detail's three contribution rows,
full components and models, and the unlinked review label, missing-price marker
and absent internal navigation link. A 360-pixel viewport keeps the modal and
review row with no page-wide horizontal overflow; the viewport was reset.
Manual refresh succeeded from 16:03:10.069 to 16:03:43.474 UTC.
The first automatic refresh succeeded from 16:08:43.487 to 16:09:18.410 UTC.
The open detail retained the same parent link and automatic-review row.
The second automatic refresh succeeded from 16:14:18.422 to 16:14:51.426 UTC,
again retaining that parent and review row. Its fixed-cutoff report reconciles
exactly to `470.10822774` USD and 3,261,974,023 tokens across the same five
projects, 48 families, 95 model rows and 99 contribution rows. Browser console
inspection found no errors.

The actual Electron main window was created, responsive, and its overview pixels
were inspected through Computer Use. Another application reclaimed the foreground
during input, so further native clicks stopped to avoid disturbing user activity.
Native usage-detail interaction is not claimed; the full detail interaction
checks above are browser evidence for the shared renderer.

The bounded observer completed at 16:17:05.604 UTC after 905 seconds and 90
samples. Both automatic cycles and the manual refresh succeeded; no report-time
regression, refresh/scheduler failure or workload issue was recorded. Original
fact preservation was rechecked after observation: all 690,812 frozen facts and
their internal links remain unchanged, with valid integrity and foreign keys.
The main process remains responsive, the native window exists, executable and
ASAR hashes match, and stderr is empty.

An initial event-log query included an older WER event because PowerShell
converted a deserialized timestamp through local time. That initial query was
retained. Comparing the original ISO launch timestamp with event XML UTC times
established that the event occurred at 11:44:05 UTC, before this candidate's
16:01:07 UTC launch. The corrected query found no matching post-launch crash.
No product change was made to hide or suppress an event.

The normal-profile candidate remains running. No installer, signing, publishing,
system application replacement or data deletion was performed.
