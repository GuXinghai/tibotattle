---
title: Remove community sharing, contribution, and share cards from the desktop product
date: 2026-10-13
type: decision-record
status: accepted
---

# Remove desktop community sharing, contribution, and share cards

On 2026-10-13 the owner decided to remove community sharing, hosted
contribution, and result share cards from the TiboTattle desktop product.
This supersedes the [accountless sharing defaults](2026-09-04-accountless-sharing-policy.md)
for the desktop client. It also supersedes the earlier
[dashboard UI plan](../plans/2026-10-13-dashboard-ui-restructure.md) proposal
to move sharing controls into Settings.

## Removed from the desktop client

- The dashboard Community page and its sharing switch.
- The existing-install transition notices, including **Share now** and
  **Keep sharing off**.
- Promotional links to the public community page.
- The Settings sharing card.
- Share-card generation, preview, save, copy, export, the Share view, and the
  global Share button.
- Contribution enrollment, pairing, hosted sign-in handoff, upload scheduling,
  and prepared-set publication.
- Performance-sharing review.
- The Electron IPC, preload methods, and companion routes and options that
  served only these features.
- The accountless installation-credential backend used only for uploads.

Local analysis, the local index, and the Windows account-observation credential
path remain. Account-observation scoping is used for local quota attribution
and is not a sharing feature.

## Preserved state

Removal stops reading and writing sharing state. It does not delete, tombstone,
rewrite, or migrate that state. The following stay where they are:

- accumulated local evidence and the local index;
- device salts and identities;
- the saved sharing choice (`accountless-sharing-v1.json`) and other durable
  opt-out records;
- notice receipts;
- the accountless installation credential and existing Credential Manager
  entries;
- prepared spools and contribution queues.

Startup steps that retired or deleted contribution artifacts are removed rather
than kept running. The companion's single-instance lock keeps its existing lock
file path. Deleting any preserved artifact needs a separate receipt-backed
deletion workflow.

## Out of scope: deployed services

The hosted Worker is deployed infrastructure. Its contribution, enrollment,
community publication, and erasure contracts are not changed by this decision.
The same applies to the public community page and the admin UI. Retiring them
is a separate, owner-authorized operation. Until then:

- Owner-only hosted erasure and deletion-safe restore remain in force.
- Client modules that only Worker contract tests import stay in source, so
  those tests keep exercising the deployed ingestion contract.
- The Stage 1 removal report lists these modules and the hosted surfaces that
  this decision orphans.

## Evidence boundary

This is a source decision. It is not an installed-artifact, release, updater,
or deployment result. Earlier sharing decisions, runbooks, and receipts remain
historical records of the behavior they describe.
