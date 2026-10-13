---
title: Windows v2 cutover continuation
date: 2026-10-13
type: implementation-plan
status: partial
---

# Windows v2 cutover continuation

Starting checkout: `fix/windows-codex-refresh`, `1eed0f44`. The only initial
untracked file was the owner's `CODEX_HANDOFF.md`; preserve it. The five cutover
commits and completed v1 retirement are not repeated.

## Acceptance boundary

- Verify the outstanding Windows tests independently of historical receipts.
- Close the derived-table audit/repair gap using committed facts only, in a
  worker, with atomic repair, cancellation, retry and cache invalidation.
- Correct source-proven stale references without changing settled platform,
  identity, retention or sharing decisions.
- Record environment gaps and outstanding contract choices separately from
  passing source tests. Installed, signed, updater and deployment qualification
  remain separate gates; no publication or live-state mutation is authorized.

## Work sequence

1. Verify checkout, instructions, public facades and outstanding tests.
2. Add and validate maintenance at the completed refresh boundary: first
   process refresh and daily thereafter, before downstream generation reads.
3. Repair stale maintained documentation; apply the owner's 2026-10-13 scope:
   preserve published-manifest compatibility, retire the unavailable shadow
   prototype, and retain deployed Worker tables pending forward migration.
4. Run owning tests, architecture and preflight; update this record with exact
   evidence and remaining gates.

## Risks

Do not replace the live database, regenerate its salt, renumber sources, edit
published migrations, regenerate R7 receipts, or use private sessions as fixtures.
Audit repair must advance publication identity only when aggregates changed.
Worker cancellation or repair failure must roll back and leave facts intact.
Dependencies and the sandbox may prevent a test from reaching its assertions;
such a result is an environment gap, never a passing gate.

## Implemented in this working tree

- Audit maintenance runs in a worker on the first completed process refresh and
  daily thereafter at the next completed ingestion boundary. It rechecks under
  the writer lock, atomically rebuilds only drifted derived tables from facts,
  verifies the result and advances publication with a `verify` commit. Failure,
  cancellation and conservative WAL/disk admission refusal stay retryable.
- The pairing oracle now reports nonpositive orphan rows. Maintenance reads no
  rollouts and changes no source ordinals. No live-profile mutation, original
  salt regeneration or live database replacement was performed; validation
  creates and mutates only synthetic state.
- Final preservation inspection found that refresh created a missing salt
  before opening an existing store. Refresh now probes existing state read-only
  and requires the original salt for published/source-bearing state, carried
  ordinals or a legacy index. Missing/malformed salt and incompatible state
  refuse without creating salt or changing database bytes. Fresh empty stores
  still initialize normally. Valid-length substituted salts remain a recovery
  checksum responsibility; no stored salt-authentication schema was added.
- The telemetry publication exposes the existing extractor parser label; the
  internal compound store stamp remains in its fingerprint. Both successor
  contribution engines run with real synthetic capability leases and durable
  journals. Legacy ordinal carry, reversed discovery, identical replay and
  later append are exercised with no real accounts or hosted writes.
- Device-state directory durability reuses the existing Windows platform
  adapter. File fsync, no-clobber, identity and credential checks remain intact.
- Companion shutdown now rejects new work, drains workers while the listener
  keeps the process alive, and closes the listener even on cleanup failure.
  Direct performance requests retain their existing bounded deadline; idle
  workers remain unreferenced. This fixes reproduced premature process exits.
- The candidate smoke fixture now carries one explicitly identified weekly
  quota observation needed by calibration; its event/token counts and first-run,
  generation and replay assertions remain intact.
- The unavailable Claude Desktop shadow prototype and exclusive wiring,
  fixtures and benchmark tool are retired under the new decision. Generic
  Claude parsing and published telemetry contracts remain.
- The published manifest schema retains historical shapes, while current
  release generation/qualification stays Windows-only. Obsolete runtime
  references and an unused Linux catalog key were removed; generated i18n
  mirrors were regenerated through their generators.

## Validation environment and evidence

Windows x64, Node `22.21.1`. Owner-authorized dependency installation used
`corepack pnpm` `11.9.0` with `--frozen-lockfile`, then `npm ci` in the Worker.
Neither lockfile changed. Installed builder `26.15.7`, keytar `7.10.6`, Worker
jsonc-parser `3.3.1` and builder-relative js-yaml `4.3.2` remove the recorded
dependency gap. Worker installation reported five high audit findings; no
automatic dependency fix was applied.

Synthetic Windows filesystem tests ran in an approved execution context after
the sandbox refused `realpath` operations. Sandbox refusal is not product proof.

| Gate | Current evidence |
| --- | --- |
| Maintenance, pairing and WAL pressure | 14/14 pass; seven new maintenance cases cover atomic repair, facts/identity preservation, rollback, cancellation, retry, incompatible stores, daily/restart scheduling and pressure refusal |
| Salt preservation and affected v2 paths | 29/29 pass: three new negative/recovery cases plus refresh, backend, cutover, successor replay and WAL coverage |
| Final core integration | 113/113 pass after salt protection: refresh/error allowlist, identity preservation, maintenance and actual loopback; final foreign/newer-state cases separately 3/3 pass |
| Backend integration | 15/15 earlier backend/maintenance pass; actual loopback, import/privacy boundary and cutover safeguards 8/8 pass |
| Successor engine and backend suite | 61/61 pass; actual synthetic device lifecycle 1/1 pass |
| Windows normal-candidate contracts | Final retained full run 53/53 and isolated case 32 pass; another full run was 52/53 with an unclassified intermittent failure, so stability is not established |
| Release-schema compatibility and i18n | 31/31 pass; both generated mirrors match canonical catalogs |
| Refresh and shutdown | Refresh 102/102 pass, shutdown/admission contracts 3/3 pass |
| Performance | Root performance 36/36 and real telemetry 2/2 pass after the lifetime fix |
| Documentation and architecture | Final source/evidence recheck: preflight 20/20, API source parity 1/1, 248 Markdown files valid, architecture 608 production files / 2,410 imports / zero debt edges, whitespace clean |
| Broad root | Integration run: 4,467 tests; 4,094 pass, 323 fail, 31 cancelled, 19 skipped (1,040.2 seconds). Started before later integration fixes, so not a frozen-final-diff gate; final focused runs qualify changed areas separately |
| Local owning gate | Final run after salt protection: 376 tests; 373 pass, 1 fail, zero cancelled, 2 skipped (63.0 seconds). Remaining failure is the POSIX mode assertion in device-disconnect fixture. An earlier final run also had startup snapshot polling timeout; stability is not established. The reproduced telemetry cancellations are fixed |
| Worker | Full owning run: 1,987 tests; 1,979 pass, 8 fail, six failed files / 153 passed files (3,215.8 seconds). Retired-appcast route count fixed from 51 to 50, focused registry 4/4 pass. Seven timeout failures remain unqualified; the full run is not relabelled green |

## Release-readiness continuation

The owner subsequently authorized local commits and requested failure-cause
triage, permission and Worker timeout investigation, and Windows atomic release
storage. The earlier validated work is preserved in five independent commits:
`d56841a0` (v2 identity/maintenance), `3460150d` (companion lifetime), `0afe2064`
(shadow retirement), `7d76a0bb` (published manifest compatibility), and
`12869eb8` (candidate fixtures/interfaces). The original handoff stays untracked.

[The complete failure ledger](../reports/2026-10-13-root-failure-triage.md)
covers every retained root not-ok row: 319 direct failures, four duplicate parent
failures and 31 cancellations. It separates confirmed native identity defects,
obsolete harness assumptions, deliberate security refusals, earlier repaired
cascades and unresolved behavior. This is triage of the old mutable run, not a
new all-suite result.

Windows release operation storage now uses a separately manifested narrow
native capability. It pins the protected current-owner root and ancestors,
uses root-bound single-link child reads and flushed atomic replacement, and
pins SQLite mutex/journal identities through connection close. EXCLUSIVE SQLite
ownership is released on process death. A direct rename test exposed the old
metadata-only native audit handle's ineffective delete-sharing guarantee;
adding data-read access fixes that defect. Generic production/path-walk flags
stay false; hostile same-owner writers bypassing the mutex are outside the
cooperation contract. Existing unsafe ACL state refuses without repair.

The actual native security gate passed 16/16; native credential mutex process,
worker and crash-recovery tests passed 4/4. Final operation/loader/manifest tests
passed 27/27, including root/mutex rename refusal, replaced receipt refusal,
closed save, bounded reads and child-process death recovery. Release cache and
stable preparation contracts passed 26/26. These use disposable synthetic state
and simulated publication transports, not credentials or actual publication.
The final stable writer gate passed 13/13. This independent implementation is
saved in local commit `8160863e`.

Contribution bindings, settings/progress/instance locks and renewal state now
use native owner-protected root-bound storage rather than Node mode bits.
Focused integration passed 76/76; additional renewal/default-path, preference
and disconnect cases passed 7/7, 13/13 and 8/8. Actual unsafe persisted opt-out
remains unavailable/disabled with original bytes unchanged; unsafe disconnect
intent blocks delivery/revocation. This deliberately does not qualify old-state
operational continuity. Local commit `9ae3125b` preserves this change. The local
owning gate, after ACL changes and before callback integration, reached 376 tests: 345 pass,
29 fail, zero cancelled and two skipped. Failures group into 26 inherited-ACL
fixture refusals, one scheduler retry mismatch and two startup/EBUSY cases.
These are current failures, not an all-green gate or a compatibility result.

The generic Claude callback's hard-coded Unix shell is replaced by the reviewed
Windows command adapter, including branded owned-process-tree cancellation and
Windows lifecycle path quoting. Focused native tests passed 23/23. Managed
Credential Manager composition still fails closed; the full lifecycle's ACL
qualification is separate from this shell/fallback result.
Local commit `35c43c2c` preserves the callback change. Final preflight passed
20/20, architecture passed with 609 production files / 2,413 imports / zero
approved debt edges, and maintained API source parity passed 1/1. Root layout
remains clean with 34 allowed tracked entries. No broad root/Worker suite was
rerun; the retained failing suites are not relabelled green.

Worker focused results preserve the original deadlines: three typed-v11 cases,
daily-storage and the 1,025-contributor case passed individually. The latter
took 23.544 seconds, with approximately 23.038 seconds provisioning fixtures.
The 16-owner graph case still fails its five-second whole-workflow limit before
publication: provisioning plus 32 kernel computations took approximately 5.64
seconds. A reduced 10/20-contributor scale diagnostic passed 2/2; work counts
approximately doubled, which does not qualify the 1,000-contributor gate. No
timeout was raised, production algorithm changed or 600-second run repeated.

## Remaining gates

### Current continuation evidence (2026-10-13)

This continuation started at `b8da3479`. The root-suite 323 failures are the
earlier diagnostic inventory, not 323 newly established regressions. No broad
root/Worker rerun was used to chase a passing count. Investigation prioritizes
new product defects and unqualified release boundaries over obsolete fixtures.

Independent local commits: `eacce955` restores the missing default-device-path
import; `686c5ca4` creates local synthetic fixtures with native protected ACLs;
`94a5def1` introduces exact filesystem identity contracts; `e2ac61ff` implements
the explicit legacy ACL continuity copy. The owner's handoff remains untracked.

New product defects established and fixed:

- NTFS identifiers exceeded JavaScript safe integers. New versioned plans and
  deletion state retain canonical unsigned-64 decimal strings from BigInt stats.
  SQLite INTEGER affinity could round those strings again; physical workspace
  schema 5 uses tagged identity text. Existing physical schema 4 and safe numeric
  plans retain their version, digest, ordinals and checkpoints. Unsafe rounded
  legacy identities are refused, never reconstructed.
- Workspace writable configuration previously ran before newer-schema refusal.
  Read-only preflight now refuses unsupported state before writable PRAGMAs;
  a synthetic future-schema WAL database retains its main-file hash.
- A native-copy crash window could retain an unfinished destination. Protected
  no-clobber creation now starts with delete-on-close and clears it only after
  flush and exact readback. The first complete-copy rehearsal then exposed the
  final-file flag incorrectly reaching intermediate directories. It now applies
  only to the final new file; nested sharing-state copy and real child-process
  interruption passed 2/2 after rebuilding the exact binary and manifest.

ACL recovery is a fixed, copy-only continuity bundle, not whole-profile
activation. Synthetic native rehearsal preserves original salt, participant
identity, accumulated facts, ordinals, ACLs and persisted opt-out through
interruption/resume. Held native ancestor identities reject aliased/contained
roots. Open writers, nonempty database sidecars, unsupported archives and
over-limit state refuse intact. See the maintained
[copy boundary](../runbooks/2026-10-13-windows-legacy-acl-copy.md). General native
production/path-walk flags remain false; no real profile was modified.

Focused evidence: exact-identity/source scope 133 pass and two unchanged
chmod-only permission-rejection failures; deletion crash/recovery 26/26;
retained physical-v4 compatibility 6/6. Local owning suite: 375 pass, zero
fail/cancel, two deferred native ACL/reparse cases skipped (377 total). Local
scheduler admission failure traced to unsafe synthetic ACL creation; startup
and EBUSY suspicions were not reproduced, so no speculative runtime change was
made. Native loader/security/copy validation before final-copy correction was
54 pass, two fail; those two were diagnosed, the test-child error corrected,
and the actual nested-copy defect fixed and verified by the targeted 2/2 run.
The entire native suite was not repeated after that correction.

The original 1,000-contributor Worker gate passed within its unchanged
600-second deadline: 314.064 seconds, original bounds/assertions retained.
The 16-owner five-second gate remains unqualified: approximately 2.3 seconds
provisioning/delivery plus 2.8-3.2 seconds for 32 kernel computations. Temporary
diagnostic experiments were fully reverted. No Worker production diff, timeout
increase or retry-to-green was retained. Other previously timed-out Worker
cases remain separate unqualified gates.

Maintenance validation at the final source state: preflight 20/20, root layout
clean, architecture 611 files/2424 imports/zero approved debt. The pnpm launcher
attempted automatic dependency checking and hit sandbox EPERM; the existing
manifest's Node entrypoints were run directly without installation. No broad
product validation or publication is implied.

### Outstanding release boundaries

- Installed/signed qualification of the new operation storage remains separate
  from its passing native/source tests. Exact old-state ACL recovery also remains
  a release gate; no inherited live state was rewritten.
- Exact NTFS representation now has versioned source-level implementation and
  synthetic compatibility proof above. Installed-artifact qualification and
  the remaining native permission/reparse boundaries are still required.
- The broad root integration run also exposes native filesystem/identity
  qualification, export-source/recovery fixtures, R7 filesystem evidence,
  metadata and localization failures. These are not all classified as baseline
  regressions: test membership, installed dependencies and the active diff differ
  from the handoff receipt, so raw failure totals cannot establish improvement.
  Protected R7 evidence was not regenerated and no assertion was bypassed.
- Worker timeout gates: captured
  cohort publication beyond 1,024 contributors (30 s), daily-storage migration
  setup (10 s), 16-owner graph publication (5 s), and three typed-v1.1 daily
  projection cases (5 s each). These five test files are unchanged since
  `cf94e9a8`, but that alone does not establish historical timing results or
  distinguish an environment limit from a runtime regression. Timeouts were not
  increased and the full suite was not repeated to obtain a passing sample.
- Maintained callback composition still lacks the Windows adapter/readiness
  default. Its current fail-closed behavior is documented rather than described
  as operational managed callback support.
- The old Worker nonce table and historical migrations remain. Retirement
  requires a coordinated forward migration and restore/preflight changes, plus
  separately authorized remote application.
- Retired-v1 runtime differential, real Credential Manager, installed-artifact,
  signed-release, updater and hosted deployment acceptance remain unproven.
  Production candidate preparation still requires exactly Node `26.2.0`.
- Layer C's target decision and real-worker timing remain open. The original
  30-second cold and two-second cold-report targets are not reclassified as
  passes. The owner-deferred schema-v4 WAL soak is not repeated.

Local commits preserve independent validated changes. No push, publication,
deployment, signing or installed-app change was performed. Preserve the original
untracked `CODEX_HANDOFF.md`; this record is the resume point for this checkout.
