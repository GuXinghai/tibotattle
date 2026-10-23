---
title: Bounded model performance recovery retries
date: 2026-10-23
type: review
status: implemented
---

Scope: source changes and synthetic validation of model-performance recovery
warnings. Preserve prior measurements, source consistency checks, unrelated
worktree changes and the workload preview. Packaging, restarting, installing,
committing and modifying real indexes are outside this task.

## Plan and acceptance

1. Consume the existing closed source-diagnostic header without changing the
   measurement DTO or exposing source identifiers, paths or exception text.
2. Retry recoverable source-change warnings with a separate bounded backoff
   budget. Show retrying and, only with growth evidence, waiting for a stable
   log. Keep missing/unreadable sources and terminal failures explicit.
3. Fence retries by period, speed, exact reporting window, visibility and
   cancellation. Preserve existing cold-history polling and backend consistency
   checks. Verify recovery, exhaustion, mixed failures and cleanup using
   content-free synthetic fixtures; regenerate canonical translations.
4. Run focused tests and the owning UI gate, record rendered checks and remaining
   native-package evidence separately.

## Implemented behavior

- The browser validates the existing closed source-detail header independently
  from the unchanged schema-6/method-5 measurement DTO. Invalid details reject
  with `timing_contract_invalid`; the page displays the failure.
- Recovery warnings caused only by growth, metadata changes or an unspecified
  source change retry at 5, 10, 20 and 30 seconds, at most four retries. An older
  companion's generic recovery warning can retry without claiming growth.
  Every gap stays below the worker's one-minute idle lease; total backoff spans
  its one-minute rediscovery cadence. Requests do not force a full rescan.
- During retries the page says “正在重试”. Confirmed growth also says
  “等待日志稳定，保留旧测量” when a prior ready result exists; a cold result does
  not claim saved measurements. All three shipped locales have matching keys.
- Missing/unreadable/undiscovered recovery sources, identity changes, truncation
  and mixed hard diagnostics remain explicit errors. A request, JSON or contract
  failure stops retries with its fixed error code. Exhaustion retains the
  original recovery error and source details and offers manual retry.
- Success removes old diagnostics even if the measurement body is unchanged.
  Retry counts advance only when an automatic attempt actually runs. Scope
  changes, cancellation, hiding and teardown fence timers and late responses.
  Backend consistency guards, transactional recovery and cold-history polling
  are unchanged.

## Evidence and remaining gates

Environment: Windows x64, Node.js 22.21.1, existing dirty checkout. No dependencies
were added and no unrelated production files were changed for this task.

- Initial model-performance tests: 58/58 passed before editing.
- Final focused model-performance, i18n foundation, browser mirror parity and
  warning localization tests: 83/83 passed, no failures or skips. New cases cover
  closed-header refusal, recovery, independent subsequent incidents, exhaustion,
  hard/mixed errors, cold evidence, request failure, cancellation, scope changes,
  late ignored-abort responses and revalidation without spending the retry budget.
- The test timer harness now removes one-shot timers when fired, matching browser
  behavior. The first broad run exposed three new assertions that had counted
  already-fired fake timers; these were resolved without weakening assertions.
- Browser mirror freshness and `test:preflight` pass; preflight has 20/20 passing
  documentation/guidance tests. The final owning UI suite has 1,109 tests:
  1,086 passed and 23 failed, with no skips.
- The owning UI suite still has 23 failures outside model-performance: two
  accounting presentation expectations, eighteen allowance tank source-extraction
  failures, two other source-extraction files and one settings-category mismatch.
  An in-memory counterfactual removes only this task's client-header handling
  and new catalog rows, preserving earlier worktree changes: all 23 UI failures
  still reproduce. This is scoped attribution, not a clean-checkout baseline.
- The separate localization-system check has two failures: an existing excluded-
  sources placeholder mismatch and missing static API-equivalent copy inventory.
  Both also reproduce in that counterfactual. No unrelated assertions or product
  copy were weakened to obtain green results.
- Real Chrome rendering used the source model-performance component and a read-only validated saved
  aggregate with three models. Diagnostic states were explicitly synthetic;
  exhaustion used accelerated test timers. Wide and 360px component layouts,
  Chinese/English/Spanish copy, retrying, missing/unreadable, exhausted and clean
  recovery states were checked. The preview read the saved snapshot only; it
  never started a worker, scanned raw logs or wrote a real index.
- Component browser evidence does not establish the complete dashboard or native
  packaged behavior. No packaging,
  application restart, installation or commit occurred. The workload preview's
  SHA-256 remains `f334a53ebca1eca6f7df705e770a58e78d94fcd7d178baece64e42e41b8c29a0`.

## Follow-up: compact retry status, 2026-10-23

The owner subsequently requested a single “正在重试” status. The retry display
now omits the explanatory sentence, saved-result timestamp and cancel button.
Successful recovery removes the status; ordinary errors, diagnostic details,
retained charts and the bounded background retry policy remain unchanged.
The unused explanatory key was removed from all canonical locales and the
browser mirror regenerated. Earlier rendering evidence above describes the
initial implementation, before this presentation-only adjustment.

Focused tests remain 83/83 passing, including exact status text during queued
and in-flight retries, successful disappearance and unchanged error behavior.
The owning UI gate remains 1,086 passing and the same 23 failing tests.
Real Chrome component checks used the same read-only saved aggregates and
synthetic warning states: wide/360px retry text, zero status nodes after recovery,
and an explicit unreadable-source error were verified. No package or app restart
was performed for this follow-up.
