---
title: Local refresh ownership and publication implementation
date: 2026-10-21
type: review
status: source-implemented
---

# Scope and evidence boundary

This records phase one of the [refresh architecture plan](../plans/2026-10-21-local-refresh-ownership-and-publication.md)
on the working tree based on `94cc26f3a63fc12b726fd47da8a83b44ba27e425`.
Existing X-reader and accounting/cache changes remain intact. No commit,
packaging, restart, computer automation, installation or publication was performed
for this implementation. The user's currently running candidate predates it.

# Implemented behavior

The existing companion scheduler owns the desktop business interval and one
permission-checked startup freshness check after last-good initialization.
Electron no longer composes a second hourly business cadence; settings delivery,
renderer heartbeat, absolute watchdog, idempotent settlement and replacement
recovery remain. Explicit legacy shell-owned callers keep their old protocol.
`-1` stops periodic work while preserving the startup check and manual requests.
X retains its separate scheduler.

Refresh POST routes return actual run state beside started/joined/pending
acceptance flags. A stronger request during weaker work creates at most one
merged follow-up. Cancellation and timeout discard pending intentions. The
execution `running` flag remains true until the writer settles, even if the
public outcome has already timed out; this is not permission to start another
writer. The browser observes actual capabilities and pending state rather than
retaining an independent local task intention.

A valid quota commit invokes a narrow quota projection before usage computation.
It does not read accounting/calibration or clone retained usage. Quota and usage
outcomes are separately observable; already published quota survives a later
usage failure. `quotaFreshness` is separate from usage freshness, generation and
evaluation times. Future quota timestamps remain stale with unknown age. Reading
an unchanged cached observation does not manufacture a new provider observation.

The data store uses publication ordering and same-read account-scope proof to
reject late or unprovably scoped replacements. Scope proof remains internal in
WeakMaps and the validated worker envelope, never dashboard JSON, diagnostics or
durable snapshots. Unknown-account sequential full publication remains allowed;
unknown or changed-account interleaving cannot borrow a prior identity. Full
snapshot persistence keeps its existing authority checks.

Automatic, manual and newly observed runs share busy/progress/cancellation UI.
Quota publication can update the allowance while the icon remains busy for usage.
Network reconnection, scheduler failure, component failure and completion are
distinct. Foreground restoration re-reads state and age without submitting a
second business refresh. Reduced-motion behavior remains supported.

Tray display can retain verified quota after usage failure/cancellation, without
promoting it to notification authority. Existing provider-only notification,
continuity, freshness and deduplication gates remain unchanged. A long usage run
can still outlive the notification evidence window; early-notification delivery
was not added or claimed.

# Targeted validation

Owning tests cover controller/scheduler behavior; real loopback client requests,
join/upgrade/cancel and timeout writer settlement; narrow quota publication and
account-scope collisions; off-main closed envelopes; renderer observation,
independent freshness, recovery and request routing; Electron lease/diagnostic
integration. Only affected files or selected named cases were executed, not a
full product or workspace suite. Final integration and governance results are
listed separately below; overlapping owning runs are not summed:

- Controller/scheduler: 123 tests passed; Electron controller/diagnostics/lease
  integration: 50 passed, plus one selected runtime diagnostic case.
- Narrow quota publication: 22 passed, with targeted worker-envelope, retained
  store and authoritative-persistence checks also passing.
- Parent integration: 35 tests passed across quota publication, tray status,
  i18n foundation and API inventory. Final real loopback startup/join/upgrade/
  cancellation/timeout checks: six passed.
- Final web refresh/notice/lease/freshness checks: 55 passed, including actual
  controller timeout and real polling-budget regressions.
- Architecture, browser/Electron catalog checks, documentation and preflight
  passed; preflight includes 20 documentation/guidance tests. Whitespace checks
  passed. These are source/synthetic gates, not Windows app proof.

An independent read-only review found and drove fixes for missing execution
ownership in the receipt, a pending strong-request wait after timeout, and
continuation attempts before the old writer settled. Regressions use real
controller state rather than inventing the execution flag in a UI stub.

# Remaining evidence gates

Quota projection retains bounded memory but traverses quota records linearly,
with cooperative yield and a row limit; it is not constant-time or proven free
of SQLite lock waits. No concurrent quota execution or new worker was added.
Real-source latency, long calculations, Windows sleep/resume timing, actual tray
notification delivery and rendered Electron behavior remain unqualified by the
synthetic/source checks. A fresh package and user inspection are separate future
gates; installed, signed-release and updater gates are outside this task.
