---
title: Local Data, Network, and Privacy Inventory
date: 2026-08-27
type: reference
status: maintained
last_reviewed: 2026-10-27
---

# Local data, network, and privacy inventory

This maintained inventory describes the current source of the independent local
Windows product, Rhetrion (衡川): source reads, protected local writes, optional
network use and separate removal boundaries. The app has no configured cloud
project, hosted account, contribution destination, public download or update
feed. See the [local-product decision](../decisions/2026-10-23-local-product-identity-and-cloud-retirement.md).

This is source behavior reviewed on 2026-10-23, not proof that a published or
installed artifact has passed native qualification or that existing real data
has been converted. A new name or state directory does not establish migration,
backup, erasure or remote-service shutdown.

The central rule is structural: prompts, responses, reasoning, raw commands,
credentials, private paths/filenames, emails, account names, and other free
text have no allowed destination in contribution schemas, diagnostics, or
public aggregates. Unknown fields are omitted; an input that cannot be safely
projected is refused or shown as unavailable.

Local metadata export deduplicates identical normalized activity-marker
occurrences and rejects conflicting records with the same derived identifier.
Privacy source-value canaries are compared in their canonical JSON encoding,
including escaped characters. The public byte verifier can repeat that check
only when its caller supplies the source values in memory. A standalone reload
without those values checks the exact receipt, digest, schema and structural
privacy rules; it cannot independently repeat a source-value canary check. Raw
source values and their hashes are not added to persisted receipts.

Electron session permission handlers remain deny-by-default after the final
window releases its policy. Explicit notification grants belong only to the
registered WebContents and are revoked on release. Recovery and tray windows
also install the shared deny policy; closing them does not restore Electron's
default permission behavior.

## Owner-selected window backgrounds

Electron Settings can read one image chosen through the native file picker.
Only static PNG, JPEG and WebP images with validated dimensions and native
decode success are accepted; there is no fixed total byte or pixel cap. The app
keeps an original-byte copy in owner-only protected binary resources, using
bounded chunks and SHA-256 verification. A dedicated
small configuration contains an opaque resource reference, color and overlay;
the normal desktop settings record is unchanged. An import journal recovers
interrupted changes and reclaims only unreferenced background resources.

The source filename/path never crosses the renderer mutation boundary, is not
persisted in the background configuration, and is not printed in failures. A
separate owner-only `window-background-picker-v1.json` remembers the last selected
directory for the native picker; it never enters renderer IPC or diagnostics.
Renderers load the selected original-byte resource through the trusted local
desktop resource boundary. They never enter local usage reports, diagnostics,
exports or telemetry, and there is no remote image URL or upload path. Removing or resetting
a background affects only the app's own resource copy, not the source file.

## Desktop sharing removal

The desktop app is local-only. Community sharing, contribution upload, performance sharing, share cards, and hosted sign-in were removed on 2026-10-13 ([decision](../decisions/2026-10-13-desktop-sharing-removal.md)). The app sends no usage data, and local analysis works without an account.

The retained local state is preserved untouched: the saved sharing choice (`desktop-settings/accountless-sharing-v1.json`), notice receipts, device salts and identities, the accountless installation credential, and prepared spools and queues. The desktop app neither reads nor writes that state; deleting any of it needs a separate receipt-backed workflow.

Former hosted deployments are outside this product configuration. Removing their
source and links does not delete remote records, revoke old authority or establish
that a deployed service has stopped. Historical responsibility is described below.

## Optional X reader

The desktop's [optional X reader](../decisions/2026-10-20-optional-x-reader.md)
uses an isolated X session. Its user-selected webpage login or Chrome extension
import does not access coding-agent credentials or Chrome's encrypted cookie
database. Imports use Native Messaging and a protected local transport only
after the user requests them. Passwords, cookies, authentication responses and
tokens never enter the dashboard, ordinary logs, clipboard or test fixtures.
Persistent candidate sessions require verified Electron cookie encryption and
owner-protected session directories; those properties need artifact/runtime
qualification, not only source assertions.

Validated public post text, public author names/handles, publication times,
reply/quote relationships and media references are stored in a protected X
cache separate from the usage index. This owner-approved public-content cache
is not permission to retain coding-agent session content. It is not exported,
uploaded, sent to telemetry or added to accounting results. Login replacement
isolates the visible scope and archives the prior cache. Explicit cache
clearing removes post payloads from all scopes, retaining login metadata,
settings and notification baselines. Logout affects only the app's X session,
leaving Chrome's login and the independently managed reading cache intact.

The dashboard reads media through opaque post-associated resource references;
it cannot provide arbitrary remote URLs or local paths. Only the trusted main
frame can use the media scheme. Same-origin MSE blobs are media-only and HLS
workers are disabled. Media is fetched on demand, not promised for offline
playback. X requests use their own system/loopback proxy choice and timer; they
do not upload usage data or change local-analysis scheduling. `-1` stops timed
refresh and background keepalive; user-triggered page reads remain available.

## Normal refresh sources

| Provider | Exact source | What is read | What is retained by Rhetrion | Network boundary | Removal/reset |
| --- | --- | --- | --- | --- | --- |
| Codex rollout metadata | Selected Codex home, normally `~/.codex/sessions` and `~/.codex/archived_sessions` | Bounded record headers and allowlisted metadata from `turn_context`, `token_count`, `thread_settings_applied`, quota/accounting, tool-outcome, lineage, and compaction-boundary records. | Typed usage/quota/tool facts, timestamps, model/speed/reasoning/outcome enums, local HMAC join keys, source cursors, coverage and diagnostic codes. | Local filesystem only. | Refresh preserves accumulated projection; it never edits or deletes Codex source files. |
| Codex configuration | `~/.codex/config.toml` | Only the top-level `service_tier` baseline used when a rollout has not yet recorded an observed speed. | Timestamped declared speed-baseline windows. An observed rollout value always wins. | Local filesystem only. | Retained with the local evidence; the app never edits Codex config. |
| Codex runtime diagnostics | `~/.codex/logs_2.sqlite` including committed WAL | Incremental, bounded read-only diagnostics; transient bodies are projected immediately to model/context/fallback evidence. | Closed kind, canonical model, time, digest and device-HMAC joins in the protected local index; source cursor commits with receipts. No body, command, credential, raw thread/response ID or private path is retained or sent to the renderer. | Local filesystem only. | Evidence is retained with the local index; closing Rhetrion cannot prevent Codex from removing upstream logs. |
| Codex selected-rollout store | `~/.codex/state_5.sqlite` | Read-only `threads.id` and `threads.rollout_path`, after owner/file/path validation, to select the physical head of a logical thread. | Only the validated selected rollout filename mapping needed during ingest. | Local filesystem only. | The app never edits Codex SQLite; selected source paths stay owner-only. |
| Codex account/quota service | Local `codex app-server` subprocess using `account/read`, `account/rateLimits/read`, `account/usage/read`, and bounded update notifications | Current plan/account scope, quota windows, resets, credits-presence flags, and provider usage projection. | Sanitized quota/account observations and local-HMAC account scope. No Codex authentication token is copied. | Rhetrion talks to a local subprocess. If Codex itself cannot refresh its account evidence offline, Rhetrion records the source as unavailable/stale rather than inventing continuity. | Observations and identity state are preserved; unavailable credentials never authorize creating a replacement identity. |

Codex is the only supported usage provider. Claude Code/Desktop collection,
transcript ingestion/export, callback and status-line lifecycle, and
Anthropic-specific pricing are retired. Existing versioned generic
telemetry/export formats and provider-accounting snapshot formats are preserved
only to identify or read already-retained bytes. Their original contract-status
fields remain unchanged; preservation does not imply a frozen, published, or
active contract. The one historical credential-audit pair (`owner=claude-callback`,
`capability=claude_callback`) may be read under bounded historical contracts;
the pair is read-only and cannot authorize new credential preparation or a
lease. No status-line JSON or Claude settings reader remains. The product
does not scan existing Claude profiles or settings to remove those integrations;
existing profiles, ledgers, callback state, credentials and files remain
untouched. Historical readback is not current provider support. See the
[Codex-only provider decision](../decisions/2026-10-27-codex-only-product.md).

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
| Custom Codex home | User chooses a directory in Settings | It replaces the default Codex home anchor; the same fixed subpaths and allowlists apply. | Owner-only launcher setting. |
| Local cache-drop thread links | Local interactive dashboard, for recent displayed drops only | Read-only bounded `session_index.jsonl` (`id`, `thread_name`, `updated_at`) and `state_5.sqlite` (`id`, explicit `name`, worker nickname, and allowlisted source ancestry). For a `guardian_review` row only, the first bounded `session_meta` header in its selected owner-controlled session may supply its matching explicit parent UUID after source and path validation. Never uses prompt-bearing `threads.title`, first messages, or transcripts. | Names and IDs exist only in a separate `no-store`, same-origin local response and transient UI memory, reused for unchanged displayed event pairs during refresh. No snapshot/cache/report/share-card/diagnostic/contribution persistence. Clicking hands only the canonical thread UUID to the local Codex URL handler. |
| Export workspace | Explicit CLI or review flow | Only allowlisted metadata for the selected time range and sources. | Journaled workspace, chunks, manifest, and verification/deletion receipts at explicit paths. |

## Model performance timing in development source

Opening **Model performance** (`#performance`) enables an independent local worker
for the selected Codex home's plain `.jsonl` session and archived-session files.
This diagnostic population spans accounts on this device. It reads timestamps,
allowlisted model and speed-mode metadata, token counters, and response/turn boundaries to
reconstruct timing; raw content and raw IDs are never persisted or returned.
Compressed-only histories and missing timing remain unavailable.

Page reads renew a 60-second lease. Discovery is capped at 50,000 entries;
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

Normal stable-profile source pins Electron `userData` before readiness to
`%APPDATA%\UsageMonitor\profiles\stable`; the companion receives its
`companion-state` child through `USAGE_MONITOR_STATE_ROOT`. Electron `sessionData`
is the separate `chromium` child. Development and preview use separate profile
identities; explicit qualification launchers may use isolated test roots. None
of these paths derives from the display name. Resolve the actual runtime root
before recovery or cleanup.

Desktop settings, background resources and the X cache live under the profile's
`desktop-settings` directory; X browser sessions use protected
`desktop-settings/x-sessions/<opaque session ID>` directories. The following
companion entries are beneath `companion-state` unless a row states otherwise:

| State | Purpose | Retention behavior |
| --- | --- | --- |
| `local-index-store-v1.sqlite` (with its `-wal` and `-shm` sidecars) plus the device salt `local-unified-index-device-salt-v1` in the same directory | Canonical replay-safe Codex usage/quota/tool projection, source provenance, and the owner-only local rollout paths and working directories that the [v2 decision](../decisions/2026-10-12-local-index-v2-and-local-paths.md) allows. Paths never leave the machine. The salt anchors local join keys and retained historical export pseudonyms. | Accumulates locally; the 30-day UI horizon is not retention. Rollout sources are never modified. Facts of rollouts that have since left disk are kept, not deleted by absence. The salt is never regenerated. |
| `local-unified-index-v1.sqlite` (retired previous index, if present) | Previous physical index. The app does not read it except for the one-time ordinal seed while the v2 store has no sources, and it is not a current contract. | Kept until its retirement is assessed and an owner-authorized, receipt-backed deletion removes it. It holds facts of any rollout that has left disk, and such a file is retained as an unread archive. |
| `inference-timing-v2/model-performance-snapshot.json` | At most twelve rolling period/mode and twelve exact-window completed timing projections, fixed model IDs and numeric bins; 4 MiB owner-only, schema/digest-checked v5 envelope bound to the configured Codex source. | Uses the same atomic snapshot transport as Overview. Earlier mixed-mode receipts are preserved and refused until mode-separated reconstruction produces a v5 replacement. Unknown and mixed-mode turns are excluded from all selectable modes. Restored measurements keep their observation date while background scanning runs or fails; incomplete scans cannot replace them. First result saves immediately, then hourly, with latest completed results flushed on clean shutdown. |
| `inference-timing-v2/source-<Codex-home digest>/timing-experiment.sqlite` (development source) | Separate owner-only timing sidecar: one row per completed turn, counts/durations/coverage, local HMAC keys, source cursors and bounded pending state. No raw content or IDs. | Maximum 256 MiB per selected source; measurement method 2 and SQLite user version 12, with an exact `usage-monitor-timing-identity-v1` metadata marker. Existing older or foreign identities are inspected read-only and refused; only the independent transition package may reconcile their HMAC keys on a verified copy. The legacy unscoped sidecar is preserved without reading or migrating its unknown source provenance; first use rebuilds measurements from retained source logs. Incompatible stores, including version 1, are preserved and refused. Display periods do not delete evidence or migrate the accounting index. |
| `inference-timing-v2/source-<Codex-home digest>/tool-free-v1/timing-experiment.sqlite` (development source) | Independent supplement for reconciled single-response turns without tools, plus its own source cursors and bounded scalar pending state. Shares the original private timing correlation key for local joins only. | Maximum 256 MiB; measurement method 3 and SQLite user version 13, bound to the same identity marker. Unconverted stores are refused before writable reopening; the original primary store remains separate. An incompatible or unavailable supplement does not hide original measurements. |
| `local-collector-state-v1.sqlite` | App-server quota observations, checkpoints, dedupe, locks, and replay-safe collector state. | Accumulates until a separately authorized, receipt-backed cleanup or reviewed migration/retention workflow. |
| `private/` settings/handoff state | Fast-mode preference and speed baselines. Retired contribution settings and OAuth handle are preserved, not read. | Settings persist. |
| Retired prepared contribution/review directories and queue | Preserved spools and queue state from removed contribution sharing; not read or written. | Preserved untouched; deletion needs a receipt-backed workflow. |
| Diagnostics log | Fixed error/status codes and opaque support references. | Bounded, content-free local diagnostics only. |
| Profile `chromium/` data | Loopback dashboard browser data; no hosted account session is configured. X browser sessions are isolated in their separately protected directories. | Preserved with the profile. X logout and X cache clearing are separate scoped actions, not a whole-profile erase. |

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

The standalone CLI/developer default is `%LOCALAPPDATA%\app-usagemonitor`.
Read-only usage-explainer discovery selects an existing stable companion store
before that CLI store; `USAGE_MONITOR_STATE_ROOT` overrides discovery. These are
separate locations, not aliases or a migration path.

Old profiles remain preserved source data. Only a separate, backed-up and
validated one-time conversion package may translate their old keys and layout.
The application has no former-name fallback. A profile path change does not prove
that any original state has been copied, converted or accepted.
The owner-approved [2026-10-25 cutover scope](../decisions/2026-10-25-usage-only-state-cutover.md)
is limited to usage computation and history continuity. X state, background and
generic Chromium data are not transferred, inspected for migration or deleted;
they stay at the source. This does not retire X or authorize logout, registry
rebinding, secret export or identity rotation. Only explicitly reviewed
source/calculation controls, not the entire settings/browser profile, may be
carried into the usage target.

## Credential Manager and credential state

Rhetrion keeps separate credential capabilities for:

- export pseudonym identity;
- current account observation pseudonymity;
- the retired paired contribution-device credential, preserved and not used by the desktop app.

These installed-app capabilities are stored in Windows Credential Manager through
the noninteractive native adapter. A content-free binding/renewal record lives under
the app's user-data state root; it is not the credential. Keys are intentionally
separate so one identity namespace cannot be joined to another by accident.

Current Electron has no credential migration approval entrypoint. Its
noninteractive adapter preserves a legacy credential and blocks the affected
path when migration is required. A required startup credential blocks before
Settings and reports `SECURE_STORAGE_MIGRATION_REQUIRED`; quit, preserve the
state and follow the [local recovery boundary](../runbooks/local-index-recovery.md).
Preserve the legacy credential and app data; do not delete or reset credentials
or app data. Retry only repeats the silent readiness
check, and reinstalling this release does not perform a credential migration.

The Electron production source serves the four legacy broker capabilities
through its checked main-process broker and inherited FD4 channel; signing
and installed-artifact acceptance are separate gates. The retired accountless
installation credential is preserved in Credential Manager; the
[2026-10-13 decision](../decisions/2026-10-13-desktop-sharing-removal.md) retires
its sharing use.
Secret bytes never enter renderer IPC, local HTTP responses or diagnostics.

A packaged Windows development shell that passed the native qualification checks
can read the existing fixed account-observation key through the same parent IPC
boundary. Its parent broker refuses key creation before entering the credential
backend. Missing keys remain unavailable; development cannot rotate, replace, or
delete credentials. New observations can be attributed, while previously
unattributed records retain their original status. This does not grant production
updater, installer, or signing policy.

The current desktop has no whole-profile erase or general identity-reset control.
The explicit CLI export-identity operations are capability-specific;
they are not permission to rotate the index salt or delete unrelated credentials.
An unavailable Credential Manager entry is an availability condition, not proof
of corruption or permission to replace it.

## Network destinations

| Destination | When used | Data boundary |
| --- | --- | --- |
| Loopback companion (`127.0.0.1`, with the runtime-selected port) | Dashboard reads and bounded local mutations. | Host/Origin checks and route-specific local headers protect local evidence. The companion is not a general network proxy. |
| Local `codex app-server` subprocess | Account/quota observations. | The app uses reviewed local RPC methods, not a copied provider credential. Codex may itself contact its provider; failed/offline reads remain stale or unavailable. |
| X webpages and their webpage assets; controlled media on `pbs.twimg.com`, `video.twimg.com`, `abs.twimg.com` | Explicit optional X login, authenticated reading, refresh and media playback. | Isolated X browser requests and validated post-associated media only; no local coding-agent usage, paths or accounting data is uploaded. |
| User-selected system proxy or fixed loopback proxy for X | Only the isolated X session and its requests. | An independent X setting; it does not change local-analysis scheduling or authorize usage transmission. |
| Explicit live research experiment | Standalone CLI `experiment --execute-live` with a reviewed manifest. | Separate from desktop analysis. The manifest bounds the operation; a dry run does not authorize network execution. |

There is no configured update feed, hosted sign-in, contribution destination,
former-project API relay, public site or reporting endpoint. A UI label or a
retained schema cannot enable one. External product links are unconfigured.
The local route inventory is maintained in [the API surface](./api-surface.md).

## Historical remote state and responsibility

Earlier deployments may retain contributed history, pseudonymous identifiers,
consent/opt-out records, deletion safeguards or backups. This repository's cloud
source retirement does not administer those deployments. It does not establish
remote erasure, a new retention period, a completed restore reconciliation or a
shutdown. Saved local receipts, salts, identities and opt-outs remain intact.
Historical pseudonyms can support longitudinal linkage; they are not anonymous.

Any request about former remote records requires its actual responsible operator
and a separately verified, authorized procedure. Remote erasure and deletion-safe
restore remain distinct from local cache clearing, uninstall and source removal.
No former domain or operator contact is configured as this product's service or
support channel; see [the current support boundary](../../SUPPORT.md). No remote
lifetime or successful deletion is promised here.

## Separate deletion actions

| Action | Current scope | Does not establish |
| --- | --- | --- |
| Ordinary refresh or changing a display period | Reads sources and updates/reuses derived evidence; absent sources keep accumulated facts. | A retention cutoff or deletion of older history. |
| Remove/reset a window background | Changes the app-owned selection and reclaims only unreferenced background resources. | Deletion of the original user-selected image. |
| X cache clearing | Removes cached public-post payloads across X scopes while preserving X login metadata, settings and notification baselines. | Logout, Chrome cleanup or deletion of usage evidence. |
| X logout | Clears the app's isolated X session. | Logout from Chrome, X-server data deletion or removal of the independent reading cache. |
| CLI export deletion/workspace discard | Acts only on the exact reviewed export/workspace, confirmation token and recovery journal. | Analysis-index deletion, unrelated credential removal or remote erasure. |
| CLI export identity rotation or removal | The named export capability, with its explicit confirmation and lifecycle contract. | Rotation of the local index salt or a whole-profile reset. |
| Ordinary app uninstall | Packaging is configured to remove binaries while retaining AppData. | Local evidence or Credential Manager erasure; this source setting is not installed-uninstaller qualification. |

The desktop provides no blanket **Erase local data** or **Reset identity and
device** operation. Do not replace a missing control with manual AppData or
credential deletion. Old-profile conversion and any exact, receipt-backed
cleanup require separate preservation and authorization. Local actions cannot
perform historical remote participant erasure. For diagnosis, use
[local index recovery](../runbooks/local-index-recovery.md); never delete the
only store as a repair.

## Coverage and uncertainty

- Missing, inaccessible, stale, partial, or unattributed evidence is shown as
  such; it is not converted to zero.
- A provider quota snapshot is provider-reported status, not proof of billing
  semantics or a guaranteed future allowance.
- Standard API prices are a comparison normalization, not subscription billing.
- A 30-day chart is a display window, not proof that older local data was
  deleted.
- Retained historical aggregate or contribution records do not prove current
  service availability, a particular person's activity or completed erasure.

## Updating this inventory

Any shipping source reader, subprocess RPC, local store, Credential Manager entry, network
destination, retained schema, retention rule, or removal/uninstall behavior
must update this file, localized first-run/refresh disclosure, current support
guidance and source-backed privacy tests in the same change.
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
The usage-only relation reader also verifies automatic-review parents from the
first bounded session header against the local thread-store classification.
It supports current and legacy guardian classifications and compressed headers,
without reading transcripts or titles. Missing, conflicting, inaccessible or
cyclic relationships remain unlinked. Each usage cell contributes exactly once;
live task details partition primary, subworker and automatic-review usage.
Review classification is transient; the saved anonymous report schema is
unchanged and restored reports do not open detail dialogs.
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

### Background resource isolation

Imported images retain their original bytes in independently protected 1 MiB
chunks, with atomic metadata and recovery journals. There is no artificial total
byte or pixel limit; system decoding/allocation failures preserve the previous
selection. The main process validates a bound source handle and verifies its
digest during import. Renderers receive only an opaque local resource reference,
never a source path or whole-image Base64 payload. Only the trusted main top
frame may load the currently selected image; it is never uploaded or projected
into diagnostics or usage artifacts. Background state migrates forward to v2.
