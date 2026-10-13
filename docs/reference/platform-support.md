---
title: Platform support and qualification
date: 2026-10-12
type: reference
status: maintained
---

# Platform support and qualification

TiboTattle supports **Windows x64 only**, under the
[Windows-only platform decision](../decisions/2026-10-12-windows-only.md).
macOS and Linux are not supported platforms: their desktop builds, installers,
updaters, credential stores, and qualification paths are removed. Earlier
released macOS and Linux artifacts and their evidence remain available only as
historical records. See [current status](../current-status.md) for the source,
updater, and hosted boundaries, and the
[public release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.26/release-manifest.json)
for the exact 0.1.26 artifact hashes and recorded assurances.

## Status matrix

| Platform | Current distribution | Proven final-artifact boundary | Acceptance limits |
|---|---|---|---|
| Windows x64 | Released; 0.1.26 signed installer | Authenticode signature, timestamp and hosted installed journey on the exact candidate | Existing-install updater replacement and every physical desktop integration are not qualified |

Windows ARM and unlisted Windows variants are not covered. Platform-specific
trust, credential, and installed-lifecycle evidence is not interchangeable with
shared application source tests.

## Evidence ladder

Keep these boundaries separate for every release:

1. Source and automated contracts: selectors, schemas, bounded processing,
   filesystem and credential protection, and negative behavior.
2. Final artifact: exact source/build identity, architecture, checksum and the
   Windows trust policy.
3. Installed lifecycle: fresh launch, retained-data upgrade, local processing,
   preferences, opt-out and restart on Windows.
4. Updaters and desktop integration: replacement, relaunch, tray,
   notifications and login behavior where tested.
5. Publication: immutable installer, checksums, manifest, stable updater
   metadata, and website and distribution guidance agree.

An explicit owner acceptance identifies missing observations; it does not
convert source tests, a container run, metadata or a prior release into a
passed installed test. It never waives data preservation, credential protection
or updater integrity.

## Windows

The 0.1.26 installer is signed and timestamped. Its
[hosted installed journey](https://github.com/adamallcock/tibotattle/actions/runs/36347063769)
qualifies the exact signed candidate. It does not establish every existing
installation's updater replacement, retained credentials or physical desktop
notification behavior. Do not promote earlier unsigned or source-only Windows
tests into final-artifact evidence.

Windows credentials use the Windows Credential Manager. Unexpected credential
prompts remain a release blocker; do not weaken credential protection to avoid
them.

## Maintenance rule

Update this declaration from exact release evidence and explicit acceptance.
Do not infer current support from an open pull request, development build,
screenshot or old receipt. A future release needs its own frozen source,
artifacts and qualification.
