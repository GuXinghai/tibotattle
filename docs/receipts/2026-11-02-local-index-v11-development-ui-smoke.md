---
title: Local-index v11 packaged development UI smoke
date: 2026-11-02
type: receipt
status: verified
source_commit: 6d9ec437
---

# Result and boundary

A packaged Windows development candidate built from source revision
`6d9ec437` rendered the v11 dashboard from an isolated copy of the audited real
index. The live index was not read or written by this launch. This is an
unsigned development-package and rendered-UI smoke, not installed-app, stable
packaging, native qualification or release evidence.

# Artifact

- Source revision: `6d9ec437614f79af4ba920ad9521927f0708cbb5`.
- Build tool: portable Node.js v26.2.0, verified against the official
  `node-v26.2.0-win-x64.zip` SHA-256 before use.
- Package command: development packaging with `--format dir`.
- Output: `.release-build/electron-candidates/6d9ec437.../win32-x64/dir`.
- Executable SHA-256:
  `36730211b91d0d7ef47649d10022f79989abe7890b0aa7dc7410d1dd9d83499d`.
- ASAR SHA-256:
  `58e1544b65731dcdc6f017f2ccb0da341d92d72d80d270158e4ba961876817b5`.
- The ASAR contains `workload_bucket`, so the package includes the v11 work
  projections.

# Profile and data source

The candidate was launched through the reviewed development launcher with an
isolated profile on the quarantine volume. The profile state root was seeded
from the audited v11 copy of the real index; the live stable companion-state was
not used. The development launcher supplies an isolated empty Codex home, so
the dashboard showed the expected "Codex folder not found" setup banner and the
data appeared stale; the copied index facts and projections still rendered.

# Failure found and corrected

The first two launches exposed protected-state setup issues in the isolated
profile:

1. A pre-created `state` directory with inherited ACLs was rejected as
   `companion_configuration_invalid`.
2. A copied `local-collector-state-v1.sqlite` with `SYSTEM` and logon-session
   ACEs was rejected as `local_collector_state_unavailable`.

The final profile lets the companion's native adapter create the protected state
root, creates the collector database through that boundary, and then copies the
real collector bytes into the app-created file while preserving its owner-only
ACL. The live index was never used as a repair target.

# Rendered result

After the protected-state correction, the candidate opened the normal
`Rhetrion` window with the dashboard, not the recovery window. The overview
rendered real quota history, projected work hours and quota-consumption charts
from the copied v11 index. The live index retained its post-migration SHA-256
and modification time.

The development package remains unsigned and isolated. Installed Windows
packaging, stable-profile selection, native rendering qualification, updater and
release evidence remain separate gates.
