---
title: One-time controlled state migration before first release
date: 2026-10-27
type: decision
status: accepted
---

# Decision and scope

Rhetrion is unpublished. Legacy Windows ACL state and older export workspaces
are a bounded pre-release migration task, not a requirement for a general
backward-compatible runtime or a permanent multi-version writer.

Use one explicit, standalone migration for the admitted old versions and named
local state. After successful cutover, ordinary runtime code accepts only the
current protected format. Retained historical records keep their original
meaning; this does not remove their existing readback contracts or relabel
their versions. Newer or unrecognized state remains fail-closed.

This decision authorizes source work and isolated synthetic rehearsal. It does
not authorize access to, migration of, or rollback of existing user data.
Real execution and activation require separately authorized exact targets.

## Current admitted upgrade

The previous brand cutover is complete according to the owner's 2026-10-27
read-only receipt verification; it is not the operation planned here. The new
source is the active `UsageMonitor` stable profile's usage state, including
post-cutover history. Preserve the prior TiboTattle source, backup, converted
copy and activation receipts as historical material; never replay them over
the current active state.

The observed index is schema 8 and the source change targets schema 9;
collector schema 1 is unchanged. Prepare a fresh protected cold backup and a
separate conversion target. Keep the currently active profile authoritative
until the new copy and compatible candidate have passed acceptance. Existing
`activated / existing_only` startup policy belongs to the completed cutover
and is not authorization to mutate or replace it for this upgrade.

No old export workspace was found in the bounded filename-only inventory. Do
not create a migration task for an assumed workspace; admit one only after an
exact existing target is independently identified.

## Migration boundary

- Preserve the original files, ACLs, database versions and historical evidence.
  Make a consistent frozen copy into a separately created protected destination;
  do not repair original permissions or run an in-place schema upgrade.
- Admit only the explicit Codex usage/history and export-workspace scope. Follow
  the [usage-only cutover decision](./2026-10-25-usage-only-state-cutover.md).
  Retired provider state, contribution settings/receipts and their identity or
  credential state, X/browser and unrelated UI state remain untouched. Current
  Codex calculation salts and identity continuity follow the explicit usage-only
  scope; never remint or rederive them. Its existing bounded omission decision
  is unchanged and does not authorize additional losses. The broader legacy
  continuity-copy bundle is not this migration's allowlist.
- Convert supported old workspace data into a newly initialized current-schema
  database, with explicit source provenance and field transformations. Changing
  `user_version` or a format label alone is not conversion. Do not guess exact
  file identities from rounded numbers, invent missing evidence, resume retired
  provider sources or silently replace unfinished work with a fresh export.
- Bind each operation to source/destination identities and verified hashes.
  Journal progress and commit only verified destination state. A retry must
  resume that exact operation or verify its completed result without duplicate
  accounting. Changed inputs, unknown journals or conflicting destinations
  refuse without deleting either side.

## Acceptance and retirement

Rehearse supported versions using isolated, content-free synthetic data. Verify
protected destination ACLs, source preservation, database integrity, retained
record and accounting equality, checkpoint/progress continuity, exact identity
handling, interruption and safe retry. Unsupported or unrecoverable information
must be reported explicitly and cannot be counted as a successful migration.

Activation is a separate final step after verified copy/conversion and readback;
it must bind to the completed migration receipt and preserve the original.
Source deletion is not part of migration. No runtime auto-repair or automatic
fallback to an old writer is introduced.

The migration entrypoint is outside ordinary startup and is retired from the
normal product path after the one-time pre-release cutover is accepted. Keep
only the historical readback and recovery evidence that still has a defined
purpose. This decision sets implementation scope; it does not claim that a
combined migration tool, native qualification or real cutover has completed.
