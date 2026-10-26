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
| Local companion API | Browser/native shell → loopback Node companion | 17 paths, 18 method/path operations |

## Local route inventory

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/local/health` | Companion readiness, refresh state, schema versions, and configured capabilities |
| `GET` | `/api/local/desktop-status` | Closed lifecycle plus a current direct display allowance from bounded published-overview metadata; strict v2 notification evidence remains receipt-only. Optional `notificationEvidenceStatus: "expired"` identifies age-only expiry after fresh completion without authorizing an alert or clearing comparison baselines. Available before the first snapshot and without account identifiers or filesystem paths. |
| `POST` | `/api/local/diagnostics/note` | Record one bounded fixed-vocabulary local diagnostic note |
| `GET` | `/api/local/onboarding` | Local installation and evidence-source readiness |
| `GET` | `/api/local/overview` | Personal dashboard headline and evidence coverage |
| `GET` | `/api/local/cache-drop-thread-links` | Optional, generation-bound local thread-name/parent lookup for the two recent cache-drop tables; requires `X-Usage-Monitor-Local: 1` and no foreign Origin |
| `POST` | `/api/local/work-usage/query` | Read-only local project/worktree/thread reports; optional canonical ISO `endAt` pins the selected period and rejects older snapshot substitution; closed JSON, local header and Origin/Host checks; bounded cancellable snapshots with lightweight `touch` lease renewal, transient names and bounded project/task name search before pagination; retained read-only figures use a separate refresh job identity and durable anonymous snapshots |
| `GET` | `/api/local/model-performance` | Independent device-local Codex timing aggregates for `period=1`, `period=7`, `period=30`, or `period=all`, optionally pinned by `endAt`; restores validated saved measurements before background work; reads renew a 60-second background-worker lease; schema 4/method 5 combines response speed and tool-free fallback estimates, preferring response timing per turn, with a fallback count and unchanged TTFT |
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

When contribution preparation encounters a preserved legacy export identity
without a usable modern credential, it returns the fixed
`identity_migration_required` code. This request does not migrate or replace the
identity. Quit TiboTattle and contact support with this code. Preserve the legacy
credential and app data; do not delete or reset credentials or app data. The
current Electron release has no credential migration approval entrypoint.
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

`test/api-surface-reference.test.js` compares both maintained HTTP tables to the
local route/method allowlists. Schema mirrors and generators have their own
[ownership map](./schema-contracts.md). Older remote API contracts retained in
historical documents do not create callable routes in this product.
