# Electron desktop guidance (Windows only)

Scope: all files under `apps/electron/`. Apply the repository root guidance first.
TiboTattle's desktop shell supports Windows x64 only. Do not add branches,
packaging targets, or compatibility shims for other platforms.

## Ownership and isolation

- Electron owns desktop lifecycle, preload/IPC capabilities, settings, tray,
  menus, notifications, and Windows shell integration. The existing local
  companion owns analysis and the shared web dashboard owns its data
  presentation; reuse those owners rather than introducing a second accounting
  implementation.
- Read `apps/local/AGENTS.md` for companion changes and `apps/web/AGENTS.md` for
  dashboard changes. Read `scripts/AGENTS.md` for packaging or smoke tools and
  `native/AGENTS.md` for Windows filesystem or credential changes.
- Keep renderer sandboxing, context isolation, loopback validation, navigation
  restrictions, and the frozen, narrow preload bridge. Renderer input does not
  authorize arbitrary paths, URLs, commands, or main-process operations.
- `platform-gate.js` is the fail-closed boundary: any non-`win32` host is
  refused before a companion, state root, notification, or credential path is
  composed. Do not weaken it to make another host "work".
- Platform capabilities must reflect actual qualification. A simulated adapter,
  development package, or passing contract test cannot enable signed-updater,
  notification-identity, credential, or installer production policy.
- Preserve single-instance control, bounded recovery, shutdown of the owned
  companion, safe cancellation, and settings persistence. Do not kill unrelated
  processes or reuse another app's mutable state to simplify a test.

## Settings, state, and credentials

- Windows state goes only through the repository-branded protected state store
  (`src/platform`). Settings, first-run receipts, sharing, notification policy,
  update preferences, and refresh cadence must not fall back to ordinary Node
  filesystem writes.
- The account-observation credential broker is handed over only through the
  reviewed Windows factory (`desktop-windows-accountless-credential.js`; the
  filename predates the sharing removal). Generic `safeStorage` paths are not a
  production fallback.
- The companion receives a closed environment allowlist
  (`companion-supervisor.js`). Add a variable only with a reviewed reason; do
  not pass shell secrets, provider credentials, or `NODE_OPTIONS`.

## Packaging, installer, signing, and updater

- Use the reviewed Windows staging and builder configuration
  (`electron-builder.config.cjs` for development, `electron-builder.production.config.cjs`
  for the candidate, `electron-builder.release.config.cjs` for the signed release).
  Keep the exact source/dependency closure and the Windows native bytes verifiable.
- The Windows NSIS installer, Authenticode signing, `usagemonitor://` protocol
  registration (`windows-protocol-registration.nsh`), and the `electron-updater`
  feed are the only installer and update paths. Do not add other packaging
  targets or update feeds.
- Never reuse the retired native app's state, credentials, or profile.
  Never mutate or downgrade the native app's databases; a Windows profile
  migrates only through its reviewed, forward-moving path.
- The application icon is `assets/tibotattle.ico`, generated from the approved
  web artwork as described in `assets/README.md`.
- Keep unsigned development packaging separate from signing, installer/updater
  qualification, and public release. Never promote a prior receipt to proof for
  different source or artifact bytes.

## Validation and local handoff

- Run focused `apps/electron/test/*.test.mjs` tests while iterating, followed by
  affected web/companion and packaging contracts when their boundary changes.
- Windows GUI tests and packaged smokes need an interactive Windows session.
  Report their absence as an environment gap, not a passing gate.
- A user-visible fix needs a fresh packaged app and rendered inspection, not
  only a fake BrowserWindow or browser test. Bind smoke evidence to its exact
  source revision and ASAR digest; test the relevant settings and lifecycle flow.
- Use synthetic disposable profiles for automated tests. Never mutate real
  profile state from a test.
- Keep user-test apps and launchers in durable locations, not OS temporary
  directories. Preserve the previous working app/profile until the candidate
  passes its package gate. Keep raw logs and private state untracked.
- A local-QA launch must retain its no-hosted-contribution and
  no-credential-mutation safeguards.
