# Schemas

Closed canonical schemas for current local export, recoverable file transactions
and release evidence live here. See the maintained
[schema lifecycle](../docs/reference/schema-contracts.md) for owners and versions.

Current local export v1 rejects retired telemetry and export-set payloads. Its six
schemas and `contracts/local-export-v1/field-policy.json` produce the local field
dictionary and exact compatibility tuple through `pnpm run export:contract:generate`.
Validate with `pnpm run export:contract:check`. No telemetry upload mirrors remain.

Frozen release, synthetic and accounting evidence schemas serve only their named
readback boundaries. Retained deletion journal validators serve exact interrupted
file-transaction recovery; they do not enable an old telemetry reader or new
old-format deletion plan. Existing files, credentials and receipts are untouched.
