---
title: Short-term workload and load trend implementation
date: 2026-10-22
type: review
status: source-verified
---

## Scope and authority

Point-in-time source verification on Windows x64, Node.js 22.21.1 and Electron
43.5.0, over `94cc26f3a63fc12b726fd47da8a83b44ba27e425` with retained owner
changes. This work changes workload projection and its existing card, not the
parallel accounting-cache fixes. Current behavior is defined by the source,
[user guide](../user-guide.md) and
[local index reference](../reference/local-index-schema.md).
No package, running-product restart, installation, commit or publication was
performed. Rendering below uses an isolated Electron harness, not a packaged app.

## Implemented contract

- Policy `task-workload-v9` produces `overview-workload-v6`. `current` measures
  five elapsed minutes; `trend` measures fifteen. One estimator and one fitted
  historical classifier serve both. No extra scheduler, accounting path or
  durable state is introduced.
- Receipts use start-exclusive/end-inclusive bounds and work uses clipped
  parallel union time. At least one evidenced work minute is required for a
  rate. Each window independently rejects missing history, uncertain boundaries,
  unpriced usage and stale evidence. Quota-capacity conversion independently
  checks the window against the estimated plan era.
- These are recent-window intensities, not merely the currently open task.
  Completed work retains its recent grade until it leaves the window. Confirmed
  absence of work shows idle; receipts without established work cannot become
  idle or known zero. The task detector's prior fifteen-minute unresolved
  lookback remains unchanged and independent of display windows.
- Both grades occupy the existing current-load card. Labels use small inline
  parenthetical windows, including `短期负载（5分钟）` and
  `负载趋势（15分钟）`. Rate and remaining work hours refer only to short term.
  Idle/unknown short term does not add meaningless metric rows. Grid, number of
  cards and outer sizing rules are unchanged. English, Simplified Chinese and
  Spanish come from the canonical catalog and regenerated mirrors.
- V2–v5 saved results remain stale history; v5 unallocated summaries survive.
  An old fifteen-minute grade cannot become a five-minute grade. Stale and
  unavailable results expose no fresh recent grades or estimates. SQLite and
  persisted workload-state schema are unchanged.

## Focused evidence

98 tests passed across the workload analyzer, committed-index workload reader,
web workload renderer, i18n foundation and quota package-boundary tests. Coverage
includes both elapsed windows, common classification, exact receipt boundaries,
future exclusion, older-only pricing/coverage gaps, parallel union, minimum
duration, plan transitions, completed-work expiry, unknown/stale states and
legacy saved projections. Existing quota conservation and ordering checks pass.
The reader tests include the concurrent cache thread's capacity-history fixes;
the previous v5 expectation is updated to the new v6 producer contract.

Seven separate focused stale-accounting integration tests also passed during
integration. They are not a replacement for the other thread's cache validation.
Canonical browser and Electron catalog checks pass. Architecture and preflight
checks pass; no full test suite was run.

The isolated renderer reads only committed real-system workload evidence, then
applies the closed DOM-facing projection. Real evidence remains distinct from
synthetic populated/sparse/idle/stale display cases. The comparison uses the
prior candidate source's actual renderer, styles and catalogs as the baseline.
Widths 1280, 900, 390 and 320 and all three shipped locales are checked. Five
cards and two recent-window sections remain present, with no horizontal
overflow. Each new card keeps the baseline width and does not exceed its prior
height. These checks do not establish packaged/native lifecycle acceptance.

Local diagnostic scripts and captures are ignored, contain no raw input records,
and do not modify the production index, settings, credentials or session data.
