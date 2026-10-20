---
title: X session and ingestion failure diagnosis
date: 2026-10-20
type: review
status: complete
---

# Scope and evidence boundary

Source snapshot: `a65bd7ed`, branch `fix/windows-codex-refresh`, v0.1.27.
This records the owner-supplied external review and the subsequent independent
static check. External synthetic reproductions are reported evidence, not runs
performed by this review. No installed, signed-release or upstream X behavior
is established by a source check. The working tree was clean before this work.

The accepted [X decision](../decisions/2026-10-20-optional-x-reader.md),
[local index schema](../reference/local-index-schema.md), root guidance and
scoped instructions remain the authorities. This dated review is not policy.
The [test plan](../plans/2026-10-20-x-failure-boundary-validation.md) separates
isolated results from real runtime evidence. No production repair is claimed.

## Findings

| ID | Finding and static evidence | Evidence limit / repair boundary |
| --- | --- | --- |
| D1 | Native browser-profile preparation counts the whole descendant tree, limited to 4,096 entries and depth 32 (`native/windows-filesystem/windows-filesystem.cc`, `EnumerateBrowserProfile`). X opens it with caching enabled (`desktop-x-service.js`, `createContext`). Repository `profileError` translates a bound failure into `session_permission_failed`. | The external review reported a synthetic reproduction and a real profile below the cap. Those counts have not been remeasured here. Bound failure is additional to, not a disproof of, previously diagnosed ACL failures. Keep security checks and bounded work; do not simply skip untrusted cache descendants or delete reading history. |
| D2 | After restore fails before assigning `active`, `logout` calls `destroyContext(undefined)`, skips clearing the saved partition, then nulls `activePartition`. Promotion only discards an in-memory `oldActive`. | Auth residue and orphan recovery need isolated restart/cleanup tests. Retaining public reading cache after logout is intentional and is not itself a defect. Failed cleanup must remain visible and retryable. |
| D3 | The startup `ready` promise catches a repository read failure and resolves with defaults. `persist` can subsequently write that snapshot. Repository commit rereads durable data but replaces its current settings/pointer with the supplied snapshot. | Persistent read failure prevents writes; the problematic case is a transient first read failure. Preserve unread durable state instead of treating it as a new installation. |
| D4 | `rolloutContentQuarantineReason` quarantines a deferred incomplete tail. Refresh calls `deleteSourceFacts(sourceId)` with its default zero offset, removing the source's earlier committed facts as well. | The documented quarantine contract currently requires zero committed facts, while general last-good preservation guidance points the other way. Distinguish incomplete append from invalidated prefix before changing policy. The existing fresh-build test does not establish append-after-commit behavior. No claim that every rotation permanently destroys recoverability. |
| D5a | `recoverMedia` permanently sets `recoveryAttempted` on a resource. A transient recovery failure blocks later recovery of that same reference. | A refreshed URL can create a new reference; a refresh with an unchanged URL need not heal it. Use bounded retry, cancellation and stable media identity, not an unlimited loop. |
| D5b | Without exhaustion evidence, an empty appended page returns the same cursor and reports `pagination_pending`. | This is an observable branch, not proof that actual X end-of-list always lacks a terminator. Do not infer permanent exhaustion from a transient empty page. |
| D5c | Repository scope changes archive the old snapshot. Logout clears scope but retains posts, so a subsequent login can archive those posts again. | Preserve intended historical cache retention; prevent duplicate archives rather than arbitrarily capping retained history. |
| D5d | `cacheResults` skips an entire incomplete incoming post when an existing version is complete, including fresh media URLs and avatar data. | Merge only fields whose evidence is valid; never replace complete text with truncated text. |
| D5e | `notifyNew` inserts all observed own-post IDs into both processed notification baselines, then applies a greatest-ID watermark. Baselines grow without a bound. | Late-indexed replies may be suppressed. Initial baseline, category isolation, deduplication and retention semantics need focused tests. |
| D5f | `openDetail` flags any cache-sourced detail or non-idle operation as failed, even with valid saved replies. | Saved content, freshness and a failed attempted read are separate states. |
| D5g | Adapter media IDs are positional; recovery matches by ID and type. | Same-type reordering can select another item. Verify stable upstream identity before repairing. |

## Additional observations, not yet established defects

- Import early-return credential lifetime, dead optional `permit.isValid`,
  control-pipe server identity, HEAD content-type validation and missing
  `Content-Range` on 416 require narrow confirmation. Do not repeat credentials
  or raw upstream responses in evidence.
- `clearStorageData` is called by session-health cleanup. Whether additional
  HTTP cache removal is necessary is a separate Electron/runtime question,
  not proof that authentication Cookies survive successful cleanup.
- A sharing violation and an ACL refusal can map to the same broad visible
  category. Retain only allowlisted, content-free failure stages in a repair.
- Crash boundaries between flush/checkpoint and pointer/discard remain open.
- Foreground refresh has an `inFlight` guard; broad claims that all concurrent
  callers rely only on SQLite require tracing other entrypoints.
- The model-composition divisions cited as C4 have preceding positive-value
  guards. A divide-by-zero defect is not established.
- Scalar salvage accepts a digit prefix, but partial accounting records also
  increment quarantine diagnostics. A regex weakness alone does not prove
  wrongly priced committed facts.
- Provider normalization marks inconsistent components unavailable; the ledger
  excludes unavailable components. Silent exact pricing is not established by
  the clamping helper alone.
- Mid-window plan changes in the shared rolling-analysis path have not been
  fully traced. Do not attribute a desktop historical error to that helper
  without establishing the production call path.

## Optimization proposals, separate from correctness

Whole-cache read/hash/rewrite cost, duplicate status-driven loads, full-text
prefetch contention and eager HLS segment registration merit measurement after
failure boundaries are covered. Display size is not retention policy. Cache
cleanup must distinguish disposable browser assets from retained post history.

## Validation record

Initial independent work was static and read-only. It did not rerun the
external author's test counts, inspect credentials, trigger another login,
package, install or publish. Results of this work's own isolated and real
checks follow. Complete means this diagnostic round is recorded, not that the
defects are fixed or every real-world condition has been reproduced.

### Isolated results, 2026-10-20

| Group | Observed result | Evidence boundary |
| --- | --- | --- |
| Service and logical repository interruptions | 16 cases: 13 meet the contract; D2, D3 and D5a reproduce failures | Fake BrowserWindow, cookies and network; no real credentials. |
| Owned Node process termination | Five boundaries recover whole old/new snapshots: journal, chunk, before pointer, after pointer and cleanup. Unrelated record preserved. | Actual subprocess death with a test-only file/atomic-rename adapter; not native storage or power loss. |
| Windows native bounds/locking | 12 cases meet the expected native contract | Existing manifest-verified binary, real Windows handles on synthetic files. |
| Actual Electron Cookie interruption | Three boundaries classified as expected; details below | Electron 43.5.0 with encrypted disposable synthetic profiles; only owned probes terminated. |
| Extra media/pagination checks | Timeout retains retry cursor and reports offline. Four failures: HEAD type bypass, lost 416 metadata, wrong-image recovery after reordering, fresh media discarded with incomplete text. | Five fake-runtime/injected-response cases. HEAD bypass does not establish HTML body rendering; GET rejects that type. |
| Repository integration | D1 maps actual native bound error to permission failure. D3 still overwrites unread pointer/proxy settings with actual commit logic after a transient initial read failure. | Native synthetic profile for D1; real repository with memory storage/fake runtime for D3. Two failure cases. |
| Real ingestion/index with synthetic rollout | Initial facts 1; incomplete append 0; completed append 2; unchanged refresh 2 | D4 reproduced; completion heals without duplication. Last-good preservation fails under current quarantine policy. |

The native bound counts the root: totals 4,095 and 4,096 pass; 4,097 returns
`WINDOWS_FILESYSTEM_BROWSER_PROFILE_BOUND_EXCEEDED`, without a stage field.
Fixed-scope health still passes with `entries=5`, not a full profile inventory.
Cookies, WAL and SHM each received three real access/share combinations.
Compatible sharing produced `busy=false`; exclusive data access produced
`busy=true`, returning to false after release. Metadata/security preparation
still succeeded. All post-release retries passed and byte hashes were unchanged.
These cases did not reproduce lock-induced permission failure; they do not
qualify all Chromium or security-software interactions.

Actual Electron used only synthetic authentication-shaped Cookies and the
reserved-domain persistence marker, with the encryption fuse verified first.
Before-flush termination restored a valid marker. After-flush/pre-checkpoint
termination retained both synthetic auth Cookies but returned
`session_restore_failed`. After-checkpoint termination verified successfully.
This proves visible local classification, not seamless recovery from an
interrupted checkpoint, real-account validity or OS power-loss durability.

Native/service probes used Node v22.21.1. Ingestion, extra integration and the
Electron parent runner used Node v26.2.0. No build or packaging occurred.
Native binary: 379,392 bytes, SHA-256
`05071e951168bf04761fef5a2b031f0deb230538f4b3b5338e3b688b95c6d7fe`.
Isolated Electron executable SHA-256:
`dff3512ff57892303ec0214b649b8537fd7eb7ee15b89f6f2251a41ed89b51f7`.
General native production/path policy remains disabled, not newly qualified.

### Real application observations

After the initial isolated matrix, the existing login was ready/idle; no new
login/import was requested. The inspected ASAR SHA-256 was
`57ef3f37267a0d70806230ea1af19c255abc989b5da859799df8a0fb085c9502`.
Its service, session-health, repository, page-adapter and reader bytes matched
the checkout. Local debug protocol reported `Chrome/150.0.7871.250`, protocol
1.3. Observation time: `2026-10-20T03:59:22.719Z`. Only normal application bridge
reads and one associated resource fetch were performed, without UI automation.

- Two post pages returned 20 and 21 items, source `live`, idle and error-free.
  The continuation cursor advanced; more remained.
- One detail returned a post and 48 replies, source `live`, without error.
- One associated GIF's MP4 accepted a byte-range request: HTTP 206,
  `video/mp4`, 1,024 bytes and Content-Range present. The stream was cancelled
  after this bounded sample; no media contents were recorded.
- Login remained ready/idle without error afterward.

This establishes working current pagination/detail/resource retrieval, not
visible rendering, audiovisual playback, actual final-page recognition or actual
signed-URL expiry recovery. No arbitrary relay or weaker permission was added.

### Non-blocking gaps and repair disposition

Real timeline exhaustion was not reached within two pages. No naturally expired
media reference was observed. Do not crawl the account, alter expiry or repeat
login to manufacture those conditions. Synthetic end/pending and 403/404/410
cases remain separate from live behavior. Actual decoding/player behavior was
not exercised. Native-record-store power loss, arbitrary promotion/discard
crashes and external security software remain separate gates.

These gaps do not block evidence-backed D1/D2/D3/D5 defensive repairs. D4's
retention/quarantine conflict still needs an explicit policy resolution. Missing
real evidence does not resolve that conflict or authorize destructive cleanup.
Public post history and disposable browser assets remain distinct.

### Local reproduction and scoped checks

Content-free scripts/JSON receipts are retained locally in the ignored
`.release-build/x-audit-20261020/` directory: `service/`, `native/`, `electron/`,
`extras/`, `ingestion/` and `live/`. These are diagnostic artifacts, not tracked
regression tests or release receipts. Electron/ingestion use fresh single-run
fixtures; preserve receipts and choose a new isolated root before repeating.

The diagnostic entrypoints are `service/run.mjs`, `service/crash-run.mjs`,
`native/run.mjs`, `electron/run.mjs`, `ingestion/probe.mjs`, `extras/run.mjs`,
`extras/repository-integration.mjs` and `live/check.mjs`, relative to that local
directory. Node v26.2.0 is available at
`.release-build/toolchains/node-v26.2.0-win-x64/node.exe`.

Additional commands from the repository root:

```text
node --test apps/electron/test/desktop-x-service.test.mjs apps/electron/test/desktop-x-session-health.test.mjs apps/electron/test/desktop-x-repository.test.mjs apps/electron/test/desktop-x-media-policy.test.mjs
.release-build/toolchains/node-v26.2.0-win-x64/node.exe --test --test-name-pattern="unfinished JSONL tail" test/codex-rollout-hardening.test.js
pnpm run docs:check
pnpm run test:preflight
```

Focused Electron tests passed 45/45; the selected fresh-build ingestion test
passed 1/1. That existing test does not cover earlier committed facts disappearing.
Documentation validation and 20/20 preflight checks passed. Green existing tests
do not cancel the diagnostic failures. No full suite, production repair,
packaging, installation, commit or push was performed. Real profile permissions
and files were not directly modified; normal application reads may update its
own protected reading cache.
