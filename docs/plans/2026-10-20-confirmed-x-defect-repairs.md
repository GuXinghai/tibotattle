---
title: Confirmed X failure repairs and separate ingestion proposal
date: 2026-10-20
type: plan
status: implemented
---

# Scope and acceptance

Repair confirmed X defects from the
[diagnosis](../reviews/2026-10-20-x-session-and-ingestion-diagnosis.md), preserving
all owner changes. No full tests, Electron packaging, installation, live-profile
mutation, commit or push. Native rebuild is only for the changed binding's
focused synthetic validation, not a packaged-app qualification.

## Implementation boundaries

1. Keep bounded native profile inspection and safe inheritance migration.
   Dispose only fixed disposable browser cache subtrees on overflow, with
   handle-relative owner/link/reparse/ACL checks and bounded resumable work.
   Preserve Cookies, durable site state and the separate retained post cache.
   Report overflow/pending cleanup distinctly from a permissions failure.
2. Register sessions durably before Chromium opens them. Explicit cleanup intent
   survives interruption; accepted active sessions remain distinguishable from
   abandoned candidates. Clear/verify, publish the new pointer, then acknowledge
   cleanup. Failed initial reads block writes until a successful reload.
3. Preserve complete text while accepting fresh validated media/author data.
   Recover media only by stable upstream identity; legacy positional IDs cannot
   rebind another asset. Permit bounded retries after transient recovery failure.
   Enforce response types for GET/HEAD and preserve safe 416 range metadata.
4. Keep cached replies readable, with detail-specific freshness/failure rather
   than unrelated global operations. Avoid duplicate archives. Migrate to
   category-specific notification anchors with bounded recent seen IDs, retaining
   no-history-replay behavior and late arrivals within that bounded window.

Use shared closed validators, forward-only cache migration and the existing
protected record owner. Do not add a second persistence or security mechanism.
Every repair gets the smallest meaningful focused regression; unavailable live
conditions remain explicit and do not block evidence-backed defensive changes.

## D4: historical usage proposal only

The [separate proposal](2026-10-20-historical-usage-preservation-proposal.md)
retains the verified prefix while deferring an incomplete append, with integrity
checks, atomic resume and copy-first recovery validation. No ingestion code or
real usage data changes in this batch.

## Source validation result

Implemented on 2026-10-20 against base `a65bd7ed`, preserving the existing
worktree. This record covers the working diff, not a new commit or running app.

Focused checks passed:

| Scope | Result |
|---|---|
| Service and lifecycle regressions | 45/45 |
| Repository, migration and archive regressions | 18/18 |
| Post/baseline contract and page adapter | 20/20 |
| Reader UI behavior and session error messages | 21/21 |
| Windows native profile, loader and manifest | 43/43, zero skips |
| Canonical i18n and browser mirror | 6/6 and mirror check |
| Affected native artifact-verifier cases | 2/2 |
| Documentation/root-layout/whitespace preflight | Passed |

The exact native binding was rebuilt with Node.js 26.2.0; its SHA-256 is
`261db1d6ecf63060fd14b5dece98e898fb66fc89c3e5c686b65e275c38562196`.
The native tests used disposable synthetic profiles and checked resumable cache
cleanup, malicious links/ACLs/siblings and unchanged durable browser content.

No full suite, Electron package, app launch, real login, real-profile write,
installation, commit or push occurred in this batch. Fresh packaged UI/playback,
natural X media expiry, remote pagination end, system notification delivery and
physical Electron crash acceptance remain separate runtime gates. Earlier live
observations in the diagnosis are not promoted to proof for this repair diff.
