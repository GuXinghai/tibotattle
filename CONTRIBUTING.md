# Contributing to Rhetrion

This checkout owns a local Windows x64 application, its loopback companion and
browser dashboard. Read [AGENTS.md](AGENTS.md), the nearest scoped guidance and
[SECURITY.md](SECURITY.md) before changing a boundary.

## Setup

Use Node.js 22.13 or newer and the pnpm version in `package.json`. Production
Electron preparation requires exactly Node.js 26.2.0; native packaging and GUI
checks require Windows x64. Install only the root workspace:

```sh
pnpm install --frozen-lockfile
```

There is no Worker dependency tree or cloud deployment in this product.
No source checkout step authorizes remote changes, signing, publication,
installation into system locations, or changes to real credentials/profile data.

## Checks

Run the smallest meaningful direct tests first, then the owning gates. Root
checks use pnpm; serial test configurations must remain serial.

```sh
pnpm run test:preflight
pnpm run architecture:check
pnpm run codex:contract:check
pnpm run product:ui:test
pnpm run product:electron:test
pnpm run product:local:test
```

`pnpm run check` composes source gates. Physical Windows behavior, packaged apps,
installers, signing and updater availability are separate gates. Report missing
prerequisites and baseline failures explicitly; do not lower checks for a green run.

## Contracts and generated files

Use reviewed public facades. Keep packages platform-neutral, local HTTP loopback-only,
and renderer capabilities narrow. Preserve replay safety, sparse evidence,
forward-only schemas, cancellation and recoverable state transitions.

Change canonical inputs and regenerate i18n/telemetry mirrors through their owned
commands. Never hand-edit `generated/` or generated contracts. R7 receipt regeneration
is a protected environment-specific operation, not routine validation.

Brand resources belong in `config/product-brand.cjs`. Machine identity belongs in
`config/application-identity.cjs`. Display names and artwork must not determine
storage paths, credentials, account scope, protocols or runtime authority.

Use synthetic minimal fixtures. Never include prompts, responses, credentials,
real account identifiers, session paths or raw private records in source, logs,
issues or artifacts. Preserve unrelated worktree changes and inspect the exact
diff before committing. Update maintained docs and owning tests with behavior.

Third-party workflow actions remain pinned to immutable commits, with read-only
permissions by default. Future publication needs a configured owner/repository and
new evidence bound to exact final bytes; inherited historical releases cannot be
presented as releases of this independent product.
