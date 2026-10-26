# 衡川 · Rhetrion

Rhetrion is a private, local coding-agent usage dashboard for Windows x64.
It reads bounded Codex usage/account observations and shows recorded usage,
quota movement, cache behavior, and estimates with their coverage and uncertainty.
It is not a provider billing system or an authoritative quota formula.

This independent product is under development and has not been published.
The repository has no configured download website, hosted contribution service,
signing account, or update feed. Older Git history and retained evidence describe
an earlier project; they do not establish a Rhetrion release or deployment.
See the [current status](docs/current-status.md) and
[identity decision](docs/decisions/2026-10-23-local-product-identity-and-cloud-retirement.md).

## Local behavior and privacy

Local reads cover Codex `sessions`, `archived_sessions`, bounded `state_5.sqlite`
thread metadata and `config.toml`, plus the app-server methods `account/read`,
`account/rateLimits/read` and `account/usage/read`. These sources have separate
privacy and coverage boundaries; they do not authorize storing session content.

Analysis works offline. The companion binds only to loopback. Prompts, responses,
raw commands, credentials and session contents do not belong in derived reports.
Private source paths remain in the owner-only local index and never leave it.
Missing, stale, partial, unpriced and unattributed evidence stays explicit.
Display windows do not delete retained history.

The desktop has no community sharing or contribution upload. Saved opt-outs,
identity salts, receipts and credentials are preserved. Removing the old cloud
project from this checkout does not erase or administer any former remote service.
The optional X reader uses a separate protected browser session and does not send
local usage data in its network requests.

See [local data and privacy](docs/reference/local-data-and-privacy.md),
[security policy](SECURITY.md), and [safe recovery](docs/runbooks/local-index-recovery.md).

## Install Windows x64

No Rhetrion installer is published. Source staging and unsigned local test artifacts
are separate from installed, signed-release, updater and GUI qualification.
The native Windows adapter retains its fail-closed policy; a valid binary digest
or passing source tests does not enable unqualified production capabilities.
Do not run an incomplete candidate against your only copy of application data.

Branding is presentation only. The executable remains `usage-monitor.exe`,
the package is `app-usagemonitor`, and the stable App ID is `com.usagemonitor.local`.
Profiles use `%APPDATA%/UsageMonitor/profiles/<profile>` independently of the title.
A new name never authorizes changing credentials or selecting another profile.
Existing data cutover requires the separately verified one-time migration and backup.

## Develop and verify

Root tooling needs Node.js 22.13 or newer and pnpm 11. Production Electron source
preparation requires exactly Node.js 26.2.0. Native packaging and desktop validation
require a supported interactive Windows x64 host.

```sh
pnpm install --frozen-lockfile
pnpm run product:local
```

The source dashboard is served through its loopback companion. Use focused tests
first, then the relevant owning gate:

```sh
pnpm run test:preflight
pnpm run architecture:check
pnpm run product:ui:test
pnpm run product:electron:test
pnpm run product:local:test
```

`pnpm run check` composes the broad source gates; it is not installed-artifact
or production-release proof. See [contributing](CONTRIBUTING.md) and the
[documentation index](docs/README.md) for maintained contracts.

## Local usage coaching

`node ./src/cli.js explain-usage-plans` lists the bounded, deterministic local
analysis plans. The [agent protocol](docs/reference/usage-explainer-agent-protocol.md)
defines pagination, evidence selection and prohibited claims. The repository skill
uses this CLI; the former macOS-only plugin wrapper is retired.

The source layout follows `src/` for domain behavior, `apps/local` for the companion,
`apps/web` for the dashboard, `apps/electron` for the shell, `packages/` for neutral
public APIs, and `native/windows-filesystem` for the Windows security boundary.

## Support and language

The interface supports English, Simplified Chinese and Spanish. Product names and
artwork come from the presentation config, separately from stable internal identity.
For troubleshooting, review [support guidance](SUPPORT.md). No external support or
private reporting destination is configured for this unpublished product.
