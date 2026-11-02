---
title: Live real-data refresh verification
date: 2026-11-02
type: receipt
status: verified
source_commit: 624b8adf
---

# Result and boundary

The unsigned stable-metadata candidate was launched against the **real** stable
profile and the real `~/.codex` source, not a copy. The companion refreshed the
live index successfully, and the dashboard moved to 2026-11-02 data. The index
and UI update path is therefore verified on real data.

This remains an unsigned local candidate. It is not a signed installer,
installed-app qualification, normal-candidate CI journey, or release evidence.
The app was stopped after the check; no debug endpoint remains open.

# Live refresh delta

| Measure | Before | After |
|---|---:|---:|
| `source` | 4,219 | 4,264 |
| `usage_event` | 550,560 | 553,240 |
| `quota_occurrence` | 477,665 | 480,205 |
| `work_lifecycle_fact` | 42,136 | 42,419 |
| latest `usage_event.observed_at_ms` | 1793450653146 | 1793577643539 |

The source tree also had newer Codex session files at the start
(`latestCodex` later than the index maximum), so this was a genuine ingest
delta rather than a copied store being reread.

# UI observation

The real-profile dashboard updated from the 2026-10-31 snapshot to 2026-11-02:
it showed 81% remaining, the Plus plan and a 09:00 refresh timestamp. The old
"results need an update" notice was no longer the dominant state. The sidebar
continued to show "updating usage records" while the work-usage projection was
being generated; that completion was not observed before the app was closed.

The earlier local index copy test could only prove readback because its
isolated Codex home was empty. This run closes the missing update check for the
real source path.

# Remaining gate

The work-usage snapshot generation remained pending for several minutes on the
real store. The companion diagnostics history contains earlier
`work_usage_timeout` notes; this run did not establish a terminal work-usage
snapshot. Investigate that performance/timeout path separately before claiming
the dashboard refresh is fully settled.

Signing, disposable-runner normal-candidate smoke, NSIS installation/upgrade,
owner-profile phase receipt and release publication remain separate gates.
