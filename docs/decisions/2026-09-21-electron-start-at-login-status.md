---
title: Electron start-at-login status and refresh
date: 2026-09-21
type: decision-record
status: accepted
---

# Electron start-at-login status and refresh

The Electron Settings switch presents observed platform state. Opening Settings,
completing a switch operation, and returning focus to Settings each trigger a
fresh read. The normal page has no manual refresh control; **Try again** appears
only when a status or settings read fails. A successful request is never treated
as proof that the operating system applied the requested state.

On Windows, the app uses Electron's startup registration and observed
approval state. **Open Login Items Settings** is available only where the app has
a fixed Windows Settings target.

This is an unreleased source contract. Source tests and a disposable
round trip do not qualify an installed Windows login session. Physical Windows
launch, login, disable, upgrade, and uninstall behavior must be qualified before
a new release claims that startup integration is verified.
