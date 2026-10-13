---
title: Production operation ownership and recovery
date: 2026-09-28
type: runbook
status: maintained
---

# Production operation ownership and recovery

The native app release doctor and finalization journal have been retired with
the native builder. Use [early qualification](./release-qualification-admission.md)
for local evidence admission. Neither grants publication authority.

The production coordination and recovery policy below remains in force for
current deployment operations.

## Local Windows operation storage

Local operation receipts use the narrow `windows-release-operation-storage-v1`
native capability, checked against the exact binding bytes and its sidecar.
Missing or older capability manifests refuse; Node mode bits are not ACL proof.
The operation root must already be owner-private or be newly provisioned with
the protected current-owner DACL. Existing inherited or broader ACLs refuse
without repair. Keep operation storage on a local drive.

Native guards hold the root and its ancestors against rename and pin the
single-link SQLite mutex and rollback journal until connection close. SQLite
EXCLUSIVE ownership serializes cooperating processes across Windows sessions;
PERSIST recovery invalidates the protected hot journal in place. Receipts are
bounded, root-relative, flushed and atomically replaced against their recorded
identity. A failed save does not advance in-memory state. Process death releases
the OS guards and SQLite mutex while retaining the last durable receipt.

This is cooperative operation ownership, not protection from a hostile process
acting as the same Windows owner and bypassing the mutex. Generic native
production/path-walk flags remain disabled. Native test evidence does not
qualify installed, signed or published artifacts, nor authorize publication.

## Production ownership and recovery

Both production entrypoints use the exact reviewed predecessor and a fixed
coordination ref: `refs/heads/codex/production-deployment-lock` on the approved
TiboTattle origin. The owner commit has an empty tree and content-free operation
metadata; taking ownership does not upload candidate source history. Conditional
creation/deletion uses an explicit expected object ID, not tracking-ref guesses.
There is no timeout-based stealing, and no repository protection changes.

The Git credential must be permitted to create/delete this one coordination ref.
These writes are part of an explicitly authorized production operation, not
doctor mode. Every production writer must use the updated guard. This is a
cooperative lock, not a Cloudflare-enforced fencing token: raw Wrangler, old
checkouts and privileged dashboard actions bypass it and must not run concurrently.

The operation persists intent before Wrangler. A lost/nonzero provider response
cannot be reported as proof of no deployment. Exact source plus public-surface
checks establish verified completion; cleanup warnings are separate. Missing or
wrong post-source leaves ownership retained. Rerunning the normal command on an
existing journal refuses, preventing blind repeated deployment.

Use the [production reconciliation procedure](production-operations.md#guarded-deployment-wrapper)
only after proving the old executor has stopped. It never deploys, and releases
only the exact owner after verifying the intended live source/public surface.
Uncertain acquisition, inaccessible remote state or a candidate not observed live
requires investigation; do not delete the shared ref manually to make progress.
A proven pre-mutation failure with no held/uncertain lock can use a new explicit
operation directory after review, retaining the failed record for diagnosis.

The conditional Git update contract follows [Git's explicit expected-value
lease semantics](https://git-scm.com/docs/git-push).
