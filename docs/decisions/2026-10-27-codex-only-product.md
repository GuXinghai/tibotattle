---
title: Codex-only provider scope for the local product
date: 2026-10-27
type: decision
status: accepted
---

# Decision and scope

Codex is the only supported usage provider. Retire Claude Code and Claude
Desktop collection, standalone integrations, transcript ingestion/export,
callback and status-line lifecycle, Anthropic-specific pricing and quota
accounting, related dashboard surfaces, commands, and provider-facing tests.
The optional X reader remains a separate local feature and is not a usage
provider.

This supersedes the Claude identity retention portion of the
[Astra pricing and model identity decision](./2026-09-03-astra-pricing-and-model-identity.md)
for the local product. It does not rewrite that decision's dated Codex pricing
evidence or identities.

Existing versioned generic telemetry/export and provider-accounting snapshot
formats, provider/surface vocabulary, and enum values are preserved by this
retirement decision only to identify or read already-retained historical usage.
This decision does not change their original contract-status fields, versioned
bytes, publication state, or runtime authority; it does not make them frozen,
published, or active contracts. Old export workspaces may be inspected without
reopening any retired provider source path; resume fails closed. The one retained
Claude callback identity audit pair
(`owner=claude-callback`, `capability=claude_callback`) is read-only history and
cannot authorize new preparation or a lease. Do not read, copy, migrate, or
remove credential values or identity-service state; existing credential entries
remain untouched in their designed store. Dedicated Claude status-line schemas
and parsers are not retained as product support.
Historical values remain dated evidence; do not reprice or reinterpret them as
current support.

## Preserve existing state

This source retirement does not authorize scanning, changing, importing,
uninstalling, repairing, resetting, migrating, or deleting an existing Claude
Code or Claude Desktop profile, settings, transcript, ledger, callback state,
credential, or secret. Do not run an uninstall or cleanup operation against
those locations. Keep existing files and permissions untouched. No profile or
credential inspection is needed to implement this decision.

Removing application code and tests does not change a user's existing local
data or any former remote service. Retained export choices, salts, identities,
receipts, and usage history remain preserved under their existing contracts.

## Codex continuity

Codex remains the sole supported usage provider. Preserve its existing source
selection, accounting, identity, quota-observation, timing, local-index,
historical-readback, and recovery contracts. Removing Claude-specific
normalization must not relabel, discard, replay, or alter Codex records.

R7 receipts and protected source artifacts remain immutable. Do not regenerate
or edit them as part of this provider-scope change.

The R7 release-evidence v0.1 schema requires Claude operation values and
fields. Preserve that schema and existing receipt bytes exactly for historical
readback; do not narrow or relabel v0.1 and do not create a v0.2 schema to
refresh these receipts. New R7 receipt or evidence generation is retired. Any
remaining generation entrypoint must reject before it creates or reads a
fixture, reads or writes repository state, or reads a provider source. This
boundary does not change current Codex collection, accounting, or UI behavior.

## Implementation boundary

The repository is removing current Claude-specific code, tests, UI, commands,
and active operational guidance. This decision records the accepted target; it
does not by itself prove source removal, test results, native behavior, an
installed artifact, or a release. Retired-path checks and source-derived docs
must be updated with the implementation. Any retained legacy parser or schema
must be limited to the readback boundary above and have explicit compatibility
tests.
