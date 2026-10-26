---
title: Current product and qualification status
date: 2026-10-27
type: status
status: current
source_commit: fdd66671bf643b09f2b3b2e957e20db17778d45a
observation_date: 2026-10-27
---

# Current product and qualification status

衡川 · Rhetrion is an independent, unpublished local Windows x64 product.
Source version 0.1.27 is a development identifier, not a published release.
Codex is the only supported usage provider. The owner accepted the
[Codex-only scope](./decisions/2026-10-27-codex-only-product.md) on this date;
active provider cleanup was committed at the source revision above. Historical
format readback does not enable a retired provider. Subsequent debt repairs and
their isolated validation are working-tree changes, not a release qualification.
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

Generic atomic report publication currently fails closed on Windows because no
qualified general publisher is available. This deliberately blocks unprotected
report writes before creating directories or files; it is an availability gap,
not successful native publication evidence. Source-reader and installed-app
capabilities remain separate gates.

The repair adds local-index schema 9 without guessing missing historical tier
provenance, and export workspace v0.6 / physical schema 6 with exact private
Windows identities and durable auxiliary-read reservations. Older export
workspaces are refused before writable configuration, not converted or relabeled.
Collector SQLite files now require native protected-DACL creation/checks;
unprotected older state is preserved and refused, not repaired implicitly.
These are source and isolated synthetic-test results, not a real-data upgrade.
The [HTTP cache backport gate](./runbooks/2026-10-27-http-cache-backport-verification.md)
replaces the expired build dependency exception without any OSV suppression;
an actual scanner run and hosted CI remain separate evidence.

Real application data has not been moved or converted. Scope update, 2026-10-25:
the owner approved [usage-only cutover](./decisions/2026-10-25-usage-only-state-cutover.md),
not whole-profile migration. A protected cold backup/readback of the explicit
usage bundle, timing conversion, semantic continuity checks and journaled
activation/recovery remain required. X, background and generic Chromium state
are not migrated and stay untouched at the source; their restart/decryption or
helper-registry rebinding is not a usage-cutover gate. The bounded legacy
continuity copy is not a usage-bundle selector or complete migration tool.

Current work and exact outstanding gates are tracked in the
[cutover plan](./plans/2026-10-23-rhetrion-brand-identity-and-local-state-cutover.md).
Passing a source gate never proves physical Windows, packaged, installed,
signed-release, updater or public deployment behavior. Retained historical
receipts apply only to their own original project, source, bytes and dates. No
user-owned Claude profile/source content, settings, ledger, callback state,
credential, or file has been inspected, moved, or cleaned up for this decision.
