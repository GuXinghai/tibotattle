# Codex catalog guidance

Scope: `packages/codex-catalog/`. Apply the root guidance first.

- This runtime-neutral package owns reviewed Codex plan and model identities,
  display names, bounded model lookup and reasoning-configuration vocabulary.
- Identifiers and labels do not establish access, entitlements, quota capacity,
  allowance formulas or prices. Keep those policies with their existing owners.
- Unknown/private model names never pass through the reviewed lookup. Preserve
  unknown plan evidence in consumers rather than guessing a known variant.
- Use the public root entrypoint. Keep runtime and declarations aligned; do not
  depend on applications, root source, tooling or telemetry formats.
- Generate the local browser mirror with `pnpm run codex:browser:generate` and
  verify it with `pnpm run codex:browser:check`. Do not edit generated files.
- Verify source-backed plan changes through the contract ledger and its drift
  checker. Historical binary observations keep their original hashes.
- Run focused catalog, provider, cache and browser tests plus architecture checks.
  A source check does not qualify an installed application or provider allowance.
