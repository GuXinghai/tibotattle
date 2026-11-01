---
title: Stable-metadata candidate local verification
date: 2026-11-02
type: receipt
status: verified
source_commit: 624b8adf
---

# Result and boundary

A stable-metadata Windows candidate built from source revision `624b8adf`
rendered the v11 dashboard from an isolated stable profile containing a copy of
the audited real index. The notice popover stayed inside the window, and
clicking the missing-Codex-folder setup row opened the native
"Choose Codex folder" picker instead of the details dialog.

This is an **unsigned local candidate**. It is not a signed installer, an
installed-app qualification, a normal-candidate CI journey, or release
evidence. The live index was not read or written by this launch.

# Candidate identity

- Source revision: `624b8adf68cc254d2fab71e326c5bfc682db93a7`.
- Production source candidate: build number `2026110201`, staged under
  `.release-build/electron-production/win32-x64`.
- Local artifact: `.release-build/electron-production/win32-x64/artifacts/win-unpacked`.
- Executable SHA-256:
  `82E38D0B12F6DAA623BD99DF1CCE5A717BAD6F43A705F82E99DDA4843A3614B4`.
- ASAR SHA-256:
  `7320E3E66AE582FDE61BB4F7357E669BDE3D2CA3E9CD737F4F255521C9CC0443`.
- Authenticode status: `NotSigned`.
- The artifact was built with the production configuration while explicitly
  disabling code signing only for this local verification. `signAndEditExecutable`
  remained enabled so the executable identity and ASAR integrity resources were
  written.

# Verification

- The reviewed production source-candidate staging completed with
  `signingRequired: true`, `signingPerformed: false` and
  `publishingPerformed: false`.
- The normal-candidate smoke was not run: it refuses a real host with
  `DISPOSABLE_CI_REQUIRED` and requires `GITHUB_ACTIONS=true` on a disposable
  Windows runner. That guard was not bypassed.
- A fresh stable profile was created under the quarantine volume. The
  first-run acknowledgement was written through the application's protected
  first-run backend; copying a receipt between profiles was not accepted.
- The profile's `companion-state` was seeded from the audited v11 copy. The
  stable candidate opened the normal `Rhetrion` window and rendered quota
  history, projected work hours and quota-consumption charts from that copy.
- At a 1180x822 viewport, opening the refresh notice measured
  `left: 16`, `right: 436`, `width: 420`; the panel was fully inside the
  viewport.
- Clicking the setup row with `sourceStatus = codex_home_missing` left the
  details dialog closed and opened the native Windows "Choose Codex folder"
  picker. The picker was cancelled; no folder was selected.
- The live index retained its post-migration SHA-256
  `4B1C3C9F8F457881C25B20591AF0F1E5DB0A2300C4A4FF9532AFD8C77F938343`
  and modification time.

# Remaining gates

- Signing material and a signed production candidate.
- The normal-candidate smoke on a disposable GitHub Actions Windows runner.
- NSIS installer installation, upgrade, restart and uninstall behavior.
- Owner-profile phase receipt (step 0) and release/updater publication.

The unsigned local candidate is usable for UI inspection only; it does not
close any of those gates.
