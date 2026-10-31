# Generated artifacts

Committed contract outputs and frozen historical release evidence live here.
Never edit their bytes by hand or gitignore this directory.

Generate current local export outputs with `pnpm run export:contract:generate`
and verify exact source/policy/registry hashes with `pnpm run export:contract:check`.
These routines do not inspect or mutate retained user exports or identities.

Existing R7 receipts prove only their recorded source digest, environment and
date. Generation is retired; do not regenerate or rewrite them to match current
source. Use the [R7 preservation runbook](../docs/runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md)
for explicit historical readback. Passing source checks does not qualify an
installed application, signed artifact or release.
