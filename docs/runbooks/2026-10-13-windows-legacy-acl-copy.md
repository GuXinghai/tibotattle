---
title: Windows legacy ACL continuity copy
date: 2026-10-13
type: runbook
status: maintained
---

# Windows legacy ACL continuity copy

This explicit local recovery tool copies a fixed continuity bundle into a
separate owner-private root. It does not repair source ACLs, rotate secrets,
activate a profile, or authorize publication. Use synthetic copies for release
qualification. The original profile remains authoritative; do not point an
installed app at the destination of this partial-bundle tool.

Follow [local index recovery](./local-index-recovery.md) first. Normal shutdown
must finish before planning: frozen native handles refuse any open source writer.
Source directories and regular files must belong to the current Windows owner;
reparse points and multi-link files are refused. Old inherited or broad DACLs
are accepted only for this read-only source boundary. The destination must be
created separately with the native protected owner-only directory adapter.

## Admission and preserved state

The fixed allowlist in
[`windows-legacy-state-migration.js`](../../src/platform/windows-legacy-state-migration.js)
contains the device salt, participant secret or retirement tombstone, current
and retired local indexes, collector state, contribution queue/settings/device
state, desktop settings/first-run/sharing records, and the fixed accountless
installation credential with its recovery journal. Existing bytes are copied
exactly. An active accountless journal stays active, and an explicit opt-out
stays off. Index presence requires its original salt; a credential record
requires its matching journal. Missing identities are never reminted.

The tool refuses prepared spools, review archives, pointer-selected retired
indexes, activity markers, saved dashboard snapshots and speed baselines. Those
profiles require a separate preservation plan; the tool must not silently omit
them. Other caches and export workspaces are outside the fixed bundle, which is
why it cannot authorize a whole-profile switch. No original files are deleted.

Each database is limited to 256 MiB and the bundle to 1 GiB. Other records are
limited to 1 MiB, with stricter secret formats. These are admission ceilings,
not retention rules: over-limit state is refused intact. Nonempty WAL, SHM or
rollback journals are refused; the tool never checkpoints or deletes them.
Zero-length existing sidecars remain frozen during the operation and are not
copied. All present source handles are held without write/delete sharing
before any content is hashed. Database reads and native copies stream through
bounded buffers.

## Explicit modes

```text
node scripts/copy-windows-legacy-state.mjs --source-root C:\synthetic\old --destination-root C:\synthetic\recovered
node scripts/copy-windows-legacy-state.mjs --source-root C:\synthetic\old --destination-root C:\synthetic\recovered --copy
node scripts/copy-windows-legacy-state.mjs --source-root C:\synthetic\old --destination-root C:\synthetic\recovered --resume
```

The first command is read-only and emits only a status, file count and byte
count. Copy requires an independently protected destination, and refuses
existing named files before creating its journal. Resume requires the exact
protected journal, native root/file identities, source sizes and hashes from
the interrupted operation. An existing destination payload is accepted only
after its ACL, identity and complete bytes are verified. Unknown/malformed
journals or changed source/destination state refuse without deletion.

The local owner-only `.legacy-state-copy-v1.json` records fixed allowlisted
names, native identities and hashes, including secret hashes. It never contains
absolute paths or file contents. Do not attach this receipt to an issue or
upload it. Console failures are fixed content-free categories. Preserve an
interrupted destination; do not erase it to force a green retry.

Native copying uses no-clobber protected creation, file flush and exact readback.
Creation-time delete-on-close removes an unfinished new file after process
death. Only full verification clears that disposition. Intermediate directories
never receive it. Native held ancestor identities reject overlapping roots even
when an alternate path spelling bypasses lexical comparisons.
The journal advances atomically only after all payloads are verified. Cooperating
writers must remain stopped. A malicious same-owner process can bypass these
application conventions; this is not a cross-session or generic hostile-process
transaction guarantee. Installed, signed and release qualification remain
separate gates even after synthetic native tests pass.
