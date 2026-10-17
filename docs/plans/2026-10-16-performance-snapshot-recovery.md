---
title: Source-isolated performance snapshot recovery
date: 2026-10-16
type: plan
status: complete
---

# Source-isolated performance snapshot recovery

Preserve existing work, raw logs, accounting facts, old timing rows and the legacy
snapshot. No schema relabeling, source reassignment or deletion is authorized.

1. Diagnose retained parser-zero sources against current discovery, retained
   catalogs and file identities using read-only, content-free local summaries.
2. Isolate future snapshots by source. Read a matching legacy receipt only as a
   bounded fallback; preserve mismatched and corrupt receipts and report failures.
3. Distinguish discovered parser repairs from unavailable retained history. Keep
   old measurements and explicit stale/history-unavailable status. Persist only
   validated finished scans, including explicitly stale results whose sole gap
   is unavailable history; never promote them to complete/fresh measurements.
4. Test isolation, legacy fallback, corruption, persistence, restart and recovery
   when missing evidence returns. Verify real data against a protected copy and
   preserve original-fact hashes. Prepare and verify a fresh Windows candidate.
5. Start with the normal profile and hand acceptance to the owner. Per the latest
   request, do not perform post-start UI acceptance or continued observation.
