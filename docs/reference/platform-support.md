---
title: Platform support and qualification
date: 2026-10-23
type: reference
status: maintained
---

# Platform support and qualification

The product scope is Windows x64 only. Rhetrion is unpublished; this scope is
not a claim that every native, installed or release gate has passed. See the
[current status](../current-status.md) and
[Windows-only decision](../decisions/2026-10-12-windows-only.md).

| Gate | Required evidence |
| --- | --- |
| Source and contracts | Exact checkout, active diff, owning tests and maintained documentation |
| Native Windows | Exact binary and sidecar, C N-API/ABI, owner/ACL/link/reparse/race and credential boundaries |
| Packaged artifact | Exact staged inventory, ASAR integrity, package identity, native bytes and resources |
| Physical desktop | Real interactive Windows rendering, tray/taskbar, lifecycle and credential behavior |
| Installed lifecycle | Fresh install, shortcuts/protocols, notifications, startup, reopen and recovery |
| Release and updater | Final-byte signing/timestamp/provenance and separately configured feed/publication proof |

Passing one row never establishes another. Node.js 22.13 or newer is required
for root tools; production source preparation requires exactly Node.js 26.2.0.
Windows packaging and GUI checks require a supported interactive Windows x64 host.

The native binding deliberately retains `productionSafe: false` and
`pathWalkRaceSafe: false`. Narrow source-reader, release-operation and
browser-profile approvals are separate capabilities, not switches for general
production safety. Qualification markers and synthetic adapters must not be used
against a real profile. A development artifact or unsigned local candidate does
not become a signed release because its source tests passed.

Unexpected credential prompts remain a release blocker; do not weaken credential
protection to suppress them. Credential Manager access must be non-interactive.
Preserve the designed identity, owner-only state, native validation and explicit
recovery path. Never rotate credentials or wipe a profile to hide a prompt.

An independent-product signing account, release owner and updater feed are not
configured. Former project receipts remain historical and cannot qualify new
source or artifact bytes. Full local-data cutover also requires protected cold
backup, copy conversion, schema/semantic checks, encrypted session restart and
journaled activation/recovery before the original profile can cease to be authoritative.
