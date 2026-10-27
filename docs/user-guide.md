---
title: Local application guide
date: 2026-10-23
type: guide
status: maintained
---

# Local application guide

衡川 · Rhetrion is an unpublished local Windows x64 usage monitor. No public
download or update feed is configured. Build, native, GUI and installed-release
qualification remain separate; see [current status](./current-status.md).

## Local analysis

The Electron window presents the loopback companion's validated usage evidence.
The source companion can also serve the local dashboard for development.
Codex is the only supported usage provider. Claude collection, callbacks,
transcript export and provider-specific pricing are retired. Existing Claude
profiles, settings, ledgers and credentials are left untouched; retained
records in existing versioned formats can only appear as historical readback.
That preservation does not change their original contract status or imply
current provider support.
Choose the intended Codex folders, then use Refresh to advance bounded indexing.
Long histories can need more than one pass. Keep unknown, partial, stale,
unpriced and unattributed states visible; an unavailable observation is not zero.

Overview, usage, allowance and model-performance views describe recorded
observations and estimates. They are not provider-authoritative billing or quota
formulas. Changing the display period does not delete accumulated evidence.
Local analysis works offline and the HTTP service binds only to loopback.

Codex `sessions`, `archived_sessions`, bounded thread metadata in `state_5.sqlite`,
local `config.toml` and the app-server methods `account/read`,
`account/rateLimits/read` and `account/usage/read` have distinct coverage and
privacy boundaries. Prompts, responses, raw commands, credentials and session
contents must not enter derived reports. Private paths stay in the owner-only
local index. Projects & threads labels are local-display metadata and are not
exported or uploaded. Project grouping uses explicit Codex assignments,
including non-Git projects, and verified parent inheritance for subworkers.
Only explicit projectless markers appear as Non-project tasks; missing or
conflicting membership remains Unassigned. A bounded read of Codex's global-state
file supplies these current assignments without rewriting historical usage.

## Settings and optional features

General, tray, notifications, data, X and About are the settings categories.
Source selection, language, appearance, refresh and tray preferences belong to
their existing owners. The optional X reader uses a separate protected session;
its network activity does not include local usage evidence. A missing native or
notification capability stays unavailable instead of being inferred from the UI.

English, Simplified Chinese and Spanish are supported interface languages.
The product name and icon are presentation only; internal package IDs, executable
names and profile paths do not change with language or future branding.

There is no community sharing, contribution upload, hosted sign-in or remote
administration surface in this product. Saved opt-outs, salts, identities and
receipts remain intact. Source retirement does not delete former remote data.

## Data and recovery

The executable composition fixes independent profile paths under
`%APPDATA%/UsageMonitor/profiles/<profile>` before Electron readiness. Existing
state is not automatically imported by an old brand name. Real cutover requires
its separate verified backup and migration workflow; it is not yet accepted.

Keep original data and all backups. Do not relabel SQLite versions, destructively
downgrade, wipe AppData or reset credentials to resolve an error. Diagnose and
rehearse on a copy. A rollback must preserve data written after activation.
See [local recovery](./runbooks/local-index-recovery.md),
[local data and privacy](./reference/local-data-and-privacy.md) and
[support](../SUPPORT.md). Diagnostics can be reviewed and copied locally; no
external support form or private reporting destination is configured.
