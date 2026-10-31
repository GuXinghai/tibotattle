---
title: Source-backed API surface reference
date: 2026-08-26
type: reference
status: maintained
---

# Source-backed API surface reference

Updated for the independent local product on 2026-10-23. This describes source
contracts, not permission to access private data or evidence of an installed
release. There is no hosted Worker, public site, remote relay or cloud runtime.

## Surface ledger

| Surface | Owner | Callable boundary | Authority |
| --- | --- | --- | --- |
| Local companion API | Browser/native shell → loopback Node companion | 18 paths, 19 method/path operations |

## Report failure diagnostics

`POST /api/local/diagnostics/note` still requires the local header, same-origin
checks and the four existing fields (`reference`, `surface`, `code`, `requestId`).
For the closed `work_usage_*` failure vocabulary on `local_refresh`, it also
accepts an optional, closed `workUsage` object. Its seven required fields are:

| Field | Accepted value |
| --- | --- |
| `schemaVersion` | `work-usage-request-diagnostic-v1` |
| `phase` | `query`, `lease`, `preload`, `nested`, `cancel` |
| `stage` | `request`, `response_body`, `validation`, `unknown` |
| `elapsedMs` | Integer 0–86,400,000, or `null` when a monotonic measurement is unavailable |
| `timeoutMs` | 10,000, 30,000, or `null` when no request timer is configured |
| `httpStatus` | Integer 100–599, or `null` before a response is available |
| `background` | Boolean |

The accepted codes are `work_usage_timeout`, `work_usage_invalid_response`,
`work_usage_expired`, `work_usage_unavailable`, `work_usage_permission`,
`work_usage_capacity` and `work_usage_network`. Unknown fields, values, surfaces
or code/context combinations are refused before logging. No query, search term,
project name, thread/snapshot ID, path, response body or raw error is included.
Measurements describe browser-observed request progress, not server execution
or a proven timeout cause. No successful-request stream is added.

The optional object is stored beside the same support reference in the bounded
local log. The outer `local-diagnostic-note-v0.1` log and response contracts,
rotation, authorization and rate limits are unchanged. Existing four-field
clients and existing log records remain valid; old records cannot acquire
missing measurements retroactively. An older server can reject the new object;
the UI then reports that the diagnostic was not recorded, without silently
retrying a stripped note or claiming a write receipt.

## Local route inventory

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/local/health` | Companion readiness, refresh state, schema versions, and configured capabilities |
| `GET` | `/api/local/events` | Same-origin, query-free server-sent lifecycle notifications for the startup snapshot, refresh and independent reports; available before snapshot readiness. Events are read hints, not report or refresh success receipts. |
| `GET` | `/api/local/desktop-status` | Closed lifecycle plus a current direct display allowance from bounded published-overview metadata; strict v2 notification evidence remains receipt-only. Optional `notificationEvidenceStatus: "expired"` identifies age-only expiry after fresh completion without authorizing an alert or clearing comparison baselines. Available before the first snapshot and without account identifiers or filesystem paths. |
| `POST` | `/api/local/diagnostics/note` | Record one bounded fixed-vocabulary local diagnostic note |
| `GET` | `/api/local/onboarding` | Local installation and evidence-source readiness |
| `GET` | `/api/local/overview` | Personal dashboard headline and evidence coverage |
| `GET` | `/api/local/cache-drop-thread-links` | Optional, generation-bound local thread-name/parent lookup for the two recent cache-drop tables; requires `X-Usage-Monitor-Local: 1` and no foreign Origin |
| `POST` | `/api/local/work-usage/query` | Read-only local project/worktree/thread reports; optional canonical ISO `endAt` pins the selected period and rejects older snapshot substitution; closed JSON, local header and Origin/Host checks; bounded cancellable snapshots with lightweight `touch` lease renewal, transient names and bounded project/task name search before pagination; retained read-only figures use a separate refresh job identity and durable anonymous snapshots |
| `GET` | `/api/local/model-performance` | Requires `X-Usage-Monitor-Local: 1` and an absent or same-origin `Origin` before any reader or worker call. Independent device-local Codex timing aggregates for `period=1`, `period=7`, `period=30`, or `period=all`, optionally pinned by `endAt`; restores validated saved measurements before background work; reads renew a 60-second background-worker lease; schema 4/method 5 combines response speed and tool-free fallback estimates, preferring response timing per turn, with a fallback count and unchanged TTFT |
| `GET` | `/api/local/gradient` | Quota-versus-cost gradient report data |
| `GET` | `/api/local/weekly` | Weekly calibration report data |
| `GET` | `/api/local/weekly-pace-outlook` | Privacy-safe weekly allowance pace projection bound to the current observed window |
| `GET` | `/api/local/quality` | Monitoring-quality report data |
| `GET` | `/api/local/timeline/window-breakdown` | Bounded indexed timeline breakdown for `from` and `to` epoch-millisecond bounds |
| `GET`, `POST` | `/api/local/refresh` | Inspect actual run/component state or request one bounded retained-history and detailed-accounting refresh; 202 starts, 200 joins or merges one pending follow-up |
| `POST` | `/api/local/refresh/quick` | Request quota-only refresh without advancing retained history or rebuilding accounting; returns the same actual-run and request-acceptance receipts |
| `POST` | `/api/local/refresh/overview` | Join, start or merge a bounded quota plus incremental usage/work publication pass; quota can publish before usage settles; reset the sole configurable companion cadence after settlement |
| `POST` | `/api/local/refresh/cancel` | Cooperatively cancel the active refresh |

The thread-link route has a closed `local-cache-drop-thread-links-v1` response:
`schemaVersion`, `status`, `generation`, and at most 160 `entries`. Each entry
has a content-free event-pair `key`, `kind` (`switch` or `continuity`), and a
`thread` with canonical `id`, nullable display `name`/`nickname`, and nullable
`parent` (`id`, nullable `name`). It only resolves rows from the current
attested overview; callers cannot supply IDs, source paths, or query parameters.
Names and raw IDs never enrich the persisted overview, reports, share cards,
diagnostics, or contributions. Missing or ambiguous metadata is optional
unavailability, not a refresh failure.

Refresh progress distinguishes source scanning from subsequent calculation.
Once unified ingestion returns and accounting begins, the count-free receipt
is exactly `{ "kind": "accounting", "status": "calculating" }`. It remains a
running-stage indication during accounting and full snapshot projection, not
an assertion of available accounting or refresh success. Clients must replace
the scan counter for that stage; only a terminal refresh receipt establishes
the outcome. Unknown progress kinds, extra fields, and arbitrary server prose
are not admitted by the native projection.

The switch- and cache-continuity impact projections distinguish whole-period
totals from the priced comparisons that remain usable when coverage is partial.
Their `coveredSubtotal` is either `null` or a closed object with
`scope: "covered_priced_drops"`, positive `pricedDrops`, a nonnegative
`standardApiPremiumUsd` and exact decimal `standardApiPremiumUsdExact`, plus
the existing `allowanceWeighting` shape scoped only to those priced drops.
It is derived from the complete exact accumulator, not the capped recent list,
and is available on period and breakdown projections. A missing price or
unprovable session order still withholds the whole-period money/allowance
claim. Clients must identify the subtotal's scope and must not substitute it
into `allowanceImpact` or hide excluded sessions. No priced observations means
`coveredSubtotal: null`, not a zero-valued placeholder.

Cache continuity also carries an optional `byModel` array on the selected
impact and each reporting period. Each reviewed model ID has the same aggregate
counts, gap/outcome buckets, pricing, coverage and bounded recent-detail shape.
Cohorts partition the complete comparable evidence, never the recent-detail
sample. Unattributable ordering gaps conservatively qualify every model total.
The breakdown is bounded to 128 models; missing, unsupported or inconsistent
breakdowns normalize to `null` while All models remains available. An empty
array means no eligible same-configuration models were found.

Startup blocked by required credential migration instead reports
`SECURE_STORAGE_MIGRATION_REQUIRED` before Settings is available. Retry only
repeats the silent readiness check; neither Retry nor reinstalling this release
performs a credential migration. The dashboard offers no approval authority,
identity reset, deletion, or rotation as migration recovery.


## Fixed report pages

These are HTML report routes backed only by allowlisted artifact names. They
are not a directory server and have no JSON report-index endpoint. The four
direct pages remain intentionally addressable for operator review.

| Method | Path | Report |
|---|---|---|
| `GET` | `/reports/gradient` | Quota and API-price gradient |
| `GET` | `/reports/weekly` | Weekly calibration |
| `GET` | `/reports/quality` | Monitoring quality |
| `GET` | `/reports/multi-surface` | Cross-surface comparison |


## Integrated desktop settings contracts

The trusted dashboard frame uses the frozen desktop IPC allowlist for Settings,
notification preferences, refresh and original-quality background resources.
Paths and arbitrary external destinations are not renderer capabilities.
The X bridge's `configureXImport` action explicitly prepares or repairs the
fixed Chrome bridge assets and current-user Native Messaging registration;
`openXImportFolder` has no renderer arguments and reveals only the fixed,
verified extension folder. Routine import setup verifies existing approval and
registration without granting Chrome permission or reading cookies. Cookie
access still requires the user action in Chrome and application preflight.

## Process and module boundaries

Electron launches the companion through a closed environment allowlist and a
bounded readiness/stop protocol. Only its trusted dashboard frame may invoke
the reviewed desktop IPC actions. Settings, background and X resources retain
their closed schemas, opaque identifiers and fixed protocol allowlists.

The read-only local agent CLI delegates to the existing usage-explainer service.
It does not create another ledger. The former platform-specific plugin is
retired; see the [agent protocol](./usage-explainer-agent-protocol.md).

Codex app-server normalization belongs to `src/providers/codex` and its reviewed
public facade. Windows filesystem, source reading, credential mutex/audit,
protected state and browser profile capabilities belong to `src/platform/index.js`
and its narrow native adapter. Qualification of one capability never enables
another. Reusable workspace packages expose only their reviewed public roots.

`@app-usagemonitor/codex-catalog` exposes the reviewed Codex plan types and display
names, model catalog and lookup, reasoning-configuration helpers and the catalog
completeness validator. It has no entitlement, quota, pricing or telemetry-schema
API. The local browser mirror exposes the vocabulary and lookup helpers; the
completeness validator stays in source verification.

`test/api-surface-reference.test.js` compares both maintained HTTP tables to the
local route/method allowlists. Schema mirrors and generators have their own
[ownership map](./schema-contracts.md). Older remote API contracts retained in
historical documents do not create callable routes in this product.
