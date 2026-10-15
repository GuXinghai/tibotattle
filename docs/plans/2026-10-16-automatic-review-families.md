---
title: Attribute automatic review usage to its verified task family
date: 2026-10-16
type: plan
status: implemented-and-locally-verified
---

The owner approved grouping automatic approval-review records into the owning
task's details, with a separate usage contribution. Unlinked reviews remain
visible and explicitly labelled. Source records, ledger facts, pricing and
refresh cadence remain unchanged.

Use matching local thread-store and bounded session-header evidence, including
compressed and legacy review headers. Follow explicit worker ancestry only;
missing parents, invalid headers and cycles must not imply a relationship.
Keep the existing navigation-only ancestry API unchanged. The new usage-only
relation resolver reads no names, messages or command content.

Aggregate each accounting cell once before ranking and pagination. Partition
thread contributions into primary, subworker and automatic-review amounts and
tokens. Model filters and exact worker lookups must conserve the same cells.
Only process-local snapshots retain review classification. Saved anonymous
reports retain their existing schema and totals, and cannot open detail views.

Validate synthetic ancestry, malformed/legacy/compressed metadata, cycles,
unlinked review labels, contribution conservation, pagination and model filters.
Run affected Windows-native and browser tests plus architecture and UI gates.
Reconcile real data at one fixed cutoff and verify frozen original fact hashes.
Prepare a fresh Windows local candidate, preserve the prior candidate, launch
with the real profile, and check startup, report rendering and refresh errors.
Keep browser, native-window, unsigned-candidate and release evidence separate.

Completed evidence and remaining native-interaction/test boundaries are recorded
in the [local candidate validation](../qa/2026-10-16-automatic-review-families.md).
