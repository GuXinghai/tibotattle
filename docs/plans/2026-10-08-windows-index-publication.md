---
title: Windows history index publication coordination
date: 2026-10-08
type: plan
status: implemented
---

# Windows history index publication coordination

Scope: fix the reproduced conflict between asynchronous report readers and
replacement of the existing SQLite index on Windows. Preserve the database
schema, identity salt, old publication, history, cancellation and quota refresh
semantics. Source and development-package evidence do not qualify an installed
or signed release.

## Implementation plan

1. Track read-only connections at the unified-index owner, including immutable
   cache-validity readers. On Windows, publication stops admitting new readers
   and waits for existing connections to actually close. Asynchronous readers
   wait for publication; synchronous readers receive a fixed busy code.
2. Bound publication coordination to 120 seconds, preserve cancellation, and
   release the gate on every exit. Retry external Windows sharing conflicts for
   at most five seconds within that same budget, rechecking stage/target identity
   and recovery exclusion before each replacement. Never unlink the live file.
3. Keep reviewed publication errors and retryable source-change errors in public
   refresh results. Display natural, specific English, Chinese and Spanish copy
   while preserving quota results and existing partial-coverage semantics.
4. Test reader draining, admission, cancellation, timeout, replacement failure,
   identity changes, external conflicts and recovery. Reproduce the original
   concurrent report read on a private index copy with its matching identity salt.
5. Run scoped index, refresh, local and UI checks, architecture and i18n checks;
   build an independent Windows Dev package and verify its runtime on isolated
   state. Keep the installed application untouched.

## Acceptance boundary

Concurrent production report reading must no longer cause an immediate EPERM
publication failure. A cancelled or exhausted attempt keeps the previous index
and releases queued readers. A later attempt can succeed without wiping state.
Unknown exception messages and private paths never enter diagnostics or UI.

## Source validation

The reader/publication barrier and fixed failure presentation are implemented.
The original concurrent production report-reader experiment now publishes the
new index successfully on a private copy under Electron 43.5.0 / Node 24.19.0.
The live index's size and modification time remain unchanged.

The new publication suite passes 24 tests, including physical Windows SQLite
replacement, cancellation, exhausted budgets and recovery. Core index/refresh
tests pass 263 with one platform skip; focused UI/i18n tests pass 56. Architecture,
i18n mirrors and documentation checks pass.

Broader Windows gates are not wholly green: the accounting reader suite retains
two tests that also fail against the original source (POSIX mode semantics and
replacing an open SQLite file). The full UI suite passes 1019 and retains an
unrelated admin-render timeout. Local contribution/telemetry failures also occur
against the original source. These are recorded separately from the passing
publication regression and must not be treated as release qualification.

Development-package preparation and exact packaged-runtime verification follow
the source commit. They do not authorize replacing the installed app. The earlier
reported attempt's original error was discarded; its exact historical cause
cannot be reconstructed from the generic public code.
