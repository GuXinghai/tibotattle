---
title: API and Integration Surface
date: 2026-08-27
type: reference
status: maintained
last_verified_commit: 52399658
---

# API and integration surface

This is the maintained inventory of TiboTattle's callable boundaries. Route
method and authority metadata is checked against source by
`test/api-surface-reference.test.js`; descriptions explain the trust and
storage effects that the registry alone cannot express.

This document is an implementation reference, not permission to deploy, call
protected production endpoints, or use private data. Production writes,
migrations, update-feed publication, and admin operations remain owner-authorized
actions.

## Authority vocabulary

| Authority | Meaning |
| --- | --- |
| Public | No participant credential; bounded admission and publication controls can still apply. |
| Enrollment | Same-origin enrollment plus the configured identity or invitation proof. |
| Accountless enrollment | Native installation enrollment proof with a bounded device-hash body and no ambient participant/session authority. |
| Accountless ownership | Device-secret proof against an active versioned installation enrollment; no session, social identity or pairing. |
| Handoff | Short-lived, state-bound hosted identity handoff; provider callbacks terminate at the Worker. |
| Session | Secure, HTTP-only participant session cookie and CSRF on mutations. |
| Device | Rotating device bearer stored by the native app in the platform credential store. |
| Upload | One-use upload authorization bound to a session or device. |
| Pairing code | Short-lived claim code created by an authenticated participant session. |
| Admin | Cloudflare Access assertion, configured owner identity, and revision/CSRF controls where applicable. |
| Operator | Separate owner-held release credential; never exposed to the public app. |
| Loopback read | Loopback peer, exact Host header, fixed path, and no arbitrary proxying. |
| Loopback mutation | Loopback read controls plus same-origin and route-specific token/review checks. |

## Hosted Worker route inventory

The source authority is `apps/worker/src/route-registry.ts`; the handlers in
`apps/worker/src/index.ts` enforce the declared methods and credentials. The
Worker rejects unknown `/api/` paths instead of falling through to the static
site.

| Method | Path | Caller | Authority | Storage or network effect | Owner |
| --- | --- | --- | --- | --- | --- |
| all | `/.well-known/apple-developer-domain-association.txt` | Legacy crawler | None | Always returns 404 so the SPA cannot masquerade as configuration. | Worker |
| `GET` | `/api/health` | App and operator probes | Public | Reads D1, deletion ledger, R2, controls and contract configuration; ingress-budget probing persists its lease housekeeping. A source-bound temporary migration fence serves storage-free liveness with `storageQualified: false`. | Worker operations |
| `GET` | `/api/ready` | Deployment probes | Public | Reads lifecycle, retention, reconciliation, and rebuild readiness; no mutation. | Worker operations |
| `POST` | `/api/v1/enroll` | Website or loopback relay | Enrollment | Validates identity/consent, creates or reattaches a D1 participant, and may bootstrap a device pairing. | Identity and contribution |
| `POST` | `/api/v1/accountless/enrollment` | Native installation | Accountless enrollment | When the separately configured accountless enrollment gate is enabled, atomically records one versioned enrollment-only ledger row keyed by device ID and a 256-bit device-secret hash. It creates no participant, session, pairing, device credential, upload authority, identity link, or community eligibility. | Accountless enrollment pilot |
| `POST` | `/api/v1/accountless/ownership` | Native installation | Accountless ownership | With accountless ownership enabled, proves the enrolled device secret and atomically creates one installation owner, credential and versioned v1.1 upload authorization, or returns the same existing receipt. Rejects ambient sessions and revoked/expired enrollment; creates no social consent or public-fit eligibility. | Accountless contribution |
| `POST` | `/api/v1/accountless/renewal` | Native installation | Accountless ownership | Proves the same installation secret and renews only its active, policy-matched owner graph near or after lease expiry. Preserves identity and upload receipts; rejects revoked, erased or inconsistent state. | Accountless contribution |
| `POST` | `/api/v1/identity/google/start` | Website or loopback relay | Handoff | Creates a short-lived D1 handoff and returns the Google authorization URL. | Hosted identity |
| `GET` | `/api/v1/identity/google/callback` | Google | Handoff | Exchanges the provider code, verifies identity, and completes the bounded D1 handoff. | Hosted identity |
| `POST` | `/api/v1/identity/google/result` | Initiating client | Handoff | Reads/delivers the state-and-verifier-bound result; proof is later consumed by enrollment. | Hosted identity |
| `POST` | `/api/v1/identity/apple/start` | Website or loopback relay | Handoff | Creates a nonce-bound D1 handoff and returns the Apple authorization URL. | Hosted identity |
| `POST` | `/api/v1/identity/apple/callback` | Apple form post | Handoff | Exchanges and verifies the provider response, then completes the bounded D1 handoff. | Hosted identity |
| `POST` | `/api/v1/identity/apple/result` | Initiating client | Handoff | Reads/delivers the state-and-verifier-bound result. | Hosted identity |
| `GET` | `/api/v1/session` | Website or loopback relay | Session | Reads the current participant session and CSRF projection. | Participant account |
| `POST` | `/api/v1/logout` | Website or loopback relay | Session | Revokes/clears the current web session. | Participant account |
| `GET` | `/api/v1/admin/overview` | Admin application | Admin | Reads bounded operational, distribution, lifecycle, sampled error evidence, and optional failure-isolated reconstruction progress. Refresh never advances calculation. | Operations |
| `GET` | `/api/v1/admin/metrics/history` | Admin application | Admin | Reads bounded operational history. | Operations |
| `GET` | `/api/v1/admin/database-health` | Admin application | Admin | Checks each API-bound D1 role with one constant read; partial failures, latency and size metadata only. | Operations |
| `GET` | `/api/v1/admin/reconstruction-progress` | Admin application | Admin | Reads bounded refresh-generation and historical-completion metadata; never advances calculation. | Operations |
| `GET` | `/api/v1/admin/community/allowance-preview` | Admin application | Admin | Reads unpublished allowance-fit previews; does not publish. | Operations |
| `POST` | `/api/v1/admin/action` | Owner/admin application | Admin | Collection controls, maintenance, and distribution actions; explicit participant erasure uses the existing maintenance action with auditable D1/R2 effects. | Operations |
| `POST` | `/api/v1/me/security-reset` | Participant browser | Session | Rotates session/recovery state and invalidates affected credentials. | Participant account |
| `POST` | `/api/v1/me/device-pairings` | Participant browser | Session | Creates a bounded device-pairing claim in D1. | Device lifecycle |
| `POST` | `/api/v1/device-pairings/claim` | Native app | Pairing code | Claims the pairing and returns the device credential once. | Device lifecycle |
| `POST` | `/api/v1/device/upload-authorizations` | Native app | Device | Creates a one-use upload authorization for a paired device. | Contribution |
| `POST` | `/api/v1/device/disconnect` | Native app | Device | Revokes the current device and stops its hosted upload authority. | Device lifecycle |
| `POST` | `/api/v1/device/credential/renew` | Native app | Device | Rotates the same device credential without creating a new device slot. | Device lifecycle |
| `GET` | `/api/v1/device/sync/state` | Native app | Device | Reads the device's v1 incremental cursor/admission state. | Contribution sync |
| `GET` | `/api/v1/device/sync/manifest` | Native app | Device | Reads a bounded date-range manifest of accepted incremental chunks. | Contribution sync |
| `GET` | `/api/v1/device/sync-capabilities` | Native app | Device | Reads accepted formats, exact v1.1 grant, write floor/revision and authenticated enrollment/destination binding; never creates consent. | Contribution sync |
| `GET` | `/api/v1/device/sync-capabilities-v1.2` | Contribution client | Device | Read independent successor lifecycle, exact consent and server-issued activation instant; never grant authority. | Contribution telemetry |
| `POST` | `/api/v1/me/device-telemetry-v12-consents` | Contribution client | Session | Grant the exact v1.2 contract for one reviewed device. | Contribution telemetry |
| `GET`, `POST` | `/api/v1/device/telemetry/v1.2/day-manifests` | Contribution client | Device | Read or register bounded immutable successor manifests and staged chunk receipts. | Contribution telemetry |
| `POST` | `/api/v1/me/telemetry-v12/domain-predecessor` | Contribution client | Device | Pin a complete mixed-client predecessor for successor activation. | Contribution telemetry |
| `POST` | `/api/v1/me/telemetry-v12/domain-activate` | Contribution client | Device | Activate a complete proven successor domain under the pinned predecessor. | Contribution telemetry |
| `POST` | `/api/v1/accountless/telemetry-v1.2-authorization` | Contribution client | Device | Record the independent accountless successor policy for the current enrollment and device. | Contribution telemetry |
| `POST` | `/api/v1/accountless/telemetry-performance-authorization` | Contribution client | Device | Record the independent accountless performance policy for the current enrollment and device. | Contribution telemetry |
| `GET` | `/api/v1/device/telemetry/performance/capabilities` | Contribution client | Device | Read the separate daily-performance capability and authorization. | Contribution telemetry |
| `POST` | `/api/v1/me/device-telemetry-performance-consents` | Contribution client | Session | Grant separate performance consent to a reviewed device. | Contribution telemetry |
| `GET`, `POST` | `/api/v1/device/telemetry/performance/reports` | Contribution client | Device | Read bounded report revisions or admit an encrypted daily histogram report; preserve ordinary replay and replacement semantics. | Contribution telemetry |
| `POST` | `/api/v1/me/device-telemetry-consents` | Participant browser | Session | Records explicit current v1.1 consent for the selected device and raises the persisted participant write floor. | Contribution consent |
| `GET`, `POST` | `/api/v1/device/telemetry/v1.1/day-manifests` | Native app | Device | Reads a bounded date-range candidate inventory, or registers/replays one immutable day manifest and reports exact staged chunks; no analytical activation. | Contribution sync |
| `POST` | `/api/v1/me/telemetry-v11/domain-predecessor` | Native app | Device | Issues a bounded source-pinned bootstrap/successor token, with null predecessor for first cutover. | Contribution sync |
| `POST` | `/api/v1/me/telemetry-v11/domain-activate` | Native app | Device | Proves complete predecessor coverage and atomically switches the whole analytical domain; incomplete transfers remain staged. | Contribution sync |
| `GET` | `/api/v1/me/devices` | Participant browser | Session | Lists participant device projections without credentials. | Device lifecycle |
| `POST` | `/api/v1/me/devices/revoke` | Participant browser | Session | Revokes a selected device. | Device lifecycle |
| `GET` | `/api/v1/envelope-key` | Native or web client | Public | Returns the public wrapping key; never returns private key material. | Contribution crypto |
| `POST` | `/api/v1/contributions` | Prepared uploader | Upload | Validates and deduplicates an encrypted contribution, writes D1 state and quarantined R2 object data, and schedules aggregation. | Contribution ingestion |
| `GET` | `/api/v1/me/export` | Participant browser | Session | Returns a bounded export of the participant's hosted data. | Participant data |
| `GET` | `/api/v1/community/daily` | Website | Public | Reads a bounded published daily range; omits unavailable allowance evidence and stale or invalid optional API-equivalent spend. | Community publication |

Production admin API and UI paths are served only on the configured admin host.
Public-host requests to those paths are deliberately 404. Static site assets
are not part of the API registry.

### Public allowance breakdowns

`GET /api/v1/community/daily` may add `allowanceBreakdowns` with schema
`community-allowance-breakdowns-v1.2`. Its only fields are schema version,
aggregate basis, reference plan, normalization, model basis/gate, generation
timestamp and up to 70 date rows. Each row contains the day, the combined
summary, the four configured
personal-plan summaries and reviewed model tuples `[modelId, usd, accountCount]`.
Combined and plan summaries contain only median dollars, account/fit counts and an optional
middle-80%-of-fits band. Model estimates have no band or reset-fit count.

The underlying combined and model estimates use a Pro 10x-equivalent weekly
basis: Pro ×1, Pro 5x ×2, Pro Max 25x ×0.4, Plus ×10. The public By
plan chart displays each plan's own week on its own scale by dividing the
reference estimate by that plan's factor; each card also shows the reference
estimate. The Pro Max 25x factor assumes a common Plus baseline and is pending
provider confirmation. Unknown plans and separate-track Spark estimates are
excluded. Model values require the existing composition identification gate;
historical values are never carried backward from today's fit.

The raw `pro` identity and retained evidence continue through the Pro 10x
rename; only the configured cross-plan ratios change. Derived allowance and
model publications use a new normalization identity, so they are rebuilt from
retained fits instead of relabeling an old serialized estimate. Public v1.0/v1.1
read compatibility preserves the original Pro 20x basis and coefficients;
v1.2 publishes the four-plan Pro 10x basis. Frozen local `pro-20x` and
`pro-10x-promo` variant identifiers retain their original meanings.

The daily range/state and cached preview are read in one two-statement
transaction. The optional cache is limited to 256 KiB, must match the current
method and fall between the last hard-invalidation epoch and current input
epoch, and is projected into a new closed
object. Only requested, actually published days before both the current and
generation UTC dates are included. A validated v1 append or same-device chunk
correction preserves the published graph while changed accounts and affected
days are processed. Corrections require a one-use capability created and consumed
inside the same accepted-upload transaction. Source-device changes, withdrawal,
policy changes and unknown mutations hard-invalidate it. Missing/invalidated/invalid
cache or an unavailable optional cache schema omits the breakdown, preserving
the independent daily activity response. No public request invokes analysis,
writes state, accepts cohort filters or exposes the private admin response.

All three graph views use the same published snapshot; immutable daily rows
are not rewritten or relabelled to achieve this. Generation/evidence dates are
preserved, with no additional "last good" label or age-only expiration. New
publications use complete cached inputs from one immutable captured generation,
with its hard authorization epoch checked at promotion. Ordinary uploads queue
the next generation without requiring a quiet interval across every account;
capture start is not presented as a latest-live source revision. Daily
activity/spend retains separate exact source guards.
The browser continues to understand v1.0 breakdowns, refreshes visible pages
once a minute with non-overlapping, timed requests, and backs off on failures.
Transient failures preserve the displayed result; authoritative invalidation or
publication-disabled responses clear it. No hidden-tab polling or client-side
analytical reconstruction occurs. Refresh preserves the open daily disclosure,
selected legend and keyboard inspection position without retaining old values.
The owner page likewise keeps its graph through classified network/storage
failures, but clears it for access/policy refusals, invalid payloads or an
authoritative unavailable-cache response.

The additive `allowanceReadState` distinguishes `confirmed` from
`temporarily_unavailable`. An optional storage-read failure keeps independent
daily activity available, uses `no-store`, and does not clear an already displayed
graph. It is not permission to retain a graph after a confirmed invalidation.

The owner-only `GET /api/v1/admin/reconstruction-progress` returns the closed
metadata contract (`schemaVersion: 1`): requested, prepared and
published generations; current phase/trigger; and resolved/required historical
days. The exact optional query `detail=preparation` negotiates schema version 2
with retained source-day counts, saved preparation steps and prepared quota/usage
counts. With migration 0056 its single metadata query reads one maintained
aggregate row, independent of contributor/day count. Missing schema, inexact,
unsafe or unavailable counts return null, not an invented total. These are
retained reusable inputs, not a remaining-work denominator. All other query
fields and repeated selectors are rejected. Both versions are read-only and
return no account IDs or raw evidence. The owner UI uses independent,
non-overlapping reads with a 15-second timeout; automatic polling respects the
existing user-selected cadence and pauses while hidden/offline. A slow graph
read cannot conceal progress. Access loss clears private state.

The owner explicitly approved dollar estimates and sample counts even when
based on one account. This can reveal that contributor's estimated capacity;
omitting identifiers is not an anonymity guarantee. The visible small-sample
disclosure applies to all three views. Older sealed weekly snapshot thresholds
are unchanged; contribution consent and v1.1 activation are unchanged.

### Self-service retirement and private owner erasure

Under the [2026-08-30 source decision](../decisions/2026-08-30-self-service-deletion-retirement.md),
`DELETE /api/v1/me` is not a registered route: it returns the existing unknown
API `404 NOT_FOUND` without D1 access or participant mutation.
`POST /api/v1/me/contributions/delete` remains retired. Health reports
`participantDeletion: false` and retains `deletionSafeRestoreReplay: true`;
neither field is deployment or erasure-completion evidence.

Private erasure uses the existing `POST /api/v1/admin/action` and
`action: "run_maintenance"`, with the closed `participantErasure` object:
`participantId` is the exact opaque `participant:<UUID>` string, and
`confirmation` is `"erase_hosted_participant"`. It requires the configured
admin host, Access-pinned owner identity, exact-origin CSRF, and
`x-usage-monitor-admin: 1`. Without `participantErasure`, ordinary maintenance
must not initiate participant erasure. No new route, action enum, or migration
is introduced.

Success has `schemaVersion: "admin-action-v0.1"`, `action: "run_maintenance"`,
and `result` containing `task: "participant_erasure"`, `operationId` (UUID),
`deleted: true`, `alreadyDeleted`, and `contributionsDeleted`:

| Completion evidence | `alreadyDeleted` | `contributionsDeleted` |
| --- | --- | --- |
| The operation completed participant erasure | `false` | Number of contributions removed |
| Participant absent and an unexpired independent tombstone proves prior erasure | `true` | `null` (historical count unknown, not zero) |

Absence without an unexpired tombstone returns `404 NOT_FOUND`, not success.
An interrupted `deleting` participant with a non-null deletion fence can resume
through the owner boundary without its former web session. A fresh started
owner attempt returns `409 PARTICIPANT_DELETING`; wait/recheck rather than
erase concurrently. Owner takeover is limited to a non-null legacy fence
without a matching audit, a failed attempt, or a started attempt older than
five minutes. The new audited operation
UUID fences final removal against stale attempts. A null `deletion_session_id`
on a deleting participant belongs to restore replay: owner erasure returns the
same busy response while maintenance finishes or retries that restore. Cron
does not resume non-null owner/legacy deletions. Audit action remains
`run_maintenance`; its details identify `task: "participant_erasure"`, a
purpose-separated participant digest, and bounded outcome/code/count, never
raw identifiers. The
[production owner procedure](../runbooks/production-operations.md#private-owner-participant-erasure)
defines the exact audit domain and preserved pipeline/restore requirements.

## Local route inventory

The local companion binds to loopback and checks the peer address and exact
Host header. Unknown API paths are 404. Mutations also require a same-origin
request and their route-specific authorization. The companion relays no
requests to the hosted Worker.

| Method | Path | Caller | Authority | Storage or network effect | Owner |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/local/health` | Dashboard/native shell | Loopback read | Reports companion/snapshot readiness and enabled local capabilities. | Local companion |
| `GET` | `/api/local/desktop-status` | Electron shell | Loopback read | Projects closed lifecycle, schema-v2 current display lanes with observation/reset times from bounded published-overview metadata, and receipt-only strict v2 notification evidence. Optional `notificationEvidenceStatus: "expired"` distinguishes an unchanged receipt that aged out after fresh completion from a new ineligible observation; it authorizes no alert. No account identifiers or filesystem paths. Available before the first snapshot. | Local companion |
| `POST` | `/api/local/diagnostics/note` | Native shell | Loopback mutation | Records a bounded, fixed-vocabulary diagnostic reference; no prompt or path content. | Diagnostics |
| `GET` | `/api/local/onboarding` | Dashboard | Loopback read | Projects source readiness without exposing filesystem paths. | Local companion |
| `GET` | `/api/local/overview` | Dashboard | Loopback read | Reads the current derived overview snapshot. | Local companion |
| `GET` | `/api/local/cache-drop-thread-links` | Local dashboard only | Same-origin custom-header read | Ephemeral, generation-bound names and Codex thread IDs for recent cache-drop rows; no query parameters, persistence, or export. | Local companion |
| `POST` | `/api/local/work-usage/query` | Local dashboard only | Same-origin custom-header read; closed 4 KiB JSON | Cancellable, read-only project/worktree/thread reports over a pinned index; optional canonical ISO `endAt` pins the selected period and rejects older snapshot substitution; bounded process-local snapshots with closed `touch` lease renewal, per-thread model/component breakdowns and transient display metadata; optional `search` (at most 100 characters) finds project/task names before pagination with totals and share denominators covering every matching row before pagination; optional `sourceSnapshotId` anchors related period/scope queries to an available report and its canonical generation; no export. During revalidation an available saved reply has `retained`, `refreshing`, `namesAvailable` and a separate `refreshSnapshotId`; saved figures retain their original bounds and have no paging cursor. Names survive document reload only in process memory; durable snapshots contain anonymous usage figures. | Local reporting |
| `GET` | `/api/local/model-performance` | Model performance page | Loopback read | Requires one `period` value: `1`, `7`, `30`, or `all`; optional canonical ISO `endAt` pins exact rolling bounds (never a future instant); optional `speedMode=standard|fast|ultrafast` (default `standard`) filters before aggregation; returns schema-5/method-5 bounded local timing aggregates, with the selected `speedMode` and period-scoped `excludedUnknownTurns`, including tool-free fallback estimates in Output speed with one sample per turn, restores validated saved measurements before starting work, and renews an independent background scan lease. Optional `X-TiboTattle-Performance-Diagnostics` carries at most fourteen unique allowlisted codes within 512 bytes for timing worker/scan/store/projection, unavailable historical source, compressed source read/decode/resource/unsupported/recovery, or snapshot read/validation/source-mismatch/write failures, separately from the unchanged measurement body and durable snapshot. No accounting or network effect. | Local timing |
| `GET` | `/api/local/gradient` | Dashboard | Loopback read | Reads the derived cost/quota gradient. | Local analysis |
| `GET` | `/api/local/weekly` | Dashboard | Loopback read | Reads derived weekly capacity and pace evidence. | Local analysis |
| `GET` | `/api/local/weekly-pace-outlook` | Native shell | Loopback read | Reads the bounded account-scoped weekly pace presentation projection. The closed outlook v0.1 and live forecast v0.2 distinguish observed `exhausted` from unavailable evidence, using zero remaining allowance and null extrapolated ETA; unavailable forecasts retain their canonical empty shape. | Local analysis |
| `GET` | `/api/local/quality` | Dashboard | Loopback read | Reads monitoring-quality evidence. | Local analysis |
| `GET` | `/api/local/timeline/window-breakdown` | Dashboard | Loopback read | Reads a bounded `from`/`to` timeline window. | Local analysis |
| `GET`, `POST` | `/api/local/refresh` | Dashboard/native shell | Loopback mutation | GET reads refresh state, closed `mode` (`null`, `quick`, `detailed`, `overview`) and actual `startedAt`; POST explicitly advances retained history and recalculates generation-bound detailed accounting before full publication. A 409 returns the in-flight receipt. | Refresh controller |
| `POST` | `/api/local/refresh/quick` | Dashboard/native shell | Loopback mutation | Refreshes current quota/headline evidence without advancing the unified index or rebuilding detailed accounting; the last authoritative detailed projection remains available with current freshness truth fields. | Refresh controller |
| `POST` | `/api/local/refresh/overview` | Dashboard/companion scheduler | Loopback mutation | Joins or starts one quota, incremental usage/work and overview publication pass using the existing bounded index deadline (ordinary incremental or cold index); an actual accounting rebuild may extend the total deadline once. Completion resets the sole five-minute overview timer. | Refresh controller |
| `POST` | `/api/local/refresh/cancel` | Dashboard/native shell | Loopback mutation | Requests cancellation; published prior state remains intact. | Refresh controller |

The overview includes `accounting.trayCacheSummary` (schema version 1): exactly
one `7d` and one `30d` entry with availability, comparable follow-up count,
follow-ups reusing more than half, reuse percentage and coverage status. It is a
bounded projection of the existing cache-continuity calculation. A zero
comparable count has a null percentage; unavailable evidence has null counts.
Consumers retain the parent accounting scope and freshness. This adds no
collection, transcript access or independent retention authority.

The development source exposes **Model performance** at `#performance` in the
web and native navigation. Its timing route remains usable without a completed
accounting snapshot and returns explicit loading, unavailable, or stale state.
The diagnostic population covers this device's selected Codex sources across
accounts; it is not an account-scoped billing measure.

## Fixed report pages

These are GET-only, fixed-path HTML resources. They resolve only to files under
the configured local resource root and have a stricter report CSP.

| Method | Path | File family |
| --- | --- | --- |
| `GET` | `/reports/gradient` | Cost-versus-quota gradient |
| `GET` | `/reports/weekly` | Seven-day calibration |
| `GET` | `/reports/quality` | Monitoring quality |
| `GET` | `/reports/multi-surface` | Multi-surface account usage |

Live work-usage thread rows may include `unlinkedAutoReview: true`.
Their existing `contributions` array partitions the same filtered cells into
`primary`, `subworkers` and `autoReviews`; these are disjoint components of the
thread total, not additional charges. Verified review ancestry is used before
ranking and pagination. Review relationships and classification remain local
and process-only; no index or saved-report schema changes are required.

## Native bridge

The embedded dashboard view admits only the current loopback companion and `about:`.

| Direction | Name | Payload boundary |
| --- | --- | --- |
| Web to native | `tibotattleLocalization` | Closed language-preference enum. |
| Native to web | `tibotattle:local-evidence-updated` | Payload-free refresh-complete event. |
| Native to web | `tibotattle:locale-override` | Closed language preference plus locale table metadata. |
| Native to web | `tibotattle:appearance-override` | Closed appearance preference and resolved theme. |

The sandboxed Electron preload exposes the same fixed `v1` bridge version and
one fixed IPC channel. Its refresh subset is dashboard-frame-only:

| Direction | Action | Payload boundary |
| --- | --- | --- |
| Renderer to main | `getRefreshStatus` | No arguments; returns the content-free timer/watchdog projection without a lease value. |
| Renderer to main | `refreshStarted` | Exact `{ mode }`, where mode is `quick` or `detailed`; returns one positive integer lease. |
| Renderer to main | `refreshHeartbeat` | Exact `{ lease }` with one positive safe integer; renews only the matching missing-heartbeat watchdog. |
| Renderer to main | `refreshSettled` | Exact `{ lease }` with one positive safe integer; matching terminal settlement is idempotent. |

### Application menu bridge

The trusted dashboard top frame can call `getApplicationMenu()` for the five
localized menu IDs and labels plus the native `fullscreen` boolean, and `openApplicationMenu({ menu, x, y })` to open
the existing native submenu. IDs are limited to `file`, `edit`, `view`, `window`
and `help`; coordinates must be integers from 0 through 16384 and are clamped
to the live window content bounds. Unknown keys, remote pages, asset pages and
subframes are rejected by the existing fixed-channel authorization boundary.
No renderer-supplied menu items or commands are accepted. The titlebar retains
native Windows caption controls and draggable regions.
The closed main-to-renderer command `{ command: "windowFullscreen", fullscreen }`
updates titlebar visibility on native fullscreen transitions; only a boolean is
accepted and no renderer capability is added by this presentation event.

### Local window background bridge

The existing Electron `v1` channel adds four closed actions. `getWindowBackground`
accepts no arguments and returns `{ status, background: { color, mask, imageUrl } }`
only to the authorized dashboard top frame. `imageUrl` is null or an opaque
local PNG/JPEG/WebP resource URL, never a filesystem path or remote URL. It is not
part of generic settings diagnostics or any HTTP report.
`setWindowBackground` accepts exactly `{ value: { color, mask, removeImage } }`:
color is null or uppercase six-digit HEX, mask an integer from 0 to 90, and
removeImage boolean. `chooseWindowBackground` and `restoreWindowBackground`
accept no arguments. All three mutations are Settings-frame-only; the native
picker exclusively owns file selection. The payload-free `windowBackground`
desktop command invalidates the shared main renderer's presentation after a durable change.
No new IPC channel or arbitrary filesystem capability is exposed.

## Process and provider protocols

| Boundary | Caller | Contract |
| --- | --- | --- |
| Codex plugin MCP | Codex host | Bounded newline-delimited JSON-RPC over local stdio exposes six closed tools. Analysis/status are read-only; install planning and confirmed installation are separate tools. |
| Installed Electron agent protocol v1 | TiboTattle plugin | Runs the packaged companion through Electron's retained Node mode with four closed commands and one bounded JSON result. No arbitrary path, SQL, command, refresh, setting or upload input. |
| Codex app-server | Local collector | Spawns the local `codex app-server` binary and uses bounded JSON-RPC for account, rate-limit, and usage evidence. No provider credential is copied into documentation or telemetry. |
| Claude status line | Explicit standalone callback hook to local broker | Bounded JSON input through the managed callback/socket boundary; content-free status projection only. It is not an installed-app API. |
| Model performance worker | Local controller leased by page reads or separately authorized daily-report requests | Independent, bounded Codex timing scan, local snapshots and content-free performance histograms; no accounting input. Completes its requested history pass, then stops after the 60-second idle lease. |
| R7 benchmark worker | Protected release-evidence generator | Bounded JSON request on stdin and one stable JSON result on stdout. It is not a routine documentation gate and may read private local corpus evidence. |
| Local companion ready line | Native launcher | One `USAGE_MONITOR_READY` line containing the loopback URL after bind; stdout is not a general API. |

## Package and contract boundaries

Runtime-neutral package APIs are exported only through each package root:

- `@app-usagemonitor/accounting`
- `@app-usagemonitor/i18n`
- `@app-usagemonitor/identity-core`
- `@app-usagemonitor/quota-analysis`
- `@app-usagemonitor/telemetry-contract`

Closed JSON Schema contracts live under `schemas/`; telemetry v0.2 mirrors are
generated from `packages/telemetry-contract/schemas/v0.2/`. Canonical/mirror
ownership and compatibility rules are documented in
[`schema-contracts.md`](./schema-contracts.md). Storage-version recovery is
documented separately in [`unified-index-schema.md`](./local-index-schema.md)
and [`../runbooks/local-index-recovery.md`](../runbooks/local-index-recovery.md).

## Local weekly API intervals

The existing overview report carries optional `timeline.weeklyApiIntervals`,
version `weekly-api-interval-v1`; no new HTTP route or database field is added.
The closed bounded object contains status/reason, canonical result time, source
generation/fingerprint and at most 100,000 content-free rows (8 MiB projection
limit). Each row retains exact interval bounds, plan, continuity segment, quota
percentage points, decimal API-priced amount, inferred full-week value, controlled
unavailability reason, usage/unknown-speed/excluded-review counts, optional known
excluded-review amount, and price-card IDs. Unknown amounts are not zero-filled.

Its numerator uses the existing speed-specific API pricer, not subscription quota
multipliers. Unknown speed is explicitly the Standard scenario. Free automatic
approval reviews are excluded after the owner-recorded 2026-10-07 announcement;
unknown review origin remains unavailable for conversion. Physical source/session
identifiers, metadata, paths and session content never enter the projection.
Interval event membership is `(start,end]`; displayed steps occupy `[start,end)`.
Plateaus and stale lower readings retain their original cycle anchor until a new
high-water observation or an independently classified reset. Reset/plan conflicts
never yield a capacity. Old caches without this additive projection remain readable;
the next ordinary accounting publication computes it from the index, not a full
raw-log rescan. Failed computations retain an explicit closed reason.

The browser validates the extension and its source fence independently. Gaussian
smoothing is a time-integrated, normalized presentation transform within a
continuous segment, never a new accounting or observation field. It uses the full
segment before display clipping and eight-sigma numerical support. CDF differences
are integrated directly with eight-point Gauss-Legendre panels of at most half
a sigma, avoiding cancellation for millisecond intervals; independent Simpson
integration checks the numerical result. Preferences and rendered
sampling do not change report data. Snapshot validation rejects malformed, foreign
generation or future interval projections; absence remains a compatible older
snapshot, not fabricated intervals.

## Compatibility and retirement

- Compatibility aliases are explicit registry entries, not wildcard routes.
- Retire a route's callers, registry entry, handler, and active promises
  together; retain negative tests proving refusal without side effects.
  Migrations, retained-data obligations, erasure/restore safeguards, and
  historical evidence do not disappear with an HTTP route. Their removal
  requires a separate reviewed and authorized lifecycle decision.
- A deprecated route remains documented until the shipping compatibility window
  ends. An obsolete document is deleted once it no longer describes a retained
  contract or supplies enduring audit/recovery evidence.

## Integrated desktop settings contracts

The main dashboard top frame at the exact companion root owns Settings. All
settings entry points route to `#settings/<category>`; hashes select UI, not
authorization. Same-origin assets, remote pages, stale frames and subframes
cannot invoke protected settings actions. Closed preload actions remain validated.
`setNotificationPreferences` accepts only `{ threshold }` with an integer 1–100
or -1. `setRefreshInterval` accepts `{ seconds }`, either -1 or positive safe
whole minutes converted to seconds. Settings v4 and notification-policy v2 migrate
older saved preferences forward; reset-delivery helpers remain deprecated and
disconnected from production candidates.

The companion receives the interval through the reviewed initial environment
`USAGE_MONITOR_REFRESH_INTERVAL_SECONDS` and the closed process IPC message
`{ type: "tibotattle.refresh-interval.v1", seconds }`. No new HTTP mutation route
is introduced. Watchdogs and manual refresh keep their existing contracts.

Background responses contain `imageUrl` instead of image bytes. The fixed
`tibotattle-background://image/<opaque-id>` scheme serves only the current
imported image with GET/HEAD, verifies protected chunks, and streams original
bytes. The session permits image requests only from the registered trusted main
top frame at the companion root; navigation and other request kinds remain denied.
The browser CSP permits this image scheme without changing the no-referrer policy.
Background metadata v2 migrates v1 in place; unknown future versions fail closed.
