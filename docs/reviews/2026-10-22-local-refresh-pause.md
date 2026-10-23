---
title: Persistent local refresh pause
date: 2026-10-22
type: review
status: source-verified
---

Scope: preserve the existing dirty checkout; add a neutral icon above local
Refresh, leaving X independent. No full test suite, installation, or publication.

1. Persist a boolean in forward-only desktop settings v5, migrate v4 to false,
   and retain the configured interval while paused.
2. Pass the choice through trusted main-frame IPC and parent-only scheduling
   configuration, including child startup and recovery. The companion's one
   scheduler refuses submissions and cancels active/queued work while paused.
3. Show pause/resume and a persistent paused label; retain report reads and
   expose save/application failure. Resume only rearms the normal cadence.
4. Validate migration/reload/write failure, exact bridge messages, in-flight
   cancellation, pause/resume races, settings changes while paused, and UI.
   Keep source, rendered Electron, and packaged/installed evidence separate.

Source verification on Windows: focused store, controller, preload/IPC,
parent-child IPC, scheduler and web tests pass. An isolated real loopback server
confirms startup and all three refresh routes stay blocked while paused,
pending demand is cleared, and resume preserves the interval. Architecture and
generated i18n checks pass. Electron 43.5.0 renders the actual sidebar markup,
styles and pause module, with stable pause/refresh/settings geometry across
pause/resume. The render harness uses synthetic state and does not mutate the
owner profile.

Two broader first-run runtime fixtures cannot complete their Windows protected
state-store setup in this environment. They are not passing evidence for this
change; the directly affected trusted-main-frame runtime test passes. No full
suite, installation, release, or system-setting change is included.

## Startup regression and correction

The initial candidate snapshot `99010ade36ceba419eedea1d29fba13ef629f8b0`
mounted the pause control before the `allowancePage` binding was initialized.
The control immediately publishes its state; the app callback synchronously
calls `updateLocalActionButtons`, which reads that binding. Electron 43.5.0
reproduced `Cannot access 'allowancePage' before initialization`, zero primary
API reads, and a persistent saved-results loading placeholder. The earlier
component render did not exercise the complete app module and missed this.

The mount now follows the page controllers. A retained Electron regression test
loads the actual complete HTML/module graph with isolated synthetic state,
checking English, Simplified Chinese, Spanish, and a failed primary read. All
four cases reach the app-owned ready marker, issue primary reads, enable the
pause control, and report no uncaught renderer errors. The user-requested footer
and its English/Chinese/Spanish legacy translation entry are removed.

These are complete-renderer source checks; the candidate's exact-byte packaging
gate and actual user-profile launch remain separate evidence.
