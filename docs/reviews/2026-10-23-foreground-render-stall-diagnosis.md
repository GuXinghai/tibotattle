---
title: Foreground input stall and localization observer diagnosis
date: 2026-10-23
type: review
status: diagnosed
---

Scope: diagnose the owner's report that all controls stop responding for about
3–5 seconds after returning to the foreground. This record covers source
inspection, read-only saved aggregate rendering in Chrome, and content-free
synthetic experiments. No product code was changed, and the desktop application
was not started, restarted or repackaged. No real index or provider logs were
modified or scanned.

## Acceptance and evidence boundary

Separate the backend refresh duration from renderer input blocking. Identify a
measured blocking stage and test the smallest proposed correction while
preserving translations and raw-content exclusions. Native background/restore
behavior remains a separate, unexecuted gate because startup is paused.

Checkout: `94cc26f3a63fc12b726fd47da8a83b44ba27e425` with existing unrelated
uncommitted changes preserved. The previous normal candidate is version 0.1.27,
build 2026102301. Its ASAR SHA-256 is
`35d986dc4e0676cdb7c22ae7fddd0717bbf7e45c2bc1a6794b9781b736655d3c`.
The candidate's `apps/web/public/localization.js` is byte-identical to the
inspected source, SHA-256
`90f9dd446835bcd72c7fe8f1920c28527ef2968b3b6b407238059a86fd611eb8`.
The observer function is unchanged from this checkout's HEAD. This does not
establish when the symptom first appeared or whether other changes amplified it.

## Confirmed blocking work

The localization MutationObserver calls `localizeRegisteredLegacyText()` once
for each relevant mutation record. That function scans all registered legacy
text nodes and owned text elements. Large dashboard DOM updates therefore repeat
the global pass many times in one synchronous observer callback. Input handlers
cannot execute until this main-thread work finishes.

The isolated preview served the complete production HTML/module graph and four
existing validated aggregate fragments from memory over loopback. It did not
start the companion, indexer or a refresh. Business writes were rejected. Probe
instrumentation and the comparison transformation were served from memory;
production files were not edited. No aggregate payload was copied into fixtures
or this record. Timings below are single observations, not benchmark guarantees.

| Stage | Original source | Comparison: one global pass per observer delivery |
|---|---:|---:|
| Localization callback following dashboard rendering | 3,071.2 ms | 84.9 ms |
| Later localization callback following accounting rendering | 2,220.9 ms | 19.8 ms |
| Dashboard normalization | 463.4 ms | 635.6 ms |
| Synchronous dashboard render | 559.0 ms | 609.6 ms |
| Largest recorded browser long task | 4,212 ms | 1,547 ms |

Parent render timings include their nested stages and must not be added to them.
The comparison still has substantial synchronous normalization/rendering work;
batching localization alone does not establish a fully responsive native app.
The first navigation/reload and a native return-to-foreground event are different
scenarios. These measurements prove a renderer bottleneck that can explain the
reported duration, not the complete native foreground event chain.

## Content-free structural verification

The existing queued DOM test harness was reused in a disposable experiment.
Both variants translated all inserted product text correctly, preserved
`data-i18n-skip` raw text, survived English/Spanish/Chinese switches and settled
within two observer deliveries. A retained text node's read count exposes repeated
global work without relying on machine-dependent elapsed-time assertions.

| Insertions delivered together | Original retained-node reads | Batched retained-node reads |
|---|---:|---:|
| 32 | 65 | 2 |
| 128 | 257 | 2 |

The proposed correction keeps per-record registration and attribute handling,
marks legacy text dirty for relevant text/child mutations, and performs one
global localization pass after the record loop. Removal-only child mutations
must still trigger cleanup of disconnected registrations. Existing translation,
privacy and unchanged-value checks remain intact. This proposal is not applied
to product source in this diagnostic task.

## Background refresh findings

- The previous normal candidate already sets `backgroundThrottling: false` in
  the desktop BrowserWindow. Default Electron background timer throttling is
  therefore not an adequate diagnosis by itself. OS, GPU and native scheduling
  have not been measured in this run.
- Companion-owned automatic refresh scheduling is independent of renderer
  visibility. Source inspection does not show a pause-on-hidden condition.
- Focus/visibility recovery updates freshness and observes refresh publication.
  It does not start a business refresh. A newly observed completion receipt can
  load and synchronously render the dashboard. Pending and receipt guards already
  prevent an unconditional duplicate refresh on every focus event.
- Rendering also updates sections that are not the currently visible page.
  This increases affected DOM work, but no broader lazy-rendering change was
  attempted. The workload preview was untouched.
- Existing historical backend timing reports concern a separate long refresh;
  this run did not measure a new real backend refresh or establish that it stops
  in the background.

## Next bounded correction and remaining gates

Apply only the observer batching change, add a retained-node bounded-work
regression to the queued mutation tests, and run focused localization tests plus
the owning UI gate. Keep the current renderer data/translation contracts. Then,
after authorization to resume startup, validate the real packaged application's
background/foreground transition and input delay. Do not treat this browser
comparison as native, installed, signed-release or updater acceptance.

## Authorized implementation follow-up

After the diagnostic snapshot above, the owner authorized this one correction,
quick verification, repackaging and normal-profile startup. The acceptance plan
is to coalesce only the observer's global legacy-text pass, retain per-record
registration/attribute handling and all privacy guards, and add a synthetic
bounded-work regression. The new regression fails against the uncorrected
observer. Preserve the existing dirty worktree and workload preview. Verify the
new source/ASAR closure before startup; do not install, sign, publish or commit.

### Follow-up result

Implemented only the observer batching correction and its queued-mutation
regression. The regression covers 32 and 128 insertions, bounded retained-node
work, complete translations, raw-content exclusion and observer settling. The
existing locale-switch test remains intact. Focused localization tests pass
14/14. The UI gate reports 1,087 passed and 23 failed (1,110 total); all 23 failure
names exactly match the preceding compact-retry UI run, with no new failures.
Preflight passes 20/20, including documentation governance and whitespace checks.
The UI gate is therefore not claimed as green.

Built the normal-profile Windows x64 0.1.27 application, build **2026102302**,
using exactly Node.js 26.2.0 and the existing reviewed production staging/builder
boundaries. This local unsigned repack retains the dirty worktree rather than
claiming a clean-source release. The source-stability receipt verifies all build
inputs stayed unchanged during the build. Manifest/ASAR checks cover 775
manifested files, 776 archive files and both native modules; the ZIP's executable,
ASAR and native payloads match the unpacked app. The packaged localization,
retry UI and data client match current source.

- Artifact folder: `.release-build/overview-validation/candidate-localization-batch-normal-20261023`.
- ASAR SHA-256: `51fa29d77e7d104e012de8ccb3bc52d425e3ffb96a7735d12d9b0c017b40074e`.
- ZIP SHA-256: `44036302809a2c34b572e02a0abe3a0d7b69fcaef814edc22dfff8509b65dca0`.

No old application was running, so no quit was needed. Launched the new unpacked
app with its normal `com.usagemonitor.local` identity, no isolated profile or
smoke-control arguments. Windows Computer Use inspection observed the actual
dashboard with existing local evidence, then successfully switched to Model
performance and observed its charts. The companion bound only to loopback;
health returned HTTP 200, `ready`, and `loopback_real_local_evidence`. The normal
startup refresh was running in `rollout_index` without a reported error at the
last observation; its completion was not awaited or claimed. No duplicate manual
refresh was submitted. The app remains running.

This is a quick native render/interaction check, not a measured background/restore
latency benchmark. The workload-preview SHA-256 remains
`f334a53ebca1eca6f7df705e770a58e78d94fcd7d178baece64e42e41b8c29a0`.
No direct real-index rewrite, installation, signing, publishing or commit was
performed. Normal application-owned startup activity remains normal runtime
behavior, separate from the content-free regression tests.
