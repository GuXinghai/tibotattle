---
title: Windows-only platform support
date: 2026-10-12
type: decision-record
status: accepted
---

# Windows-only platform support

## Status and boundary

Owner-confirmed on 2026-10-12. This record sets the product platform scope. It
is not evidence of a Windows build, signed installer, updater feed, installed
upgrade, or public release. Those remain separate gates in
[the documentation index](../README.md).

## Decision

TiboTattle supports Windows only. The desktop app, local companion, installers,
updater, release pipelines, tests, and public support statements target Windows.
macOS and Linux are not supported platforms.

## Removed

- Linux and macOS desktop support, installers, and packaging.
- The macOS Keychain credential store, its migration, and its prompt handling.
- Sparkle update feeds, AppImage packaging and launchers, notarization, and
  macOS signing pipelines.
- Linux secret-service and XDG integration.
- Linux and macOS native addons, their build steps, and their qualification.
- macOS release runbooks, native-to-Electron handover material, Homebrew
  distribution, and macOS-only public documentation.

## Preserved

- The Windows Credential Manager credential store and its non-interactive access
  rules.
- The Windows filesystem native addon and its security contract.
- Windows code signing, the Windows installer, and the Windows updater.
- Optional hosted contribution: content-free, pseudonymous, accountless by
  default, with durable opt-outs and owner-only erasure.
- Read-only handling of the user's original Codex data.

## Superseded records

This decision supersedes the macOS and Linux platform decisions and runbooks
that are removed with it. Their history remains in Git. They include the
Homebrew and macOS support decision, the macOS Login Item lifecycle decision,
the silent native Keychain migration decision, the AppImage sandbox launcher
decision, the Electron macOS bundle version decision, the cross-platform release
trust decision, and the macOS stable release and handover runbooks.

Mixed-platform dated records that remain are point-in-time evidence. Where they
describe a macOS or Linux step, that step no longer applies to any current
release or operation.

## Consequences

- Platform support statements in the README, support, security, user, and
  reference documents name Windows only.
- Release and verification gates are Windows gates. Any future macOS or Linux
  support requires a new explicit product decision, matching tests, and
  updated authoritative documentation.
