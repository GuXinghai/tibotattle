---
title: Verify a local Windows artifact
date: 2026-10-23
type: reference
status: maintained
---

# Verify a local Windows artifact

Rhetrion is unpublished. There is no canonical public download or update feed.
Do not use prior-project websites or release assets as this product's installer.
See [current status](./current-status.md).

A local candidate needs its own exact source/runtime inventory, native binding
and adjacent manifest, package identity, ASAR integrity and SHA-256 checks. The
reviewed development artifact verifier checks the development closure; it does
not make an unsigned artifact a signed or installed release.

For a future distributed artifact, verify Authenticode publisher and timestamp,
exact final-byte checksum, installed lifecycle and each supplied provenance or
SBOM record separately. A digest proves byte identity, not publisher trust or
source provenance. Missing evidence remains null. No signing account or release
publication workflow is configured for the independent product.

Never launch a candidate against the only copy of data. Use an isolated profile,
verified cold backup and explicit migration/recovery gates first. Native safety,
Windows shell, notification identity and credential behavior need their own
physical-system evidence; source/browser tests do not qualify them.
