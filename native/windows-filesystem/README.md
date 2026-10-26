# Windows native security adapter

This is a fail-closed capability boundary. This independent Electron product
is unpublished, and this binding's general production/path-walk
policy remains disabled. Its narrow source-reader is enabled in this unreleased
source candidate, with native and packaged qualification pending. Source
compilation, native unit tests, or a valid sidecar do not establish that the
candidate works in the installed app. See the
[current status matrix](../../docs/current-status.md).

This directory contains the reviewed Windows-only filesystem and credential
mutex boundary for private Rhetrion state. The binding is deliberately a
small C N-API module;
it does not depend on a JavaScript filesystem path check being equivalent to a
Windows ACL or reparse-point check.

Build it on native Windows x64 with the repository's pinned Node toolchain:

```text
npm exec -- node-gyp rebuild --directory native/windows-filesystem
node ./scripts/build-windows-filesystem-manifest.mjs
```

The linker records only the neutral PDB basename in the binary's debug record,
so a developer's absolute checkout path does not enter the distributed module.
This changes no capability approval; regenerate the adjacent manifest after rebuilding.

The resulting `build/Release/windows_filesystem.node` and its adjacent
`windows_filesystem.node.manifest.json` are loaded only on native
Windows x64 by `src/platform/windows-filesystem.js`. Windows ARM64 and
missing/invalid bindings fail closed. The source contains a
qualification-only accountless upload-credential backend, separate from the
legacy Credential Manager capability boundary and its four logical IDs. It is
not a selected production credential backend.

The loader reads the fixed sidecar manifest, verifies the binary byte count and
SHA-256 before loading it, and cross-checks the binding's contract and native
capability claims against the manifest. The manifest has an explicit
`approvedPolicy`. Overall production and path-walk policy remain `false`; only
the narrow `credentialMutexSafe` contract is approved after native
qualification. This prevents self-reported booleans from enabling a production
path. The sidecar digest is
an integrity/mismatch check, not a provenance signature: a production release
must authenticate the manifest through a signed installer, signed manifest, or
equivalent allowlist before enabling Windows behavior.

The native methods are intentionally small and content-free on failure. The
binding still advertises `productionSafe: false` and
`pathWalkRaceSafe: false`, so the participant-identity integration refuses to
use it on a real Windows host. The path walker now uses `NtCreateFile` with a
held `RootDirectory` handle for every component; it no longer performs a
path-based validation pass followed by a second path-based open. The flag is
kept false until native Windows qualification proves the exact OS/build and
adversarial filesystem matrix, resolves the cross-session scope, and supplies
the remaining protected-state, audit, and binding-integrity evidence. This is
an intentional fail-closed gate, not a Windows support claim.

Intermediate components are opened as existing directories with
directory-safe access/share flags and `FILE_OPEN`; final-object access and
disposition are selected independently. Missing directories are created one
component at a time relative to the held parent handle. Creation requests
`WRITE_DAC`, supplies the protected descriptor, reapplies that DACL through
the handle, and marks a newly-created object delete-on-close if any validation
step fails.

- `inspectPath(path)` opens the final object without following a reparse point,
  records volume/file identity, link count, owner/DACL facts, and final-path
  resolution, and returns a metadata object for diagnostics.
- `ensureDirectory(path)` creates a missing directory with a protected,
  non-inheriting owner DACL and validates an existing directory.
- `readFile(path)` opens and validates a regular file through its handle,
  flushes no state, and returns bytes plus the handle identity.
- `createFile(path, bytes)` uses exclusive creation, an explicit protected DACL,
  `FlushFileBuffers`, close/reopen, and identity/security revalidation.
- `deleteFile(path, identity)` reopens the expected file, compares its handle
  identity and security, and marks that exact handle for deletion.
- `replaceFile(path, expectedIdentity, bytes)` creates a protected temporary
  file in the already-open parent directory, flushes and validates it, and
  atomically renames it over the target with `NtSetInformationFile` using the
  parent handle as `RootDirectory`. It reopens the destination and verifies
  the replacement handle identity, canonical final path, and bytes before
  returning. Expected paths are normalized through `GetLongPathNameW`, so a
  valid 8.3 short-name spelling can be compared with the normalized handle
  path. This is a qualification-only primitive; no production selector uses
  it today. Its ordinary race guarantee applies only to cooperating writers
  holding the opaque per-capability mutation lease across the operation. That
  lease is a `Local\` named mutex, so the guarantee is limited to one
  interactive Windows session. A deliberate same-UID process can bypass that
  lease and replace a name; that hostile case is outside this cooperation
  contract and is not a generic conditional-replacement/CAS gate.
- `inspectProtectedChild(root, rootIdentity, child)`,
  `readProtectedChild(root, rootIdentity, child, maximumBytes)`,
  `createProtectedChild(root, rootIdentity, child, bytes)`,
  `deleteProtectedChild(root, rootIdentity, child, expectedIdentity)`, and
  `replaceProtectedChild(root, rootIdentity, child, expectedIdentity, bytes)`
  first reopen and authenticate `root`, compare its handle identity with the
  caller-supplied identity, then resolve each child component relative to that
  held root handle. Child input is parsed again natively, so a JavaScript path
  check cannot redirect the operation. The read variant rejects a file larger
  than `maximumBytes` before allocating the returned byte vector.
- `acquireProtectedDirectoryGuard(root)` returns an opaque guard and the
  authenticated root identity under `windows-protected-directory-guard-v1`.
  The root must have exactly one current-owner full-access allow ACE, a protected
  DACL, and no deny ACE. All resolved ancestors and the root remain open without
  delete sharing until `releaseProtectedDirectoryGuard(guard)`; the guard uses
  the bounded 64-slot native registry. This pins the root name for cooperating
  release-operation writers while existing protected-child methods bind each
  mutation to its identity. It does not lock child names against a hostile
  same-owner process. Atomic replacements flush the replacement handle both
  before and after the rename. SQLite mutex and journal guards remain separate
  and must close only after the SQLite connection. These narrow capabilities do
  not enable the general production/path-walk policies or prove installed or
  signed-release qualification.
- `acquireProtectedChildGuard(root, rootIdentity, child)` pins a single-link
  regular file beneath that authenticated root with the exact owner-only DACL.
  It permits SQLite reads and writes while denying deletion and replacement;
  release uses `releaseCredentialAuditFileGuard(guard)`. Unlike the legacy
  path-based audit guard, it requires only the private root, leaving an ordinary
  artifact parent unchanged. Retain the directory guard across creation,
  connection, crash recovery, the exclusive mutex, and connection close.
- `acquireCredentialMutex(capabilityId)` accepts only one of four fixed numeric
  capability IDs, derives a per-user `Local\` kernel-object name from the
  current SID, applies and revalidates a protected owner-only DACL, and performs
  a non-blocking wait. It returns an opaque native lease only after a normal
  acquisition. An abandoned-owner result is released and closed, then surfaced
  as a fixed error so the JavaScript lease layer can retry once before any
  credential mutation begins. It serializes cooperating processes per
  capability in one interactive session only; the current manager deliberately
  reports `crossSessionSafe: false`.
- `releaseCredentialMutex(lease)` accepts only that opaque lease, verifies
  same-thread ownership and active state, releases exactly once, and closes the
  non-inheritable handle. The native issued-token registry is protected against
  concurrent Node worker-thread calls. JavaScript retains an in-process guard
  because Win32 mutex acquisition is recursive on one thread.

## Fixed accountless installation credential

The separate
[`windows-accountless-installation-credential-v1`](../../src/platform/windows-accountless-installation-credential.js)
backend owns one fixed, upload-only accountless installation secret. It is
exactly 32 bytes and is neither a provider, social, participant, nor legacy
Credential Manager credential. Its public backend surface has only `read`,
`createIfMissing`, and `deleteExact`; callers cannot choose a capability, record
name, or path. The fixed record
`accountless-installation-credential-v1.bin` and its fixed
`.accountless-installation-credential-v1.journal` live below the authenticated,
owner-private protected-state root selected by the main-owned composition.

The binding supplies
`acquireAccountlessInstallationCredentialMutex()` and
`releaseAccountlessInstallationCredentialMutex(lease)` for that record alone.
They have no capability parameter and are separate from the four generic IDs
`0..3` and the legacy FD4 broker. The native mutex is a per-current-owner
`Local\` object: it serializes cooperating processes in one interactive Windows
session, not every session for that owner.

This is an owner-private filesystem-permission boundary, not encryption at
rest. A backup policy can copy the plaintext secret, and a process acting as the
same Windows owner can alter the protected state outside the cooperating-writer
contract. The `Local\` mutex does not provide a cross-session guarantee. This
backend makes no lock-screen availability guarantee: it is a filesystem record,
not a Credential Manager lock-state boundary. These limits are deliberate
source-boundary facts, not a shipping Windows credential-store claim.

Before create or exact-delete can mutate the record, the backend durably writes
the journal's `active` state. An uncertain mutation, unsafe/malformed fixed
record, failed exact readback, failed release, or interrupted operation attempts
to retain that state; after it is verified, later calls return the fixed
`recovery_required` result rather than silently minting or replacing an
installation identity. If the backend cannot retain and verify that marker, it
returns a fixed operation failure without claiming restart-persistent recovery.
A known pre-mutation failure does not poison a previously normal journal, so a
later retry can safely proceed. Only the main-owned accountless adapter can
compose this secret into the existing private FD3 companion channel; it is not
exposed through FD4, renderer IPC, or HTTP.

The binding and backend deliberately remain `productionSafe: false`, and runtime
selection remains dormant. Native Windows x64 build, sidecar-manifest,
protected-state/mutex security, physical runner, installed lifecycle, signing,
and release qualification remain separate gates.

The protected DACL is deliberately strict: only the current user
SID is an allow principal. Inherited SYSTEM/Administrators/user-group allows
are not treated as an acceptable owner-only substitute; the later production
milestone must decide whether to retain this strict policy or document and
prove a narrower service-account exception.

The native implementation resolves `NtCreateFile`, `NtSetInformationFile`, and
`RtlNtStatusToDosError` from the Windows system `ntdll.dll`; no third-party
runtime or package is introduced. The native binding remains Windows x64-only.
Credential mutation audit durability is provided separately by the fixed
SQLite prepared/settled/recovered journal; neither the mutex nor audit enables
the still-disabled Windows production selectors.

The protected-child operations are real binding exports, but the v1 manifest
does not yet require them and the public protected-state readiness facts remain
false. Native Windows x64 CI must build this source, execute the protected-child
security tests, and retain its receipt before an installed Electron path can
rely on root-binding or bounded-read claims. A same-UID process that deliberately
bypasses the cooperation contract is not a conditional-replacement gate. The
disabled production flags, native Windows x64 physical and adversarial
qualification, cross-session decision, protected-state and audit lifecycle,
and authenticated installer/binding provenance remain separate production
gates.


## Shared source handles (pending native qualification)

The optional `windows-legacy-state-read-v1` capability adds frozen current-owner
source handles and directory guards for the explicit continuity-copy tool.
Inherited source DACLs remain unchanged. Frozen handles deny write/delete
sharing, and native ancestor identities reject aliased or contained roots.
Destination creation is no-clobber and protected owner-only, with bounded
64 KiB copy/readback buffers. Delete-on-close applies from creation to the final
new file only; intermediate directories are opened without that disposition.
After flush and complete byte verification, `FileDispositionInfoEx` clears the
on-close deletion. Unsupported kernels refuse the operation. Ordinary
`FileDispositionInfo.Delete = FALSE` cannot cancel creation-time delete-on-close;
see [Microsoft's API contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info).
Synthetic child-process termination verifies absence or a complete retained
payload. This narrow capability does not enable general production/path-walk
flags or qualify installed artifacts. Follow the
[continuity-copy runbook](../../docs/runbooks/2026-10-13-windows-legacy-acl-copy.md);
the copied bundle must not be activated as a whole profile.

The `windows-source-read-v1` extension supplies `openSourceFile(path)`,
`statSourceFile(lease)`, `readSourceFile(lease, offset, length)` and
`closeSourceFile(lease)`. It accepts ordinary inherited source ACLs only when the
current user owns the regular, single-link file. It does not change Codex source
permissions. Components are traversed relative to held handles with reparse
rejection; ancestors and source remain open without delete sharing until close.
Each native read is capped at 64 KiB before allocation. Source leases share the
bounded 64-slot guard registry, with source-only validation at their public close
entrypoint. The common JavaScript source-file adapter splits larger buffer reads
and exposes a FileHandle-like interface to the existing readers.

Timing and credential audit use `windows-protected-sqlite.js` for protected
owner-only database/journal creation and the existing native guard lifecycle.
Before any schema query, it enters EXCLUSIVE locking, selects PERSIST journaling,
forces recovery, then returns to NORMAL locking and releases the temporary lock
with a read. PERSIST alone does not prevent journal deletion during hot-journal
recovery. The shared sequence has portable SQLite crash/reopen coverage; native
Windows recovery remains a qualification gate. SQLite closes before guards
release. Timing refuses WAL/SHM residue and non-rollback headers without deletion;
no schema migration is introduced.

An optional closed `sourceRead` manifest capability binds the generic methods and
contract to the native digest. Existing manifests remain compatible for their
existing consumers. Source-read approval is separate from the still-disabled
general production/path-walk policies and requires the approved audit guard.
`WINDOWS_SOURCE_READ_APPROVED` is true in the unreleased source candidate; the
loader still rejects a missing or mismatched binding, manifest, contract, or
audit guard. A sidecar-only approval edit is rejected. Run the native security
suite against a rebuilt exact binary and manifest on Windows x64, then the
packaged worker smoke before merging this candidate. See the
[implementation and qualification plan](../../docs/plans/2026-09-13-windows-model-performance.md).

The native and packaged timing qualifications use disposable synthetic Codex
sources. On elevated hosted runners a new file can take the Administrators
group as its default owner. Fixture setup gives its isolated child process a
current-user default owner before creating the source, so Windows assigns its
ordinary inherited/default DACL at creation. Real Codex sources are never
modified by this setup; the native reader still refuses a foreign owner.

Projects & threads also uses these source leases for local display metadata.
Selected rollout-head hints use the same leases, without reading titles, so
paginated replacement histories and inline children resolve on Windows.
The main SQLite database and existing sidecars remain leased through connection
close. With no sidecars, an immutable read avoids creating coordination files
and rejects main-file or sidecar-presence changes. Live WAL reads require both
existing WAL and SHM files; SQLite may update existing SHM coordination bytes,
but the reader does not write database/WAL content or change journal mode or
source permissions. A transient create/remove of an absent sidecar by a hostile
same-owner process is outside the lease guarantee. Unsafe metadata retains the
anonymous fallback. Native metadata tests and the packaged project/task journey
are required in addition to model-performance qualification; see the
[issue #208 plan](../../docs/plans/2026-09-22-windows-project-task-names.md).
The Windows metadata assertions run against the real native adapter; any
non-native or simulated result does not qualify the native Windows binding.

## Chromium browser profiles

`windows-browser-profile-v2` is a separate, manifest-bound capability exposed
through `createWindowsBrowserProfileStore`. It does not change the generic
protected-record policy: `ensureDirectory` and record files still use their
protected, non-inheriting owner DACLs. Browser profile directories instead have
current-owner full access with object/container inheritance so Chromium-created
Cookie databases retain owner access alongside Chromium's sandbox capability.
No encryption settings, Cookie bytes, expiry, or account state are changed.

Before Chromium opens a profile, `prepareBrowserProfile` traverses at most 4096
objects and 32 descendant levels. All components are handle-relative; held
ancestors and accepted descendants deny delete sharing. Every object must have
the current owner, an allow-only closed ACL, no reparse point, and (for files)
exactly one link. Migration accepts current-owner, current-logon, SYSTEM, and
named application capability ACEs only; it replaces them with owner-only DACLs and
inheriting directory ACEs. Broad grants, foreign owners, unknown principals and
denies are refused. Named capabilities must have Chromium's
`S-1-15-3-1024` plus eight hash DWORDs shape; shared well-known capabilities
such as InternetClient are refused. Legacy capability-only objects are opened with the owner's
implicit READ_CONTROL/WRITE_DAC rights and kernel reparse rejection before their
individual DACL is changed. That traversal-only change is non-inheriting and
uses handle-bound `SetKernelObjectSecurity`, avoiding propagation to unvalidated
children. Inheriting ACEs are applied only after the bounded tree passes checks.
Parent-relative reopens retain both pinned handles
and compare object IDs. No privilege escalation or JavaScript ACL fallback is
used. A failure can leave earlier objects repaired; those owner-only changes
are retryable, while all file content remains untouched. This is not a
transaction against a hostile same-owner writer creating new names; application
lifecycle must keep Chromium closed during repair.

If that traversal exceeds its unchanged bound, preparation releases descendant
handles while retaining the authenticated root and ancestors, then attempts one
bounded cleanup pass. Only descendants of the fixed `Cache`, `Code Cache` and
`Service Worker/CacheStorage` directories are disposable; their roots, Cookie
databases, service-worker registrations, other site state, and the separate X
reading cache are retained. Cleanup resolves each child relative to pinned
handles, checks current ownership, the same closed migration ACL, single-link
regular files and absence of reparse points before marking that exact handle
for deletion. Legacy ACL repair is non-inheriting and handle-bound. No arbitrary
delete-tree API is exported, and generic protected-record policy is unchanged.

Cleanup has a depth limit of 32, one 64 KiB enumeration buffer and at most 8192
enumeration/open/deletion operations per preparation call. After the pass,
preparation rechecks the complete remaining profile against the 4096-entry
limit. If cleanup exhausted its budget and the tree still exceeds that limit,
it returns the distinct `windows_browser_profile_cache_cleanup_pending` error;
the next preparation resumes from the remaining files. Validated disposable
files already removed are not rolled back. Unsafe descendants fail closed and
remain untouched, while previously deleted safe cache files stay deleted.
Durable-state overflow still returns `windows_browser_profile_bound_exceeded`.
This recovery is not a replacement for retention policy or runtime cache limits,
and it is never permitted while Chromium has the profile open.

`inspectBrowserProfile` is non-mutating and checks only the profile root,
`Network`, `Cookies` and existing SQLite journal/WAL/SHM files. It does not scan
mutable browser caches during normal operation. Reads and write access are
checked separately without reading payloads. Current-owner full access must
remain present, with inheriting access on directories; safe sandbox capability
ACEs are accepted. Chromium holds its active Cookie database exclusively; only
the exact Windows sharing-violation result permits metadata-only inspection,
which validates the owner/DACL and read-only attribute and reports
`cookieDatabaseBusy: true`. Permission denial is never treated as that lock.
The metadata-only result does not claim a successful database data read/write.
Fixed errors and aggregate existence/byte counts are
returned, never paths, SIDs, Cookie values or encryption material. Access
inspection cannot establish successful decryption: the Electron service must
verify encrypted persistence and restoration separately and report uncertainty.
Native source tests, encrypted Electron restart tests, installed artifacts and
signed releases remain separate gates; general production/path-walk flags stay
disabled.

## Isolated usage-bundle freeze qualification

`usage-freeze.inc` supplies an opt-in qualification API, identified by
`windows-usage-directory-freeze-qualification-v1`. The ordinary product loader
does not select it. An isolated Node 26.2.0 build, generated adjacent manifest
and source/binary hash receipt are checked by
`scripts/lib/usage-bundle-freeze.mjs`; the receipt detects mismatched bytes, not
publisher authenticity. No global production or path-walk approval is enabled.

The qualification caller routes protected journals through that exact isolated
binding as well. Native atomic replacement retries only an uncommitted rename
for transient access/sharing rejection: at most eight attempts, bounded backoff,
the same flushed temporary handle and parent, and fresh original-destination
identity/security checks before each attempt. Persistent or uncertain results
remain failures; this is not logical-save or migration-action replay. The
ordinary compiled product binding is not replaced by qualification builds.

Opaque object leases bind current-owner, single-link, non-reparse directories
and files to native identities. Original DACLs must contain only recognized
current-owner allow ACEs; inherited current-owner grants can be preserved.
Broad/foreign/service/capability grants, source denies and unknown ACEs refuse,
without repairing or widening source permissions. The owner-approved separate
`openLegacyUsageFreezeParentDirectory` path accepts only the existing legacy
usage-source exception: SYSTEM/built-in administrators and one account-domain
read/execute SID, pinned consistently from the original parent ACL. It requires
the exact preflight descriptor bytes; mutation after preflight refuses. This
does not alter default owner-only or destination contracts. Broader SID classes,
reader write/delete/ACL rights, a second/different reader, source denies and
unknown ACEs refuse. `inspectUsageFreezeSourcePolicy` checks private supplied
descriptor bytes without mutation; it does not prove selected-file acceptance.

The separately approved snapshot exception is exposed only through
`openUsageFreezeSnapshotFile` / `reopenUsageFreezeSnapshotFile`. Native lease
ancestry must identify the primary timing root directly below the selected
usage root, with the fixed legacy/v6 snapshot filename. Only one existing,
non-inheriting logon-session read/execute ACE may be retained in that file's
exact original descriptor. Database, controls, other filenames, nested lookalike
directories, session writes and multiple session ACEs refuse. The tool must
explicitly select `preserve_legacy_usage_snapshot_v1`; earlier policies remain
unchanged. Recovery binds the same identity, nonce, descriptor and policy.
No source permission is removed, and source ACLs never reach the destination.

Directory acquisition excludes share-tracked
existing access before applying a fixed non-inheriting deny; child acquisition
uses held parent handles. All selected files reject existing granted data-write
handles and deny future data writes. Usage directories deny additions, deletion,
attribute/EA writes and child deletion. The explicit direct maintenance parent
separately denies `DELETE_CHILD` and `DELETE`, closing the source-root rename
bypass. It is acquired exclusively, frozen, then reopened against the same
identity/ACL with traversal sharing; no descendant ACL is inherited or repaired.
An independent no-delete-sharing identity handle stays held during that handle
handoff, including the close/reopen interval.
Its durable journal must be outside that parent. Unselected child contents and
ACLs remain unchanged. Ancestors are pinned during the operation; this is not
a volume lock or protection against a privileged/hostile owner changing ACLs
or relocating higher ancestors after the process exits.

Persist original owner/group/DACL bytes and object identity before mutation.
A deny-only operation nonce ACE binds recovery to that operation, so an older
valid journal cannot thaw a newer freeze. Recovery accepts only the exact
original or computed frozen ACL. Unknown changes refuse. Close, GC and process
death release handles without restoring ACLs. Explicit reverse restoration
refuses live descendants and borrowed read/SQLite handles. Failed SQLite closes
pin the whole barrier until process exit; do not turn release uncertainty into
an automatic thaw. SACLs, credentials and registry data are not accessed.

Borrowed tokens reuse the reviewed frozen source reader, native root-identity
comparison and per-file `CREATE_NEW` copier. Copying never invokes the broad
legacy continuity selector. Backup creation, readback, immutable SQL inspection,
conversion, permission restoration and activation remain distinct operations.
Qualification tests use disposable private roots only. Source/native synthetic
success does not qualify a real source, installed artifact or release.
