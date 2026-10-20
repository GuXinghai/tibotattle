---
title: Isolated and real X failure-boundary validation
date: 2026-10-20
type: plan
status: complete
---

# Acceptance and execution order

Execution round complete on 2026-10-20, with failures and non-blocking gaps
recorded in the linked diagnosis. This is not a completed-repair claim.

Validate the [diagnosis](../reviews/2026-10-20-x-session-and-ingestion-diagnosis.md)
at source `a65bd7ed`. Preserve production code and all existing owner changes.
First finish isolated checks; then run available real Windows/Electron/X checks.
Do not run a full suite or rebuild merely for this investigation.

Each case records expected behavior, observed behavior, evidence level and
remaining gate. A harness completing is not a product pass when it exposes a
defect. A missing real precondition is an environment gap, not a pass and not
a blocker for independent tests or later narrow defensive repairs. Do not claim
upstream end-of-list or expiry behavior from synthetic responses alone.

## Safety boundaries

- Synthetic fixtures contain no real posts, auth Cookies, account identifiers
  or private source paths. Never print credentials or raw network payloads.
- Real directories may be inspected read-only. Mutating experiments use newly
  created isolated profiles; do not change the live app's ACLs, cookie database,
  pointers or cache. No live-profile crash/kill experiment.
- Only explicitly owned test subprocesses may be forcibly terminated. Record
  precise synthetic root and PID ownership before crash injection.
- Reuse an existing accepted X login for limited normal reads. No repeated
  login/import, account experiments, external writes or permission weakening.
- No computer-control tools, installation, publishing, push or full tests.
- Do not relax production media host/resource authorization for test traffic.
  Deterministic responses use injected test adapters; native playback and real
  upstream behavior remain separately labeled.

## Phase A: isolated checks

| Cases | Method | Expected contract |
| --- | --- | --- |
| A1: profile bounds and Windows locking | Create synthetic native profiles below/above the entry bound. An owned helper holds synthetic Cookie/WAL/SHM handles with compatible and incompatible sharing modes. Release and repeat. | Categorize bound/security/sharing failures accurately; preserve bytes; recover after release. Native observation and user-visible service mapping are separate results. |
| A2: failed restore/logout and initial read | Fake service runtime with saved partition but failed health/read; inspect clear calls and durable pointer. Fail the initial repository read once, then permit reads/writes. | Logout cannot discard the only cleanup pointer without clearing; unread durable settings cannot be overwritten with defaults. |
| A3: interruption ordering | Use owned disposable subprocesses and synthetic storage. Interrupt before/after Cookie flush/checkpoint, repository journal/chunk/pointer publication, and promotion/old-session cleanup. Reopen the same synthetic store. | Read either old or new valid state; never an empty fallback on corruption, mixed account data, false cleanup success or unpublished provisional facts. Fake-runtime boundaries do not qualify actual Chromium crash durability. |
| A4: pagination | Explicit terminator, next page, repeated cursor, duplicate-only page, empty page with continuation, cancellation and timeout. | Bounded requests; preserve retryable cursor/content; distinguish pending from proven end. |
| A5: media recovery | Inject 403/404/410, refreshed URL success, one transient recovery failure followed by recovery, unchanged URL, 416/range, cancellation and media reordering. | Bounded retry; no permanent transient-failure latch or wrong-item binding; preserve range/type gates and cancel old resources. |
| A6: existing ingestion facts | Synthetic source: commit complete records, append incomplete final line, refresh, finish line and refresh; compare facts, totals and recovery. | Record current quarantine policy versus last-good preservation; no real index writes. A policy conflict remains open until explicitly resolved. |

Run only directly relevant existing tests and local diagnostic probes. Keep
fault-injection findings visible rather than weakening assertions to make the
source look correct. No private-state fixture enters a test or a commit.

## Phase B: real checks after Phase A

1. Use the available native adapter on disposable Windows files to confirm
   actual sharing error behavior and recovery. Keep compatible-share controls.
2. Use an isolated actual Electron session for synthetic Cookie restart and
   controlled interruption when the exact runtime/native closure is available.
   Otherwise record the missing prerequisite; do not crash the live app.
3. Inspect the existing app's content-free status and exact executable/runtime
   identity. Existing login failure or absent debugging access does not block
   remaining offline tests and does not authorize another login attempt.
4. If existing login is ready, make a bounded normal detail/pagination read.
   Summarize counts, progress, exhaustion/error categories only. Stop on
   challenge, expiration or rate limit. Lack of a reachable actual end is a gap.
5. Reuse already associated media for a small normal retrieval/playback check
   when available. Do not force upstream expiry. A successful fresh download
   does not prove expired-address recovery or actual audiovisual playback.

## Delivery

Append isolated outcomes, native/Electron/live outcomes, exact commands and
content-free failure categories to the diagnosis. Keep upstream-dependent gaps
explicit and non-blocking for unrelated checks and evidence-backed defensive
repairs. Product repairs, packaging and visual acceptance are later work, not
implied by a successful diagnostic run.

## Execution disposition

- A1/A2/A6 completed using native synthetic files, fake service/real repository
  integration, and the real ingestion/index path. Defects remain open.
- A3 covered logical and owned Node process interruptions at repository
  journal/chunk/pointer/cleanup boundaries. Encrypted actual Electron profiles
  covered before-flush, after-flush/pre-checkpoint and after-checkpoint. Native
  record-store power loss and arbitrary promotion/discard crashes are not
  qualified; an exception harness is not substituted for those gates.
- A4/A5 covered explicit end, repeat/empty pending, timeout, expired-response
  renewal, failed-renewal retry, logout cancellation, reordered media, partial
  updates, HEAD type and 416 metadata. Uncovered UI/rendering/cancellation
  permutations remain for repair regression tests, not silently passed.
- B checked current login, two live pages, a live detail and a bounded associated
  MP4 retrieval. Natural terminal/expiry evidence and actual playback remain
  separate non-blocking gates. No repeat login, CUA or live-profile crash.
- Only these two dated documents change repository content. Local diagnostic
  scripts, synthetic profiles and receipts remain ignored. Later repairs should
  add durable focused regressions under their owning surface, preserving these
  failures instead of weakening assertions.
