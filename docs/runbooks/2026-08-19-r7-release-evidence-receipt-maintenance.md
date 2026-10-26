---
title: R7 evidence preservation and readback
date: 2026-08-19
type: runbook
status: maintained
---

# R7 release-evidence receipt maintenance

## Current boundary

New R7 release/resource receipt and evidence generation is retired by the
[Codex-only provider decision](../decisions/2026-10-27-codex-only-product.md).
There is no supported freshness, regeneration, recovery, or replacement
procedure. Do not run the historical generation workflow, change file
permissions to prepare for it, or treat a stale source digest as permission to
refresh the retained evidence.

The v0.1 release-evidence schema requires Claude operation values and fields.
Keep the v0.1 schemas and existing `generated/r7-*.json` receipts byte-for-byte
unchanged for historical readback. Do not narrow or relabel the v0.1 schema,
create placeholder values to make a receipt pass, or introduce a v0.2 schema to
refresh old receipts. A historical validator can establish only that old bytes
match their original contract; it cannot establish current source freshness,
current capability, or release readiness.

`validateHistoricalR7ReleaseEvidenceReceipt` is the explicit readback API. It
retains schema, self-hash, privacy and metric consistency validation without
requiring a historical receipt to match today's source hashes. The ordinary
validator still requires current provenance. Tests pin the retained receipt
bytes and their original input/decision bindings; neither API authorizes
regeneration.

## Required generation guard

Any remaining new-receipt or evidence-generation entrypoint must fail closed
before creating or reading fixtures, reading or writing repository state, or
opening any provider source. Treat generation as unavailable until the source
guard and its negative tests establish that ordering. This document records the
accepted target; it is not evidence that the guard has already passed.

This boundary does not change Codex collection, accounting, quota observation,
or dashboard behavior. Routine source, documentation, and release checks must
not invoke R7 generation or mutate its schemas or retained receipt files.
