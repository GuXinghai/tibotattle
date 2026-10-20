---
title: Marked plan-period inference in overview history and work-hour estimates
date: 2026-10-19
type: decision-record
status: accepted
---

# Marked overview plan-period inference

Owner-approved on 2026-10-19 for the local overview. This narrowly permits
missing plan labels to be inferred in a recomputable projection under the
single-account continuous-subscription assumption. It does not establish
account identity, a provider billing formula, or the exact upgrade time.

The first explicit observation of each changed plan starts a new period.
Missing labels thereafter inherit that period's plan, with an inferred marker.
No label is filled before the first anchor. Explicit labels take precedence;
conflicting simultaneous labels and explicit account changes break continuity.
Repeated returns to the same plan start separate periods. Original observations
are retained unchanged, and new historical evidence can recompute the periods.

Historical daily consumption retains all periods. Same-day plans render as
separate groups because their percentage points are not equivalent. Pairing
never crosses a reset or plan-period boundary. Remaining work hours use only
the latest period of the current plan and retain inferred-sample markers;
unavailable samples do not borrow another period's rate.

This exception applies only to overview history and explicitly qualified
estimates. The strict startup comparison, provider normalization, raw local
index, accounting ledger, calibration and other report attribution do not gain
inferred account or plan evidence. The current projection and compatibility
contract are maintained in the [local index schema reference](../reference/local-index-schema.md).
