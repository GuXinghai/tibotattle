---
title: Initial dashboard copy and visual simplification
date: 2026-10-08
type: plan
status: implemented
---

# Initial dashboard copy and visual simplification

Owner-approved scope: prioritize readable allowance values and explanatory copy
in Overview and Trends. Preserve ingestion, accounting, quota freshness,
sharing policy, distinct allowance pools and unavailable/partial evidence.
The installed app and its data are outside this development change.

1. Replace dashboard liquid-tank mounting with compact allowance cards, a static
   percentage bar, reset times and each pool's observation timestamp. Keep
   unknown capacity distinct from an observed zero. Keep forecast evidence and
   uncertainty accessible; remove its decorative flow animation.
2. Replace the dashboard day/night scene with a neutral selected-time toolbar.
   Keep replay, synchronized readouts, chart cursors and reset inspection. Put
   advanced observed/estimated comparisons in a keyboard-accessible disclosure.
   Public interactive examples retain their existing optional decoration.
3. Shorten normal setup text, explain allowance estimates in concrete terms,
   and replace internal comparison vocabulary. Update all shipped locales and
   regenerate canonical mirrors. Keep meaningful limitations visible.
4. Verify static syntax, architecture, catalogs and documentation. Build a
   separate unsigned Windows development package. The owner requested manual
   visual review instead of further UI tests or automated window interaction.
   Source, browser, packaged runtime and installed-release evidence remain
   separate.

Cache-dot-matrix replacement and a broader redesign of other pages are deferred
to a later pass. This first pass does not alter pricing or prediction methods.

The owner's subsequent review also removes repeated visual page titles and
separates Overview measurements from explanatory prose. Totals, comparison
bars, absolute difference and fitted rates stay in the primary card body;
methodology and examples move into a separate disclosure. Coverage, stale,
unavailable and account/plan qualifications remain visible.

The owner's single-screen follow-up replaces stacked allowance cards with compact
rows beside two small measurement panels. Components, fit statistics and setup
reading open in a native HTML dialog that retains the live result nodes and
restores keyboard focus on close. The forecast moves to Allowance Estimate.
Overview uses the available viewport height and fits unusually long states or
small windows proportionally without clipping values. No UI tests or automated
window review are run for this follow-up; visual acceptance remains owner-led.

## Validation boundary

Before the owner's request to stop further UI tests, 94 focused rendering,
freshness, refresh and trend tests passed. A broader UI attempt was not green:
it included old text expectations and Windows/runtime failures. Changed text
expectations have been updated, but the final UI gate has not been rerun and
rendered acceptance belongs to the owner. Architecture, catalog mirror checks
and documentation checks pass; a pre-existing catalog placeholder mismatch in
the excluded-source warning was independently reproduced at the base revision.
