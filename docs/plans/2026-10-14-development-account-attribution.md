---
title: Development account attribution repair
date: 2026-10-14
type: plan
status: implemented
---

# Development account attribution repair

The packaged Windows development launcher has quota access but no account
observation broker. The repair admits only an existing fixed account-observation
key through the reviewed parent IPC broker after development qualification.
The parent refuses credential creation; missing or invalid keys stay unavailable.
Production flags, credential protection, and historical attribution are unchanged.

Acceptance: synthetic IPC tests must prove reads and mutation refusal; prepare a
fresh development package and inspect its normal refresh with the preserved local
profile. Verify future attribution and forecast samples without printing identities
or secrets. A missing existing key remains a separate activation boundary.

Steps: implement the read-only composition, run focused contracts and architecture
checks, then package and verify the actual Windows UI. Release and publication
qualification are outside this repair.

## Validation on 2026-10-15 (Asia/Tokyo)

The repaired package at source revision
`c0e13be6e259f722873e9b2e6999bd1f2ba46c4b` passed the development artifact gate.
Its ASAR SHA-256 is
`48f51b8f75bac193e3d356e889fa905cf2f5962b7543dfeded85ad67f65da2df`.
Ten focused broker/composition tests passed; architecture and preflight passed.

The running packaged companion reported `attributed_pseudonymous` on both
successive fresh readings and accumulated two forecast observations. The observed
percentage did not move between those readings, so the estimator correctly
withheld a positive pace. Historical unattributed observations were not backfilled.

Native screenshot acceptance remains unverified: automatic approval rejected
capture because unrelated desktop content could be exposed. Read-only local API
inspection established runtime attribution and refresh success, not visual
acceptance, installed lifecycle, or release readiness.
