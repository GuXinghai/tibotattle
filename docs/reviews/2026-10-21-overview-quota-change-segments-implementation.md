---
title: Overview quota change segmentation implementation
date: 2026-10-21
type: review
status: source-implemented
---

# Scope and evidence boundary

Implementation of the [approved plan](../plans/2026-10-21-overview-quota-change-segments.md)
on the dirty working tree based on `94cc26f3a63fc12b726fd47da8a83b44ba27e425`.
Existing refresh, X-reader, accounting and theme changes were preserved. No
packaging, restart, installation, commit, publication or computer control was
performed. The running user candidate does not contain this source repair.

# Implemented contract

`task-workload-v7` retains equal-balance allocation anchors and closes only
positive changes. History and startup comparison share the existing anchored
weekly cycle resolver with separate identity and accumulation policies. Stale
readings, retired cycles, ambiguous transitions, account/plan changes and
simultaneous conflicts do not produce invented continuity. An ambiguous history
transition has its own bounded error. Conflicting task bounds mark overlapping
coverage incomplete instead of pairing all consumption with other tasks' time.

The read-only index reader retains preceding usage/work context, with resource
limits, cancellation and last-good failure behavior. Full interval denominators
precede date clipping. No database version, source fact or price is rewritten.
Missing prices retain consumption and diagnostics rather than assigning unknown
weight to priced records. Composite hours remain independent of model prices;
unclosed tails do not lower historical rates.

`overview-workload-v5` includes per-plan conservation summaries and cross-day
unallocated aggregates with at most twenty detail records. The section is the
last Overview child, after all cards and diagnostics; it disappears when empty
and retains disclosure/focus on refresh. Old v2–v4 projections remain readable as
stale whole results. Canonical English, Chinese and Spanish strings and both
generated mirrors were updated. Public types and maintained schema/user guidance
were updated; startup persisted state stays v3.

# Focused validation

Windows x64, Node.js 22.21.1, pnpm 11.25.0; source tests do not qualify a package.

- 77 tests passed across `test/overview-workload.test.js`,
  `test/local-index-workload.test.js`, `apps/web/test/overview-workload.test.mjs`,
  `test/i18n-foundation.test.js`, `apps/web/test/i18n-browser-parity.test.mjs` and
  `test/quota-analysis-package-boundary.test.js`.
- Three selected companion tests passed: unified output-only evidence,
  cancelled-candidate publication, and projection-mode delegation. Full test
  suites were not run.
- Tests cover unchanged inputs, reversed/duplicate reads, same-time conflicts,
  first change/multi-point jumps, stale and retired cycles, anchored jitter,
  explicit resets, per-plan conservation, full pre-window usage denominators,
  incomplete history, cross-month/day and daylight-saving allocation, missing
  prices, incomplete work, separate reset lookback/account scope, cancellation,
  malformed v5/footer counts, old versions, disclosure/focus and detail truncation.
- Architecture boundaries passed (606 production files, 2410 imports); browser
  and Electron catalog mirror checks passed after generation.
- `pnpm run docs:check` passed (311 Markdown files and 998 source/config files).
  `pnpm run test:preflight` passed root hygiene, whitespace and all twenty
  documentation/agent-guidance tests.

# Real history, read-only replay

The comparison used one frozen input inside one index read transaction, source
generation 16316, analysis clock `2026-10-21T09:48:25.041Z`, device timezone
`Asia/Tokyo`. Raw session records were neither copied into fixtures nor modified.
Only content-free aggregates are retained here. The same input was evaluated by
the baseline, an anchor-only diagnostic variant, the new policy with exact old
reset keys, and the full new policy. Diagnostic variants were local only.

| Local date | Old daily pp | Anchor-only pp | Full new pp | New unclassified pp |
| --- | ---: | ---: | ---: | ---: |
| 10/15 | 41 | 40.124 | 41.279 | 1.527 |
| 10/16 | 42 | 42.000 | 42.454 | 0 |
| 10/17 | 65 | 65.566 | 69.196 | 0 |
| 10/18 | 18 | 18.167 | 18.053 | 0 |
| 10/19 | 13 | 12.267 | 13.876 | 0 |
| 10/20 | 21 | 21.000 | 23.769 | 0 |
| 10/21 | 8 | 8.000 | 13.498 | 0 |

The anchor-only column isolates changes in date allocation caused by keeping the
first balance observation; it also reduces the earlier unclassified 2 and 11 pp
on 10/19 and 10/20 to 0 and 1 pp. It is not the completed repair. The full new
policy with old exact reset keys produces the same daily values as anchor-only.
Thus the remaining per-date differences in the last column of totals arise from
cycle normalization, including redistribution across midnight: +1.155, +0.454,
+3.630, −0.114, +1.609, +2.769 and +5.498 pp respectively (rounded). A date can
decrease while its complete interval conserves consumption.

Full cycle resolution restores five closed pp for Pro 5× and ten for Pro 10×.
New Pro 5× conservation: 178 observed = 176.124451954 daily + 1.875548046
outside visible dates + 0 unallocated. Pro 10×: 46 = 46 + 0 + 0. Residual
floating-point error is below 0.000000000002 pp. Different plans are not pooled
as equivalent workload. This sample has no cross-day unallocated interval;
synthetic tests exercise that path, including missing prices.

Clustering centers are unchanged. Composite sample coverage and hours change
because zero-change tails no longer enter historical rates and previously split
cycles regain full work intervals. The result still exposes `price_missing`,
`comparison_reset_gap` and `quota_reset_ambiguous`; no missing model was guessed
and no unresolved evidence was converted to zero. These values are local
estimates for this evidence set, not provider-authoritative billing.

# Rendering and remaining gate

An isolated hidden Electron 43.5.0 window loaded the actual renderer and styles
from loopback, sandboxed and without a preload or production profile. The real
safe projection rendered all five cards. Synthetic cross-day aggregates exercised
the footer at 1266 and 416 CSS-pixel window widths in Chinese and Spanish. The
footer remained the final child and document scroll width equalled client width.
Screenshots were inspected separately from source tests. This is component-level
Electron evidence, not a rebuilt application or installed-artifact qualification.

The fresh-package/native full-app gate remains pending by instruction. No claim
is made that the running application's display has changed.
