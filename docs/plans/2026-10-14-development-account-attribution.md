---
title: Development account attribution repair
date: 2026-10-14
type: plan
status: in-progress
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
