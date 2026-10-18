---
title: Opt-in crash capture and support doctor
date: 2026-09-21
type: decision-record
status: current
---

# Opt-in crash capture and support doctor

The Electron **Show diagnostics** action is the small support doctor. It displays
the closed, content-free diagnostics projection before offering copy or a
prefilled GitHub issue. Opening the issue form is a deliberate action; the user
can edit it before submitting. The issue body contains no raw crash report,
dump, private path, account identifier, session content, or native error text.
The GitHub issue form is an external destination, so even its URL may be logged
by GitHub when opened. Do not add automatic submission or a second support
ingest route under this decision.

Native Electron crash capture is not offered. The macOS-only Crashpad capture
preference, its Apple crash-report reader, and the `diagnose:desktop-crash`
macOS command were removed under the [Windows-only platform decision](./2026-10-12-windows-only.md).
No crash dump is started, attached to the doctor, or uploaded by TiboTattle.
The doctor reports only the content-free projection and startup record below.

The Electron main process also overwrites one owner-only, content-free startup
result per launch in `startup-diagnostics/startup-diagnostic-v1.json` under the
selected Electron user-data root, separate from migration-owned settings and
companion state. Windows writes use the branded protected state store, with
native owner-only DACL, owner, reparse-point, link and replacement-identity
checks; POSIX mode bits are not a Windows permission gate. If that store is
unavailable, this optional journal is omitted without an ordinary filesystem
fallback. Early recording therefore does not occupy a native handover
target. The independent doctor reads this location first, falling back to the older `desktop-settings` location only when the new
record is absent; unsafe or invalid current evidence is not hidden by an older
record. It contains only version/platform labels, timestamps, the
last fixed startup phase, outcome, and an allowlisted code. Each startup phase
now attempts to save its checkpoint before work begins, and deliberate early
quit paths attempt to save a stopped result before quitting. A handled startup
failure attempts to save its result before the deliberate quit. When these
writes succeed, the independent doctor can distinguish credential,
settings, lifecycle, and updater failure families without retaining an exception
message or path. The released v0.1.24 journal wrote only its initial and terminal states:
`in_progress at profile_selection` in that release does not prove the process
stopped during profile selection; it may have proceeded to a later phase and
quit before the terminal write.
No private crash export mode exists. Raw crash contents may contain paths and
process memory, so none is created or transmitted by TiboTattle. Public issues
continue to receive only reviewed summary text.
The doctor script is included in the reviewed Electron runtime closure and can
be run through the installed executable with `ELECTRON_RUN_AS_NODE=1`, which
bypasses the app entrypoint. Source tests validate the preference, startup
journal, and projection boundaries. Packaged-source validation establishes the
file is present; installed, signed-release, and updater behavior require their
separate evidence.
