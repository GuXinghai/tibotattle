---
title: Checkpoint continuation and refresh observability repair
date: 2026-10-22
type: review
status: implemented
---

# Scope and acceptance

Implement the narrow continuation proved in the
[checkpoint follow-up](./2026-10-22-allowance-overlap-checkpoint-followup.md).
Preserve existing work, workload previews, original logs and the live index.
No packaging, restart, installation, commit or live refresh is part of this work.

1. Add synthetic positive and negative checkpoint/legacy overlap fixtures. Accept
   only an exact preceding checkpoint and one-to-one, component-consistent
   subsequent legacy/modern observations. Keep the unpriced historical prefix
   distinct from newly observed usage and preserve model/speed uncertainty.
2. Audit the affected refresh error projections and diagnostic sinks. Preserve
   reviewed fixed codes, record settled partial failures, and continue redacting
   arbitrary error text, provider identities and paths.
3. Correct failed-versus-partial UI state and unsupported retry claims. Preserve
   the previous source fixes for estimate-only stale labels and indexing copy.
4. Run focused synthetic provider, index, loopback, refresh, UI and i18n checks;
   document exact results and remaining native/live gates.

# Compatibility and risks

The extension must change only previously rejected overlap cases. It must not
relax unknown-prefix rejection generally, change accepted response identities,
price a checkpoint automatically, or invalidate all historical caches. Genuine
conflicts continue to fail before emitting partial totals and retain committed
facts and cursors. Diagnostic logging stays bounded and cannot affect refresh
success. UI copy must not assert a scheduler policy it has not observed.

# Implemented result

The shared response reconciler recognizes the narrow checkpoint continuation.
It checks same-thread/turn identity, a single preceding checkpoint, exact
compactor/retained-response identity, absence of that response from ordinary
records, explicit six-component prefix agreement, and individually paired
legacy increments. Each legacy latest vector and valid preceding cumulative
delta must match a distinct adjacent ordinary response at the same instant.
Conflicts still fail before either ingestion entrypoint emits a partial total.
The prefix remains uncharged with its incomplete-coverage diagnostic; no model,
speed or price is inferred. Previously accepted facts and verification keys are
unchanged, so there is no global parser-stamp bump or database migration.

The refresh boundary now preserves all fixed codes found in the response
reconciler and direct index refresh/store/extractor failure sites, including
identity, chain, legacy overlap, resource, worker and transaction guards.
Unknown strings still become a generic reviewed code. The scanner's malformed
modern-JSON failure now sets its fixed `code` instead of only an error message.
Settled partial index, accounting and quota failures enter the existing bounded,
rate-limited diagnostics recorder; quota-only failure details retain the
allowlisted provider code. Diagnostics sink failures remain isolated from the
refresh outcome. Cancellation and successful/deferred-budget handling remain
separate.

UI notices distinguish failed usage publication, accepted partial coverage and
quota-only failure. A failed index cannot claim analysis completion or inherit
a partial-publication explanation. Known usage reconciliation errors explain
the conflict without exposing raw error text. Retry guidance follows settings
without claiming that the independent scheduler stopped. Previous-version
estimate labels state provenance and past deferrals without inventing current
recalculation activity. Existing source fixes still keep the estimate label in
estimate details and suppress the owner-removed indexing warning. Changed copy
lives in the canonical three-locale catalog, with regenerated browser/Electron
mirrors.

# Evidence and remaining gates

On Node.js 22.21.1 / Windows x64, focused synthetic tests cover both parser
entrypoints, cold/append equivalence, repeat refresh, conflict rollback with an
unchanged committed cursor, model/speed uncertainty, safe code projection,
diagnostics rate limiting and UI notices in every shipped locale.

- The final provider/parity/model-recovery/refresh/UI run passed 227/227 tests:
  `pnpm exec node --test --test-concurrency=1 --test-reporter=spec test/codex-response-usage.test.js test/codex-ledger-parity.test.js test/codex-response-model-recovery.test.js test/local-companion-refresh.test.js apps/web/test/refresh-policy.test.mjs apps/web/test/dynamic-product-copy.test.mjs`.
- The isolated loopback quarantine, terminal failure and new degraded-failure
  diagnostic checks passed 3/3. The new case verifies the concrete HTTP code,
  one bounded note across repeated failures and omission of synthetic private
  message text.
- Additional UI/chart/stale-label/i18n checks passed 48/50. The two failures are
  existing `test/localization-system.test.js` failures: the excluded-source
  message's cross-locale placeholder set and an untranslated static component
  explanation. An in-memory inspection of the `HEAD` catalogs and HTML
  reproduces both defects independently of this change. They were left outside
  this focused repair; this check is not reported as fully passing.
- Architecture boundaries passed: 607 production files, 2,411 imports, no
  approved debt edges. Both i18n mirror checks passed.
- `pnpm run docs:check` passed across 327 Markdown files and 998 source/config
  files. `pnpm run test:preflight` passed workspace hygiene, whitespace,
  documentation and 20/20 governance/guidance tests. `git diff --check` passed;
  existing CRLF normalization notices are not validation errors.

The originally failing compressed source was also extracted read-only through
the stable-source/decompression facade, without writing either real or copied
index state. It now accepts 12 response records, retains one incomplete-prefix
diagnostic, and reports zero malformed accounting records. Its 25 emitted
events include independent quota/status observations; that count is not a
claim of 25 billable responses. No private content, path or identity was copied
into fixtures or this report. This establishes acceptance of the specific
source, not complete cross-source publication, historical totals or pricing.

Full surface/root suites, live index refresh, packaged/native
rendering, packaging, restart, installation and commit are outside this run.
