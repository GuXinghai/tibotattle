---
title: Fifteen-minute API workload and sixty-minute quota trend
date: 2026-10-23
type: review
status: implemented
---

Owner-authorized scope: replace the five/fifteen-minute API workload pair with
fifteen-minute API-equivalent intensity and a sixty-minute observed quota trend
inside the existing card. Missing, idle and unclassified values display a dash,
with numeric API intensity retained when available without a fitted grade.
Concrete errors remain in diagnostics. No process detector, scheduler change,
real-data mutation, packaging or restart is part of this change.

Acceptance: quota rate uses only paired raw observations from one current plan
period and reset cycle, wholly inside the trailing window. Its denominator is
the actual observed elapsed span, including spans shorter than sixty minutes.
Unchanged integer readings are not a measured zero. Unknown labels reuse the
existing marked plan projection; conflicts, stale regressions, resets and
identity changes must not manufacture a decrease or a cross-boundary pair.
API intensity retains canonical pricing, union work time and one-minute minimum
work coverage. The independent fifteen-minute task-boundary lookback stays fixed.

The v7 projection distinguishes these units and refuses to reinterpret retained
v6 values as new measurements. Private startup state and raw index facts stay
unchanged. Inferred quota values retain an asterisk, without adding missing-data
hint text.

Validation on 2026-10-23: 110 focused synthetic tests passed across workload,
local-index integration, browser rendering, i18n and package-boundary coverage.
This includes receipt/window edges, future exclusion, incomplete history,
parallel work, unknown pricing, plan/account/reset boundaries, conflict recovery,
stale regressions, replay ordering, known numeric zero, and malformed browser
coverage metadata. The 20 preflight checks, architecture boundaries, i18n mirror
and documentation governance checks also passed. Full root and full UI suites
were not repeated under the owner's directed-validation scope.

A full production browser module graph was inspected using GET-only local
aggregates and a read-only index projection at the 2026-10-23T01:38:16.631Z cutoff.
The observed quota span was 59.8653 minutes and the rate 2.0045001027306304 points
per elapsed hour, displayed as 2. The short-term API value was unavailable and
rendered as `-`. Existing concrete work-boundary, quota conflict/reset and missing
price codes remained visible in diagnostic details. The index generation advanced
during the running app's normal refresh; this is not an exact same-generation
before/after accounting comparison. Default declared-speed inputs in the read-only
helper do not establish monetary accuracy. No private contents were projected,
and no index, collector state or application data was written by the helper.

This proves the named source and browser gates only. The running native package
is unchanged; packaging, restart, native validation and release qualification
remain outside this change.
