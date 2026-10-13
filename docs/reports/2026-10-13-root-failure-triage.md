---
title: Windows v2 retained root-suite failure triage
date: 2026-10-13
type: report
status: partial
---

# Windows v2 retained root-suite failure triage

This is point-in-time triage of the retained broad run against a changing worktree based on `1eed0f44`, not a current frozen-checkout result or a regression baseline. Current operational authority remains [the Windows-only decision](../decisions/2026-10-12-windows-only.md) and [the continuation plan](../plans/2026-10-13-windows-v2-cutover-continuation.md). No full-suite rerun, real session reads, R7 regeneration, deployment, or publication was performed for this report.

## Evidence and accounting

The owner-local retained log is `.usage-monitor/windows-v2-continuation-root-tests.log`; its SHA-256 is `c2a5e8e9ea4054e8507d9c108eb643c7d9d3a2a7878590c46d1fabf28bbd8a3f`. It records Node 22.21.1, Windows x64, root `npm test` with serial test-file execution: 4,467 tests, 4,094 passing, 323 failing, 31 cancelled and 19 skipped. The log was produced before later fixes and while the active diff changed. It is not comparable by raw totals with Claude's earlier suite.

There are **319 directly failed test rows plus 4 failed aggregate parent rows**, and 31 cancellation rows. Parent rows repeat failures from their children. Every retained not-ok row appears exactly once in the ledger below; TAP line numbers distinguish nested test IDs which restart at 1. Fixture and product causes are separated, and unresolved redacted boundaries stay unresolved.

## Priorities and limitations

1. Qualify the ACL-safe atomic release writer and exact production candidate configuration; release admission is blocked, not merely a mode assertion to remove.
2. Repair exact Windows identity and timestamp contracts in export/deletion paths that shipping workflows actually reach. NTFS inode numbers may exceed the JavaScript safe-integer/schema range; do not round them. A public synthetic Claude planner/cursor probe confirmed unsafe inode numbers in returned sources; the existing producers already truncate birthtimeMs. Exact NTFS identity needs a versioned representation.
3. Restore native test reachability through reviewed facades, qualify protected timing roots, and inspect real missing-security-rejection cases.
4. Confirm actual rendered UI/closure behavior, then repair portable test setup (locale, executable paths, URL conversion, stderr warning handling).
5. Preserve historical R7 receipts and deprecated platform evidence as protected history; passing portable replacement tests is not new R7 or installed-artifact proof.

The collector and bundle redacted errors expose their rejecting boundary, not the offending field. Their exact originating cause remains open; this report does **not** turn a possible unsafe inode into a proven cause for every plan_invalid row. Security tests that expect a rejection cannot all be dismissed as POSIX-only without inspecting the failing scenario.

## Cause groups

| Group | Failed rows | Cancelled rows | Meaning |
|---|---:|---:|---|
| Web UI assertion or extracted helper contract differs | 15 | 0 | Unresolved behavior/fixture drift: missing helper, changed paging, disclosure, DOM shape, or fixed copy. The retained log alone cannot prove a product regression. Prioritize actual rendered behavior and security copy; do not blindly update expected output. |
| Web fixture expects English locale-specific formatting | 6 | 0 | Retained output shows Chinese date, locale money prefix, or translated text differing from English fixture. Use explicit locale in synthetic tests and preserve localization behavior. |
| Contribution capability setup fails before sync/credential assertions | 41 | 0 | Historical contribution_device_state_unavailable cascade. Earlier continuation replaced unconditional POSIX directory fsync with reviewed syncDirectory; actual synthetic device lifecycle and successor engines later passed. Some remaining mode assertions are separate. Reverify only affected files; do not treat this entire historical group as still failing. |
| POSIX mode bits asserted on Windows | 13 | 0 | Harness assumption: actual 438 (0666) versus expected 384 (0600) or 448 (0700). Mode bits do not prove Windows ACL privacy. Replace with real protected-DACL assertions, without deleting the security requirement. |
| Browser served modules differ from reachable module closure | 1 | 0 | Observed allowance-tank-renderer.js and allowance-tanks.js served outside discovered closure. Reconcile actual browser entrypoints/static allowlist; this separate contract mismatch is not tool-inventory drift. |
| Exact stderr comparison includes Node SQLite experimental warning | 3 | 0 | Harness output assumption on Node 22.21.1. Actual stderr contains only the runtime warning (or differing warning PIDs). Distinguish expected runtime warnings from product diagnostics; do not suppress arbitrary failures. |
| Expected filesystem rejection is absent or has a different code | 9 | 0 | Security-sensitive unresolved gate. Some tests use chmod-only unsafe state on Windows; others exercise symlink/no-follow policy. Inspect each failing branch before marking obsolete; missing rejection is not automatically harmless. |
| Generic Claude callback always spawns /bin/sh | 7 | 0 | Confirmed Windows product defect: createCoexistingInvocation hard-codes /bin/sh -c. Prior-command output/fallback disappears and the monitor error is then propagated. Windows command composition must preserve bounded input, fallback and zeroization; printf-based fixtures also need portable commands. |
| Claude plan identity rejects unsafe Windows inode numbers | 33 | 0 | Confirmed product portability blocker in a public synthetic planner/cursor probe: returned sources contain inodeSafe:false and birthtimeInteger:true, then plan_invalid. Both producers already truncate birthtimeMs, so fractional NTFS timestamps are not the cause claimed by the initial triage. Historical rows have the same identity admission boundary; exact original values are unavailable. Never round inode values or loosen safe-integer guards. |
| Collector source plan rejected before the tested lifecycle | 24 | 0 | Observed plan_invalid cascade. Collector validator correctly accepts finite birthtimeMs but still requires safe integer inode/device. The retained log does not preserve offending fields; identify the exact rejected input in a minimal synthetic reproduction before choosing a contract fix. |
| Compressed rollout failure reports changed-source category | 1 | 0 | Observed codex_rollout_source_changed instead of codex_rollout_content_invalid in bounded compressed-read fixture. Inspect exact failing assertion and source identity timing; neither category may leak input, and source preservation must remain intact. |
| Pending promise has no live event-loop owner | 0 | 31 | Cancellation group, separate from 323 failures. First stalled v1 timeout cancels 3 successors; first R7 filesystem sampler pending operation cancels 26 successors. These 31 rows do not prove 31 independent defects. |
| Aggregate parent failures | 4 | 0 | 4 parent rows repeat child failures; never count as independent defects. |
| Electron packaging/verification closure differs | 4 | 0 | Release-sensitive contract mismatch: native/windows-filesystem retained, crash-capture shell entry present, runtime layout or platform matrix assertions differ. Compare exact final package/verifier closures to Windows-only decision; test snapshots alone cannot determine correctness. |
| Windows release storage refuses POSIX permission policy | 23 | 0 | Release blocker. RELEASE_OPERATION_DIRECTORY_UNSAFE stops journal/mutex/qualification before the asserted operation. Windows ACL-safe atomic writer must replace the POSIX assumption without reducing guarantees. |
| Test harness uses Unix executable/URL/path conventions | 38 | 0 | Verified harness portability defects: /usr/bin/git ENOENT, C:\C: child paths from URL pathname, or separator-only expectations. Retain behavior/security checks while using reviewed platform-neutral path conversion. |
| Windows inode exceeds deletion-journal schema ceiling | 17 | 0 | Product portability blocker. Errors explicitly name directoryIdentities and inventory inode:maximum. Native identities need an exact, versioned representation; rounding or relaxing safety is not a fix. |
| Export identity lacks qualified Windows filesystem composition | 21 | 0 | Release blocker if this feature is shipped. Windows production policy unavailable is a deliberate refusal before credential/migration behavior. Source/native qualification and reviewed injection are needed; portable fixture backends alone do not qualify production. |
| Source-plan bundle fails integrity before intended assertion | 11 | 0 | Observed integrity cascade; the retained log has no underlying field/reason. Reproduce a synthetic bundle once and inspect its fixed owning-stage context. Do not classify integrity failure as an obsolete test. |
| Windows file lock prevents synthetic cleanup | 1 | 0 | EBUSY unlink of workspace.sqlite3 after the subject. Close owners and workers deterministically; distinguish cleanup failure from corrupted durable data. |
| Timing fixtures fail native owner-protected SQLite admission | 23 | 0 | Observed security_policy from WindowsProtectedSqliteError. Native adapter validates parent/files before SQLite. Mode-only fixture creation is insufficient; qualify owner-protected roots and preserve negative ACL assertions. Do not call this evidence of timing parser regressions. |
| Local metadata guard/identity or normalized-path expectations differ | 5 | 0 | One ancestry probe records no expected open, one unsafe metadata case still returns a value, and repository hints have Windows-normalized paths. Split security/ancestry behavior from separator-only expectations; qualify the actual ACL guard before relaxing assertions. |
| Legacy report/replay storage contract remains platform-specific | 4 | 0 | EPERM fchmod or no-follow refusal in legacy report path; one old replay cache expects deep-scan source count 4880 and receives undefined. Determine whether the shipping v2 path reaches this feature before prioritizing it; no retained safety assertion is automatically obsolete. |
| Locale catalogue or complete mirror coverage mismatch | 2 | 0 | Missing translated excludedSources/clock text in retained run. Current canonical catalog and generated mirror parity are separate checks; no generated file hand edits. |
| R7 retired-platform qualification or stale provenance | 10 | 0 | Protected evidence gate. Historical macOS arm64 receipt/runtime profiles reject Windows, unsupported_platform/root_unsafe stop workload admission, and workloadCodeSha256 has drifted. No R7 regeneration was performed or authorized. Do not rewrite historical receipts or call these v2 accounting failures. |
| Inventory/parity changed while the broad run was in progress | 2 | 0 | Historical mutable-run drift: inventory 91 versus 92 and added static caller; continuation subsequently validated inventory/parity. Browser serving closure separately contains newly retained allowance modules and must match actual served closure. |
| Native credential test child imports a retired facade | 4 | 0 | Four historical failures cannot reach the intended mutex/crash gate because export-identity-keychain.js was removed. Restored the capability import through platform/index.js; focused native proof remains separate. |
| Production Windows builder binding fails configuration admission | 1 | 0 | Release blocker. Exact candidate binding/configuration is rejected before signing-runtime assertions; qualifies neither signing nor production preparation. Must use required Node 26.2.0 and exact candidate inputs. |

## Subsequent scoped results

The retained counts below do not change when a later targeted test passes.
Local commit `8160863e` closes the POSIX-only release writer boundary using
native pinned-root/child guards and protected atomic storage: native security
16/16, credential mutex/crash lifecycle 4/4, final operation/loader/manifest
27/27, release cache/preparation 26/26 and stable writer 13/13 passed.

Local commit `9ae3125b` closes unsafe Node-mode contribution writes. Focused
integration passed 76/76, with additional renewal/default-path, unsafe opt-out
and disconnect tests green. Unsafe old ACL state remains fail-closed and needs
qualified identity-preserving recovery. The local owning gate after this change
had 345 pass / 29 fail / 2 skip: 26 inherited-ACL fixture refusals, one scheduler
retry mismatch and two startup/EBUSY cases. None is silently dismissed.

Local commit `35c43c2c` fixes the actual Unix shell callback defect; 23/23 focused
Windows callback tests passed. Four full-lifecycle ACL/mode cases still fail;
managed credential composition and existing-profile ACL recovery remain gates.
The exact unsafe NTFS inode problem is reproduced but has no schema fix here.
No timestamp validator change, inode rounding, safety-assertion bypass, R7
regeneration or publication occurred.

## Complete retained failure ledger

Each row identifies a test file, its category, and exact retained TAP line numbers. Counts include nested parent rows only in the explicit aggregate category. This ledger uses source paths only; private temporary paths, identifiers, session data and full raw errors are not copied.

| Test file | Category | Count | TAP lines |
|---|---|---:|---|
| `apps/web/test/accounting-layout.test.mjs` | Web UI assertion or extracted helper contract differs | 1 | 25 |
| `apps/web/test/admin-growth.test.mjs` | Web fixture expects English locale-specific formatting | 1 | 478 |
| `apps/web/test/admin-site.test.mjs` | Web UI assertion or extracted helper contract differs | 1 | 632 |
| `apps/web/test/admin-site.test.mjs` | Web fixture expects English locale-specific formatting | 2 | 670, 792 |
| `apps/web/test/allowance-tanks.test.mjs` | Web UI assertion or extracted helper contract differs | 1 | 1082 |
| `apps/web/test/cache-drop-thread-links-ui.test.mjs` | Web UI assertion or extracted helper contract differs | 1 | 1480 |
| `apps/web/test/cache-switch-impact.test.mjs` | Web UI assertion or extracted helper contract differs | 1 | 1680 |
| `apps/web/test/community-site.test.mjs` | Web UI assertion or extracted helper contract differs | 1 | 1920 |
| `apps/web/test/divergence-retention.test.mjs` | Web UI assertion or extracted helper contract differs | 3 | 2874, 2900, 2932 |
| `apps/web/test/lib.test.mjs` | Web UI assertion or extracted helper contract differs | 4 | 4354, 5571, 6908, 8197 |
| `apps/web/test/page-headers.test.mjs` | Web UI assertion or extracted helper contract differs | 2 | 10134, 10160 |
| `apps/web/test/public-allowance-views.test.mjs` | Web fixture expects English locale-specific formatting | 1 | 10336 |
| `apps/web/test/ui-format.test.mjs` | Web fixture expects English locale-specific formatting | 1 | 11070 |
| `apps/web/test/work-usage-view.test.mjs` | Web fixture expects English locale-specific formatting | 1 | 11506 |
| `test/accountless-contribution-scheduling.test.js` | Contribution capability setup fails before sync/credential assertions | 2 | 12047, 12062 |
| `test/automatic-contribution-retirement.test.js` | POSIX mode bits asserted on Windows | 1 | 12759 |
| `test/browser-module-serving-parity.test.js` | Browser served modules differ from reachable module closure | 1 | 12805 |
| `test/build-weekly-calibration-audit.test.js` | Exact stderr comparison includes Node SQLite experimental warning | 1 | 12895 |
| `test/bundle-verifier.test.js` | Expected filesystem rejection is absent or has a different code | 1 | 13029 |
| `test/claude-callback-lifecycle.test.js` | POSIX mode bits asserted on Windows | 1 | 13392 |
| `test/claude-callback-lifecycle.test.js` | Expected filesystem rejection is absent or has a different code | 3 | 13440, 13457, 13481 |
| `test/claude-callback-runtime.test.js` | Generic Claude callback always spawns /bin/sh | 7 | 13500, 13530, 13551, 13572, 13592, 13610, 13634 |
| `test/claude-statusline-export-source.test.js` | Claude plan identity rejects unsafe Windows inode numbers | 10 | 13687, 13707, 13727, 13747, 13767, 13787, 13807, 13827, 13847, 13874 |
| `test/claude-statusline-workspace-source.test.js` | Claude plan identity rejects unsafe Windows inode numbers | 6 | 13896, 13916, 13938, 13972, 14006, 14040 |
| `test/claude-statusline.test.js` | POSIX mode bits asserted on Windows | 1 | 14146 |
| `test/claude-statusline.test.js` | Expected filesystem rejection is absent or has a different code | 1 | 14175 |
| `test/claude-transcript-export-source.test.js` | Claude plan identity rejects unsafe Windows inode numbers | 12 | 14260, 14290, 14308, 14326, 14344, 14368, 14392, 14410, 14428, 14446, 14464, 14482 |
| `test/claude-transcript-workspace-source.test.js` | Claude plan identity rejects unsafe Windows inode numbers | 5 | 14502, 14523, 14557, 14577, 14597 |
| `test/codex-collector-export-source.test.js` | Collector source plan rejected before the tested lifecycle | 10 | 14746, 14764, 14782, 14800, 14818, 14837, 14855, 14873, 14891, 14947 |
| `test/codex-collector-workspace-source.test.js` | Collector source plan rejected before the tested lifecycle | 8 | 14973, 15007, 15041, 15062, 15083, 15104, 15125, 15147 |
| `test/codex-compressed-rollouts.test.js` | Compressed rollout failure reports changed-source category | 1 | 15221 |
| `test/contribution-device-capability.test.js` | Contribution capability setup fails before sync/credential assertions | 9 | 16672, 16692, 16712, 16732, 16752, 16772, 16804, 16841, 16861 |
| `test/contribution-device-renewal.test.js` | POSIX mode bits asserted on Windows | 1 | 16971 |
| `test/contribution-device-repair.test.js` | Contribution capability setup fails before sync/credential assertions | 2 | 17021, 17040 |
| `test/contribution-v1-sync-engine.test.js` | Pending promise has no live event-loop owner | 4 | 17830, 17842, 17854, 17866 |
| `test/contribution-v11-local-sync.test.js` | Contribution capability setup fails before sync/credential assertions | 23 | 17928, 17948, 17968, 17988, 18008, 18028, 18048, 18068, 18088, 18109, 18131, 18163, 18184, 18206, 18228, 18250, 18272, 18304, 18324, 18344, 18364, 18384, 18404 |
| `test/contribution-v11-local-sync.test.js` | Aggregate parent failures | 2 | 18153, 18294 |
| `test/contribution-v12-local-sync.test.js` | Contribution capability setup fails before sync/credential assertions | 5 | 18708, 18728, 18748, 18768, 18788 |
| `test/electron-app-package.test.js` | Electron packaging/verification closure differs | 1 | 19208 |
| `test/electron-development-artifact-verifier.test.js` | Electron packaging/verification closure differs | 1 | 19292 |
| `test/electron-package-layout.test.js` | Electron packaging/verification closure differs | 1 | 19631 |
| `test/electron-production-distribution.test.js` | Electron packaging/verification closure differs | 1 | 19715 |
| `test/electron-stable-publication.test.js` | Windows release storage refuses POSIX permission policy | 1 | 19849 |
| `test/electron-stable-writer.test.js` | Windows release storage refuses POSIX permission policy | 12 | 19870, 19888, 19907, 19927, 19957, 19975, 19993, 20011, 20029, 20047, 20065, 20083 |
| `test/electron-stable-writer.test.js` | Aggregate parent failures | 1 | 19947 |
| `test/electron-windows-development-launcher.test.js` | Test harness uses Unix executable/URL/path conventions | 1 | 20195 |
| `test/export-artifact-storage-owner-boundary.test.js` | Expected filesystem rejection is absent or has a different code | 1 | 21285 |
| `test/export-checkpoint-process-death.test.js` | Test harness uses Unix executable/URL/path conventions | 1 | 21438 |
| `test/export-deletion-executor.test.js` | Windows inode exceeds deletion-journal schema ceiling | 16 | 21684, 21702, 21725, 21754, 21772, 21790, 21807, 21825, 21843, 21867, 21885, 21903, 21921, 21945, 21963, 21980 |
| `test/export-deletion-preflight.test.js` | Windows inode exceeds deletion-journal schema ceiling | 1 | 22062 |
| `test/export-deletion-preflight.test.js` | Collector source plan rejected before the tested lifecycle | 1 | 22085 |
| `test/export-identity.test.js` | Export identity lacks qualified Windows filesystem composition | 20 | 22237, 22259, 22275, 22291, 22307, 22325, 22341, 22357, 22373, 22389, 22405, 22421, 22437, 22466, 22482, 22498, 22514, 22534, 22562, 22582 |
| `test/export-set-controller.test.js` | Export identity lacks qualified Windows filesystem composition | 1 | 23207 |
| `test/export-set-materializer.test.js` | POSIX mode bits asserted on Windows | 1 | 23374 |
| `test/export-set-materializer.test.js` | Collector source plan rejected before the tested lifecycle | 1 | 23432 |
| `test/export-source-plan-bundle.test.js` | Source-plan bundle fails integrity before intended assertion | 7 | 23990, 24008, 24026, 24044, 24068, 24092, 24110 |
| `test/export-source-plan.test.js` | Expected filesystem rejection is absent or has a different code | 1 | 24160 |
| `test/export-workspace-discard.test.js` | Expected filesystem rejection is absent or has a different code | 1 | 24453 |
| `test/export-workspace-discard.test.js` | Test harness uses Unix executable/URL/path conventions | 1 | 24492 |
| `test/export-workspace.test.js` | Windows file lock prevents synthetic cleanup | 1 | 24602 |
| `test/inference-timing-experiment.test.js` | Timing fixtures fail native owner-protected SQLite admission | 13 | 25068, 25089, 25110, 25136, 25157, 25178, 25199, 25220, 25241, 25262, 25283, 25304, 25324 |
| `test/inference-timing-store-v12.test.js` | Timing fixtures fail native owner-protected SQLite admission | 7 | 25365, 25384, 25403, 25422, 25441, 25460, 25479 |
| `test/local-codex-thread-metadata.test.js` | Local metadata guard/identity or normalized-path expectations differ | 5 | 25893, 26027, 26062, 26097, 26132 |
| `test/local-codex-thread-metadata.test.js` | Expected filesystem rejection is absent or has a different code | 1 | 25962 |
| `test/local-legacy-report-storage.test.js` | Legacy report/replay storage contract remains platform-specific | 3 | 28562, 28594, 28611 |
| `test/localization-system.test.js` | Locale catalogue or complete mirror coverage mismatch | 2 | 28852, 28894 |
| `test/metadata-export-owner-boundary.test.js` | Test harness uses Unix executable/URL/path conventions | 1 | 28960 |
| `test/metadata-exporter.test.js` | POSIX mode bits asserted on Windows | 1 | 29002 |
| `test/passive-collector.test.js` | POSIX mode bits asserted on Windows | 2 | 29672, 30072 |
| `test/prospective-collector-cli.test.js` | Exact stderr comparison includes Node SQLite experimental warning | 1 | 30700 |
| `test/prospective-collector-tool-parity.test.js` | Exact stderr comparison includes Node SQLite experimental warning | 1 | 30732 |
| `test/r7-filesystem-high-water.test.js` | Pending promise has no live event-loop owner | 27 | 31196, 31208, 31220, 31232, 31244, 31256, 31268, 31280, 31292, 31304, 31316, 31328, 31340, 31352, 31364, 31376, 31388, 31400, 31412, 31424, 31436, 31448, 31460, 31472, 31484, 31496, 31508 |
| `test/r7-generated-release-evidence.test.js` | R7 retired-platform qualification or stale provenance | 1 | 31522 |
| `test/r7-materialized-boundary-benchmark.test.js` | R7 retired-platform qualification or stale provenance | 1 | 31581 |
| `test/r7-materialized-boundary-harness.test.js` | Collector source plan rejected before the tested lifecycle | 1 | 31605 |
| `test/r7-real-history-benchmark.test.js` | Source-plan bundle fails integrity before intended assertion | 4 | 31635, 31655, 31674, 31693 |
| `test/r7-real-history-benchmark.test.js` | Aggregate parent failures | 1 | 31712 |
| `test/r7-release-decision.test.js` | R7 retired-platform qualification or stale provenance | 4 | 31742, 31761, 31799, 31818 |
| `test/r7-release-synthetic-evidence.test.js` | R7 retired-platform qualification or stale provenance | 1 | 31937 |
| `test/r7-release-workload-fixture.test.js` | Collector source plan rejected before the tested lifecycle | 1 | 31968 |
| `test/r7-resource-benchmark.test.js` | R7 retired-platform qualification or stale provenance | 3 | 32123, 32158, 32188 |
| `test/release-attestation-action.test.js` | Test harness uses Unix executable/URL/path conventions | 2 | 32398, 32488 |
| `test/release-operation.test.js` | Windows release storage refuses POSIX permission policy | 4 | 32785, 32802, 32819, 32836 |
| `test/release-qualification-cache.test.js` | Windows release storage refuses POSIX permission policy | 6 | 32873, 32891, 32909, 32950, 32988, 33006 |
| `test/release-sbom-action.test.js` | Test harness uses Unix executable/URL/path conventions | 1 | 33173 |
| `test/replay-safe-accounting-cache.test.js` | POSIX mode bits asserted on Windows | 4 | 33383, 33573, 33637, 33688 |
| `test/replay-safe-accounting-cache.test.js` | Legacy report/replay storage contract remains platform-specific | 1 | 33659 |
| `test/supplemental-source-lifecycle.test.js` | Test harness uses Unix executable/URL/path conventions | 3 | 34528, 34577, 34626 |
| `test/supplemental-source-lifecycle.test.js` | Collector source plan rejected before the tested lifecycle | 2 | 34675, 34697 |
| `test/tibotattle-plugin.test.js` | Test harness uses Unix executable/URL/path conventions | 2 | 35287, 35321 |
| `test/tool-free-timing.test.js` | Timing fixtures fail native owner-protected SQLite admission | 3 | 35503, 35523, 35543 |
| `test/tool-inventory.test.js` | Inventory/parity changed while the broad run was in progress | 2 | 35563, 35585 |
| `test/transition-miner.test.js` | POSIX mode bits asserted on Windows | 1 | 35737 |
| `test/web-release-lane.test.js` | Test harness uses Unix executable/URL/path conventions | 26 | 36075, 36094, 36113, 36132, 36157, 36201, 36226, 36251, 36270, 36289, 36308, 36327, 36346, 36365, 36390, 36409, 36428, 36447, 36466, 36485, 36504, 36523, 36542, 36561, 36580, 36599 |
| `test/windows-credential-mutex-native.test.js` | Native credential test child imports a retired facade | 4 | 37234, 37258, 37277, 37296 |
| `test/windows-electron-release-config.test.js` | Production Windows builder binding fails configuration admission | 1 | 37498 |

## Focused follow-up receipts

The retired native credential child import was changed to the reviewed `src/platform/index.js` facade. A restricted focused run reached the native logic (1 pass, 3 failures); a following host run encountered `windows_credential_mutex_unavailable` before all four test bodies. This does not qualify the current binary or contention behavior. Those preliminary results are superseded by the stable-build receipt below. Node 22 SQLite warnings differ from the original tests' empty-stderr assumptions.

Earlier continuation receipts already establish later narrow passes for v2 core, successor sync, generated mirrors and tool inventory. Those receipts cannot be subtracted mechanically from this historical count, or used to claim every historical cascade now passes.

A later focused host rerun of the two Claude source files recorded 7 passes and 22 failures. The restricted equivalent stopped on sandbox realpath/root admission and is environment evidence, not product evidence. The eight-file synthetic public planner/cursor probe isolated unsafe inode values while all serialized birthtimeMs values remained integers. No timestamp or inode validator was changed. This corrects the initial fractional-timestamp attribution before any product patch.

After the native build became stable, the native credential mutex fixture was qualified on the host: **4/4 passed**, covering separate processes, worker concurrency, worker termination and durable prepared-row crash recovery. The test now accepts either empty child stderr or exactly Node 22's fixed two-line SQLite experimental warning; all other diagnostics remain rejected. This does not qualify real Credential Manager prompts, production selection or installed artifacts.
