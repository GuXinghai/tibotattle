---
title: Allowance stale label scope
date: 2026-10-22
type: review
status: source-verified
---

# Scope and acceptance

Keep prior calibration summaries distinct from the primary Weekly API equivalent
interval chart. Move the previous-version annotation with its calibration
estimate into Complete details. A pending interval report with no usable curve
must say that no previous chart is available; an existing compatible curve must
remain usable during refresh. Preserve all accounting and generation fences.

Validate with synthetic mounted-page, chart-state and locale regressions. Preserve
the dirty worktree and workload preview. Do not manually change live data,
submit refresh requests, install, or commit.

# Confirmed observations

The running normal application returned an unavailable interval report with
reason `weekly_api_source_pending` and zero interval rows. The separate weekly
calibration endpoint returned a stale summary, one summary row and two estimate
rows. That response does not include a primary interval-chart projection. These
are read-only, content-free API observations, not a claim about all historical
cache contents.

The primary chart and the legacy calibration share a page, but the latter's
previous-version annotation was left in the visible page header after its
estimate moved into the details dialog. A retained calibration summary therefore
incorrectly appeared to describe the empty primary interval chart.
Both affected presentation modules matched the checkout's HEAD before this fix;
the cache-computation and mean/median changes did not introduce these two lines.

# Validation

The two presentation changes move the existing annotation with its estimate and
give a pending report with no usable curve an explicit recalculation state.
Initial reads retain their loading state; usable curves remain selectable
during refresh, and unavailable, invalid and confirmed-empty reports remain
distinct. No backend accounting or source-generation contract changed.

The focused serial run of `allowance-page.test.mjs`,
`weekly-api-chart.test.mjs`, `stale-serve-data-client.test.mjs` and
`i18n-foundation.test.js` passed 29/29 tests. Coverage includes mounting and
opening the real estimate detail component, absence of fabricated chart paths,
all three locales, unavailable/error/empty transitions and retained curves.
Browser and Electron i18n mirror checks, scoped whitespace checks and documentation
governance passed. The repository preflight also passed its 20 governance and
guidance tests. The Electron mirror regeneration changed only its canonical
source hash; pre-existing generated message content was preserved.

The active normal application package remains unchanged. This source-only
correction has not been packaged, restarted or accepted in the live native
window. Native rendering with real evidence remains an open gate.
