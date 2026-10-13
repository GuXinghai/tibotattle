---
title: Windows portability qualification environments
date: 2026-08-17
type: runbook
status: maintained
---

# Windows portability qualification environments

This runbook describes the Windows test environment. It is not a Windows
installation or release runbook. TiboTattle supports Windows x64 only
([decision](../decisions/2026-10-12-windows-only.md)); the macOS host, Linux
container, and local ARM guest lanes that once supplemented this environment
are removed. All commands use synthetic fixtures; none should be pointed at a
real Codex home.

## Recorded environment

| Lane | Recorded implementation |
|---|---|
| Native Windows x64 | Microsoft Windows Server 2025 x64; runner image `windows-2025-vs2026` version `20260810.198.2`; Node 26.2.0; Corepack 0.34.0; pnpm 11.9.0 |

The GitHub-hosted Windows x64 lane is the authoritative environment for Windows
filesystem, process, ACL, and Credential Manager behavior. Any other host is
a development convenience and does not satisfy that gate.

## Native Windows x64 lane

The workflow is manual-only so an unreviewed branch cannot consume runner time
or become support evidence automatically. One dispatch runs the fixed warm and
clean dependency-store matrix against the same exact revision:

```bash
gh workflow run windows-portability.yml \
  --repo adamallcock/tibotattle \
  --ref codex/windows-security-credentials
```

For each run, preserve the run URL, commit SHA, `ImageOS`, `ImageVersion`,
architecture, Node and pnpm versions, test counts, skips, binding SHA-256, and
credential cleanup result. Any failure or unexplained skip keeps the milestone
open. The clean matrix job intentionally skips only the pnpm store cache; the
hosted runner itself is still a Microsoft-provided runner image.

The latest completed qualification is
[run 32085366833](https://github.com/adamallcock/tibotattle/actions/runs/32085366833):
restored/primed-store job `95556686783` and clean-store job `95556687033` both
passed on revision `b8811349b5b38df0319684ebc0b4377f9d404c94`.

## Cleanup and restoration

- Portable tests create temporary directories under the runner temp root and
  assert their removal.
- The Credential Manager probe uses a random service/account pair and confirms
  deletion before reporting success.
- Do not delete the task worktree or branch until the receipt is reviewed and
  the maintainer decides whether to integrate the change.
