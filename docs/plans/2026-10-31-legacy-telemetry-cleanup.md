---
title: Legacy telemetry source cleanup
date: 2026-10-31
type: plan
status: implemented
---

# Legacy telemetry source cleanup

Source implementation and focused acceptance are complete; broader repository
and native qualification gates are not passing or remain unqualified.
The owner directed removal with no legacy telemetry compatibility, conversion,
retained-data deletion or remote changes. The owner subsequently authorized
local development packaging and startup acceptance on 2026-10-31; signing,
publication and real-profile migration remain outside this authorization.
The original inventory used `108ac9ff59d048eea92f59b55c7f18425a55162d`;
implementation is an uncommitted working-tree change, not a release or installed
application qualification.

## Local development startup acceptance (2026-10-31)

The first unsigned development package passed byte-inventory verification but
failed before the dashboard with `electron_shell_entry_failed`. An isolated
debugger trace located the failure at Electron's `app.getPath("appData")` during
profile selection. The launcher had created the synthetic home without the
standard Windows `AppData/Roaming` and `AppData/Local` directories. Creating these
empty directories through the launcher's existing checked-directory helper
resolves the lookup without changing profile selection or security policy.

Launcher, startup-order and artifact-verifier checks pass: 29 tests, zero
failures. Preflight passes. The verifier also recognizes the existing closed
report-publication and local-volume-query manifest extensions, with malformed
contract, approval and unknown-property rejection coverage.

A fresh `legacy-telemetry-acceptance-20261031-r2` development directory package
was built with Node 26.2.0 and Electron 43.5.0. Its ASAR SHA-256 is
`debfb15d819c1cd1d30870450981726ee2eea94989b60681c681223bc0678c4c`.
Exact staged/archive/native inventory verification passes. The bundled launcher
was executed and the physical first-run local-data dialog was visually
inspected and left open for owner acceptance. This proves startup through that
dialog, not dashboard operation, native security qualification, signing,
installation, updates or release readiness. No first-run choice was submitted,
and no real profile migration or credential mutation was performed.

After the owner continued past the first-run dialog, a second startup failure
surfaced: the companion's ordinary directory creation did not create a protected
Windows state-root DACL, so SQLite creation correctly refused it. Installation
root preparation now creates/validates that root with the native filesystem
adapter, rejecting existing unsafe directories without ACL repair. The launcher
no longer pre-creates the state directory and uses a fresh `profile-v2` test
profile, preserving the earlier profile. A Windows regression checks native
root protection, immediate protected SQLite creation and unchanged rejection
of an existing unprotected root.

The final `legacy-telemetry-acceptance-20261031-r3` development package has ASAR
SHA-256 `689a5fbe83637c7f36bb42ef242b742774900cdc981458bf5409f2e78d34991b`.
Its byte inventories pass verification. A separate disposable synthetic profile
with a synthetic first-run test receipt reached the actual dashboard; loopback
health and snapshot status both returned `ready`, with remote uploads disabled.
The empty synthetic Codex source is reported as missing; this does not qualify
real-data ingestion or a complete UI acceptance. The synthetic instance was
stopped and the bundled launcher opened the separate `profile-v2` owner-test
instance. No automated UI action submitted a first-run privacy choice.

Installation/loopback tests pass 54/54; package/handoff tests pass 13/13;
artifact/startup-order/launcher checks passed 29/29 before the state-root fix,
with the final launcher regression separately passing 5/5. Architecture,
preflight and documentation gates pass. These are scoped local source and
development-package results; the broader repository failures and separate
installed/release qualification limits below remain.

## Implemented boundary

### Candidate-branch reconciliation (source integration reviewed)

The owner identified regressions against the previously accepted 2026-10-29
candidate, commit `9703f8b016f7746745292a9d3f078fe734145cfd` on
`codex/schema9-desktop-candidate`. The active source base is
`108ac9ff59d048eea92f59b55c7f18425a55162d` on `fix/windows-codex-refresh`,
with the uncommitted telemetry removal and startup fixes above. Their common
ancestor is `63e8753a27a0da0c67d8ddd3226df4dd855ad055`. A read-only merge-tree
preview reports 96 conflicts; no Git merge, commit or branch rewrite was made.
Changed/untracked source bytes were backed up before integration. The prior
development packages are superseded for owner acceptance until reconciliation
and a fresh packaged/runtime check finish.

The owner explicitly selected the candidate's compact tray instead of the
active branch's expanded tray interactions. The first semantic integration
restores its renderer/settings and native ICO loading, reviewed model glyphs
and picker styling, retained model selection, and the associated v9 workload
projection/types/15-minute elapsed-rate semantics and localized hourly units.
Canonical locale changes were regenerated through the browser generator.
The telemetry removal, Codex-only policy, protected-state startup repairs and
current-format rejection boundaries are retained. Retired provider support,
older migration readers and former generated telemetry mirrors are not
automatically admitted from the candidate.

The first integration passed 218 scoped checks and 861 web checks. The owner
subsequently requested complete per-path reconciliation and GPT-6 Luna/high
subagents, with root review of safety-critical decisions. The resulting
content-free local ledger, `reconciliation-ledger.json` under
`.release-build/branch-reconciliation-20261031/`, assigns a disposition to all
374 original differing paths. It distinguishes exact candidate restoration,
selected integration and intentional retention of current safety/retirement
boundaries. A per-path disposition is not a claim of native qualification.

The reconciled source additionally restores notification capability caching
and click navigation, Chrome import prepare/repair/reveal and its closed IPC,
bounded local Work Usage request diagnostics, and the protected read-only
cutover interlock paired with existing-only observation identity selection.
Normal index opens and refresh preflight reject old versions before writable
pragmas, salt creation or source discovery. The separately reviewed protected
v8-to-v9 copy converter remains; ordinary startup does not replay conversion.

Root review retains current native report-publication, exact file identity,
protected SQLite and atomic storage controls, isolated test tooling, HTTP cache
backport validation, Codex-only pricing and retired R7 generation boundaries.
The accounting differences are Anthropic removal, not missing Codex APIs.
Candidate shared-accounting tests that assumed completed Work Usage cache reuse
were not adopted: both source lines require external metadata to be reread;
the current 13 freshness/coalescing tests pass. Superseded historical provider
plans/receipts are not restored solely for history; their Git history remains.

Final validation: web 885 passes; Electron 588 passes, zero failures, three
qualification skips; integrated runtime/companion/package checks 114 passes,
zero failures, two qualification skips; current-only/copy-conversion/compact
host checks 34 passes; accounting/local read/cache/ledger checks 74 passes.
These suites overlap and must not be added into a unique test count. Architecture,
preflight, documentation and both generated locale mirrors pass.

The final local development package is `legacy-telemetry-acceptance-20261031-r5`,
ASAR SHA-256 `c65ba7e6bf65610aa8743dd2cc7f47098bd69630bd3910621b9b403f1924f948`.
Its complete staged/archive/native byte inventory passes. An isolated synthetic
profile with a synthetic first-run receipt opened the actual dashboard and
returned ready health/snapshot status, with remote uploads disabled. Direct
archive inspection confirms candidate-byte parity for model glyphs, compact
tray renderer, file-backed native tray loading and the cutover interlock. The
synthetic instance was closed and the bundled launcher opened the owner's
separate development-test profile. Real data, real notification/Chrome behavior,
installation/signing/updater qualification and owner UI acceptance are separate.
Earlier r1-r4 packages are superseded for this acceptance. The source integration
is uncommitted; Git histories have not been merged, rewritten or pushed.

- Independent `packages/codex-catalog` owns reviewed plans, models, model lookup,
  reasoning settings and completeness validation. Local provider, accounting,
  cache/history and dashboard consumers use its public entrypoint. The separate
  deterministic browser mirror exposes no consent, upload or admin-history API.
- `sci` and `sci_plus` retain distinct labels from upstream revision
  `275a9a89b6a2689b5b5a8b3b4aa5dc3c02e7d64a`. Source evidence is recorded in the
  Codex ledger; historical binary observations remain unchanged. No fixed quota,
  capacity, entitlement mapping, price or history backfill was added.
- Current local export v1 has six independent closed schemas, its own field
  policy, generator, exact hash tuple and registry. It declares only Codex and
  local use, with no hosted consent or retired-provider adapter. Bundles,
  records, receipts and compressed export sets have new version identities.
  Prior telemetry and export-set payload versions are rejected, including
  completed-set retries; no adapter or old uncompressed reader remains.
- Local export workspace v1 uses SQLite physical version 7. Versions 4/5/6 and
  unknown newer versions are rejected read-only. Descriptors and current
  compatibility are checked before opening writable state or applying writable
  pragmas. This also stops an older physical-version-6 reader from mutating new
  workspaces. Existing workspaces are not relabeled, upgraded or overwritten.
- Deletion planning verifies only current local export sets and produces journal
  v0.4. Original committed deletion journal/marker schemas and exact filename
  resolution remain solely for interrupted file-transaction recovery. Recovery
  binds original canonical bytes, hashes and filesystem identities; it does not
  parse, verify, resume or convert an old telemetry payload. No new deletion of
  an old export is authorized by this change.
- Passive collection no longer accepts or captures a hosted destination or
  enrollment binding. Local account observation, before/after account checks,
  account-switch isolation, freshness and reset classification remain separate.
- Contribution projection, preparation, prepared sets, device sync/client,
  queues, encrypted telemetry transport, the obsolete real-backend acceptance
  runner and their commands were removed. The telemetry workspace package,
  upload schemas, status/consent source contracts, old generators and generated
  artifacts were removed. Browser legacy consent, hosted identity/community and
  upload APIs plus four obsolete static modules were removed; routes return 404.
- The contribution credential capability is no longer public or operable. New
  reads/mutations/leases are rejected before native access. Existing audit rows
  remain readable, are not prepared again or automatically recovered, and their
  original database constraint is unchanged. Saved credentials are untouched.
- Workspace manifests, pnpm workspace links, runtime closure, workflow path
  filters, architecture rules, tool inventory, tests and maintained references
  follow the new owners. Inventory classification also records two pre-existing
  copy-only desktop-calculation scripts; those scripts were not executed or
  changed. Third-party dependency versions are unchanged.

## Explicitly preserved

Saved opt-outs, identities, salts, credentials, receipts, old prepared files,
private source/index state and accumulated evidence were not inspected,
converted, migrated or deleted. Removing source code is not a data-erasure
operation. Remote contracts, services and privacy/retention obligations were not
changed. Frozen R7 receipt bytes were not rewritten or regenerated. Current R7
source provenance follows the new source tree; historical readback remains a
separate gate.

Local timing database `telemetry_revision` fields, mathematical contribution
breakdowns, historical credential audit labels and preservation-only profile
inventory names and stable local process-lock identifiers are not legacy telemetry readers or upload support. Their names
are not an instruction to rewrite retained state. Local timing measurement,
accounting conversion and file-transaction recovery keep their own contracts.

## Validation checkpoint

Validation uses Windows x64, Node.js 22.21.1, pnpm 11.25.0 and isolated synthetic
homes/state. No real credential qualification, source migration or packaging was
performed.

- Current export/schema/privacy/version-rejection and owner-boundary acceptance:
  55 tests passed. The separate workspace/materializer acceptance passed 39
  tests, including byte/sidecar preservation on old/newer version refusal and
  rejection of a current physical workspace carrying retired compatibility.
- Architecture/dependency owner tests: 77 passed in the focused run. The live
  architecture gate reports 394 production files, 1,383 imports and zero debt.
  Tool inventory is complete: 85 records, 86 executable paths, 43 aliases.
- Windows credential manager/lease/audit tests: 43 passed, two native
  qualification cases skipped under the ordinary isolated runner. Retired
  contribution capabilities do not reach native credential calls, and existing
  historical audit rows survive the synthetic startup sweep unchanged.
- Browser cleanup acceptance: 156 passed; reviewed model catalog: four passed;
  actual loopback server tests: 47 passed, including all four retired static
  routes returning 404. The full UI suite has 880 passes and one pre-existing
  stale i18n mirror failure. Earlier explicit demo rendering proved the Academic
  Researchers label only, not quota calibration or native rendering.
- New export generator, Codex browser generator, architecture, inventory and
  documentation/root-layout/whitespace preflight gates pass. The 20-test
  preflight does not establish hosted CI, native storage or release readiness.

A broad diagnostic root run started during implementation finished with 3,913
passes, 309 failures, 27 cancellations and 70 skips across 4,319 cases. It is not
a final-green result or an immutable final-tree receipt. Failures include
protected Windows artifact/collector storage, stale source/API/fixture assertions,
and removed-feature references. The cleanup's residual imports, privacy fixtures,
exact API assertions, portable-test ledger and retired-feature acceptance cases
were subsequently corrected and rerun in focused checks. The final 23-file
cleanup acceptance has 267 passes, no failures and three configured skips;
separate residual privacy/identity/API/readiness/ledger checks have 20 passes.
Generator and inventory follow-up checks also pass. A refreshed local-index
backend negative case confirms no contribution reader; that whole test file has
eight passes and two independent snapshot/callback failures. The broader source
and fixture failures have not all been audited against original HEAD, so they
must not all be labeled pre-existing.

No assertion, ACL check, qualification skip or privacy validator was weakened.
The Windows portability ledger was reconciled to the actual existing test
manifest and explicit native branch classifications; this neither changes test
membership nor qualifies a native operation. Full collector persistence and
native file-transaction qualification remain unproven in this ordinary
environment. The unchanged i18n mirror also remains outside this cleanup.

The maintained [schema lifecycle](../reference/schema-contracts.md) describes the
current owners and rejection/recovery contracts. The separate Windows Codex
`.cmd` invocation failure was subsequently repaired at source: the drift workflow
passes the npm package's `bin/codex.js` entrypoint and the inspector executes it
with the current Node executable, without shell parsing. Windows Node 26.2.0
synthetic subprocess checks cover version reads, schema generation, paths with
spaces and shell metacharacters, and nonzero-exit refusal. Hosted CI, installed-app
behavior and signed-release proof remain separate and must not be inferred from it.

## Dependency security follow-up (2026-10-31)

The owner authorized remediation of the earlier GitHub OSV failures. Electron
43.5.0 advances within major 43 to 43.8.4, fast-uri to 3.1.9, and the two
undici branches to 6.29.1 and 7.30.1. pnpm 11.9.0 frozen-lock installation passes;
the runtime fast-uri version and verified tree digest advance together. Existing
HTTP cache patches and direct scanner failure semantics remain intact, with no
new advisory suppression or release-age exception.

The checksum-pinned OSV 2.5.1 scanner inspected the updated root lockfile. The
previous 25 findings are absent. The scan still fails for GHSA-g3hv-75wg-m249 on
four minimatch versions; the owner explicitly deferred that separate investigation.
This is not a clean security scan or hosted CI success. Upstream references:
[Electron 43.8.4](https://releases.electronjs.org/release/v43.8.4),
[fast-uri fix](https://github.com/fastify/fast-uri/security/advisories/GHSA-wjr9-j795-jxcr),
[undici fix](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx),
and [remaining minimatch advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).

Windows Node 26.2.0 isolated checks: 45 packaging/cache-security cases pass;
Electron has 588 passes and three configured skips. Preflight has 20 passes.
An unsigned, unpublished directory development package was verified and launched
with synthetic state: the dashboard displayed, and health/snapshot were ready
with remote upload disabled. Its ASAR SHA-256 is
`5c84d96963dc680509d1e1586244646ba9039065e19a9ddf6ac8bd89d3886fac`.
This does not qualify real-profile migration, native credentials, signing,
installation or updates; existing owner acceptance instances remain unchanged.

### Minimatch investigation (2026-10-31)

Investigation is complete; dependency remediation is not implemented. The
root lock retains minimatch 3.1.5, 5.1.9, 9.0.9 and 10.2.6 through build tooling.
The verified development runtime closure contains no minimatch package. This
finding concerns the described preprocessing DoS, not every possible minimatch
vulnerability or future build configuration.

The upstream advisory describes attacker-controlled patterns at optimization
level 2 or higher. The GitHub advisory database instead declares every version
below 11.0.1 affected. Installed 3.1.5 and 5.1.9 have no first-phase advanced
preprocessor. Installed 9.0.9 and 10.2.6 do have it. Bounded synthetic runs on
Node 26.2.0, with 2/4/6/8 repetitions of `**/../a/b`, produced 4/16/64/256
patterns at level 2 in both 9 and 10, versus one pattern with default options.
Both older branches retained one pattern. These small probes demonstrate
amplification and the data-range disagreement without running an unbounded
denial-of-service payload.

The effective app-builder-lib 26.15.7 file matcher passes only `{dot: true}`,
leaving optimization level 1. A search of installed JavaScript consumers found
no explicit optimizationLevel setting outside minimatch itself. No currently
enabled caller was found for this vulnerable path; this is not a general
unreachability proof for arbitrary caller-supplied build options. Pattern input
belongs to build configuration, not the dashboard HTTP API.

A global override to 11 is unsuitable. ASAR 3.4.1 and dir-compare 4.2.0 expect
the old callable CommonJS export. The
[11 changelog](https://raw.githubusercontent.com/isaacs/minimatch/v11.0.3/changelog.md)
also changes `Minimatch.set` entries and removes APIs, so the build pipeline
needs consumer-level review before any major upgrade. Registry inspection found
electron-builder 26.18.0 still depends on minimatch `^10.2.5`; a builder-only
upgrade does not demonstrate resolution.

Recommended implementation: preserve the installed major APIs and backport the
[upstream bounded-preprocessing fix](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8)
to branches 9 and 10 using reviewed pnpm patches for both CJS and ESM. Verify
exact consumer bytes, level-2 expansion bounds, large-set deduplication limits,
ordinary matching parity and Windows packaging. Keep branches 3 and 5 unchanged
for this specific issue; record their absent mechanism rather than inventing
an API compatibility shim. Prefer official same-major fixed releases when
available. No same-major fixed releases were listed during this investigation.

Such a local backport alone does not make OSV green, because it scans the
unchanged version numbers. Keep the unsuppressed gate failing until advisory
range correction and/or upstream-recognized fixed artifacts resolve all rows.
Any report to upstream is a separate external message requiring authorization;
none was sent. A full move to 11 would require coordinated dependency upgrades
and review of retained legacy consumers, not a blanket override.

### Allowance chart empty-state correction (2026-10-31)

Owner acceptance identified an incorrect collection claim: the allowance chart
showed "Collecting data" whenever it had no usable points, regardless of actual
collector activity. Its empty state now says "No usable allowance observations"
in all three catalogs; it does not infer that collection is running. Backend
collection and retained evidence are unchanged. Focused synthetic coverage checks
empty and null-valued observations across available/partial/stale/unavailable
states and preserves an actual zero-percent observation as plotted evidence.

The owner also identified a separate legacy history warning. A deferred index
projection emitted an "indexing is in progress" sentence without establishing
an active job. The deferred and incomplete-history warnings now describe only
the unavailable published aggregate, in English, Chinese and Spanish. They
retain the withheld-total boundary and do not imply collection/indexing activity.
Browser warning-localization regressions pass. At this stage the companion test
file had 13 `local_collector_state_unavailable` failures before snapshot
assertions. The subsequent fixture investigation below resolves those failures.

### Cross-surface message audit (2026-10-31)

Scope: current dirty working tree, root HEAD `108ac9ff59d048eea92f59b55c7f18425a55162d`.
Two GPT-6 Luna high read-only reviews covered dashboard and desktop/tray/X/
performance/work-usage messages; root reviewed the findings and companion
warning producers. Catalog enumeration found 1,458 keys in each of en-US,
zh-Hans and es. This is a cross-surface static audit with targeted trigger
inspection, not exhaustive execution of every translated string or native branch.
No computer-use actions were taken after the owner's Escape interruption.

The audit identified the following findings. The subsequent owner-authorized
message repair is now implemented; the last column records the correction.

| Finding | Trigger/evidence | Correction |
| --- | --- | --- |
| Workload hours say samples are being collected without active-task evidence | `apps/web/public/overview-workload.js:137` tests only that all hours are null; a new plan also produces this state | State that the current plan period has no usable estimate |
| Old-schema results are called an update failure | `overview-workload.js:62` normalizes v2-v8 to stale, then `:207-220` emits the failure diagnostic even with an empty error list | Distinguish unavailable validation of older results from a failed attempt |
| Tray starting state says collecting | `apps/web/public/electron-tray-popup.js:196-200` maps starting and a freshness fallback to collecting; `apps/electron/desktop-tray-status.js:209-214` distinguishes starting from analyzing | Use startup/no-current-observation wording unless active work is proven |
| Runtime-evidence checkpoint is presented as live collection progress | `src/local-index-runtime-model-evidence.js:17-31,59-66` persists pending/catching_up; `:108-129` tracks actual running work separately and stops retrying after failures; `overview-workload.js:246` renders the persisted status | Describe incomplete/not-yet-checked coverage; pending does not uniquely mean an absent index, and catching_up does not prove a currently running job |
| Windows first-run refers to Login Items | `apps/electron/desktop-first-run-login.js:114-208` displays the approval/failure dialog; canonical `apps/electron/desktop-copy-source.js:180-199` uses Login Items although the action targets Windows startup settings | Use the same Windows Startup apps terminology as Settings; regenerate derived desktop copy |
| Index-lag warning guarantees the next refresh catches up | `src/local-companion-data.js:2771` and `apps/web/public/localization.js:138` infer the promise from timestamp lag alone, without a completion or batch bound | Say that refreshing can advance the index; do not promise completion on the next pass |

The capture-checkpoint finding is root-reviewed beyond the UI agent's initial
status-allowlist review: validation of an enum proves its shape, not live task
activity. The 3/5 minimatch advisory disagreement remains separate from this audit.

The subsequent repair removed retired sharing/performance-consent/community/site
keys and unused trayPopover titles/bodies after checking their callers. This
removed 453 canonical definitions across three locales and 152 entries from the
legacy browser table, plus their obsolete prefix forwarding. Generated browser
and Electron copies were regenerated from canonical sources. Regression checks
reject retired message namespaces. The reporting-scope text no longer refers
to removed sharing preferences. No compatibility alias or reassurance disclaimer
was added. Startup and missing observations have distinct tray text; preserved
results and incomplete evidence describe stored data rather than live work.
Model-performance and work-usage loading/retry/error paths reviewed here have
request/pending/timer state behind them; no additional unsupported activity
claim was confirmed. Updater available/current labels remain a reachability
question under the currently unconfigured updater capability.

Validation of the repair: full UI suite has 890 passes; full Electron suite has
588 passes and three configured skips; catalog/removal/localization checks have
17 passes; root preflight has 20 passes. Added regressions cover null hour
estimates, error-free old results, checkpoint states, tray starting/no-observation
copy, retired namespaces and first-run Windows terminology. Generated mirrors
check clean. The companion file's 13 local-state failures were investigated
separately below. No packaged/rendered acceptance, publication, remote message,
migration or real-profile access was performed for this message repair.

### Companion state fixture investigation (2026-10-31)

Reproduced all 13 failures with Node.js 26.2.0 through the isolated test runner.
Each failed in protected SQLite preparation, before its snapshot assertions.
The native filesystem adapter loaded successfully: creating a new protected
child directory succeeded, while inspecting an ordinary temporary directory
through `ensureDirectory` returned `WINDOWS_FILESYSTEM_SECURITY_POLICY`.
The test fixtures created `.usage-monitor` using ordinary `mkdir`; POSIX mode
bits did not establish the required Windows protected owner-only DACL.

`test/local-companion-data.test.js` now reuses the existing
`createProtectedFixtureDirectory` helper before creating synthetic state on
Windows. Other platforms retain owner-only mode bits. Production code, schema,
ACL refusal behavior and existing directories are unchanged. No real profile
was accessed or repaired. The full companion data test file passes 53/53;
the related refresh, protected SQLite and Windows collector ACL tests pass
128/128, including rejection of unsafe synthetic state without repair.
The full local surface suite passes 283/283. Root preflight passes 20/20;
architecture, documentation governance and whitespace checks pass. These source
test results do not qualify a newly packaged or installed application.

### Retired visual rules cleanup (2026-10-31)

Removed retired community-site rules and their unused heartbeat animation,
old native-dashboard shell rules and its onboarding-only branch, unused sync
layout selectors and obsolete tray customization preview rules. Current compact
tray styles and its live icon preview remain. CSS no longer excludes retired
community/admin body classes. Removed model picker badge sizing/background
overrides in favor of the current compact 20px glyphs. Restored explicit light
and dark neutral placeholder colors with contrast checks. Updated source
contract tests and the startup harness to exercise current onboarding without
the removed native-dashboard bypass.

The full UI suite passes 891/891. Isolated Electron 43.8.4 offscreen render
comparisons used synthetic markup and the current styles at 1280, 760 and
400px in light and dark themes; the sampled computed layout/icon/color
properties match the saved pre-cleanup styles. The intended placeholder color
change is covered separately by the theme contrast test. Root inspected the
rendered synthetic usage/picker examples. This does not qualify the full live
dashboard, a new package, installation or release; no user state was accessed.
Root preflight passes 20/20; architecture, documentation governance and
whitespace checks pass.

### Model-performance tooltip investigation and unaccepted experiment (2026-10-31)

The owner's screenshot identified the model-performance chart tooltips, not
the tray popup. The default tooltip used opaque `--surface-raised`; the retained
4px wallpaper-copy blur applies only with a custom image background and did not
prove that the default tooltip was translucent. The compact candidate branch
already had that opaque default; its presence does not establish when the
owner's earlier visual effect was lost. The style cleanup changed only the
retired body-class exclusions in this sheet, not the tooltip background.

The default tooltip now uses an 82% theme surface with 4px backdrop blur;
forced-colors mode uses opaque system colors. Custom image background rules
retain their existing wallpaper-copy behavior. Focused model-performance and
window-background tests pass 87/87. Isolated synthetic Electron 43.8.4 renders
confirm alpha 0.82 and `blur(4px)` in both light and dark themes, with rendered
charts inspected. The already-running acceptance package predates this fix.

Subsequent exact-artifact comparison located the 2026-10-29 candidate under
`settings-memory-candidate-de8edcc8/artifacts/win-unpacked` in the candidate
checkout. Its ASAR SHA-256 is
`9eabcc454e46c6b70b6bf27f523d9ad9ea86a0be15339d42dd070abba869b46b`,
matching the retained package proof for build `2026102901`. Direct extraction
confirms the opaque default tooltip and wallpaper-only 4px blur. The archived
model-performance and window-background JavaScript files are byte-identical to
build `2026103102`. Replaying the extracted old default styles in isolated
Electron 43.8.4 yields opaque white/dark tooltip backgrounds and no backdrop
blur; this is style replay, not execution of the old packaged runtime. The new
82% backdrop effect is therefore a new implementation, not verified restoration
of the owner's earlier appearance.

Read-only preference inspection found an image background record in the retired
TiboTattle settings directory and no background record in the current stable
settings directory. The old renderer activates its wallpaper-copy surface only
when a color or image is selected. This is a current configuration difference,
not proof of the settings active during the 2026-10-29 session. No background
image was opened, and no preferences were copied or changed.

The backward artifact audit then inspected 75 retained pre-2026-10-31 archives
dated 2026-10-18 through 2026-10-29. All contain the opaque default
model-performance tooltip and the custom-background-only 4px wallpaper blur.
The two relevant sheets are byte-identical across the 38 candidate-checkout
archives from 2026-10-25 through 2026-10-29. This does not establish every
historical runtime state or rule out an earlier unretained build.

The 2026-10-18 package identifies itself as TiboTattle and reads its background
repository below its own `userData/desktop-settings`; later stable packages use
the explicit UsageMonitor stable profile. The retained TiboTattle image
background record was last written on 2026-10-19. The accepted
[usage-only cutover decision](../decisions/2026-10-25-usage-only-state-cutover.md#not-migrated-retained-at-the-source)
explicitly excludes backgrounds and leaves them at the source. Thus the missing
background record in the current stable profile is consistent with the scoped
cutover, rather than evidence that the tooltip CSS was deleted. The owner's
earlier visible effect still has no contemporaneous runtime capture here.
Old schema-6/8 applications were not launched against the current schema-9
database. No settings migration, downgrade or profile activation was performed
in this backward audit.

### Background-copy history and configuration boundary (2026-10-31)

The subsequent history investigation distinguishes the original implementation
from today's unaccepted 82% backdrop experiment. The original design paints an
opaque base, an aligned copy of the selected wallpaper and its mask, then applies
4px blur only to that decoration. Surface text stays clear and underlying page
text is covered. It does not require or provide desktop-window transparency.
The implementation is conditional on a selected window color or image; a
default profile has neither and retains the opaque theme surface.

Historical implementation and build evidence establishes this sequence:

- On 2026-10-18 the background-copy implementation was built as `2026101811`
  from snapshot `3907943e7b5d706f717e73c59bc34d353b71b649`.
  A subsequent picker edge correction was built as `2026101812` from
  `f8844b22736300c2d692023a34a703370d19af9c`. Retained Electron 43.5.0
  synthetic QA results cover popover, translated tooltip, select picker,
  dialog, scroll, resize and mask cases; underlying-text pixel independence
  passed. These are historical QA results, not a fresh runtime qualification.
- Further 2026-10-18 work fixed wallpaper movement when page scrollbars changed
  the layer width. Geometry uses window inner dimensions and shared image
  coordinates. The subsequent scrollbar candidate `2026101817` identifies
  snapshot `56d98506e237c24ba47a0d94b24eb2ebb52bf0fe`.
- Integration commit `79d3d907` on 2026-10-19 retained the CSS/JS implementation.
  Commit `a65bd7ed` subsequently deferred image exposure until successful decode;
  `c2aae20c` and `15776b67` introduced profile separation and renamed the
  background schema, protocol and preload bridge. No deletion of the original
  effect was found in the tracked history of these files.

Fresh direct archive extraction checked builds `2026101814`, `2026102601`,
`2026102901` and `2026103102`. The last three contain byte-identical
`window-background.js` (SHA-256
`1b1b853feb59f9c2307ec4d6655eb737765838f80831bec37149cef70e16db07`).
All four retain the background module and stylesheet. The first retained archive
with explicit stable-profile routing in this inventory is `2026102601`; this
does not identify the first real launch using that routing.

The observable appearance continuity breaks at the profile/settings boundary:
`application-profile.js` selects the new stable root; `desktop-runtime.js`
resolves the background repository below that root's `desktop-settings`.
The [usage-only decision](../decisions/2026-10-25-usage-only-state-cutover.md#not-migrated-retained-at-the-source)
excludes appearance state. The actual selectors in
`scripts/lib/usage-state-bundle.mjs` and `scripts/lib/usage-bundle-freeze.mjs`
extract only selected computation/control settings and do not select background
records or image chunks. Thus the implementation survived, but its old selected
background was not carried into the stable profile. Current read-only metadata
inspection confirms that the source still has color/image selection and the
stable profile has no background record. Missing records resolve to null
color/image; the renderer then omits `data-window-background`, leaving the
original background-copy rules inactive.

The retained source record uses the old brand's v2 schema. The current reader
does not accept that namespace, so copying only the JSON would not restore the
feature. Any later explicitly authorized recovery must address the closed
configuration and image-reference boundary, not overlay an old profile.
No source images were opened, no settings were migrated, and no product code
was changed by this investigation. The exact first real launch that changed
the visible appearance remains unproven. Today's 82% backdrop experiment is
still present in the working tree and build `2026103102`; it has not been
accepted as restoration of the original behavior.

### Authorized selected-background restoration (2026-10-31)

The owner subsequently authorized restoring the original appearance. Removed
the unaccepted 82% surface/backdrop-filter experiment from the default chart
tooltip; the original conditional wallpaper-copy implementation is retained.
No permanent old-brand compatibility path was added.

With the application stopped, a one-time local operation read only the selected
old background record and its three protected image chunks. The source record,
chunk sizes and complete image digest were validated. The current public
background repository imported those original bytes under a fresh resource
identity into the existing stable profile, preserving its color and mask.
The target background record and import journal were absent before the operation.
Protected preparation/result receipts were retained locally. Source config and
chunk hashes were unchanged after recovery; target readback and image verification
passed. The initial verification incorrectly compared JSON insertion order;
field-by-field verification finalized the already committed recovery without
repeating or overwriting it. Usage state was not selected by this operation.

Focused isolated tests pass 100/100 and the complete isolated UI suite passes
891/891. Local unsigned build `2026103103` was prepared with Node 26.2.0 and
Electron 43.8.4. Its 746 staged/archive files match; ASAR SHA-256 is
`60d7d1afb9c422e874c3ff7d736e5a3ee80266e530bd552ab1ed97acdcbc81e2`.
The retained synthetic Electron overlay probe reported a long-picker scrolling
pixel difference before completing its remaining cases. This is unresolved
render validation, not a passing gate. The launch tool brought up the old
candidate executable, so a successful launch/render of `2026103103` has not
been established. The owner stopped Computer Use and requested manual
acceptance instead. No further desktop automation is authorized for that handoff.

### Current allowance display correction (2026-10-31)

Read-only runtime inspection of build `2026103103` found a fresh direct weekly
quota observation of 79%, while the overview workload displayed an older 64%
observation. Historical consumption watermark rejection had also selected the
displayed current balance, despite the latest direct observation being present.
The composition now marks that current observation explicitly; analysis uses
it for the current balance without admitting the rebound as historical
consumption. Conflicting simultaneous observations still produce unknown,
and rejected historical evidence does not authorize estimated work hours.
The optional public observation type includes this direct-evidence marker.

Removed hardcoded plan multipliers from overview labels. A generic provider
`pro` observation displays Pro; it does not independently prove a price tier
or entitlement multiplier. Regression coverage checks rebound display,
unchanged consumption totals, ordering, duplicate observations and conflicts.
Focused analysis/index/UI tests and the architecture check pass. The long
refresh duration and observed workload-state write error are separate unresolved
issues, not fixed by this display correction. No real state was edited.

### Account continuity implementation boundary (2026-10-31, source implemented)

Owner direction: complete the account connection in overview quota analysis and
establish whether delayed old quota evidence actually occurs. Acceptance requires
the same private account namespace on current and direct historical observations,
separation at account changes/loss, no inferred identity for old rollout records,
and account-bound saved comparison inputs. No account handles may enter dashboard
DTOs. Preserve existing stores and historical facts; do not mutate real state as
part of tests. Use synthetic account-switch, identity-loss, return-to-account,
restart and out-of-order fixtures. Distinguish late insertion from stale provider
values and do not claim that a synthetic test proves either occurred locally.
Package, runtime and manual acceptance remain separate gates.

The current collector publication WeakMap now supplies the exact observation's
scope to workload composition. Private direct-history metadata uses that same
namespace, with a new continuity epoch at an identity change or loss. Account
epochs do not span A/B/A switches or unknown observations, even with identical
plans and reset deadlines. Same-time identity conflicts remain unknown. Rollout
quota facts without a proved account remain in the index; they are not assigned
to the current account. Their unscoped descriptive reader remains distinct from
the production account-scoped path.

The new protected `private/overview-workload-account-state.json` has a closed
single-file container with at most 64 account partitions. It atomically preserves
other partitions, refuses unknown/future formats and never reads or overwrites
the older unscoped state file. Unknown identity causes no partition read/write.
The usage cutover allowlist includes the new file as byte-preserved state. Saved
comparison inputs only come from the matching partition; calibration capacity
without matching account proof is not retrospectively labelled as belonging to
that account. Such capacity-derived estimates remain unavailable. The quick
quota publication clears old workload analytics when account continuity changes
or becomes unknown, before the next full analysis finishes. Public DTOs do not
contain these identity handles.

Read-only retained-evidence inspection found 1,852 direct collector quota
observations in the initial snapshot, and 1,854 on root's subsequent recheck.
All were active app-server reads, with no notification records, local timestamp
lag or observation-time backsteps in record iteration order. This does not prove
provider-side freshness: app-server read responses lack an independent provider
observation timestamp, and the collector stamps local observation/receipt time.
No local direct-read evidence establishes delayed old quota as the cause of the
64% versus 79% display error. Historical rollout backfill and out-of-order insertion
are supported and tested, but original observation times are preserved and reads
sort by observation time. The unified index lacks per-occurrence first-insertion
timestamps, so source traversal order or latest file verification time cannot
prove when a historical quota occurrence first arrived. No provider session
content was read in this investigation; no real profile state was changed.

Validation: 213 focused tests, 45 quota-package tests and 891 UI tests pass.
Architecture and preflight pass. The first complete local gate passed 282/283;
its synthetic process-exit observer timed out. The owning server file then
passed 48/48 unchanged on a separate run, and a subsequent complete local gate
passed 283/283 without changing assertions or deadlines. This source change has not yet been
packaged, launched or manually accepted. The quota-restoration stage policy and
refresh-performance work remain separate from this identity connection.

### Same-response quota contradiction check (2026-10-31)

Inspection found that `sanitizeCodexAccountSnapshot` used `Object.fromEntries`
and the collector used `Map.set` to merge canonical and keyed quota entries.
Both could silently overwrite the same normalized limit identity. This is a
concrete input-acceptance path, not evidence that Codex has emitted contradictory
responses in this installation. Ingress now validates the normalized entries
before either merge; the collector reuses that same reviewed sanitizer. Identical
duplicates, different families/durations and successive percentage decreases
are accepted; contradictory slots/windows in one response are refused with a
fixed `malformed_output` error before creating a record. Synthetic tests cover
raw and already-sanitized collector ingress, aliases and cross-slot conflicts.
The separate single-flight/timeout policy and restore-as-new-stage rule are not
implemented by this response-local check. No real state was changed or rebuilt.
The added contradiction tests pass. The full provider/normalization/collector
run passes 116/118; two foreground tests still fail (an early SQLite read and a
timer-driven ingestion retry). It is not a green collector gate. Test fixture
setup now creates protected Windows state and asserts native owner-only metadata
instead of POSIX mode bits; the notification-burst fixture initializes its DB
before polling. No production security check or test deadline was weakened.
Architecture and preflight pass. No package or live-provider contradiction
qualification was performed.

### Upstream quota field relationship verified (2026-10-31)

Read-only source review covered installed PATH CLI version
`0.166.0-alpha.5.1`'s public tag commit
`f79b26ccbb3116b052544666a181012fb45dc49b`, the ledger-pinned revision
`275a9a89b6a2689b5b5a8b3b4aa5dc3c02e7d64a` (response and snapshot builders),
and current upstream main `67f0994b532b8740f14b5b738af7b7b2a915b1d6`.
The installed binary version string matches the tag; binary/source equivalence
was not independently qualified. Public source snapshots are retained under
`.release-build/quota-upstream-audit-20261031/`.

- `GetAccountRateLimitsResponse` documents the historical single-bucket field
  and the multi-bucket mapping. These fields preserve upstream client API
  compatibility; they do not require a compatibility layer in Rhetrion.
- `get_rate_limits_for_usage` performs one usage GET and builds one snapshot
  list. The separate reset-credit-detail read does not supply either quota
  percentage. Snapshot conversion preserves both fields identically.
- The builder first creates the default `codex` snapshot, then appends additional
  snapshots using their `metered_feature` as limit identity. The public generated
  model uses a string and the inspected path has no duplicate-ID rejection.
- The response processor selects the first `codex` snapshot for `rateLimits`;
  the map is collected from the entire list and retains the last duplicate key.
  Unique IDs guarantee agreement. A backend additional entry also named `codex`
  with a different value could pass through and cause disagreement. This
  conclusion follows the actual source path, but remains conditional: no live
  backend response proving this case was found or collected, and the private
  backend implementation is outside the available public-source evidence.
- Upstream integration tests exercise default `codex` plus distinct
  `codex_other` and assert equal default values in both views. These tests support
  intended semantics; they do not establish backend uniqueness in production.

The earlier 21/36 fixture is therefore an abnormal-input regression only. It
does not explain the reported stale balance and must not justify rejecting a
normal sequential decrease in used percentage. Current response-local rejection
remains a defensive boundary, not an additional ordinary recovery rule. No
production source, real profile, package, or running app was changed in this
investigation. Exact upstream links are in the schema-contract reference.

### Quota request and recovery-stage implementation (2026-10-31)

Owner approved implementing the verified chain. Acceptance boundary: one pending
quota RPC in a process; timeout invalidates its response; stable account brackets
before accepting account-bound quota; one observation per retained read; latest
balance independent of historical rebuilding; recovery establishes a fresh
consumption stage; replay and restart do not duplicate intervals. No migration,
real-profile writes, packaging, launching or remote publication is included.

Source changes now include a process-wide quota queue (including the direct
request entrypoint), fresh response IDs after timeout, late-response rejection,
closed-client cancellation and bounded close-listener cleanup. Existing
collector state leases prevent simultaneous ownership of one ledger. The
bracket sanitizer is shared; known account or plan changes reject with the
existing bounded `request_failed`, while missing identity stays unattributed.

`task-workload-v15` reconstructs recovery stages from retained facts. Downward
used-percentage changes become baselines, upward changes inside a stage accrue
consumption. Scheduled-window resolution remains separate. Daily allocation,
startup comparison and current trend share this stage boundary. The record
iterator now supplies durable record order privately; it distinguishes ordered
reads sharing a millisecond without inventing a conflict from timestamps alone.
Saved baseline evidence remains source evidence and does not add another copy
of an already retained observation. Account epochs still separate A/B/A and
unknown-identity gaps.

Both collector projections select the last durable row at a tied observed time.
Private account publication metadata carries record order through the closed
worker envelope, never dashboard data. Quick and full publications use this
order when their timestamps match. The overview current balance consumes the
independent normalized quota window, including while historical workload is
absent. Old remaining-hour outputs are cleared until analysis uses the new
balance. No provider plan multiplier or unsupported plan name is inferred.

Initial focused integration run: 173 passed, one existing platform-specific
skip, zero failed (174 total). Additional publication-order coverage and broad
validation are in progress; this is source evidence, not packaged/native or
live-account qualification.

Owner resumed the quota/stage work with the explicit constraint that first
confirmed plan time and observed percentage establish the baseline, without
backfilling preceding consumption or joining a plan boundary by reset deadline.
Account-specific work-hour attribution redesign remains outside this resumed
scope. The new regression covers 97% -> 95% -> 99% -> 98% remaining: three
percentage points accrue, and the three points preceding first observation do
not. Private publication metadata now includes the account epoch as well as row
order, protecting same-millisecond A/B/A and rejecting older tied rows. Scoped
startup comparisons replay the current epoch instead of reusing an unsequenced
saved baseline. A privacy assertion was corrected to check exact property names
rather than matching the word `epoch` in unrelated synthetic strings.

Resumed focused chain validation passed 308 tests with one existing skip
(309 total), including provider, normalization, collector, protected state,
workload analysis, account connection/state, worker publication and overview UI.
Architecture passed with 398 files and 1393 imports; preflight passed 20 tests.
The earlier broad root run was interrupted on owner pause and had failures in
other suites; it is not a passing whole-repository gate. Final surface gates
passed: local 283/283 and UI 892/892. The historical allowance UI assertion was
updated to expect the separately approved Pro 200 name rather than Pro (10×).
Documentation validation and whitespace checks passed. No package or
real-profile runtime was activated.
