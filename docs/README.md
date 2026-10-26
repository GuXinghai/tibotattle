# Documentation index

This index separates maintained truth from point-in-time evidence. Start with
the current authorities below. A dated filename does not make a document
current, and source, local runtime, native app, installed artifact, CI, release,
updater, and public deployment remain separate evidence gates.

When maintained behavior changes, update the affected authority in the same
change. Git-remove obsolete instructions, plans, reports, and handoffs once
they no longer have enduring audit, recovery, decision, or release value. Git
history is the default archive; do not keep wrong prose in the working tree as
an informal archive.

## Current authoritative documentation

| Area | Authority | Boundary |
|---|---|---|
| Independent local product | [Stable identity and cloud retirement](./decisions/2026-10-23-local-product-identity-and-cloud-retirement.md) | Accepted local-product boundary; source retirement and migration implementation remain in progress; no remote-resource deletion |
| Local state cutover scope | [Usage-only state cutover](./decisions/2026-10-25-usage-only-state-cutover.md) | Owner-approved usage computation/history continuity only; X/UI/browser state stays untouched at the source and is not a migration prerequisite |
| Platform scope | [Windows-only platform support](./decisions/2026-10-12-windows-only.md) | Accepted product scope: Windows x64 only; earlier macOS and Linux platform records are superseded and removed |
| Claude Desktop prototype retirement | [Shadow prototype retirement](./decisions/2026-10-13-claude-desktop-shadow-retirement.md) | Accepted Windows-only source retirement; generic provider and hosted contracts remain, existing local prototype state is preserved |
| 0.1.19 patches | [Model attribution and labels](./plans/2026-09-06-v0.1.19-model-attribution-and-labels.md) | Prepared model-inheritance and display patches; private history conservation verified, release pending |
| Status | [Current product and release status](./current-status.md) | Commit- and date-stamped source, live-service, published-release, updater, and support snapshot; reverify before relying on it later |
| Dashboard UI restructure | [Four-entry dashboard UI plan](./plans/2026-10-13-dashboard-ui-restructure.md), [Claude Code execution handoff](./plans/2026-10-13-claude-code-ui-handoff.md) | Owner-approved concept direction; planned navigation and presentation work with analytical-detail preservation, not implementation or release evidence |
| User help | [User guide](./user-guide.md) | Local setup, uncertainty, refresh/recovery, optional features, retained data and unconfigured updates/support |
| Architecture | [System architecture](./reference/system-architecture.md) | Current components, trust boundaries, stores, identities, and data flow |
| Privacy | [Local data, network, and privacy](./reference/local-data-and-privacy.md) | Exact source reads, local and hosted stores, Windows Credential Manager, network, retention, deletion, and uninstall boundaries |
| Desktop sharing removal | [Remove desktop sharing, contribution, and share cards](./decisions/2026-10-13-desktop-sharing-removal.md) | Accepted owner decision: the desktop product has no community sharing, uploads, or share cards; saved opt-outs, receipts, salts, and identities stay on disk; deployed Worker retirement is separate. Supersedes the 2026-09-04 accountless sharing defaults for the desktop client |
| Optional X reader | [X reader and isolated session import](./decisions/2026-10-20-optional-x-reader.md) | Accepted optional network and protected public-post cache boundary; separate X sessions, user-triggered Chrome import, controlled media resources and independent refresh; no usage upload or published-release claim |
| Local index v2 and local paths | [Local index v2 store and local path storage](./decisions/2026-10-12-local-index-v2-and-local-paths.md) | Accepted decision: the live WAL store is the only local index backend, no legacy preservation, conditional v1 deletion, owner-only local paths that never leave the machine |
| Electron crash doctor | [Opt-in crash capture and support doctor](./decisions/2026-09-21-opt-in-crash-doctor.md) | Reviewed content-free support projection and startup record; native crash capture is not offered and no raw crash data is exported or uploaded |
| Electron refresh resilience | [Observable self-healing refresh leases](./decisions/2026-09-21-electron-refresh-resilience.md) | Accepted renderer/preload/IPC lease, heartbeat, watchdog, live-freshness and content-free diagnostics contract; source and release evidence remain separate |
| Electron startup status | [Start-at-login status and refresh](./decisions/2026-09-21-electron-start-at-login-status.md) | Accepted Windows source behavior for automatic status reads and error retry; installed Windows login-session qualification remains separate |
| Public contribution sources | [Shared public community sample](./decisions/2026-09-11-public-contribution-sources.md) | Accepted inclusion of durable accountless sources in current public calculations; source identity, withdrawal, suppression, and activation gates |
| Dashboard appearance | [Monochrome app appearance](./decisions/2026-10-18-monochrome-dashboard-appearance.md) | Default white/black/grey, preserved workload colors, and owner-selected whole-window colors or original-quality local images; saved dark-mode preferences remain supported, public and operator palettes stay separate |
| Opt-out retention | [Opt-out stops future uploads](./decisions/2026-09-15-opt-out-stops-future-uploads.md) | Accepted separation of future upload permission from retained-history eligibility and published graph continuity; implementation and deployment tracked separately |
| Calibration semantics | [Composition-aware expected-line contract](./design/composition-aware-expected-line.md) | Maintained model-mix, saturation, reset, and lineage carry-forward interpretation; not a provider capacity claim |
| APIs | [API and integration surface](./reference/api-surface.md) | Stable entry point for the source-checked HTTP, native, process, package, schema, binding, and external-service inventory |
| Detailed API inventory | [Source-backed API surface reference](./reference/2026-08-26-api-surface-reference.md) | Complete inventory maintained with source-parity tests; implemented source is not deployment or release proof |
| Commands | [Command-line reference](./reference/cli-reference.md) | Source-checked `usage-monitor` command inventory and safety classes |
| Usage coaching | [Usage explainer agent protocol](./reference/usage-explainer-agent-protocol.md) | Maintained plan selection, pagination, evidence lookup, model-synthesis, and claim boundaries for agents |
| Schemas | [Schema and contract lifecycle](./reference/schema-contracts.md) | Canonical owners, mirrors, generators, versioning, and retirement |
| Local index | [Local index store schema](./reference/local-index-schema.md) | v2 store identifiers, tables, source cursors, incremental refresh, rollup and audit contracts, and fail-closed open rules |
| Local recovery | [Local index recovery](./runbooks/local-index-recovery.md) | Preservation-first diagnosis, copy-first rehearsal, the audit, and what cannot be rebuilt from rollouts; never relabel or destroy the only store |
| Legacy Windows ACL recovery | [Windows legacy ACL continuity copy](./runbooks/2026-10-13-windows-legacy-acl-copy.md) | Explicit frozen-source, copy-only bounded continuity bundle; original profile remains authoritative and profile activation stays blocked |
| Platform support | [Platform support and qualification](./reference/platform-support.md) | Windows is the only supported platform; released artifact assurances and qualification gates are Windows-only |
| Release verification | [Verify a local artifact](./verify-release.md) | User-facing checksum, native trust, manifest, and evidence verification |
| 0.1.27 build dependency exception | [Temporary HTTP cache advisory exception](./decisions/2026-10-03-v0-1-27-http-cache-advisory-exception.md) | Owner-approved root-lock-only exact-patch exception for GHSA-ch52-4w7c-c8xp; fails closed at 2026-10-10T00:00Z, with source/status and child-lock boundaries |
| Early release qualification | [Synthetic admission and evidence reuse](./runbooks/release-qualification-admission.md) | Reviewed local proof cache and owning test lanes; not R7 or installed-app qualification |
| Windows readiness | [Windows portability environments](./runbooks/2026-08-17-windows-portability-environments.md) | Development/qualification environments only; current release support is defined by the platform authority |
| R7 evidence | [R7 release-evidence receipt maintenance](./runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md) | Staleness rule and protected dual-runtime regeneration; not a routine documentation check |

## Lifecycle evidence

The [API lifecycle review](./reviews/2026-08-26-api-lifecycle-review.md) records
the source-level removals merged in PR #78. It is an implementation record, not
an assertion that an installed release or deployed service has already adopted
those removals.

That review's preserved self-service deletion route is historical. The
[2026-08-30 decision](./decisions/2026-08-30-self-service-deletion-retirement.md)
subsequently retires it in source; it does not remove retention/restore
obligations or establish that the service or installed app has changed.

Documents not listed as authorities are records or supporting context, not
current operational instructions:

- **Decisions** remain only when the accepted contract still explains or
  constrains the current system.
- **Receipts and QA** prove only the exact checkout, command, environment,
  artifact, and date they name. Retain them only for an enduring release,
  recovery, compliance, or regression purpose.
- **Audits, reviews, investigations, research, and reports** remain only when
  their findings still have audit or recovery value.
- **Plans and goals** describe intended work, never implementation or release
  state. Delete completed, abandoned, or superseded plans after durable results
  are incorporated into code, tests, decisions, and maintained authorities.
- **Design records** remain only for durable product rationale; current
  implementation status comes from source and the authorities above.

Every retained dated Markdown record requires `title`, `date`, `type`, and
`status` frontmatter. Status `current`, `canonical`, `maintained`, or
`operational` is valid only for a document listed in this index.

## Maintenance workflow

1. Search every tracked file for affected document paths and basenames, including
   current authorities, READMEs, public docs, disclosures, templates, scripts,
   comments, fixtures, ignore files, and security allowlists.
2. Update code-derived documentation tests and generated mirrors with the
   source change.
3. Delete superseded prose and repair every inbound link; do not add an
   `archive` folder merely to avoid deletion.
4. Run `npm run docs:check` and `npm run test:preflight`, then the owning
   contract or release gate.
5. Re-read rendered Markdown and distinguish source, runtime, artifact, release,
   updater, and deployment claims before reporting completion.

The repository root [README.md](../README.md),
[CONTRIBUTING.md](../CONTRIBUTING.md), [SUPPORT.md](../SUPPORT.md), and
[SECURITY.md](../SECURITY.md) are the maintained public/developer entry points.
