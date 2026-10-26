---
title: Independent local product, stable identity, and cloud project retirement
date: 2026-10-23
type: decision
status: accepted
---

# Decision and scope

The product is an independent Windows x64 local application, branded 衡川 / Rhetrion.
Display branding is separate from its permanent usage-monitor identity. Local usage,
history, settings, protected credentials, and optional X sessions remain local.

Retire the repository's former hosted Worker project and the previous product's
deployment, signing-account, publication, and hosted-site integrations. This is a
source retirement, not deletion, migration, or shutdown of remote resources.
Existing local privacy choices, receipts, salts, identities, and history remain
preserved. Remote data ownership and erasure obligations are not changed by removing
source from this independent product.

This decision supersedes the requirement to keep the hosted Worker in this checkout.
Earlier hosted contracts and operational evidence do not authorize network access
from the new application and are not evidence of its release or availability.
General local accounting and export contracts remain where the local product uses
them; removing the cloud project does not authorize deleting local retained evidence.

# Permanent identity

`config/application-identity.cjs` owns the fixed package, App ID, executable name,
profile namespaces, and local protocol identity. `config/product-brand.cjs` owns
only presentation. A display name is never a production-authorization check, state
root, credential service, or schema-version selector. Profile selection must still
validate the packaged application's identity and maintain all existing platform,
native, and artifact refusal boundaries.

No former-brand compatibility path is shipped. A separate local transition package
backs up the explicitly selected source, transforms a copy with version-specific
rules, validates it, and cuts over only after a successful recovery rehearsal.
Original data and verified backups are retained. No bulk string replacement is
permitted inside user databases, encrypted browser state, or credential material.

Scope amendment, 2026-10-25: the owner narrowed that transition to
[usage computation and history continuity](./2026-10-25-usage-only-state-cutover.md).
Whole-profile, X, background and generic Chromium migration are not acceptance
requirements; their original state remains untouched, not deleted or reset.
The timing conversion and usage-history safeguards below remain in scope.

Timing measurement methods remain 2/3; their new physical SQLite schemas are
12/13 and bind the sole correlation-key record to
`usage-monitor-timing-identity-v1`. Existing stores must pass read-only identity,
schema and parser-version checks before a writable connection or journal pragma.
Old namespaces are not an in-app migration path. The separate conversion package
must reconcile every digest, fingerprint, cursor and parser-state reference on a
copy; unknown or missing mappings preserve the source and block cutover.

Owner clarification, 2026-10-25: recompute identities under the new HMAC
namespace from original evidence rather than retain the former namespace as a
permanent runtime identity. Keep the original timing correlation key. Bind
the source/target algorithms and retain a private, verifiable old-to-new
identity mapping with the conversion evidence. Recalculation must reconcile
retained measurements, prefix fingerprints, cursors, deduplication and pending
parser state; it does not authorize replacing non-reproducible history,
replaying accounting, copying provider session folders or reading real state
before its existing security/authorization gates. An HMAC namespace alone
does not make missing original evidence reconstructible.

# Implementation and remaining gates

Implementation is in progress under the
[brand and state cutover plan](../plans/2026-10-23-rhetrion-brand-identity-and-local-state-cutover.md).
The old Worker working directory was moved into a local ignored quarantine, retaining
its files and permissions. This decision does not certify complete dependency removal,
a finished application, a native qualification result, a migration, or a release.

Source closure, synthetic migration/recovery tests, Windows candidate rendering, and
real data cutover are independent gates. Signing, publication, external changes, and
deleting retained local data are outside this implementation's authorized scope.
