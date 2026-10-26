---
title: Limit the local state cutover to usage computation and history continuity
date: 2026-10-25
type: decision
status: accepted
---

# Decision and scope

Owner direction on 2026-10-25 narrows the brand/identity transition to
**usage computation and history continuity**, not whole-profile migration.
This supersedes whole-profile, background, Chromium and X migration prerequisites
in the [earlier cutover plan](../plans/2026-10-23-rhetrion-brand-identity-and-local-state-cutover.md).
It does not remove the optional X feature or change its independent runtime
security contract. Implementation and real-data acceptance remain unfinished.

## Latest owner amendment: bounded timing omission

After the bounded path-recovery attempts, the owner chose to stop spending
effort on the three unresolved timing sources. Rebinding the one located
source to its current path is not a simple supported conversion: the converter
requires the original source-path HMAC and reproducible prefix evidence.
Use the owner's fallback: omit all three from the future converted target,
without further path recovery or provider-content reads for these sources.
This supersedes the earlier requirement to recover and rekey every one of
these three sources; it does not permit skipping other unresolved dependencies.

The reviewed loss is three source rows and two completed measurements in each
of the current primary and supplement stores, with no pending turns or replay
rows in the selected sources. These are two projections, not four independent
accounting events. The index, collector, token/cost/quota/account attribution,
original salt, unrelated timing sources and dated snapshots remain unchanged.
The previously observed current-store count would become 17409 measurements
per store, from 17411; revalidate exact identities, row hashes and loss bounds
against the protected backup before a real conversion. Changed evidence blocks
this exception rather than broadening it.

Bind the exact selected rows and whole-store review to the durable conversion
intent. Preserve source and backup bytes, including the omitted records; do
not delete provider files, rewrite originals, infer zero measurements or replay
these sources as another accounting input. Retained snapshots stay dated and
must not be silently rewritten to match the converted target.

This amendment authorizes preparing and validating the scoped omission. It
does not perform a real conversion or activation, waive remaining safety gates,
or resume the otherwise paused physical cutover.

## Subsequent owner direction: resume subject to readiness

The owner subsequently requested starting the main migration if the remaining
preparations were complete. This lifts the earlier conversational pause for
readiness work; it does not treat synthetic omission acceptance as complete
bundle acceptance. Preserve the three-source omission decision above.

Before real source mutation, the readiness review must close the historical
timing 4/5 preservation/conversion boundary, the retained archive and v5 snapshot
selection, and the exact-resource activation/recovery orchestration. The current
10/11-to-12/13 synthetic fixture does not cover these older real-source
dependencies. General production/path-walk qualification remains disabled;
never invoke a qualification-only freeze as if it were an admitted production
cutover. Source ownership/security, complete writer exclusion, protected
backup/readback and account-observation continuity remain separate gates.

## In scope

- The current local index, its original device salt, and collector state,
  preserving facts, source ordinals, account boundaries, quota observations,
  checkpoints, deduplication and accumulated history. Missing evidence is not
  zero and must not trigger salt replacement or an empty-store rebuild.
- Existing timing measurement state, including primary/supplement identity,
  digests, cursors, fingerprints and parser state. Its separate forward
  conversion and semantic checks remain required; relabeling SQLite metadata
  is not conversion.
- The declared speed-mode baseline ledger, whose timestamped evidence affects
  interpretation and repricing of historical usage.
- `private/overview-workload-state.json`, retaining the workload comparison
  anchor, baseline and capacity history as unchanged usage computation state.
- Existing usage snapshots as retained evidence. They must remain dated and
  provenance-bound; a saved snapshot does not replace the authoritative stores.
- Explicit source-root selections and primary-root semantics, if needed to
  continue the same computation. Extract only reviewed calculation/source
  settings into the new validated settings contract; do not import the entire
  desktop-settings file or discover/copy provider folders from its paths.
- Any legacy usage records, archives or incomplete usage transactions that
  could hold unique history or identity metadata require exact preservation
  review. The [v2 decision](./2026-10-12-local-index-v2-and-local-paths.md) still
  forbids reactivating the retired v1 backend. Retained v1 evidence remains an
  unread archive or the narrowly authorized ordinal input, not an additional
  live accounting source. No automatic replay, deletion or duplicate counting.

## Not migrated; retained at the source

X posts, cache, notification baselines, login sessions, encrypted browser trees,
session registries/checkpoints, import helper and its registry bindings are not
migration inputs or acceptance dependencies. Neither are background images,
appearance/tray/language preferences, generic Chromium state, first-run and
desktop-notification preferences, diagnostics, raw crash artifacts or retired
sharing/export records unrelated to the usage computation being transferred.
These exclusions authorize **no deletion, cleanup, logout, registry update or
credential change**. The old profile remains untouched. The new profile does
not inherit X state; login/import can be configured separately through normal
explicit product actions, not as a cutover side effect.

The transition does not copy or rotate Credential Manager secrets. The existing
fixed account-observation identity must remain available through its designed
non-interactive boundary, or attribution/continuity stays explicitly blocked.
Provider source sessions are read-only external inputs, not files to relocate.
Process/operation lock files are exclusion evidence, not state to activate in
the target. Starting the target must not silently enable an observation action
that the owner had paused; review relevant control settings separately.

## Acceptance boundary

Owner maintenance-mode decision, 2026-10-25: allow a temporary, journaled
write-permission freeze on explicitly selected usage directories and necessary
common parents. Save the original DACL and exact object identity durably before
mutation; the deny must apply only to the directory itself and must not
propagate into unselected trees. On interruption, leave usage startup blocked
until identity-bound recovery restores the original permissions. This exception
does not authorize changing X/browser contents, credentials, or real source
permissions before the complete synthetic/native safety gates and exact
operation authorization. Do not weaken native policy to implement the freeze.

Following authorized read-only source metadata inspection, the owner also
approved a separate **legacy usage source ACL** policy on 2026-10-25. The normal
owner-only policy and all destination protection remain unchanged. Only the
selected old source may retain existing current-owner, SYSTEM and built-in
administrator allow ACEs plus one existing account-domain SID with read/execute
rights only. Pin that reader from the exact maintenance-parent descriptor and
require the same SID wherever it occurs below that parent; this is filesystem
policy preservation, not inferred provider-account continuity. Broad principals,
additional/different readers, non-read rights for that reader, source denies,
capabilities and unknown ACE types remain blocked.

Bind the preflight parent descriptor hash before acquisition and compare its
exact native bytes again before any ACL mutation. Persist the original complete
descriptor and object identity before the temporary non-inheriting deny, then
restore those original bytes explicitly. No source grant may be added or
removed as a repair. New backup/staging/target objects remain protected
owner-only; never copy source ACLs onto them. The approval authorizes this
scoped policy implementation and synthetic/native qualification, not real
permission changes, data backup, conversion or activation.

After diagnosing two historical timing snapshot JSON files, the owner approved
retaining their existing read/execute logon-session ACEs for this migration;
permission removal and correction of the snapshot writer are deferred. This is
the explicit `preserve_legacy_usage_snapshot_v1` policy, not a blanket logon-SID
exception. Only the fixed legacy/v6 snapshot filenames directly under the
selected primary timing root may retain one existing, non-inheriting logon SID
with read/execute rights. Bind its exact original descriptor and identity in
the durable freeze intent and restore that descriptor unchanged. Do not infer
an account identity, grant access, propagate the ACE or copy it to the target.
Default and earlier legacy policies continue to reject this principal class.

Record the Windows snapshot writer's use of Node creation mode without a native
owner-only DACL as follow-up work. The owner chose to continue migration first;
do not claim that initial owner-only copying proves later snapshot rewrites
preserve that protection. Any later removal of old-source permissions requires
its own exact targets and authorization. This decision authorizes continuing
the scoped migration work and necessary read-only history diagnosis; actual
copying/activation still require their resource, backup and semantic gates.

Use an explicit allowlisted usage bundle, exact source ownership and security
checks, writer exclusion for processes that can modify that bundle, protected
cold backup/readback, copy-only conversion, semantic comparison, and journaled
activation/recovery that preserves post-cutover history. A shell/companion
shutdown may also stop its owned X helper, but X session migration, browser
decryption, background reference closure and HKCU helper rebinding are not gates
for accepting the usage bundle. No whole-profile rename, overlay or restore.

Unknown entries within a selected usage dependency boundary remain blockers;
unselected X/UI trees must not be recursively read just to prove this narrower
migration complete. The existing broad in-memory ownership helper is optional
bookkeeping, not the selector or acceptance gate for the usage bundle. Its
always-blocked result does not impose whole-profile migration on this decision.

Narrowing the scope does not waive permissions, native qualification, unexpected
credential-prompt refusal, artifact/GUI checks, offline operation or privacy
rules. It does not prove a backup, conversion or real cutover has occurred.

## Subsequent diagnostic boundary: targeted MFT records

On 2026-10-25 the owner accepted that resident file bytes contained in explicitly
selected MFT records may temporarily enter memory, without saving or outputting
those bytes. This is a diagnostic exception while migration remains paused,
not permission to copy a complete MFT, disk image, profile or provider folder.
It does not authorize parsing provider message bodies, account inference,
credential access, source writes, permission changes or automatic retries.

Preparation uses only the three previously unresolved source identities and
necessary parent references. The bounded diagnostic design admits at most
16 parent slots plus the MFT structural locator, 4 KiB per record and 256 KiB
total reads. A reused slot may contain a later file's resident bytes; sequence
or birth disagreement must reject that binding, never substitute the new file.
Original buffers are cleared before third-party parsing or IPC. Only rebuilt
name and standard-information attributes reach the separately pinned parser;
original DATA attributes and slack never do. Diagnostic artifacts remain
content-free. Synthetic tests do not prove complete memory erasure or qualify
real-volume acquisition, source correctness, writer exclusion or migration.

The owner-facing manual runner performs its own explicit administrator launch.
Preparing and testing it does not consume or renew earlier NTFS journal query
permissions. No actual MFT acquisition has been performed by the agent as part
of this preparation; general production/path-walk flags remain false.
