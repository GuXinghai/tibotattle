---
title: Single-screen dashboard views
date: 2026-10-08
type: plan
status: implemented
---

# Single-screen dashboard views

Owner-approved scope: extend the viewport summary to all local dashboard pages.
Use switchable views instead of stacking charts, tables and explanations.
Preserve data targets, filters, cancellation, retries, reporting scopes, sharing
policy and distinct stale/partial/unavailable evidence. Do not alter accounting,
ingestion, installed application data or release policy.

1. Give Allowance Estimate history, forecast, reset details and share views;
   Trends activity, comparison, drift, divergence and exact-evidence views;
   Usage and costs summary, components, models and diagnostics views; Projects
   list and component views; Performance speed and latency views.
2. Preserve the selected view across data redraws and locale changes. Keep
   controls and scope/coverage/error status outside the switched measurements.
   Optional disclosures open in a keyboard-accessible dialog with focus return.
3. Use compact controls and short table batches, retaining access to all rows.
   Fit the active page to available viewport height without cropping values;
   Community uses the same viewport layout without changing sharing semantics.
4. Verify syntax, DOM targets, canonical locale coverage/mirrors, architecture
   and documentation, then build an isolated Windows development package.
   The owner requested manual visual review; no UI tests or automated window
   inspection belong to this change. Source and artifact checks do not establish
   native visual acceptance or an installed release.
