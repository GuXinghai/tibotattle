---
title: Local Data, Network, and Privacy Inventory
date: 2026-08-27
type: reference
status: maintained
last_verified_commit: 52399658
---

# Local data, network, and privacy inventory

This is the maintained technical inventory behind TiboTattle's first-run and
public privacy disclosures. It describes what the implemented app can read, what
it derives and stores, which operations use the network, and which removal
actions are intentionally separate. The baseline review commit above predates the
[2026-08-30 self-service retirement](../decisions/2026-08-30-self-service-deletion-retirement.md)
and [local cache-drop thread links](../decisions/2026-08-30-local-cache-drop-thread-links.md)
documented here. Source changes do not prove that an installed or published
artifact already contains them, or that the hosted service has been deployed.

The central rule is structural: prompts, responses, reasoning, raw commands,
credentials, private paths/filenames, emails, account names, and other free
text have no allowed destination in contribution schemas, diagnostics, or
public aggregates. Unknown fields are omitted; an input that cannot be safely
projected is refused or shown as unavailable.

## Desktop sharing removal

The desktop app is local-only. Community sharing, contribution upload, performance sharing, share cards, and hosted sign-in were removed on 2026-10-13 ([decision](../decisions/2026-10-13-desktop-sharing-removal.md)). The app sends no usage data, and local analysis works without an account.

The retained local state is preserved untouched: the saved sharing choice (`desktop-settings/accountless-sharing-v1.json`), notice receipts, device salts and identities, the accountless installation credential, and prepared spools and queues. The desktop app neither reads nor writes that state; deleting any of it needs a separate receipt-backed workflow.

The hosted service's contribution, enrollment, publication, and erasure contracts are a separate deployed surface. They do not describe desktop behavior.

## Normal refresh sources

| Provider | Exact source | What is read | What is retained by TiboTattle | Network boundary | Removal/reset |
| --- | --- | --- | --- | --- | --- |
| Codex rollout metadata | Selected Codex home, normally `~/.codex/sessions` and `~/.codex/archived_sessions` | Bounded record headers and allowlisted metadata from `turn_context`, `token_count`, `thread_settings_applied`, quota/accounting, tool-outcome, lineage, and compaction-boundary records. | Typed usage/quota/tool facts, timestamps, model/speed/reasoning/outcome enums, local HMAC join keys, source cursors, coverage and diagnostic codes. | Local filesystem only. | App **Erase local data** removes TiboTattle's projection, not Codex source files. |
| Codex configuration | `~/.codex/config.toml` | Only the top-level `service_tier` baseline used when a rollout has not yet recorded an observed speed. | Timestamped declared speed-baseline windows. An observed rollout value always wins. | Local filesystem only. | Local erase removes the derived baseline ledger; it never edits Codex config. |
| Codex selected-rollout store | `~/.codex/state_5.sqlite` | Read-only `threads.id` and `threads.rollout_path`, after owner/file/path validation, to select the physical head of a logical thread. | Only the validated selected rollout filename mapping needed during ingest. | Local filesystem only. | Local erase removes derived selection state; it never edits Codex SQLite. |
| Codex account/quota service | Local `codex app-server` subprocess using `account/read`, `account/rateLimits/read`, `account/usage/read`, and bounded update notifications | Current plan/account scope, quota windows, resets, credits-presence flags, and provider usage projection. | Sanitized quota/account observations and local-HMAC account scope. No Codex authentication token is copied. | TiboTattle talks to a local subprocess. If Codex itself cannot refresh its account evidence offline, TiboTattle records the source as unavailable/stale rather than inventing continuity. | Local erase removes observations; identity reset separately rotates the Credential Manager pseudonym. |
The normal installed refresh does **not** read Claude Desktop quota history,
Claude prompt transcripts, Claude project files, or Gemini artifacts. Claude
prototype and benchmark readers remain in the source tree for development
evaluation, but the installed companion exposes no setting, route, UI, or
upload surface that enables them.

Codex history discovery also recognizes cold `.jsonl.zst` representations. On
native-Zstd-capable runtimes, bounded streaming decompression feeds the same
allowlisted metadata projection. It creates no decoded transcript files and
never edits the source tree. The physical filename remains private; durable
cursors refer to logical uncompressed byte offsets. Unsupported runtimes or
damaged histories produce explicit partial coverage. See the
[compressed-history contract](./local-index-schema.md#compressed-codex-histories)
for runtime and resource limits.

## Optional local integrations

| Integration | Activation | Data boundary | Persistence |
| --- | --- | --- | --- |
| Managed Claude status-line callback | Explicit standalone CLI install/repair lifecycle | Bounded JSON status input through the managed local broker; projected status/usage fields only. | Managed callback state plus provider-isolated pseudonym capability. This is not an installed-app feature. |
| Custom Codex home | User chooses a directory in Settings | It replaces the default Codex home anchor; the same fixed subpaths and allowlists apply. | Owner-only launcher setting. |
| Local cache-drop thread links | Local interactive dashboard, for recent displayed drops only | Read-only bounded `session_index.jsonl` (`id`, `thread_name`, `updated_at`) and `state_5.sqlite` (`id`, explicit `name`, worker nickname, and allowlisted source ancestry). For a `guardian_review` row only, the first bounded `session_meta` header in its selected owner-controlled session may supply its matching explicit parent UUID after source and path validation. Never uses prompt-bearing `threads.title`, first messages, or transcripts. | Names and IDs exist only in a separate `no-store`, same-origin local response and transient UI memory, reused for unchanged displayed event pairs during refresh. No snapshot/cache/report/share-card/diagnostic/contribution persistence. Clicking hands only the canonical thread UUID to the local Codex URL handler. |
| Export workspace | Explicit CLI or review flow | Only allowlisted metadata for the selected time range and sources. | Journaled workspace, chunks, manifest, and verification/deletion receipts at explicit paths. |

## Model performance timing in development source

Opening **Model performance** (`#performance`) or running a separately authorized
daily-performance delivery enables an independent worker
for the selected Codex home's plain `.jsonl` session and archived-session files.
This diagnostic population spans accounts on this device. It reads timestamps,
allowlisted model and speed-mode metadata, token counters, and response/turn boundaries to
reconstruct timing; raw content and raw IDs are never persisted or returned.
Compressed-only histories and missing timing remain unavailable.

Page reads and daily-report requests renew a 60-second lease. Discovery is capped at 50,000 entries;
scan passes target at most 32 MiB or 750 ms, checking between chunks of at most
two 2-MiB reads per source (original timing and supplemental throughput). It
pauses 250 ms during history collection and five seconds after catching up.
The worker checkpoints each store independently, finishes an explicitly
requested history pass, and then stops after the idle lease expires.
The supplement observes only allowlisted activity kinds and scalar counters;
unknown activity, tools, steering, ambiguous tokens, or incomplete evidence
excludes a turn. Full-turn duration includes initial waiting; TTFT is never
subtracted. Output speed uses response timing when available, otherwise an eligible
supplemental full-turn estimate. Each turn is counted once; the display discloses
the fallback count and its inclusion of initial waiting. It does not feed accounting.
The desktop app does not send its content-free daily histograms; performance sharing was removed on 2026-10-13.
Failures preserve available saved evidence with its
stale/unavailable state. Windows remains unavailable until its protected-state
adapter is qualified. These are source behavior, not installed-release proof.

## Installed local state

The app owns its per-user state root under Electron's user-data directory
(normally under `%APPDATA%`) with owner-only permissions. Important entries include:

| State | Purpose | Retention behavior |
| --- | --- | --- |
| `local-index-store-v1.sqlite` (with its `-wal` and `-shm` sidecars) plus the device salt `local-unified-index-device-salt-v1` in the same directory | Canonical replay-safe Codex usage/quota/tool projection, source provenance, and the owner-only local rollout paths and working directories that the [v2 decision](../decisions/2026-10-12-local-index-v2-and-local-paths.md) allows. Paths never leave the machine. The salt anchors every local join key and hosted pseudonym. | Accumulates locally; the 30-day UI horizon is not retention. Rollout sources are never modified. Facts of rollouts that have since left disk are kept, not deleted by absence. The salt is never regenerated. |
| `local-unified-index-v1.sqlite` (retired previous index, if present) | Previous physical index. The app does not read it except for the one-time ordinal seed while the v2 store has no sources, and it is not a current contract. | Kept until its retirement is assessed and an owner-authorized, receipt-backed deletion removes it. It holds facts of any rollout that has left disk, and such a file is retained as an unread archive. |
| `inference-timing-v2/model-performance-snapshot.json` | At most twelve rolling period/mode and twelve exact-window completed timing projections, fixed model IDs and numeric bins; 4 MiB owner-only, schema/digest-checked v5 envelope bound to the configured Codex source. | Uses the same atomic snapshot transport as Overview. Earlier mixed-mode receipts are preserved and refused until mode-separated reconstruction produces a v5 replacement. Unknown and mixed-mode turns are excluded from all selectable modes. Restored measurements keep their observation date while background scanning runs or fails; incomplete scans cannot replace them. First result saves immediately, then hourly, with latest completed results flushed on clean shutdown. |
| `inference-timing-v2/source-<Codex-home digest>/timing-experiment.sqlite` (development source) | Separate owner-only timing sidecar: one row per completed turn, counts/durations/coverage, local HMAC keys, source cursors and bounded pending state. No raw content or IDs. | Maximum 256 MiB per selected source; parser method 2 and SQLite user version 4. The forward migration retains existing TPS/TTFT, adds nullable completion/mode fields and source revision counters, and fences older writers. The legacy unscoped sidecar is preserved without reading or migrating its unknown source provenance; first use rebuilds measurements from retained source logs. Incompatible stores, including version 1, are preserved and refused. Display periods do not delete evidence or migrate the accounting index. |
| `inference-timing-v2/source-<Codex-home digest>/tool-free-v1/timing-experiment.sqlite` (development source) | Independent supplement for reconciled single-response turns without tools, plus its own source cursors and bounded scalar pending state. Shares the original private timing correlation key for local joins only. | Maximum 256 MiB; parser method 3 and SQLite user version 5. Its forward migration preserves previous supplement measurements and fences older writers; the original primary store remains separate. An incompatible or unavailable supplement does not hide original measurements. |
| `local-collector-state-v1.sqlite` | App-server quota observations, checkpoints, dedupe, locks, and replay-safe collector state. | Accumulates until explicit local erase or a reviewed migration/retention workflow. |
| `private/` settings/handoff state | Fast-mode preference and speed baselines. Retired contribution settings and OAuth handle are preserved, not read. | Settings persist. |
| Retired prepared contribution/review directories and queue | Preserved spools and queue state from removed contribution sharing; not read or written. | Preserved untouched; deletion needs a receipt-backed workflow. |
| Diagnostics log | Fixed error/status codes and opaque support references. | Bounded, content-free local diagnostics only. |
| Chromium website data | Loopback dashboard session/local storage and short-lived hosted web session state. | Cleared by **Erase local data**; provider pages use the system browser. |

Preserved Windows contribution device bindings, automatic settings/progress/instance locks
and renewal state use native root-bound reads and atomic writes with protected
current-owner DACLs. Existing inherited or broader ACL state is rejected without
rewriting its ACL or credential identity. A failed read is unavailable evidence,
not a fresh-install sharing choice. Migration/recovery of older ACL state and
installed-artifact acceptance remain separate release gates.

The derived accounting cache inside collector state uses compact JSON with a
128 MiB publication and child-result transport ceiling. Existing pretty-printed
caches remain readable without migration; observation values, source records,
checkpoint hashes and export serialization are unchanged. The selected-plan
comparison retains its separate 100,000-row and 4 MiB limits, the retained
dashboard snapshot retains its 16 MiB limit, and rebuild RSS limits remain
independent. These resource bounds do not authorize history deletion.

The standalone CLI/developer default uses the platform-specific
`app-usagemonitor` state directory. The installed app supplies the stable
`Usage Monitor` state root. Documentation and support instructions must not
conflate those locations.

## Credential Manager and credential state

TiboTattle keeps separate credential capabilities for:

- export pseudonym identity;
- current account observation pseudonymity;
- the retired paired contribution-device credential, preserved and not used by the desktop app.

The managed Claude callback has a separate pseudonym capability contract. Its
Windows production backend requires explicit readiness and adapter injection;
the standalone CLI and callback defaults currently fail closed without that
composition. It is not exposed by the desktop app.

These installed-app capabilities are stored in Windows Credential Manager through
the noninteractive native adapter. A content-free binding/renewal record lives under
the app's user-data state root; it is not the credential. Keys are intentionally
separate so one identity namespace cannot be joined to another by accident.

Current Electron has no credential migration approval entrypoint. Its
noninteractive adapter preserves a legacy credential and blocks the affected
path when migration is required. A required startup credential blocks before
Settings and reports `SECURE_STORAGE_MIGRATION_REQUIRED`; quit and contact
support with that code. Preserve the legacy credential and app data; do not
delete or reset credentials or app data. Retry only repeats the silent readiness
check, and reinstalling this release does not perform a credential migration.

The Electron production source serves the four legacy broker capabilities
through its signed main process and the inherited FD4 channel. The retired accountless installation credential is preserved in Credential Manager; the [2026-10-13 decision](../decisions/2026-10-13-desktop-sharing-removal.md) retires its sharing use.
Secret bytes never enter renderer IPC, local HTTP responses or diagnostics.

A packaged Windows development shell that passed the native qualification checks
can read the existing fixed account-observation key through the same parent IPC
boundary. Its parent broker refuses key creation before entering the credential
backend. Missing keys remain unavailable; development cannot rotate, replace, or
delete credentials. New observations can be attributed, while previously
unattributed records retain their original status. This does not grant production
updater, installer, or signing policy.

**Reset identity and device** is a separate two-step action from local data
erase. It removes the selected local Credential Manager capabilities and associated app
state; it does not represent hosted participant deletion. An unavailable
Credential Manager entry is a temporary availability condition, not evidence of a
corrupt credential.

## Optional hosted contribution

The desktop app has no contribution flow (see the desktop sharing removal section above). The deployed hosted service accepts only the schema below. A contribution can include closed-schema derived fields such
as:

- opaque participant/session/event pseudonyms and schema versions;
- provider/plan/model families and observed speed/reasoning categories;
- timestamps, token counts, standard API-price-equivalent cost, quota windows,
  resets, coverage, and fixed diagnostic/outcome codes; and
- source/provenance versions needed for replay, deduplication, and correction.

It excludes prompts, responses, reasoning text, commands, repository/file
paths, URLs, credentials, emails, account names, raw local account identifiers,
and arbitrary metadata. Canonical schemas and mirror ownership are listed in
[`schema-contracts.md`](./schema-contracts.md).

Hosted storage uses Cloudflare D1 for identity/session/device/contribution and
derived aggregate state, R2 for encrypted contribution objects and update
artifacts, and a Durable Object for shared upload admission. Public daily
activity totals and allowance estimates have no minimum account count or
per-account cap. The owner explicitly approved plan/model dollar estimates
and supporting account/fit counts even for one account. Such small samples can
reveal a contributor's estimated capacity despite omitting identifiers; they
are not anonymous. Plan/model comparisons use closed UTC dates, complete
source-authorized caches and qualified evidence; missing or unstable estimates
remain gaps. Only the older sealed weekly snapshot contract applies its own
delay, minimum-account threshold, caps and rounding. Its guarantees are not
weakened or attributed to the daily view.

Derived calculation state also includes a per-participant dirty-work queue,
one restartable captured publication generation, its selected fit/model cache
payloads, and one preparation-counter row (migrations 0054–0056). These add no
uploaded fields or raw session content. Participant deletion cascades captured
membership and queued work; consent, erasure and source-policy invalidations
immediately fence reading and promotion. Ordinary uploads can leave an
authorized saved graph visible while the successor is prepared. Completed
captures are retired in bounded pages when superseded; their generation date
does not represent the latest live input revision. Preparation counters contain
only aggregate derived ledger counts, not participant identifiers.

Stable pseudonyms and identity reattachment permit longitudinal linkage.
Content-free, pseudonymous contribution is not anonymous data.

### Account/plan attribution successor (staged)

The source includes a closed v1.1 successor, disabled for new writes by default
until a separately authorized hosted cutover. Its additional fields are account
basis, a purpose-separated account pseudonym or null, plan basis/type, and an
opaque plan-era pseudonym or null. The exact field inventory and derived sample
must be reviewed; an explicit hosted-session consent grant and local approval
bind the new schema, field dictionary, privacy contract and destination. Existing
consent, pairing or an app update alone does not authorize these fields.

The derivation reuses a leased existing account-observation root. It binds to
the canonical destination and authenticated enrollment namespace, never creates
a missing root during export, and makes no cross-device identity claim. Missing
root/history proof leaves attribution unknown without dropping raw local usage.
Current quota capture is bracketed by compatible account reads; logout, read
failure and disagreement clear provisional markers. Markers cannot tag history
before capture and are not upgraded to exact source proof.

Day chunks remain staged until one complete replacement domain passes source,
occurrence and base-accounting compatibility checks. Old accepted data remains
stored; a partial replacement cannot become a hybrid primary. Immutable consent
grants, enrollment bindings, staged chunks and active domains participate in the
existing owner-erasure/restore boundaries. Device disconnect retains accepted
history; format rollback changes upload admission only, not the selected data.
No account/era pseudonyms or finer account cells are added to public aggregates.

An owner-only progress file beside the local index preserves interrupted
replacement uploads. Its closed, at-most-1-MiB payload contains day/manifest
digests and control fingerprints, never credentials, root bytes, account
markers or raw provider identifiers. Loss of this file can require revalidation
and retry, but it does not erase local evidence or accepted hosted history.

Accepted v0.2 history keeps its existing analytical source. Until a compatible
replacement adapter exists, this history blocks the stronger-format upgrade
before consent or admission-floor changes; disjoint dates do not make it safe
to hide the old source. No local or hosted history is deleted by this refusal.

### Continuity successor and daily performance (source implementation)

The desktop app no longer sends these streams (see the desktop sharing removal section above). The text below describes the retained hosted contract.

V1.2 adds nullable turn-start/preceding-compaction bits, ordering among events
with the same session and timestamp, and reported five-minute/one-hour cache
write subdivisions. Unknown evidence stays null. The subdivisions reconcile to
the existing cache-write total and never add usage. Continuity before the
server-issued activation instant remains unreported. Current cache calculations
remain unchanged. Social sharing requires an exact new field review, hosted
grant and local approval; accountless sharing negotiates a distinct policy grant
while respecting the existing durable opt-out. Legacy clients retain their own
closed contracts. Installing the source does not activate the hosted runtime.

The separately authorized performance stream contains daily distributions and
counts by provider, model, reasoning effort, measurement method, event-time
speed mode/evidence source and API tier. It covers eligible TPS, first-token
time and complete-turn duration, including tool waits where qualified. Missing
measurements remain unavailable. It sends fixed histogram counts and bounded
integer summaries, not turn identifiers, prompts, responses or timestamps for
individual turns. Compatible reports are pooled as reported samples: ordinary
retry/revision deduplication does not remove copied history across devices.

Usage and performance have separate capabilities, consent/policy tuples,
progress, retry and storage state. Usage authorization never grants performance
permission. Performance delivery and application composition are still qualified
independently in the [implementation plan](../plans/2026-09-20-turn-boundary-telemetry-plan.md).
The source includes owner erasure for both streams and a typed restore role that
preserves grants, report revisions and correction history. Populated synthetic
restore/erasure checks do not establish a production migration or deletion-ledger
reconciliation. Opt-out stops future uploads and retains accepted history.

## Network destinations

| Destination | When used | Data sent |
| --- | --- | --- |
| `https://tibotattle.com` | Public community reads, hosted identity/session, optional contribution, participant export, device disconnect, app compatibility/preflight. | Route-specific closed requests; contribution requires consent and one-use/device authority. No self-service hosted deletion. |
| `https://admin.tibotattle.com` | Owner operations only, including explicitly targeted participant erasure. | Cloudflare Access owner assertion and bounded admin reads/actions with CSRF on mutations. The app is not an admin client. |
| Legacy Google or Apple identity endpoints | A legacy client starts hosted sign-in in the system browser; the shared dashboard has no sign-in controls. | Provider-controlled sign-in. The provider callback goes to TiboTattle's Worker, not loopback. |
| Artifact URL from the verified update feed | User/automatic updater downloads an update. | Standard artifact request; signature, length, and digest/provenance gates remain separate. |

The loopback companion is not a general proxy. It forwards only fixed routes
and bounded headers listed in [`api-surface.md`](./api-surface.md).

## Hosted lifetimes and deletion behavior

These current source constants describe credential/control windows, not a
promise that every data class is deleted on the same schedule:

| Data/control | Current lifetime |
| --- | --- |
| Web session | 30 minutes |
| One-use upload authorization | 5 minutes |
| Device pairing claim | 10 minutes |
| Paired social device credential | 30 days, silently renewable by the same valid device |
| Accountless enrollment and derived upload authority | 30-day lease. Same-secret authenticated renewal extends the same active installation graph within seven days of expiry or after an offline period. Revoked or erased authority cannot renew; no replacement identity is created. |
| Hosted identity authorization handoff | 10 minutes |
| Completed identity-result delivery window | 5 minutes |
| Sign-in admission rows | 24 hours |
| Identity re-enrollment cooldown | 30 days |
| Deletion tombstone | 400 days in source, to suppress erased participant data after restore replay; not a verified production backup/retention guarantee |
| Sampled admin diagnostics | 30 days |
| Contribution quarantine age deletion | Disabled in current source; private owner erasure and orphan reconciliation remain separate operations |

There is no blanket short time-based retention promise for accepted
contribution/aggregate evidence in current source. Participant capabilities
retain hosted export and device revoke/disconnect, but neither whole-account
nor individual-contribution self-service deletion is available. Disconnecting
does not shorten retention or remove previously accepted data.

Private owner erasure fences uploads, withdraws affected aggregates, records an
independently verified deletion tombstone and identity cooldown, removes owned
R2 objects, and completes participant database removal. Immutable aggregate
revisions may remain withdrawn; replacement publication must exclude the erased
participant. A tombstone, cooldown, or content-free operational audit is not
removed merely because the participant's data has been erased. Local history,
provider-side sign-in records, and provider source files are separate.

The deletion ledger must still suppress erased data after backup restore.
For tombstoned participants, restore replay claims only active rows or
interrupted restores with a null deletion fence; it must not take over
non-null owner/legacy erasures. A busy restore is finished/retried by
maintenance, not a concurrent owner erasure; final removal must still match
the restore or owner fence.
The actual production backup/restore horizon and infrastructure log/object
policies require independent verification; the constants above do not
establish them.
This retirement adds no migration, retention change, or tombstone removal.
See [production operations](../runbooks/production-operations.md#private-owner-participant-erasure)
for the protected procedure and [SUPPORT.md](../../SUPPORT.md#hosted-history-and-privacy-requests)
for the privacy-request intake boundary. Retiring a control is not a conclusion
about applicable privacy rights or how a particular request should be resolved.

## Separate deletion actions

| Action | Removes | Does not remove |
| --- | --- | --- |
| **Erase local data** | Moves the installed app's user-data state root to the operating-system trash, including the local index store, its device salt and collector state, and clears TiboTattle website data. | Provider source files, Credential Manager capabilities, or hosted data. |
| **Reset identity and device** | Reviewed TiboTattle Credential Manager capabilities plus their associated local binding/app state. | General local analysis state unless the reset contract explicitly reports it; hosted contribution records. |
| **Device disconnect** (legacy backend contract) | Hosted authority for this device plus its local device credential/binding; pauses delivery. | Other devices, hosted participant data, or local analysis. |
| Private owner participant erasure | Hosted participant/account, contribution, session, and device state through the protected pipeline; affected aggregates are withdrawn/rebuilt. | Local analysis, provider source files, retained safeguards/audit, or immutable withdrawn aggregate revisions. |
| Ordinary app uninstall | Application binaries. | By design, local state and Credential Manager entries survive ordinary uninstall. |

Use the app's explicit controls before uninstall when the intent includes
local cleanup. The saved sharing choice is preserved and no longer read; the shared dashboard no longer offers legacy device disconnect. These controls
cannot perform private owner erasure.
Do not manually delete the only local index as a repair technique; follow
[`../runbooks/local-index-recovery.md`](../runbooks/local-index-recovery.md).

## Coverage and uncertainty

- Missing, inaccessible, stale, partial, or unattributed evidence is shown as
  such; it is not converted to zero.
- A provider quota snapshot is provider-reported status, not proof of billing
  semantics or a guaranteed future allowance.
- Standard API prices are a comparison normalization, not subscription billing.
- A 30-day chart is a display window, not proof that older local data was
  deleted.
- Public aggregates do not prove a specific person's contribution, account,
  device, plan, or activity.

## Updating this inventory

Any shipping source reader, subprocess RPC, local store, Credential Manager entry, network
destination, contribution field, retention constant, or erase/uninstall
behavior must update this file, the public privacy page, localized first-run
and refresh disclosure, and source-backed privacy tests in the same change.
Obsolete privacy documents should be deleted once this maintained inventory
supersedes them; retaining contradictory consent boundaries is a product bug.

## Projects and threads local display

Owner-approved on 2026-09-08. The local reporting API can read canonical typed
usage identities/counts and explicit `cwd` from `session_meta`, `turn_context`
and `thread_settings_applied.thread_settings` through the existing
bounded source reader. The same reader can qualify status-only quota records
against canonical all-null rows; it never adds token usage. Reads stop at the
indexed prefix, including when the stable reader accepts append-only growth.
The initial session directory applies until a later explicit directory update.
Sparse settings preserve the observed directory; malformed changes invalidate it.
Later observations never backfill earlier usage.
The owner approved Codex title fallbacks for this local view on 2026-09-08.
Explicit session-index names and saved names take precedence. Titles are bounded
to 512 characters inside SQLite before reaching JavaScript; whitespace is
normalized and control-containing values are rejected. Titles can include opening
message text, but are never exported, uploaded or persisted by this feature.
No transcript or response bodies are read. The cache-drop tables and ancestry
reader retain their title-free contract. A bounded local Git lookup groups worktrees
and clones with the same normalized origin. An owner-controlled, read-only SQLite
snapshot may read up to 25,000 rows of `cwd` and `git_origin_url`, each bounded to
4,096 characters and UTF-8 bytes. Credentials, query strings and fragments are
removed from recognized network origins. Unambiguous retained origins recover
repository identity only for missing folders; existing non-Git folders override
stale hints. Conflicting hints stay unresolved. Raw origins remain transient and
never reach the browser, index, export or telemetry. Folders without identifiable
repositories share Non-project tasks; missing source context stays Unassigned.
Display labels and
basenames are transient display decoration. No raw path, name or project handle
is written to exports, diagnostics, contributions or browser storage. The
owner-only local index store holds working directories and rollout paths, as the
[v2 decision](../decisions/2026-10-12-local-index-v2-and-local-paths.md) allows;
they never leave the machine. Raw repository origins are not stored there.
Explicit collaboration parent links are read in a bounded local metadata pass
to group subworkers into primary-thread families. Cycles and unresolved ancestry
remain separate; names and title policy are independent of this grouping.
Name search is submitted only to the loopback query route in a bounded POST
body, never a URL. It may read up to 25,000 selected task identities through the
same approved name/title reader; ordinary visible-row enrichment remains capped
at 160. A lazily built search lookup stores normalized names only in private
memory, limited to 75,000 project/task entries and 16 MiB of normalized text per
report. It expires or is evicted with the report. Search matches are applied
before pagination and family/project summation, preserving global share
denominators. Neither search text nor the lookup is serialized, exported or
uploaded. Refreshing creates a new lookup when names need to be reread.
Interactive attribution reports are immutable and expire after five minutes without
a query or lease renewal, with at most two addressable reports per process. Two
additional last-completed reports may remain in memory for reload continuity;
search indices are not retained with them. A separate `work-usage-snapshot.json`
stores at most four completed period/scope projections in a 16 MiB owner-only,
digest-checked envelope. Project/worktree/thread handles are replaced by anonymous
snapshot-local aliases before writing; names, raw UUIDs, paths, display metadata
and search text are absent. Requests match a hashed period/scope key and configured
source binding; an explicit `endAt` additionally requires the exact saved window. Restored figures retain their original interval and observation
time and stay read-only while a separate refresh job runs. On companion restart,
labels explicitly remain anonymous until live enrichment completes. When the
shared reporting end advances within the same period, the view can keep the dated
previous figures visible while fetching the exact new window; those figures
never become the new query's source, cursor or cache entry. Failed,
cancelled or partial builds preserve the last completed result; an authoritative
empty result replaces it. The visible Projects &
threads page renews its lease every minute through a closed, content-free
`touch` request containing only the schema, action and snapshot handle. This
performs no aggregation, enrichment or source scan, stops when the page is hidden
or destroyed, and does not extend the separate worker cache lifetime. Returning
to an expired report automatically obtains a new snapshot. A serial local projection worker
may reuse extracted workspace observations and quota-status offsets in private
memory across refreshes, under a 32 MiB estimated payload budget and a 25,000-source
limit. It holds no database connection between jobs. The cache is scoped to one
index/home/secret configuration and disappears on abort, worker failure, shutdown or
five minutes of worker inactivity. Changed indexed prefixes are reread; absent
or rejected sources are evicted. Each hit still verifies the retained source,
and Git mappings and ancestry are resolved afresh. This cache is not serialized,
exported or returned to the browser. Retained-source loss yields Unassigned because there is no usage-bound directory
to associate with a current or retained repository identity. This is independent of token-count
and event-time API-price coverage. See the
[implementation plan](../plans/2026-09-08-thread-project-usage-implementation.md)
for the preview's bounds and qualification status.
