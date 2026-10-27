---
title: Controlled pre-release index copy upgrade
date: 2026-10-27
type: runbook
status: maintained
---

# Scope and admission

This is the standalone index-copy step for the
[one-time pre-release upgrade](../decisions/2026-10-27-pre-release-state-migration.md).
It is not a profile backup, source discovery, activation or brand-cutover tool.
Do not run the old brand activation scripts or substitute the historical
TiboTattle backup for the current UsageMonitor profile's new cold backup.

The entrypoint is `convertPreReleaseIndexCopy` in
[`pre-release-index-conversion.mjs`](../../scripts/lib/pre-release-index-conversion.mjs).
It requires explicit `sourceFile`, `destinationRoot`, and a lowercase
`expectedSourceSha256`; optional `signal` supports cancellation. There are no
default user paths, command-line auto-discovery or implicit activation.

Use only a separately verified, protected cold backup as the input. The fixed
file name is `local-index-store-v1.sqlite`; its source must be a regular,
single-link, protected current-owner file, SQLite application `0x554d4932`,
family `local-index-store`, and schema 8 with WAL-format header bytes `2/2`.
Nonempty WAL/SHM and a nonzero rollback-journal header refuse the operation.
Existing accepted empty sidecars are frozen and preserved, not cleaned.

Schema 8 is necessary but insufficient. The source's complete object SQL must
match the closed catalog captured from the actual `63e8753a` v8 writer, including
its secondary/response indexes. Listed optional indexes may be absent. Unknown
or differently defined tables, indexes or triggers refuse even if their names
and version labels look correct. Other legitimate historical DDL variants need
separate admission review on a copy; this is not a general v8 compatibility
reader. The catalog and its raw SQL provenance are committed beside the tool.

The caller must separately prepare an empty protected destination root and its
protected parent. The step does not create that root, repair permissions,
overwrite existing files or adopt a partial previous target. Source and target
must be physically disjoint on fixed local volumes. A separately manifest-bound
native volume query rejects other drive types; it is not an ACL or path-walk
approval. The native file limit is 1 GiB, with bounded cells, rows and logical
hash input. Oversized or unsupported state refuses without truncation.

# Copy and verification

The tool pins the source and directory identities, checks the expected whole-file
hash and cold sidecars, and reads the source through an immutable read-only
SQLite connection. It copies into the held destination with native protected
no-clobber creation and complete readback.

Before the writable copy opens, its WAL/SHM and rollback journal are created
with native protected DACLs. The write connection uses guarded PERSIST, a zero
journal-size limit, defensive settings and memory-only temporary storage.
It invokes the same `upgradeLocalIndexV8ToV9` transaction as the store owner;
it does not enter the normal WAL writer or its provisional repair/rollup paths.
The only data-schema change is nullable `source.carry_tier_source`; every old
row's new value must remain NULL. Source-revision triggers use the reviewed v9
definitions. Original columns in every fixed table must retain their typed,
ordered logical digest and row count, including provisional facts and stale
rollups. Blob/text bytes, NULL and empty text, integer and real types remain
distinct in those digests.

After successful SQLite close, only this operation's unchanged empty WAL/SHM
files may be removed through native expected-identity deletion. The protected
main file and zero-length rollback journal remain. The output header is non-WAL
`1/1`; a reopened read-only connection may report DELETE because PERSIST is a
writer-connection policy, not persistent format metadata. Immutable readback
rechecks schema 9, NULL provenance, original-row equality and output bytes.
The original source hash, identity and sidecar state are rechecked before return.

# Failure and next gates

Failure never deletes or repairs the source and never silently overwrites a
partial destination. Preserve that destination for explicit reconciliation;
rerunning against it refuses. Cancellation may leave an unverified copy and
does not authorize replay. An unconfirmed SQLite close or native guard release
pins remaining resources and blocks further conversions in that process;
stop the process before a separately reviewed recovery attempt.

Results contain only fixed status, schema versions, whole-file/schema/logical
hashes, source/destination root and source/target file identity hashes, and
fixed-table row counts. No raw file identity is returned. Bind these hashes to
the operator's independent resource observations. Store any actual-data receipt owner-only
and locally; do not upload it or commit it as a source/test artifact. Fixed
failure categories do not include file paths or payloads.

Synthetic native tests qualify this copy step only. Actual profile admission
still requires a new cold backup of current history, complete bundle readback,
account/salt continuity, exact compatible candidate verification, and a separate
resource-bound activation/recovery plan. Collector schema 1, timing and other
retained usage state are outside this step and must not be recreated or replaced
implicitly. No real profile conversion or activation is performed by importing
the module or by the isolated tests.
