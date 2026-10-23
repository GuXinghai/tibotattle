---
title: Electron refresh leases are observable and self-healing
date: 2026-09-21
type: decision-record
status: accepted
---

# Electron refresh leases are observable and self-healing

Amended on 2026-10-21: the local companion owns the desktop business refresh
schedule and single execution pipeline. Electron passes persisted settings and
owns window/connection recovery; it does not run a second hourly business timer.
The dashboard observes companion run IDs, actual capabilities and component
publication rather than inferring work from its own request. A renderer lease
remains bounded, observable and recoverable, without authorizing another analysis.
This amendment replaces the former shell-owned cadence in the desktop composition;
explicit legacy shell-owned embeddings retain their existing scheduling protocol.

## Lifecycle contract

- The renderer starts a lease only after the local companion accepts a refresh.
  The request carries the closed `quick` or `detailed` mode and returns one
  positive integer lease.
- While the operation remains active, the renderer renews that exact lease with
  a numeric heartbeat every 30 seconds. Quick and detailed work use different
  missing-heartbeat bounds so an orphaned quick refresh recovers sooner while a
  detailed renderer has more tolerance for heavy presentation work.
- A separate 243-minute absolute deadline is measured from lease creation and is
  never extended by heartbeat. It exceeds the renderer's current 241-minute
  polling window without allowing a live renderer bug to retain a lease
  indefinitely.
- Terminal settlement is idempotent for the most recently settled lease. A
  valid settlement clears both watchdogs. It never starts business work or rearms
  an Electron business timer in the companion-owned composition. Stale or foreign
  leases cannot change the active run or schedule.
- Dashboard replacement, missing heartbeats and the absolute deadline all clear
  an abandoned lease. They preserve the companion's own
  single-operation authority, cancellation and checkpoint rules.

## Presentation and support contract

- Dashboard and tray observation age are both derived from
  quota `latestObservedAt` (`quotaFreshness` when present) against the current wall clock;
  usage freshness remains independent. A serialized
  `ageSeconds` value cannot keep either surface visually fresh after time passes.
- When an observation crosses its stale boundary, the open dashboard updates its
  timestamp, freshness state, allowance qualifiers and pacing presentation
  without waiting for another API response.
- A renderer that finishes while Electron still reports its lease active shows
  a bounded automatic-refresh recovery message. Unknown staleness remains a
  request to update, not a claim about why provider evidence stopped.
- Content-free diagnostics expose whether the cadence timer and watchdog are
  armed, the schedule owner, active mode and lease age, the latest start, heartbeat, settlement
  and recovery times, and a closed recovery reason. They never expose a lease
  value, path, account identifier, credential or session content.

## Required evidence

The retained regression must exercise renderer lifecycle code through the real
preload request builder, IPC validator and controller for at least two complete
automatic cycles. Fake-clock checks must cover normal settlement, delayed
responses, malformed bridge arguments, heartbeat recovery, absolute recovery,
dashboard replacement and stale-boundary presentation. Browser rendering and an
unsigned package remain separate from installed, signed and updater evidence.

## Companion publication contract (2026-10-21)

The default interval remains five minutes after settlement; `-1` stops periodic
refresh, not the permission-checked startup check or explicit manual requests.
A startup intent runs at most once per companion lifecycle after last-good
initialization. Manual, automatic and startup requests use the same scheduler;
one bounded pending capability set can supplement weaker in-flight work.
Cancellation clears that pending intent. X refresh remains independent.

Quota observation and usage computation stay sequential in this phase. A valid
quota commit can publish a narrow allowance projection before usage finishes.
The run stays busy until all requested work settles; quota and usage failures
remain separately observable and preserve last-good evidence. Saved observation
time, accounting evaluation time and run completion time are distinct. Cached
reads cannot manufacture a new observation. Publication fences reject late or
unprovably scoped results. Concurrent quota work during calculation is not
implemented or qualified by this amendment.
