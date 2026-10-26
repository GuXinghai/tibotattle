# Local companion

The running companion also incrementally retains content-free Codex runtime
model evidence in the protected index (physical schema 6). Its background
collector shares durable read progress across restarts and never publishes a
dashboard refresh. Request context and fallback attempts remain separate from
an exact successful-response model; missing or conflicting evidence stays
explicit. Homepage diagnostics sit below the cards with expandable pricing
records and capture status. Original Codex records and log retention are untouched.

This loopback-only Node application turns retained privacy-safe monitoring
artifacts into the functional Rhetrion dashboard. It does not send raw
Codex logs, accept arbitrary source paths, or expose raw account/session
pseudonyms to the browser. A separate, explicitly local-only thread-link
contract exposes Codex thread IDs and display names for recent cache-drop rows,
without adding them to accounting snapshots or export DTOs.

A detailed-accounting refresh processes metadata from the selected Codex
`sessions` and `archived_sessions` folders. It also reads the selected Codex home's
`state_5.sqlite` for rollout lineage and `config.toml` for service-tier
settings, and invokes the installed Codex binary's local `app-server` methods
`account/read`, `account/rateLimits/read`, and `account/usage/read`. Source
records are processed locally; prompt and response text is never retained in
the companion's derived state. See the maintained
[local data and privacy reference](../../docs/reference/local-data-and-privacy.md).

`GET /api/local/cache-drop-thread-links` independently resolves those recent
rows against the same published index generation, then reads explicit display
names from the selected Codex home's `session_index.jsonl` and bounded
worker/parent metadata from `state_5.sqlite`. For a `guardian_review` row only,
it reads the first bounded `session_meta` header from the selected,
owner-controlled session to verify that row's explicit parent UUID. It never
reads prompt-bearing `threads.title`, first messages, or source transcripts.
The endpoint requires the local custom header, refuses foreign origins and
query strings, returns `no-store`, and does not persist its response or modify
the source databases. Missing metadata does not fail an accounting refresh. See the
[accepted local-link boundary](../../docs/decisions/2026-08-30-local-cache-drop-thread-links.md).

Windows display metadata uses held native source handles to validate current
ownership, single links and reparse-point refusal. POSIX mode bits are not used
as Windows ACL evidence. Projects & threads also permits its existing bounded
title fallback and uses a saved, unambiguous repository origin when Git cannot
be launched because it is absent. An actual Git rejection remains non-project.
These names and repository hints remain transient and local-only.
Selected rollout-head reads use the same platform-aware metadata boundary, so
valid paginated forks resolve through the shared native metadata contract. Closed
databases are read without creating source sidecars. Packaged UI execution remains
a separate gate.

## Run

Standard dashboard periods are supplied by the shared dashboard projection.
After the initial dashboard paints, the separate Performance and Projects &
threads views prepare their selected and other fixed periods before the first
visit. Their browser caches are bounded and memory-only; speculative browser
requests pause when the app document is hidden. A measurement history pass that
has already started can finish independently. Performance reuses the
worker's four periods and three observed speed modes. Only the selected exact
performance window is preloaded; other combinations load on demand so multiple
readers with different report cutoffs cannot churn the shared bounded cache.
Completed performance results follow the global five-minute/manual
refresh; pending reads are bounded to 24 attempts. Runtime collection and snapshot
failures are reported separately through an allowlisted diagnostics header,
without changing or discarding validated v5 measurements. Projects & threads uses related
period queries anchored to the selected report, preserving generation checks
and the two-report server capacity; cached display values do not authorize
drill-down through an expired report. No additional log scan is required to
change a warmed period.

Performance snapshots use source-specific filenames. A matching legacy snapshot
may restore a missing source-specific cache; mismatched or corrupt legacy files
remain untouched. Unreadable or invalid current caches fail visibly and cannot
fall back around validation. A finished scan may persist validated v5 results
with `stale: true` when its remaining gap consists of unavailable retained
history. That flag survives restart; it is not complete coverage. In-progress
repairs and scan/store failures cannot replace a settled saved result.
`timing_history_unavailable` identifies retained sources that still require parser
repair but are not discoverable in the configured source. Their rows and parser
versions remain unchanged. A successful source-specific write clears prior cache
failures while the independent history diagnostic remains visible.

Performance discovers both `.jsonl` and `.jsonl.zst`. Compressed representations
use the original logical `.jsonl` path digest and logical byte cursor; when both
exist the plain representation wins. The primary and supplement share a bounded
in-memory decoding window, without writing decoded session content to disk.
Parser progress and physical compressed-file metadata commit together. Restart
recreates the decoder and advances to the saved logical cursor under bounded
slices; it does not reparse committed turns. Completed, unchanged compressed
sources skip decoding. Format/decode, read, resource-limit, unsupported-runtime
and source-change failures remain separate allowlisted diagnostics.

Timing source replacement, truncation, or detected edits rebuild only that source
in bounded chunks. Existing measurements remain live while replacement rows are
staged; a stable completed read atomically publishes the replacement and advances
its revision once. Cancellation or failure preserves the live rows, and restart
resumes or restarts only the affected source. A changed file is never continued
with an unverified old cursor. The forward-only timing store schema prevents
older writers from opening a store with an unfinished source rebuild. Normal
collection keeps its existing discovery and read budgets; recovery does not
schedule an all-history replay.
The local timing schemas are now 10/11 (parser methods 2/3 and parser version 18
are unchanged); prior 8/9 stores migrate forward without relabeling source
parser provenance. Older candidates must not be used as writers after migration.

```bash
USAGE_MONITOR_PORT=8791 node ./apps/local/server.js
```

Then open `http://127.0.0.1:8791/`.

The packaged Electron companion also owns the closed, read-only agent protocol
used by the Codex plugin. `--agent-protocol 1` selects exactly `status`,
`explain-usage-plans`, `explain-usage`, or `explain-usage-evidence` and writes
one content-free JSON result instead of binding a server. It accepts no generic
path, command, SQL, refresh, settings, or upload input. Normal companion startup
is unchanged when the selector is absent. See the maintained
Codex plugin reference (retired; retained in Git history).

Startup defers the full-history projection so the first local dashboard does
not wait for it. A validated last-authoritative snapshot may supply retained
figures, labelled with their original provenance and the current projection's
unavailable state. Without a valid saved snapshot, missing history remains
unavailable. Automatic lightweight refresh publishes current quota/headline
evidence without advancing retained history. Manual **Refresh** updates quota
and detailed accounting together, replacing retained or unavailable details
only after its generation-bound full projection completes.

To let the personal loopback dashboard read central-service health:

```bash
USAGE_MONITOR_PORT=8791 \
  USAGE_MONITOR_CENTRAL_ORIGIN=http://127.0.0.1:8792 \
  node ./apps/local/server.js
```

`USAGE_MONITOR_CENTRAL_ORIGIN` is fixed at startup. It must be either explicit development loopback (`http://127.0.0.1:<port>`) or a non-loopback HTTPS origin. The credential-free relay permits only `GET /api/health`. The participant browser relay, its sign-in and device-pairing routes, and the device-disconnect route were removed with desktop sharing on 2026-10-13 ([decision](../../docs/decisions/2026-10-13-desktop-sharing-removal.md)).

## Electron developer app

The Electron shell starts this loopback companion and displays the same local
dashboard. Build a development package with `npm run package:electron:development`.
The production release procedure and separate installed-app qualification are
in the [release qualification admission runbook](../../docs/runbooks/release-qualification-admission.md).
The signed Windows app uses the Electron updater. Neither path changes the local
analysis boundary.

On first use:

1. open the dashboard from the Electron window;
2. review whether local Codex metadata and writable installed state are
   available;
3. let Electron refresh after the dashboard's first paint; it
   chooses detailed ingestion when the trusted unified-index publication is
   missing, invalid, in the future or at least one hour old, and quick
   quota/headline refresh when it is recent; or choose **Refresh** in a standalone browser
   development session;
4. during manual **Refresh**, keep reading as
   Rhetrion continues bounded slices under that original action, or choose
   **Cancel** and resume later; and
5. review the privacy-safe local results.

Every detailed-analysis slice is deliberately bounded. A separate 128 MiB
checkpointed headline pass publishes current quota and recent content-free
usage before the full seven-day index and deeper replay-safe accounting
complete. The refresh status
exposes `quickResultAt` and the `quick_result` phase. Internal
`bounded_pause` results continue automatically under the same user action, with
a fixed ceiling of exactly two automatic continuations after the initial pass.
Ordinary cache-hit work retains the server's five-minute pass ceiling. A fresh
index, or the exact point at which the companion has authoritatively selected a
full accounting-cache rebuild, can instead use a four-hour total cold-work
ceiling measured from that refresh's start. Each accepted pass receives a
241-minute browser polling window so progress and **Cancel** remain attached to
either server bound; the browser window does not extend the companion deadline.
The fixed maximum remains two automatic continuations after the initial pass,
so the absolute UI attachment bound is three 241-minute windows even though
ordinary passes normally settle within five minutes. If more work remains, the
dashboard says **Deep analysis paused after two bounded continuations**, retains
the headline and verified state, and offers an explicit later resume; it is not
presented as a crash.

A user can cancel through the same-origin loopback API at any time. Cancellation
preserves the last verified dashboard, safe quick result, and durable
checkpoint. A later **Update local usage** resumes from that checkpoint. Raw
prompts, responses, commands, source paths, repository names, and local files
are not served to the browser or sent to a hosted service.

The same lineage-aware accounting pass captures both five-hour and seven-day main
allowance snapshots while it computes API-price-equivalent usage. It folds both
durations into bounded, plan-separated calibrations and atomically writes only
an owner-readable, versioned, content-free accounting cache. The Allowance view
uses that live cache and labels older observations as account-unattributed and
potentially spanning multiple accounts. Five-hour history is published only
after one plan-specific reset has enough observed movement to qualify for a
fit. It does not read the replay-heavy collector record store as a substitute
or perform a second raw-log pass.

An automatic quick refresh preserves the last authoritative accounting
projection while publishing the newly observed quota card; it never advances
the unified index or starts a replay-safe rebuild. While the published index
generation and the projection's time bound are unchanged, that completed
projection remains current (`projection.status: "available"`, generation
matched). Otherwise its figures stay on screen as `retained` with their
`retainedAt` completion time. Projection validity never implies background
work: whether a refresh is running is reported only by refresh status. The single manual Refresh action
advances the index and rebuilds from the retained authoritative corpus when the
generation is not already cached. A display range is not a history-retention
limit; the explicit legacy rollback scan has a configured window of at least
365 days.

Refresh status carries the attempt's `mode` (`quick` or `detailed`) and actual
`startedAt`, including joined and terminal attempts. Native automatic cadence
observes that receipt, including browser-started work. A confirmed join of a
quick attempt does not consume the hourly detailed allowance.

Selected-plan Trends receives a separate compact, generation/basis/cohort-bound
usage and quota lane. Explicit comparable intervals prevent rolling windows or
cumulative drift from bridging a plan transition or ambiguous usage. Quota is
selected before generic cross-plan collapse. The optional lane has 100,000-row
and 4 MiB resource ceilings, not a short history window: a limit refuses that
comparison rather than truncating history or invalidating all-plan accounting.
The existing export resource guard is applied to source files and bytes,
directory entries, elapsed time, line size, and RSS, including a 1.5 GiB
accounting RSS ceiling. A violation becomes fixed
`refresh_resource_limited`; the browser retains the useful headline or prior
result and explains that deep analysis stopped at its safety limit.

Coverage is stored in the owner-only `local-index-store-v1.sqlite` file in the
state root. That file name is stable; the schema version is recorded inside the
store and described in the [local index schema reference](../../docs/reference/local-index-schema.md).
Refresh discovers rollouts under `sessions` and `archived_sessions` and indexes each
valid physical spend delta once. The dashboard reports coverage as **scanning**,
**partial**, or **complete**. A missing, incompatible, unreadable, or unfinished store
is never reported as complete coverage, and a display window is not a retention
limit. Recovery procedures are in the [local index recovery runbook](../../docs/runbooks/local-index-recovery.md).


### Codex rollout generations and integrity gaps

Codex may retain several immutable rollout files for one stable thread, including
the canonical `rollout-<timestamp>-<thread>_<rollout>.jsonl` form used by
paginated history. Rhetrion treats the stable thread and the physical rollout
as separate identities. It indexes every valid physical spend delta once,
resolves `history_base` by rollout ID and exact ordinal/byte cutoff, and seeds the
new generation from that boundary so retained history is not charged twice.
Codex's owner-controlled `state_5.sqlite` selected path is used only as a
read-only lineage hint; it never removes superseded real spend from accounting.

An invalid lineage, divergent duplicate rollout, filename mismatch, or
unsupported compressed source quarantines only the affected logical thread.
Unrelated rollouts continue into a terminal partial generation. The dashboard
keeps verified nonzero totals, labels the refresh **degraded**, and reports
privacy-safe skipped-thread/source counts and fixed reason codes; it never
represents the missing portion as zero or calls that archive generation
complete. Raw paths, IDs, prompts, responses, and rollout contents remain local.

An unchanged terminal integrity receipt is a stopping condition. Browser
continuation and the native foreground cadence do not repeatedly rescan the same
corpus. Automatic work is re-enabled only after the source receipt changes; a
user can still explicitly choose **Retry analysis** after repairing the local
files. Old parser identities trigger a cold transactional rebuild so legacy and
rollout-aware event keys cannot coexist in a supposedly complete generation.

Repository-generated weekly artifacts are not a native production fallback.
Developers who specifically need the frozen historical fixture may opt in while
running the source checkout:

```bash
USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK=1 \
USAGE_MONITOR_PORT=8791 \
node ./apps/local/server.js
```

Mutable installed state is confined to the owner-only per-user application data
directory of the signed-in Windows account. The neutral machine identity is
intentional and remains stable across display-name changes. Installed application
resources stay inside the app directory. A source build never inherits release
signing or installer claims; those come only from the retained Windows release gates.


## Product boundary

The desktop Allowance page puts **Weekly API equivalent** on the primary
surface. The selected plan sits beside the product name; global reporting
period and refresh remain shared. Exact, replay-safe API-priced usage in each
quota-change interval is divided by its newly consumed quota fraction. Repeated
or older interleaved readings never lower a cycle's confirmed deduction baseline;
classified resets establish a new baseline. Free automatic approval reviews
are excluded only from this numerator after the recorded announcement boundary.
Unknown review origin, pricing, plan attribution and reset gaps stay explicit.

Gaussian smoothing is a display-only, time-integrated kernel (off or sigma
15/30/60/120/240 minutes). It never bridges reset, plan, account, pricing or
coverage boundaries and never feeds accounting or calibration. It uses complete
segments before clipping to the reporting period; the slider uses the exact
same time domain and plot geometry. Full interval pagination, raw calculations,
observations, reset events, calibration, five-hour history, consumption comparison,
cycle differences and historical tools remain in the **Complete details** dialog.
New report publication updates the graph and open details together. The page
has no independent refresh timer; failures retain eligible old results with a
visible category and retry. A scope change closes old details.

Historical quota curves read the selected plan's observed quota independently of
priced usage or fitted-capacity availability. Missing matching data withholds
only usage/comparison views; it cannot clear observations or historical fits,
and another plan's usage cannot fill that gap.
Observed and expected consumption share actual quota-observation endpoints.
Missing endpoints remain unavailable, and cumulative expected cost does not run
ahead of the latest observed endpoint. The existing five-minute refresh owner
publishes updates to both the page and open details; failed rereads retain the
last good result and expose a retryable error.

The installed app is the local collection and lifecycle owner. Its private loopback dashboard is the canonical personal-reporting surface. A hosted site is for acquisition, downloads, documentation, and public aggregates; it does not receive permission to read Codex files and is not a substitute for the personal dashboard.

The desktop app is local-only. Community sharing, contribution upload, performance sharing, and hosted sign-in were removed on 2026-10-13; see the [removal decision](../../docs/decisions/2026-10-13-desktop-sharing-removal.md). Local analysis works offline.

## Local API

The complete route-by-route inventory lives in the maintained
[Rhetrion API surface reference](../../docs/reference/api-surface.md).
It covers all local companion paths, fixed report routes, and the credential-free central relay. A source-parity
test fails if an exact route allowlist changes without the reference changing
with it.

Local mutations require the exact same origin and
`X-Usage-Monitor-Local: 1`; handlers with bodies additionally enforce closed
JSON contracts. Detailed reports and browser assets use fixed allowlists.
Every API response is `no-store`, and no CORS permission is emitted. Use the canonical reference rather than a partial route list here.

## Development identity override

Production preparation uses the
`app-usagemonitor.export-identity.v1` item in Windows Credential Manager. It never
falls back to a file when Credential Manager access fails.

For an isolated development journey only, the launcher accepts an explicit
owner-only identity file when both fixed settings are present. Create a
temporary `0700` directory and a `0600` identity through the existing
identity core; the command never prints the secret:

```bash
development_identity_dir="$(mktemp -d "${TMPDIR:-/tmp}/usage-monitor-identity.XXXXXX")"
chmod 700 "$development_identity_dir"
development_identity_file="$development_identity_dir/export-identity"

node --input-type=module -e '
  const { loadOrCreateParticipantSecret } =
    await import("./src/export-identity.js");
  await loadOrCreateParticipantSecret({
    environmentSecret: null,
    secretFile: process.argv[1],
    legacySecretFile: null
  });
' "$development_identity_file"

USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY=1 \
USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE="$development_identity_file" \
USAGE_MONITOR_PORT=8791 \
node ./apps/local/server.js
```

The launcher rejects a relative path, symlink, non-regular file, file not owned
by the current user, any permission state that is not private to that user, a missing opt-in, or a
simultaneous `APP_USAGEMONITOR_EXPORT_SECRET`. It validates this before
listening. Browser responses expose only
`development_file_override`, never the path or credential. The override is not
an automatic recovery mechanism and does not establish production Credential Manager
acceptance. Keep the terminal open while testing; remove the specific temporary
directory later only if losing that development identity's continuity is
intentional.

## Test

```bash
npm run product:local:test
```

Run the disposable Worker/D1/R2 acceptance laboratory separately with:

```bash
npm run product:backend:acceptance
```

The lab creates dedicated synthetic owner fixtures and isolated envelope keys,
and supplies its smoke child with `--owner-access-file` automatically. It does
not require `.dev.vars` or make ordinary participants admins. Direct smoke/load
commands have a separate required owner-file preflight; see the
local HTTP procedure (retired; retained in Git history).

Use `npm run product:backend:lab` instead when you want the verified state and
portal to remain available for inspection. That command now starts this local
companion on `http://127.0.0.1:8791/` and the backend Worker on
`http://127.0.0.1:8792/` together. Open 8791; 8792 is backend-only.
The companion still defaults to the real Codex home and production credential
backend: isolated Worker storage does not isolate local sources or Credential Manager.
For backend-only inspection use `npm run product:backend:only`. A no-real-account
browser fixture must separately isolate sources, state, credentials, refresh,
and outbound requests. The standard lab is invite-only and the browser does
not collect invitation codes. Use an already established session for inspection
or a separately configured local-open fixture for fresh browser enrollment.
