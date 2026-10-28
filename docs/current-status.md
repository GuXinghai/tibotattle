---
title: Current product and qualification status
date: 2026-10-28
type: status
status: current
source_commit: 4f99be5e29ee60b325d8afc4bd8b911b7795aee7
observation_date: 2026-10-28
---

# Current product and qualification status

衡川 · Rhetrion is an independent, unpublished local Windows x64 product.
Source version 0.1.27 is a development identifier, not a published release.
Codex is the only supported usage provider. The owner accepted the
[Codex-only scope](./decisions/2026-10-27-codex-only-product.md) on 2026-10-27;
active provider cleanup and the subsequent debt repairs are included at the
source revision above. Historical format readback does not enable a retired
provider. The committed repairs and their isolated validation do not establish
release qualification.
The [identity and cloud-retirement decision](./decisions/2026-10-23-local-product-identity-and-cloud-retirement.md)
supersedes inherited service and publication wiring. No download website,
update feed, signing account or external support destination is configured.
No remote resources were modified by the source retirement.

## Evidence boundaries

The committed accounting-reuse repair distinguishes stable missing-thread
origin evidence from failed metadata reads. Equal origin evidence, including the
same unknown membership, may reuse the qualified process-local result while
preserving unknown interval reasons and the original evaluation clock. Origin
changes or unavailable read evidence invalidate reuse. No persisted schema or
existing user state is changed by this policy repair.

The working tree uses a local event stream for startup snapshot, refresh, and
independent report completion notifications. The dashboard re-reads the relevant
validated state after a notification; an event does not itself prove that a
particular report or refresh succeeded. Lease renewal, request deadlines and
fault recovery remain separate from waiting for a report to become ready. A
broken stream is shown as disconnected while reconnection proceeds. This is source-level
work under validation, not evidence for an installed application or release.

The event-driven boundary repair keeps preparation leases independent of progress
queries, revalidates collecting performance results after notifications, and
bounds refresh observation by its remaining deadline. Observer timeout does not
establish backend failure. These repairs require isolated regression checks and
independent review before packaging; existing user state is outside their scope.

GPT-6.1 Terra support is added in the working tree: reviewed model identity,
independent Standard/Batch/Flex/Fast API-equivalent prices, strict above-272K
context selection, and performance labels. Sources:
[official model page](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
and [official pricing](https://developers.openai.com/api/docs/pricing), reviewed
2026-10-28 JST. No vendor-effective date or Ultrafast price is invented. Existing
price cards remain byte-identical. Model-recognition revision 2 reuses the bounded
recovery queue for unknown-model sources; missing sources remain unknown and
replays preserve token and occurrence identity. The retired cloud history roster
remains frozen independently of the local catalog. Validation uses isolated
synthetic state. The unsigned local stable build `2026102802` adopted Terra
support at candidate revision `5acae835f7977c3892ef0dfe0c92f8c9b50e596c`;
startup and the served catalog were verified separately from source tests.
The X reader defers protected image requests until the saved session is ready
and retains a decorative initial when loading fails. The working-tree retry
repair retries failed avatars only on newer automatic-refresh timestamps, after
1/2/4/8/16/30-minute backoff (capped at 30 minutes); ordinary status polls cannot
trigger retries. Manual refresh bypasses the delay, including when post fetching
is still pending. Loaded or in-flight avatars remain unchanged; hidden readers
and unauthenticated sessions cannot retry. No extra retry timer or persisted
state is introduced. Author and quoted-author
loading, recovery and disposal use synthetic tests; it does not clear caches or
change authentication. The bare custom-protocol image path also loaded a
synthetic image in an isolated Electron profile. This does not establish the
precise network failure of the owner's prior cached image requests.
The focused model/pricing/recovery suite passed 89 checks; targeted browser,
response attribution and performance checks also passed. Contract generation,
schema/browser mirrors, architecture and preflight passed. The broader root
suite reported failures (including native publication, file-identity and old
export-list checks) and was stopped after the failure gate; it is not a passing
full-suite qualification. A read-only GPT-6 Luna xhigh review found no confirmed
defect in the Terra diff. No real user state or backups were changed for this work.

The owner-approved [Codex project-membership contract](./decisions/2026-10-27-codex-project-membership.md)
is implemented in the working tree: explicit assignments take precedence,
verified subworkers inherit their nearest assigned parent, and non-Git projects
remain projects. Focused isolated synthetic checks and a read-only projection of
an existing retained real-data copy passed. The copy was verified unchanged;
the readback did not open the active index or Codex's live SQLite/WAL/SHM files.
The wider frozen Standard report and historical work-identity checks still fail;
the same 133 report differences and 12 work-identity differences were reproduced
with the original implementation at `b5c737ceebad5240392bc8bc8712675cf8504567`
under isolated synthetic data. Their fixture was not rewritten. The project
repair was adopted by the unsigned local stable candidate at
`e059d12d4a5481355b2127b1c01632155e285667`; that package predates Terra support.

Brand configuration, neutral package identity and explicit profile paths are
implemented in source. The approved editable SVG and raster/ICO/tray variants
are included. Source staging has completed on Windows with Node 26.2.0.
This is not installed-app, signing, updater or migration acceptance.

The native binary's manifest deliberately retains `productionSafe: false` and
`pathWalkRaceSafe: false`. Narrow source-read, release-operation and browser-profile
capabilities do not establish full profile migration or general production safety.
Unexpected credential prompts remain a release blocker.

Ordinary tests now use disposable synthetic homes and state; real credential
qualification is a separate explicit gate. Earlier testing exposed an unsafe
default-backend test, so earlier assertions that local audit state was unchanged
are not verified. The repair does not inspect, recover, or roll back that state.

The source includes the separate `windows-report-publication-v1`
capability. Its exact Node 26.2.0 native build passed isolated Windows
synthetic tests for protected creation/replacement, ACL/link/path refusal,
bounded bytes, concurrent writers and no-clobber failure cleanup. The default
CLI JSON/Markdown writer uses this capability, with no JavaScript filesystem
fallback. Missing or mismatched capability still fails before destination
creation. The capability covers fixed local drives and cooperating writers in
one Windows session, not hostile same-user conditional replacement or
power-loss durability. Global safety flags and installed/release gates remain
unchanged.

Expanded synthetic native regression exposed an existing timing SQLite
hot-journal recovery gap: the read-only schema preflight returns
`SQLITE_READONLY_ROLLBACK` (776) before writable guarded recovery. A separately
rebuilt baseline binding reproduces the same failure. The report-specific
tests passed, but the broader native filesystem suite is not fully passing;
this recovery debt remains open. Those regression runs used synthetic databases.
The subsequent migration investigation read real database headers only, without
opening a SQLite connection or changing data.

The repair adds local-index schema 9 without guessing missing historical tier
provenance, and export workspace v0.6 / physical schema 6 with exact private
Windows identities and durable auxiliary-read reservations. Older export
workspaces are refused before writable configuration, not converted or relabeled.
Collector SQLite files now require native protected-DACL creation/checks;
unprotected older state is preserved and refused, not repaired implicitly.
Those source and isolated-test results are separate from the real index upgrade
recorded below; they do not qualify all repairs in a packaged release.
The owner scoped remaining ACL/workspace compatibility to a
[one-time controlled pre-release migration](./decisions/2026-10-27-pre-release-state-migration.md).
It does not require permanent old-format writers. The concrete upgrade from
local-index schema 8 to 9 is complete, with collector schema 1 preserved. No old export
workspace has been found in the bounded filename-only checks; that is not proof
of absence elsewhere and is not a reason to run a speculative workspace upgrade.
The standalone [index-copy upgrade step](./runbooks/2026-10-27-pre-release-index-copy-upgrade.md)
is implemented and has isolated Windows synthetic acceptance. It is not a
combined fresh-backup/activation tool or actual-profile admission evidence.
The [HTTP cache backport gate](./runbooks/2026-10-27-http-cache-backport-verification.md)
replaces the expired build dependency exception without any OSV suppression;
an actual scanner run and hosted CI remain separate evidence.

The prior brand/usage cutover is complete, separately from this new format
upgrade. On 2026-10-27 the owner relayed another chat's read-only verification of
the historical `activated_verified` receipt, restored-permission receipts and
the current `activated / existing_only` startup policy. Its execution tools are
ignored local files under the candidate checkout's `.release-build/brand-cutover`;
checking out a commit alone does not recover those tools or receipts. This
source-status update does not independently requalify that historical operation.

The authoritative source for the completed format upgrade was the active stable profile's
`companion-state`, under the neutral `UsageMonitor` state root, plus only the
reviewed calculation settings from its sibling `desktop-settings`. The older
TiboTattle source and its prior backup/conversion are historical preservation,
not a substitute for a new cold backup containing post-cutover history. The
initial read-only header observation found index schema 8 and collector schema 1
while the application was active. A new protected cold backup was subsequently
made after normal shutdown, including its retained WAL and current history.

The previous candidate source revision `de8edcc8` accepts index versions only
through 8 and rejects schema 9 with `local_index_newer_version`, including on
read-only opens. It must not be used as the upgraded index reader. Preparing a
compatible exact candidate is a prerequisite, not a post-upgrade repair. Its
later desktop changes and the current source diverge; a whole-branch merge
requires separate integration review and cannot be treated as a routine build.
The copy-only entrypoint now runs the shared v8→v9 transaction on a protected
PERSIST connection, without entering the ordinary WAL writer. Native synthetic
tests cover its source preservation, exact known DDL, typed row equality,
sidecar protection and cleanup, no-clobber, unsafe ACL/link and hot-state
refusal. Other historical DDL variants remain refused, not guessed.

The candidate owner supplied schema 9 candidate revision `6c5a55f8`. Its ASAR
SHA-256 was independently matched to the handoff receipt, and the converter's
output passed an isolated packaged-candidate run before real execution.
Its source selectively adopts the schema 9
store/refresh/worker contract and is not a full merge of the current source;
its UI/runtime test results and six reproduced baseline index failures remain
the candidate owner's separate evidence.

On 2026-10-27 the owner explicitly authorized the simplified one-time migration.
The protected cold backup was read back byte-for-byte; only another working
copy was checkpointed and converted. The actual schema differed from fresh
creation only in the exact historical ALTER-created `store_state` SQL spelling;
that spelling was reproduced and admitted with isolated synthetic tests.
Every original table/column retained its typed logical digest and row count;
the new provenance remained NULL. Other admitted usage files were copied
unchanged, and the active databases passed integrity checks.

After native writer exclusion and final source/target checks, the original
usage directory and previous package were retained at explicit sibling paths.
The verified schema 9 copy and compatible package now occupy the existing
active paths. Runtime files also matched the prior working package; the new
ASAR and executable matched their independently pinned candidate hashes.
Normal startup reached desktop and snapshot ready. Operational readback
confirmed schema 9, unchanged originals/backups, original salt, source selection,
pause/preferred-model settings and existing startup policy. Exact paths,
identities, hashes and recovery records remain in owner-only local receipts,
not in repository evidence. No original deletion, registry change, credential
qualification, old brand replay or new migration framework was performed.

The [usage-only scope](./decisions/2026-10-25-usage-only-state-cutover.md) remains
in force. Fresh backup/readback, copy-only conversion, semantic continuity and
compatible candidate admission were completed for this activation. Do not
repeat the migration against accumulated new history, replay the old brand activation or alter
its existing startup policy implicitly. X, background and generic Chromium
state remain outside this upgrade. The legacy continuity-copy bundle is not
the selector for either the active usage bundle or this format upgrade.

Current work and exact outstanding gates are tracked in the
[cutover plan](./plans/2026-10-23-rhetrion-brand-identity-and-local-state-cutover.md).
Passing a source gate never proves physical Windows, packaged, installed,
signed-release, updater or public deployment behavior. Retained historical
receipts apply only to their own original project, source, bytes and dates. No
user-owned Claude profile/source content, settings, ledger, callback state,
credential, or file has been inspected, moved, or cleaned up for this decision.

## Desktop calculation separation and format activation

The desktop calculation and unknown-speed policy are committed in `36755be1`;
`c15bf496` adds exact v0.24 historical preservation. The ordinary path does not
execute complete research analysis. Settings v6 and cache v0.26 are current-only,
with Standard as the default unresolved-speed assumption.

On 2026-10-28, the owner-authorized one-time conversion of the active stable
usage state was activated after cold backup, copy conversion and readback.
The entire old cache remains in its historical envelope with its original
version and time. Typed collector rows were equal after normal application
startup. The original usage directory, complete cold backup, previous program
and private operation receipts are retained. Index bytes, salt, saved usage
snapshots and unrelated settings were preserved; the existing startup policy
and X/browser state were not changed. Do not replay the old brand or schema 9
migration, or automatically restore earlier history.

The active unsigned local candidate was built from `045f7a53`, build
`2026102807`, with ASAR SHA-256
`f6934174486840050b98eece129c965960baf5836a7c6ba9f3f858e6bca7fc96`.
Normal startup and a ready local snapshot were read back separately from the
isolated automated gates. New-format active accounting is published only by
a real calculation; preserved historical results are never relabelled as a new
calculation. All automated tests and interruption rehearsals used synthetic
profiles, including the full 30-item migration bundle. Operational readback is
not a real-data test, and no installed, signed-release or publication gate is
claimed. See the [decision](./decisions/2026-10-28-desktop-calculation-and-unknown-speed.md)
and [preservation inventory](./plans/2026-10-28-desktop-calculation-preservation.md).
