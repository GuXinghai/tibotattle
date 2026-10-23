---
title: Allowance interval publication failure diagnosis
date: 2026-10-22
type: review
status: diagnosed
---

# Scope and acceptance

Diagnose the normal running application's unavailable Weekly API equivalent
chart and degraded refresh. Preserve the dirty worktree and workload preview.
Do not submit refresh requests, modify live state, package, restart, install,
or commit. Following the owner's expanded authorization, original logs were
examined read-only and a protected local index snapshot was used for isolated
refresh reproduction. Only that copy was written. Retain only fixed errors and
anonymous aggregates in this report, never session contents, identifiers, or
source paths. The private index copy remains in owner-only local diagnostic
storage and is not a fixture or distributable artifact.

1. Verify the running artifact and observe quota, index, accounting and chart
   states independently through read-only routes.
2. Locate the failing publication boundary; reproduce confirmed failures with
   minimal synthetic inputs and compare relevant prior behavior.
3. Record the strongest proven cause, any source-only correction and focused
   validation. Keep native package acceptance and historical recalculation open.

# Conclusion

The v22 overlap guard introduced by the ledger-normalization changes rejects
one retained compressed, paginated source with an unverified modern-response
prefix and legacy increments. This is the confirmed availability blocker.
Returning to the prior acceptance rule would not establish correct accounting.
The prior source-level label corrections cannot resolve this ingestion failure.

An isolated refresh of a consistent read-only backup reproduced
`codex_response_usage_legacy_conflict`. A diagnostic-only in-memory annotation
located the exact source and branch without changing product files. The source
has no `history_base`; its logical length is 828,252 bytes and compressed length
is 60,238 bytes. The response prepass sees 12 responses and one unverified-prefix
turn. The rejecting branch is specifically `unverifiedPrefix === true`:
the legacy increment exists and its required components are present. It is not
the missing-latest or missing-component branch.

The same accounting records were fed in memory to the current reconciler and
the reconciler from HEAD `94cc26f3a63fc12b726fd47da8a83b44ba27e425`.
The prior reconciler accepts; the current one rejects. This proves that the new
guard triggers this blocker, not that the prior result was correct or that the
entire new guard should be removed.

Using the normal stable-source and decompression entrypoints, all 1,898
present, non-quarantined v21 sources in the inspected snapshot were examined:
1,897 passed the standalone extraction check, one failed with the above code;
1,726 were compressed. This check took approximately 30 seconds. Standalone
extraction does not prove cross-source ownership, lineage seeding, global
publication, or complete historical coverage. An earlier physical-file scan
does not qualify compressed payloads; the decoded scan is the relevant result.

# Live observations and failure chain

The active normal 0.1.27 artifact's relevant backend files match the dirty source
under investigation. The later chart-label source changes are absent from that artifact.
Its ASAR SHA-256 is
`8bca037c02a9b82ab7c7f10d4ba7ffb6e7d7a995ed9b9768ec9e7a888eefd2b9`.
The loopback service and its snapshot are ready. Quota publication succeeds;
usage refresh degrades at `unified_index` with the generic public code
`local_unified_index_refresh_failed`. The accounting builder is therefore not
reached. Two observed refreshes lasted approximately 72 and 113 seconds.

The retained v0.23 accounting snapshot, computed at
`2026-10-22T12:09:09.342Z`, is rejected by the v0.24 reader as
`cache_accounting_semantics_outdated`. Its calibration summary remains explicitly
stale; the primary interval projection returns zero rows and
`weekly_api_intervals_unavailable`. These are distinct projections.

The actual sequence is:

1. Provider quota collection and early quota publication succeed.
2. The parser upgrade requests a rescan. The ambiguous compressed source fails
   during its response reconciliation prepass. The source transaction rolls
   back; the overall index refresh does not return an authoritative generation.
3. The refresh runner marks the index failed and skips the accounting builder.
   This is a failure before cache reuse or full accounting reconstruction.
4. The old cache cannot satisfy the v0.24 accounting contract. Its explicitly
   stale calibration summary may remain readable, while the primary interval
   projection has no current cache and no rows.
5. The overview scheduler rearms its 300-second cadence after settlement. It
   runs the same blocked upgrade again. This is repeated index work, not proof
   that full historical accounting has been recomputed on each tick.

Read-only structure checks ruled out a missing runtime-evidence table and a
missing calculation revision column. There are no response-completion receipts
or reconciliation candidates in the inspected runtime-evidence queue. Source
parser aggregates show a partially completed v21 to v22 transition. The separate
runtime-capture error remains unqualified; there were no completion receipts or
reconciliation candidates that could explain this particular failure. No
runtime-capture correction was inferred from it.

# Confirmed observability and presentation gaps

- `src/local-companion-refresh.js` does not allowlist the new fixed legacy
  conflict code. Its public failure becomes `local_unified_index_refresh_failed`.
  Synthetic injection confirms this conversion and zero accounting-build calls.
  Generic degraded index failures also do not enter the existing terminal-failure
  recorder or the budget-deferral-only recorder, explaining why the bounded log
  did not identify this blocker.
- `apps/web/public/app.js` selects `refresh.degradedTitle` whenever quota did
  not fail, including an index failure. It therefore says local analysis is
  complete despite failed usage publication.
- The generic explanatory copy says automatic retries stopped. That statement
  applies neither to the live 300-second overview schedule nor its observed
  repeated index failures.
- The old-version annotation describes the retained calibration estimate, not
  an available interval curve. Its source-only relocation and pending-chart
  copy corrections have not been packaged into the active artifact.

# Verification and remaining correction boundary

No product behavior was changed during this diagnosis. Existing uncommitted
changes and the workload preview were preserved. No live refresh request,
database write, packaging, restart, installation, or commit was performed.

- `pnpm exec node --test --test-concurrency=1 test/codex-ledger-parity.test.js test/codex-response-usage.test.js`:
  30/30 pass on Node.js 22.21.1. These synthetic tests establish the current
  ambiguity rejection, complete-overlap acceptance and rollback contract;
  they do not establish that the live chart is repaired.
- Four explicit synthetic assertions also completed using the active artifact's
  Electron 43.5.0 / Node.js 24.19.0 in Node mode: prior acceptance, current
  ambiguity rejection, exact modern usage with an unknown prefix but no legacy
  overlap, and complete-overlap acceptance. No normal-profile app was launched.
  A separate `--test` invocation produced no test output and is not counted as
  an executed or passing suite.
- Protected-copy refresh and the decoded original-source checks above are
  isolated investigation evidence, separate from synthetic fixtures and native
  rendering acceptance.
- `pnpm run docs:check` passed across 325 Markdown files and 998 source/config
  files. `pnpm run test:preflight` passed root-layout, whitespace, documentation,
  and its 20 governance/guidance tests.

The next correction needs an explicit, testable policy for isolating an
ambiguous source while preserving an honest coverage gap and preventing old
facts from becoming v24-authoritative. Do not delete the source, silently drop
its legacy increments, relabel the old cache, or relax the prefix guard just to
produce a curve. Error-code projection and truthful degraded-state presentation
can then be corrected independently. Complete source publication, recalculation
and a newly packaged native chart remain open gates.

This report records the inspected snapshot, not a claim that all private
historical usage or amounts have passed accounting acceptance.
