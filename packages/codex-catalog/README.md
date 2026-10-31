# Codex catalog

The public root entrypoint owns reviewed Codex plan identifiers, display names,
model identities, bounded lookup and reasoning-configuration vocabulary. It is
runtime-neutral and has no dependencies. Quota and accounting remain separate.

`sci` and `sci_plus` are distinct provider labels, displayed as Academic
Researchers and Academic Researchers Plus. Their names were checked against
[`KnownPlan` at revision 275a9a89](https://github.com/openai/codex/blob/275a9a89b6a2689b5b5a8b3b4aa5dc3c02e7d64a/codex-rs/protocol/src/auth.rs).
The catalog assigns no allowance, price or entitlement. Unknown plan evidence
stays unknown; unknown model lookup returns `null`.

`scripts/generate-codex-browser-mirror.js` generates the local dashboard mirror
from `src/plans.js` and `src/model-catalog.js`. Use the root workspace commands
`pnpm run codex:browser:generate` and `pnpm run codex:browser:check`.
The catalog completeness validator is available to source checks and is excluded
from the local browser mirror.
