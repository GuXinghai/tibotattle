---
title: Current product and qualification status
date: 2026-10-27
type: status
status: current
source_commit: 8597769cbd3def4b2683ec0d3ec6fb6f949cb233
observation_date: 2026-10-27
---

# Current product and qualification status

衡川 · Rhetrion is an independent, unpublished local Windows x64 product.
Source version 0.1.27 is a development identifier, not a published release.
Codex is the only supported usage provider. The owner accepted the
[Codex-only scope](./decisions/2026-10-27-codex-only-product.md) on this date;
active provider cleanup and the subsequent debt repairs are included at the
source revision above. Historical format readback does not enable a retired
provider. The committed repairs and their isolated validation do not establish
release qualification.
The [identity and cloud-retirement decision](./decisions/2026-10-23-local-product-identity-and-cloud-retirement.md)
supersedes inherited service and publication wiring. No download website,
update feed, signing account or external support destination is configured.
No remote resources were modified by the source retirement.

## Evidence boundaries

Brand configuration, neutral package identity and explicit profile paths are
implemented in source. The approved editable SVG and raster/ICO/tray variants
are included. Source staging has completed on Windows with Node 26.2.0.
This is not installed-app, signing, updater or migration acceptance.

The native binary's manifest deliberately retains `productionSafe: false` and
`pathWalkRaceSafe: false`. Narrow source-read, release-operation and browser-profile
capabilities do not establish full profile migration or general production safety.
Unexpected credential prompts remain a release blocker.

Ordinary tests now use disposable synthetic homes and state; real credential
qualification is a separate explicit gate. Earlier testing exposed an unsafe
default-backend test, so earlier assertions that local audit state was unchanged
are not verified. The repair does not inspect, recover, or roll back that state.

The source includes the separate `windows-report-publication-v1`
capability. Its exact Node 26.2.0 native build passed isolated Windows
synthetic tests for protected creation/replacement, ACL/link/path refusal,
bounded bytes, concurrent writers and no-clobber failure cleanup. The default
CLI JSON/Markdown writer uses this capability, with no JavaScript filesystem
fallback. Missing or mismatched capability still fails before destination
creation. The capability covers fixed local drives and cooperating writers in
one Windows session, not hostile same-user conditional replacement or
power-loss durability. Global safety flags and installed/release gates remain
unchanged.

Expanded synthetic native regression exposed an existing timing SQLite
hot-journal recovery gap: the read-only schema preflight returns
`SQLITE_READONLY_ROLLBACK` (776) before writable guarded recovery. A separately
rebuilt baseline binding reproduces the same failure. The report-specific
tests passed, but the broader native filesystem suite is not fully passing;
this recovery debt remains open. Those regression runs used synthetic databases.
The subsequent migration investigation read real database headers only, without
opening a SQLite connection or changing data.

The repair adds local-index schema 9 without guessing missing historical tier
provenance, and export workspace v0.6 / physical schema 6 with exact private
Windows identities and durable auxiliary-read reservations. Older export
workspaces are refused before writable configuration, not converted or relabeled.
Collector SQLite files now require native protected-DACL creation/checks;
unprotected older state is preserved and refused, not repaired implicitly.
These are source and isolated synthetic-test results, not a real-data upgrade.
The owner scoped remaining ACL/workspace compatibility to a
[one-time controlled pre-release migration](./decisions/2026-10-27-pre-release-state-migration.md).
It does not require permanent old-format writers. The current concrete upgrade
is local-index schema 8 to 9, with collector schema 1 preserved. No old export
workspace has been found in the bounded filename-only checks; that is not proof
of absence elsewhere and is not a reason to run a speculative workspace upgrade.
The new upgrade tool and its acceptance remain unfinished.
The [HTTP cache backport gate](./runbooks/2026-10-27-http-cache-backport-verification.md)
replaces the expired build dependency exception without any OSV suppression;
an actual scanner run and hosted CI remain separate evidence.

The prior brand/usage cutover is complete, separately from this new format
upgrade. On 2026-10-27 the owner relayed another chat's read-only verification of
the historical `activated_verified` receipt, restored-permission receipts and
the current `activated / existing_only` startup policy. Its execution tools are
ignored local files under the candidate checkout's `.release-build/brand-cutover`;
checking out a commit alone does not recover those tools or receipts. This
source-status update does not independently requalify that historical operation.

The authoritative source for the new upgrade is the active stable profile's
`companion-state`, under the neutral `UsageMonitor` state root, plus only the
reviewed calculation settings from its sibling `desktop-settings`. The older
TiboTattle source and its prior backup/conversion are historical preservation,
not a substitute for a new cold backup containing post-cutover history. The
read-only header observation found index schema 8 and collector schema 1; the
application and its index WAL were active, so this is not cold-snapshot proof.
The schema 9 upgrade has not been executed on real data.

The running candidate source revision `de8edcc8` accepts index versions only
through 8 and rejects schema 9 with `local_index_newer_version`, including on
read-only opens. It must not be used as the upgraded index reader. Preparing a
compatible exact candidate is a prerequisite, not a post-upgrade repair. Its
later desktop changes and the current source diverge; a whole-branch merge
requires separate integration review and cannot be treated as a routine build.
The copy-only conversion entrypoint also needs protected SQLite sidecar
lifecycle acceptance before real use; the ordinary evidence writer forces WAL.

The [usage-only scope](./decisions/2026-10-25-usage-only-state-cutover.md) remains
in force. New protected backup/readback, copy-only conversion, semantic
continuity and compatible candidate admission are required before the format
upgrade's separate activation. Do not replay the old brand activation or alter
its existing startup policy implicitly. X, background and generic Chromium
state remain outside this upgrade. The legacy continuity-copy bundle is not
the selector for either the active usage bundle or this format upgrade.

Current work and exact outstanding gates are tracked in the
[cutover plan](./plans/2026-10-23-rhetrion-brand-identity-and-local-state-cutover.md).
Passing a source gate never proves physical Windows, packaged, installed,
signed-release, updater or public deployment behavior. Retained historical
receipts apply only to their own original project, source, bytes and dates. No
user-owned Claude profile/source content, settings, ledger, callback state,
credential, or file has been inspected, moved, or cleaned up for this decision.
