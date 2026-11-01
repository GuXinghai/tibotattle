---
title: One-time local-index v9/v10 to v11 DDL migration
date: 2026-11-01
type: decision
status: accepted
---

# Decision

Rhetrion remains unpublished. A v9 or v10 local-index store is pre-release
state, not a supported historical format. The first writable open of such a
store performs one bounded, forward-only DDL migration to schema 11:

- v9 -> v10 adds the impact-manifest tables and indexes;
- v10 -> v11 replaces the derived `work_rollup` with the tiered key, creates
  `workload_bucket`, installs their triggers and marks both projections
  `pending`;
- no source, fact, cursor, salt, quota or accounting row is rewritten;
- the old `work_rollup` is derived data reconstructible from committed
  `usage_event` rows and is never source evidence.

Read-only opens of v9 or v10 continue to fail closed. After conversion only
schema 11 is accepted; there is no dual-version runtime, backward writer or
automatic downgrade. A build that does not know schema 11 must refuse the file.

This is a narrow exception to the
[one-time controlled state migration](./2026-10-27-pre-release-state-migration.md)
rule against in-place schema upgrades. It authorizes only this additive
DDL/derived-table cutover in ordinary writable open. It does not authorize
in-place fact repair, source rescans, ACL changes, export-workspace conversion,
deletion of originals, or replay against new history. Those remain separate,
explicitly admitted operations.

# Protected-copy gate

Before the first writable open of the owner's live index, take a protected
consistent copy with its sidecars and device salt. The original stays
authoritative until the converted copy passes readback:

- `PRAGMA quick_check` and `foreign_key_check` succeed;
- source and fact row counts are unchanged;
- both work-projection watermarks become `ready` only after their bounded
  backfill and audit finish;
- quota and the last-good workload result remain readable while backfill runs.

Migration failure rolls back and leaves the input file at its prior version.
A failed or absent protected copy blocks live writable open; it is not a reason
to relabel, delete or hand-repair the store.

# Projection semantics

`work_rollup` and `workload_bucket` are derived from committed facts only. The
migration and backfill never read a rollout. Per-batch backfill commits do not
advance `commit_seq`; only the final audited readiness transition publishes one
`verify` commit. Readers use a projection only while its watermark is `ready`
and its context basis matches; otherwise they stay on committed facts.

The impact manifest is a bounded description of published changes, not a second
authority over fact trust. `source_change` retention and
`meta.impact_manifest_since_change_id` bound how long a watermark can prove it
saw every change; an older watermark must rebuild a bounded component rather
than assume no impact.

# Privacy and evidence boundary

The new tables contain internal store ids, closed mode/status vocabularies,
counts and time ranges. They do not contain source paths, raw session UUIDs,
account identifiers, prompts, responses or raw errors.

This decision and its synthetic tests do not read, migrate or qualify the
owner's live index, an installed artifact, a release or a deployment. Those
remain separate gates.
