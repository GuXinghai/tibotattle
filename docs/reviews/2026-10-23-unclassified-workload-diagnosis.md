---
title: October 22 and 23 unclassified workload diagnosis
date: 2026-10-23
type: review
status: diagnosed
---

Read-only diagnosis against the normal local application, based on checkout
`94cc26f3a63fc12b726fd47da8a83b44ba27e425` with the existing dirty worktree.
No product logic, index, collector state, settings or application package was
changed. The current workload contract remains in the [user guide](../user-guide.md)
and [index reference](../reference/local-index-schema.md).

## Evidence boundary

The published cutoff was `2026-10-23T01:50:41.239Z` (10:50:41 in Asia/Tokyo),
with index generation 21346 and policy `task-workload-v10`. The running process
resolved to the previously verified normal-profile build 2026102303. Its ASAR
task-boundary function and daily classification/allocation block match the
corresponding current v11 source byte-for-byte after newline normalization.
The recent 15/60-minute source change therefore did not introduce this defect.

The source reader opened the index read-only and replayed the existing analyzer
with temporary in-memory reason probes. No alternative ledger was calculated.
The first replay used generation 21346; later structural verification reached
generation 21354 while the app refreshed normally. Both days' unclassified
amounts matched the published snapshot. Other colored amounts can differ because
the diagnostic uses default declared-speed inputs; it is not a monetary audit.

The usage explainer reported fresh but partial evidence due to
`tool_provenance_incomplete`. Its separate `pricing_coverage` request returned
unavailable with `usage_explainer_work_available`; no pricing facts were inferred
from that failed plan. The findings below come from the explicit read-only
workload replay and bounded raw lifecycle structure checks, not that plan.

## Observed classification causes

All amounts below are observed quota percentage points allocated by the existing
workload estimator, not money or provider-authoritative task charges.

| Local date | Published unclassified | Incomplete work buckets | No eligible token usage in the quota interval |
| --- | ---: | ---: | ---: |
| 2026-10-22 | 14.958653 | 14.958653 | 0 |
| 2026-10-23 | 9.442765 | 8.442765 | 1 |

The incomplete-work portions cover 46 five-minute buckets across 21 quota
intervals on October 22, and 30 buckets across 12 intervals on October 23.
The classifier had three fitted centers; global training refusal was not the
cause. Missing-price fallback was not the allocation branch responsible for
these unclassified portions.

### Confirmed cross-session terminal conflict

Nine task groups each have one parent start and a normal completion in that same
parent session. They also contain 31 abort events from descendant fork sessions.
Bounded reads of the original lifecycle lines confirmed all nine parent pairs
and all 31 aborts; all aborts belong to fork sources and retain the parent's raw
turn ID. Raw IDs, paths, messages and other contents were not retained in the
diagnostic output.

`taskWorkIntervals` groups by task key across sessions. It removes ancestry-proven
copies only when the event kind matches; a descendant abort survives a parent's
completion because `abort` and `complete` differ. The multiple-terminal guard then
marks the entire task as conflicting. Any five-minute bucket overlapping that
uncertain interval is refused a light/medium/heavy grade, even where usage prices
are known. Its observed quota remains present under unclassified.

A content-free synthetic reproduction confirms the mechanism: a parent-only
start/completion yields 600,000 ms of work with no conflict; adding one copied
descendant start and one descendant abort removes the copied start but produces
one conflict and zero accepted work for that group.

An explicitly hypothetical in-memory replay excluded only those 31 descendant
aborts from the frozen analyzer inputs. October 22 unclassified decreased to
1.295390 points; October 23 decreased to 2.077790. This establishes the impact of
the conflicting branch on this snapshot, not an applied repair or a guarantee
that all residual evidence can be classified. Historical fitted cuts can change
as newly eligible work buckets enter training.

### Remaining incomplete boundaries

The replay also contains an unresolved start on October 15 at 08:59:17 local time,
without a later same-session task context or eligible usage in the reader's
evidence range, and a more recent unresolved task. The existing policy extends
those uncertain windows to the cutoff, subtracts independently proven parallel
work, and rejects buckets overlapping the remaining gaps. This explains residual
unknown timing; it does not establish that the old task was actually still running
or that its missing terminal can be recovered. Do not invent an inactivity timeout
or classify these gaps by assuming zero work.

### Quota-only observation interval

On October 23 at 02:11:30.625–02:11:30.661 local time, quota observations rise
from 53% to 54%, with pending reset deadlines only one second apart. There is
one indexed event inside this 36 ms interval, but it is explicitly status-only
(`flags = 8`) and has no token components. The canonical usage projection
therefore supplies no token usage to allocate by price; the one-point decrease
stays unclassified. This is missing temporal attribution, not proof of missing
spend or a reason to fabricate token usage. The provider observation alone cannot
establish exactly when the preceding work consumed that point.

## Repair boundary

Fix lifecycle ownership before changing classification thresholds: descendant
branch cancellation must not terminate an independently completed parent task.
Preserve genuine same-session aborts, real multiple terminals, unrelated sessions,
ambiguous ancestry, and valid child continuation when the parent has no terminal.
Do not globally drop abort records or simply prefer every completion.

Regression acceptance should cover replay/order stability, nested forks, own-task
cancellation, conflicting completions, ancestry ambiguity and unchanged quota
conservation. The residual orphan and status-only interval need separate evidence
policies; the present diagnosis does not authorize silently filling them.

Only diagnostic scripts and this report were added. Synthetic assertions and
packaged/source block comparisons passed. No production repair, broad test suite,
packaging, restart, installation or release qualification is claimed.
