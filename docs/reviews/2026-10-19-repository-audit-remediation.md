---
title: Repository audit remediation review
date: 2026-10-19
type: review
status: complete
---

# Scope and acceptance

This is a source-repair record for the owner-supplied review of `79d3d907` on
2026-10-19, not a new full-repository audit or release qualification. Within
the narrowed scope, 28 reported findings received repairs, two were retained
as documented/controlled behavior, and four remain deferred. Additional gaps
discovered while repairing adjacent code are listed separately below.

Validate the owner-supplied review of `79d3d907` against current source before
repairing each finding. Preserve existing product choices and unrelated edits.
Use synthetic fixtures; do not mutate the live index, credentials or profile.
This work does not authorize packaging, installation, publication or a push.
Source tests do not qualify native rendering, system notifications or release
artifacts.

The owner subsequently narrowed this work to clear, locally repairable defects.
Problems requiring a new recovery protocol, identity contract or unverified
native behavior remain open. Do not introduce speculative repairs to close a
review identifier.

## Work batches

| Batch | Review identifiers | Acceptance boundary |
|---|---|---|
| Lifecycle and persistence | P1-1; P2-3,4; P3-6 | Pending loads cancel; transient failures recover; Windows storage remains protected |
| Notifications | P1-2; P3-3 | Baselines survive observation-free polling; preserve documented coalescing, identity and deduplication; reset alerts stay retired |
| Accounting | P1-3,4; P3-20 | Fast/public kernel parity; unknown components and prices remain explicit; forward cache rebuild |
| Ingestion | P1-5; P2-5; P3-21 | Cold/incremental parity, stable ordinals and replay-safe fallback; bounded resource use |
| Quota projections | P2-1; P3-8,9,10 | No interval crosses unsupported reset evidence; closed valid DTOs; independent pools stay independent |
| UI and diagnostics | P2-6,8; P3-7,11,12,13 | Localized safe errors, truthful controls, accessible navigation; verify uncertain IME behavior |
| Export and local security | P2-2; P3-1,2,4 | Producer/consumer agreement; fail-closed recovery and permissions; no privacy weakening |
| Tooling and plugin | P2-7; P3-5,14,15,16,17,18,19 | Visible desktop gate, accurate Windows scope, immutable trust policy and public test semantics |

## Execution and verification

1. Independently confirm each finding; record contradictions with maintained
   contracts rather than implementing speculative recommendations.
2. Delegate complex behavioral repairs to GPT-6.1 Sol high and focused repairs
   or uncertain investigations to GPT-6 Luna xhigh, with exclusive file ownership.
3. Add targeted regression coverage and update maintained contracts when needed.
4. Review integration boundaries and run only the smallest directly affected
   test cases or files. The owner's additional instruction prohibits full test
   suites; do not run the root, product, desktop or UI aggregate suites.
   Use narrow contract checks only when a changed boundary requires them.
5. Record confirmed, rejected, deferred and environment-blocked results
   separately. Do not claim a full-suite or native pass without that evidence.

## Report disposition

| Findings | Outcome |
|---|---|
| P1-1 | Fixed: cancel pending dashboard load before queued shutdown/retry/dispose |
| P1-2 | Fixed: observation-free polling preserves baselines; terminal invalid evidence clears them |
| P1-3, P1-4 | Fixed: missing context prices and nullable/partial components stay explicit; forward cache rebuild |
| P1-5, P2-5 | Fixed: foreign response prefixes and ignored oversized lines preserve replay and ordinals |
| P2-1 | Fixed: material backwards readings invalidate rebound capacity intervals without asserting a reset |
| P2-2 | Fixed: activity-marker producer and verifier agree on uniqueness |
| P2-3, P2-4, P3-6 | Fixed: transient settings reads retry, cadence rearms, startup journal uses protected Windows storage |
| P2-6, P2-8, P3-7, P3-11, P3-12 | Implemented: safe localized notices, truthful diagnostic cadence, permission state, heading focus and localized tour |
| P2-7 | Implemented: explicit serial Electron source-test lane, product-gate wiring, focused Windows fixtures and retired-window assertion repair; aggregate intentionally not run |
| P3-2, P3-4 | Fixed: escaped source canaries and persistent default-deny session permission handlers |
| P3-8, P3-9 | Fixed: valid unavailable forecasts and distinct observed exhaustion with closed finite DTOs |
| P3-5 | Fixed: retire legacy installer implementation/tools/promotional claims; remaining Windows discovery is separately unresolved |
| P3-14 | Fixed: stale cache-boundary assertions now accept already-reviewed v19/v20 families and still reject future parsers; production allowlist unchanged |
| P3-15, P3-16, P3-17, P3-19 | Implemented: tool classification, pinned Windows runner, recursive local-action checks and explicit release-trust ownership/triggers |
| P3-20 | Fixed: test public kernel timestamp, tier and price-boundary behavior |
| P3-3 | Rejected as a defect: one notification per observation with coalesced crossings is the maintained contract |
| P3-18 | Retained controlled design: production baseline is empty and independent tests require no approved debt |

## Explicitly deferred

- **P3-1:** prepared-manifest crash recovery needs an exact publication recovery
  contract. Preserve unknown stage residues and the normal single-link reader.
- **P3-10:** equal-duration slots need an identity and downstream aggregation
  decision. The attempted fit segmentation was removed because it did not
  prevent downstream recombination; existing slot-migration behavior remains.
- **P3-13:** no physical browser/IME cancellation reproduction. No speculative
  composition-state change.
- **P3-21:** prefix reconciliation optimization needs durable checkpoint design
  and replay parity; retain the current correct bounded reconciler.
- **Additional related gap:** legacy append tier provenance can lose
  `turn_override` in retained carry state. The targeted ingestion fixture does
  not claim to resolve that independent contract issue.
- **Additional related gap:** the separate weekly calibration reader does not
  yet carry the same flags/output-conflict information as the repaired
  period/history/by-model accounting reader.
- **Additional related gap:** the plugin's remaining installed-agent discovery
  is a legacy bundle adapter, not a qualified Windows implementation. Retiring
  installation tools does not repair Windows discovery; maintained plugin
  documentation now states this limit.

The real-index frequency of nullable components was not measured. Synthetic
regressions establish the defect and repair, not its prevalence in private data.
No new provider price policy was inferred; reviewed missing rates stay unpriced.

## Verification boundaries

All automated fixes use Node.js 26.2.0 and synthetic inputs. Tests were limited
to directly affected cases or files, with no root, product, desktop or UI
aggregate run. Do not sum rerun counts as a unique-test total.

| Scope | Minimal evidence |
|---|---|
| Lifecycle/settings/cadence/startup journal | Pending-load cancellation cases, 11 settings cases, 3 cadence cases and 6 protected-store synthetic cases passed |
| Notifications | 36 cases across three directly affected files passed |
| Accounting | Six selected reader/kernel/cache cases passed; protected synthetic index fixture required automatically reviewed escalation |
| Ingestion | 14 response cases and 3 source-consistency cases passed; one existing Windows source-replacement skip |
| Quota DTOs and consumers | 75 cases across five directly related files passed; exact-100 follow-up case passed; slot changes subsequently removed |
| Export/session permission | Four selected export cases plus public-facade follow-up, and eight permission/navigation cases passed |
| Workflow/test-lane tooling | 20 directly related cases and focused recovery/runtime assertions passed; tool inventory passed |
| UI and diagnostics | Direct diagnostics, navigation, tour, settings, refresh-notice and weekly-pace cases passed; no rendered/native claim |
| Parser boundary/plugin contract | One retained-parser case and one exact four-read-only-tool contract case passed |

The final permission-control edit was separately verified by its one selected
main-process-authoritative permission test. Integration checks passed:
architecture boundaries (591 production files, zero approved debt), tool
inventory (94 records, 95 executable paths), documentation governance
(296 Markdown files, 982 source/config files), and whitespace checks.

The OSV shell-control-flow test could not run successfully in this environment:
Windows Git Bash initially exited with `0xC0000142`; one automatically reviewed
escalated attempt failed creating its synthetic temporary directory with
`EPERM`. Its assertions were not skipped or weakened. Windows scanner bytes and
runner policy were checked separately; no hosted workflow was executed.

Startup protected-store tests exercised synthetic native metadata. The physical
sandbox native probe was unavailable, and no real startup journal, permission
prompt, system notification, packaged UI or installed artifact was qualified.
No private index was queried or modified to measure defect prevalence.
