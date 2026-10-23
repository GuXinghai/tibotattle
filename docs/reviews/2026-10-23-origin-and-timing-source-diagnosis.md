---
title: Origin evidence and timing source diagnostic investigation
date: 2026-10-23
type: review
status: completed
---

Scope: add bounded, content-free forward diagnostics for origin-proof refusal
and investigate the model-performance recovery warning using read-only live
state. Preserve all origin/accounting/source safety checks, existing dirty
worktree changes and workload preview. No package, restart, install, commit,
real-index rewrite or old-run backfill is part of this task.

## Plan and acceptance boundary

1. Trace origin lookup from protected metadata access to missing selected rows;
   report counts and fixed refusal reasons without IDs, names, source paths or
   session content. Separate unresolved threads with and without usage facts.
2. Inspect primary and supplemental timing stores read-only and reconcile their
   checkpoints with current discovery. Separate absent recovery sources from
   source mutation, read refusal and other failures. Do not repair live stores.
3. Add synthetic targeted coverage for diagnostics, privacy, refusal and
   cancellation; verify accounting/reuse eligibility remains unchanged. Record
   confirmed findings separately from hypotheses and runtime/package gates.

Current API authority: [API surface](../reference/api-surface.md). The preceding
[measured package run](./2026-10-23-refresh-diagnostic-package.md) is a separate
point-in-time receipt, not evidence for the warning's underlying cause.

## Origin evidence: confirmed current finding

Read-only protected metadata lookup selected **3,788** thread IDs. **3,787**
had corresponding rows and **one** did not. The unresolved thread has one
present source, no indexed usage events, and no token-count records. Its source
is fully scanned, not quarantined, and has no malformed accounting/line/usage
records. A bounded source-head check confirmed a session metadata record whose
ID matches the index, with structured origin and an explicit parent. No raw
IDs, paths, source values or session content are retained here.

Thus the present refusal is a missing thread-store row, not a demonstrated
database open, schema, busy-lock or malformed-source failure. Why Codex no
longer has that row is not established. The source also has tool records;
absence of token events alone is not a reviewed proof that every dependent
projection can ignore it. No metadata row was invented, no parent-origin
inheritance inferred, and no origin eligibility gate changed.

Forward diagnostics now distinguish requested/known/unknown counts, missing or
invalid selected rows, unsupported schema, unavailable home/database, database
change, busy/refused reads and close failures. The before/after proof receipt
also separates unresolved threads with and without indexed usage. Counts and
fixed codes are allowlisted; observer failures, aborts and close-error behavior
remain independent of optional diagnostics.

## Timing recovery: confirmed behavior and remaining uncertainty

The screenshot's `timing_source_recovery_failed` comes from the separate
model-performance pipeline, not the accounting refresh. Source inspection
establishes that the old code merges unavailable recovery sources and source
changes during staged replay into that same code. The old package did not keep
the failing source or exact underlying branch; this task cannot recover that
historical distinction from the screenshot alone.

The first native read-only comparison saw one `late` source replay in each
timing store, with 9 primary and 22 supplemental staged rows. All existing
source rows had parser version 18 and replay-parser version 0: this was not a
demonstrated parser upgrade. Three discovered files had grown; no inspected
file had a different native identity, shrunk, changed timestamps at unchanged
size, or failed protected opening. No missing source was in recovery.

A later independent read-only comparison found both stores at **3,884** source
rows, all parser version 18, replay-parser version 0 and rebuild kind `none`.
Both had **17,198** live turns, zero staged turns and zero pending/unavailable/
failed recovery rows. Two previously indexed, completed sources were no longer
discovered; that does not constitute a missing recovery checkpoint. These are
point-in-time reads while the ordinary application continues its own work.

An isolated, protected SQLite backup of the primary store then processed four
selected live/growing sources through **10** ordinary 2-MiB-or-smaller ingestion
batches without reproducing the failure. Original databases were opened
read-only, source files only read, all writes targeted the diagnostic copy, and
the copy was removed after closing native guards and checking cleanup paths.
The first copy attempts were refused by the native owner-protection guard:
SQLite's default output ACL did not qualify. The successful attempt created the
destination with the normal protected-file adapter before backup. Protection
was never weakened. These refusal attempts are not evidence of product-source
failure.

A minimal synthetic regression reproduces the exact general recovery error by
appending a record while a late replay is reading. The existing consistency
guard rejects that batch and retains the prior committed turns and cursor.
It succeeds on a stable retry. Missing files and denied reads reproduce their
separate new detail codes. This proves the mechanism, not that the screenshot's
specific historical request necessarily took that branch.

The strongest supported explanation is an active append racing with staged
timing replay; the current evidence does not demonstrate persistent corruption
or an unrecoverable source. The precise historical cause remains unconfirmed.
New errors retain a fixed content-free detail and expose bounded per-reason
counts through the separate model-performance source-diagnostics header.
Measurement bodies, generic codes and safety/retry policy are unchanged.

## Why a recovered backend can still show the warning

The performance page polls while its result is loading or collecting, with
bounded attempts. A finished ready/stale result with a source warning stops
that foreground poll; the page retains the last response's warning until the
next explicit retry or page entry. The independent worker may subsequently
recover. Therefore the screenshot's old graph and warning do not prove that
the ordinary accounting refresh or the current timing stores are still stuck.
This task diagnoses that behavior and does not change browser polling.

## Validation and remaining gates

The six diagnostic/source test files pass **68**, fail **0**, and explicitly
skip **1**; the separate model-performance contract file passes **38/38**.
The skip is foreign-owner fixture qualification: the Windows runner cannot
assign a foreign owner (`ERROR_INVALID_OWNER`), so that native proof remains
unavailable rather than passed.
The synthetic loopback timing/origin receipt test passes. Coverage includes
missing rows versus unreadable databases, observer rejection, closed/private
input refusal, counter bounds, event isolation, recovery detail deduplication,
concurrent source growth, transaction rollback, missing/read-refused sources,
and a successful stable retry. Architecture passes with 608 production files,
2,417 imports and zero debt edges.

The owning local gate still reports **328 passed, 9 failed, 1 skipped** out of
338. Its failures are the same timestamp fixture and eight completed-work-cache
expectations documented and reproduced against the previous staged server in
the preceding package investigation. They are retained as failed gates.

This is source and synthetic/isolated/read-only evidence. The running app is
still build 2026102301 and has not adopted the new detail fields. No package,
restart, install, commit or manual real-state repair was performed. Workload
preview remains byte-identical. New detailed runtime reasons require a later
authorized build/launch; old warning events are not backfilled.
