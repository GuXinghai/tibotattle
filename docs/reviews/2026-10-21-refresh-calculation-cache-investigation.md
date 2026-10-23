---
title: Refresh calculation and cache investigation
date: 2026-10-21
type: review
status: investigated
---

# Scope and evidence boundary

Investigate ordinary local refresh latency and cache invalidation before changing
product behavior. Preserve existing X reader changes and the running application.
No packaging, installation, external writes, or full test suite is authorized by
this investigation. Runtime observations, isolated experiments, and proposals are
reported separately. This is a point-in-time investigation, not current authority.

Checkout baseline: `94cc26f3`, with unrelated uncommitted X reader work. No
production source was changed by this investigation. The proposal is in
[the optimization plan](../plans/2026-10-21-refresh-calculation-cache-optimization.md).

## Initial observations

- Ordinary `overview` runs at 09:31:43 and 09:42:04 JST completed in approximately
  321 and 370 seconds. Both rebuilt accounting.
- Read-only index commit summaries show net increases of 56 and 49 usage-event
  rows respectively. Each run changed ten source units. Gross insertion counts
  include replacement of existing facts and must not be called new usage.
- Accounting reuse is bound to the index publication ID and fingerprint. The
  fingerprint includes the monotonically increasing commit sequence.
- Indexing, exact pricing, calibration, time-window projection, publication, and
  UI status are separate concerns. A safe optimization must retain their
  provenance, cancellation, correction, and last-good-result guarantees.

## Investigation plan

1. Inspect source replacement and publication rules. Distinguish true fact
   changes from metadata-only or semantically identical re-extraction.
2. Make a consistent, owner-protected copy of derived SQLite state for offline
   characterization. Never run a collector, migration, or writable experiment on
   the original databases; never read raw private sessions as test fixtures.
3. Measure cache-read/validation cost, accounting scan, calibration corpus,
   repeated usage passes, interval derivation, and publication separately.
4. Use synthetic cases for append, replacement, time advance, quota changes,
   cancellation, and semantic invalidation. Only targeted checks are needed.
5. Propose the smallest coherent stages, with explicit acceptance criteria and
   limits on what experiment results prove.

## Experiment safeguards

- Experimental scripts and private derived copies stay in a dedicated ignored,
  owner-protected directory. Retained evidence contains only aggregate counters,
  durations, source-relative code locations, and result comparisons.
- A consistent SQLite backup reads originals through read-only connections.
  Experiment writes target only the dedicated copy.
- Characterization uses a fixed clock and an empty synthetic Codex directory;
  any missing live origin metadata is an explicit comparison limitation.
- No relaxed generation checks, skipped validation, fabricated current labels,
  enlarged resource limits, or changed production refresh interval.

## Environment and reproducibility boundary

The running Windows x64 candidate is the local
`candidate-x-session-permissions-ready` artifact. Its ASAR SHA-256 is
`57ef3f37267a0d70806230ea1af19c255abc989b5da859799df8a0fb085c9502`.
The consistent SQLite backups passed `quick_check`; originals were opened
read-only and were not migrated or written. Copies, CPU profiles, generated
cache objects and experimental scripts remain ignored and owner-protected.
Only aggregate results are retained here.

The live index has store version **6**; the checkout reader expects **7**.
The first attempt with the checkout correctly failed
`local_index_family_mismatch`. No version was relabelled. Successful experiments
used the candidate's staging closure: the store, report, accounting-source,
calibration, replay-cache and companion-source modules were compared byte for
byte with the ASAR. Store and report differ from checkout; the other four match.
This distinction matters when implementing against the newer source schema.

Characterization ran under Node.js **22.21.1**, Windows x64, at a fixed clock
of `2026-10-21T01:30:00.000Z`, with an empty synthetic Codex directory and no
declared-speed ledger. It read copied derived facts, not raw private sessions.
No login, collector scan, production timer change, packaging or UI automation
was performed. This is not an Electron, installed-artifact or release benchmark.
Missing live origin metadata and the fixed baseline inputs limit equivalence
to the real application. CPU profiling, wrapper callbacks, warm filesystem
caches and concurrent host activity also affect timings.

## Measured calculation and publication costs

One instrumented complete cache build returned valid, available history and
weekly intervals, with a serialized cache of 11,364,544 bytes. Its build took
**128.2 seconds**; setup, generation read and final validation brought the
measured harness to 132.5 seconds. Process CPU time was 143.1 seconds; sampled
peak RSS was 1,239 MiB. Nested phase timings must not be added to the total twice.

| Work inside the cache build | Elapsed |
|---|---:|
| Accounting event scan and accumulation | 42.1 s |
| Open calibration corpus | 8.4 s |
| Five complete calibration traversals | 60.9 s combined |
| Six additional range reads, 259,308 row visits | 7.8 s combined |
| Weekly origin lookup against empty synthetic directory | 0.03 s |
| Validate the completed cache, outside build | 0.37 s |
| Serialize the completed cache, outside build | 0.05 s |

Each of the five full passes visited **267,057 retained usage rows**. The corpus
also held 23,515 quota observations. Four full passes fit the current and
historical plans; another computes weekly intervals. Range reads support
transition derivation. Thus a small source change can cause repeated conversion
and pricing of a large retained history.

CPU samples locate substantial self time in accounting-row iteration,
`projectUsageRow`, `streamProjectedRange`, pricing and timestamp/model
normalization. Garbage collection alone accounts for about 7.8 sampled seconds.
The profile supports repeated projection/allocation as a target; sampled self
times are not independent wall-clock phases.

A separate publication experiment wrote the rebuilt cache only into the copied
collector store, then called the candidate's `buildLocalCompanionSnapshot` with
the same full companion/work-usage projection shape used by the server.

| Publication work | Elapsed |
|---|---:|
| Atomic accounting-cache publication into copy | 0.21 s |
| Full index projection including work usage, nested in cold snapshot | 3.19 s |
| Cold snapshot build | 7.35 s |
| Same snapshot with its exact projection reused | 4.39 s |
| Clone and serialize the completed snapshot | 0.14 s |

Both snapshots were JSON-identical; serialized size was 13,696,029 bytes.
Collector worker reads took 0.75–0.88 seconds. The reused projection clone took
0.07 seconds. This isolates calculation from serialization: making JSON or
SQLite cache writes faster is not the first priority. It does not measure the
entire server reload, final durable dashboard write, ingestion or renderer.
The two observed 321/370-second refreshes are **not fully explained** by this
fixed-copy benchmark; no unmeasured remainder is assigned a fabricated cause.

## Controlled experiment: share a traversal without changing the fit

The existing `fitCompositionFromCorpusStream` seam was used for all four plans
over the same frozen corpus. Control: execute existing fits sequentially, each
using its own complete traversal. Treatment: register the same four consumers,
dispatch one ordered traversal to them, then let each existing fit finish.
Every consumer received the same row order. No algorithm, pricing function,
attribution rule or resource ceiling was changed; no full event array was added.

| Variant | Elapsed |
|---|---:|
| Four separate traversals and fits | 24.24 s |
| One shared traversal, same four fits | 9.45 s |

`JSON.stringify` of the complete fit results was identical. This is a **61.0%**
reduction in this component, not a claim about total-refresh latency. This A/B
run was unprofiled and warmer than the preceding build; compare its two variants
with each other, not its absolute time with the profiled five-pass total.
Corpus opening took 4.54 seconds; sampled process peak was 631 MiB for the whole
A/B harness, including both result sets. One data population does not prove all
failure, cancellation, plan-boundary or memory-limit cases.

An additional threshold explains why naive row caching is not sufficient:
the resident-row decision budgets all **456,149 candidate rows**, although only
267,057 survive the light filter. At the current conservative 738 bytes per
candidate, the reservation slightly exceeds 320 MiB, so this copy takes the
streamed path and repeats projection on later passes. This is a verified current
threshold, not proof of when or why a historical slowdown first appeared.
Raising the cap or retaining unlimited objects would hide the scaling problem.

## Confirmed invalidation and ingestion behavior

[Refresh reuse](../../src/local-companion-refresh.js) requires a valid accounting
cache bound to the new index generation, correct semantics, sufficient weekly
intervals and zero fallback. The generation fingerprint includes `commit_seq`.
This is an essential consistency check, not a guard to disable.

[Index refresh](../../src/local-index-refresh.js) promotes an append to a full
`response_reconciliation` rescan if the source already contains modern response
usage, even when the appended tail contains no new accounting facts. Shared
session replacement can widen that rescan. The extraction reconciliation prepass
also reads the prefix before the main pass. The published `bytesScanned` counter
does not include all these reads, so it understates total physical work.

The independent synthetic experiment used ten sources per case, with no real
private session content. The parent verified the relevant rescan, commit and
extraction paths and reviewed the aggregate outputs.

| Synthetic append | Rescans | Added / removed usage rows | Commit-sequence increase |
|---|---:|---:|---:|
| Modern source, ignored tail | 10 | 10 / 10 | 10 |
| Modern source, exact duplicate response | 10 | 10 / 10 | 10 |
| Modern source, genuinely new response | 10 | 20 / 10 | 10 |
| Legacy source, ignored tail | 0; 10 resumed | 0 / 0 | 10 |

The legacy ignored-tail case left all inspected fact tables unchanged but still
changed the publication generation. Modern no-op cases preserved usage facts
but also accumulated unused account-scope dictionary rows; they are not
literally byte-identical databases. Thus there is real avoidable invalidation,
but comparing only token totals would be unsafe.

Modern rescans currently protect retroactive legacy suppression, late model
recovery, response-ID conflict detection, fork/source ownership and physical
record ordering. An append cursor without persisted reconciliation state cannot
safely replace that mechanism.

## Existing facilities and constraints on reuse

- [Rollups](../../src/local-index-rollup.js) already aggregate exact token
  components by 15-minute bucket, model, tier, surface, account, NULL/conflict
  shape and context-price class. Prices are resolved on read. The report reader
  expands buckets crossing time or declared-speed boundaries. Reuse this
  traversal; do not add another aggregate ledger.
- Its current key omits pricing-evidence flags. Accounting preserves
  `PARTIAL` and `CACHE_WRITE_ASSUMED_ZERO`; the report projector does not preserve
  the same coverage semantics. Existing rollup/report parity tests therefore do
  not prove accounting parity. Unsafe groups need event fallback, or a reviewed
  evidence-class/basis/schema change.
- Report `all` means all history; replay-cache `all` is window-bounded with
  separate history. Report and recent-accounting future cutoffs also differ.
  Per-model coverage, exact decimal money and sparse timeline shapes must use
  accounting's canonical accumulator, not a renamed report object.
- [Calibration](../../src/local-index-calibration.js) already exposes a bounded
  layer memo and single-flight work. Current production callers do not use that
  memo; its exact `commitSeq` and `endMs` key would in any case miss on most
  ordinary refreshes. Wiring it in without an input/validity design is not a fix.
- The server already shares companion/work-usage projection work with generation
  and time-membership checks. It serves both overview and work breakdown routes;
  work usage is not simply an accidental discarded calculation. The experiment
  shows only a secondary saving here, not a reason to duplicate that cache.

## Conclusion and remaining gates

The strongest proven targets are repeated history traversal/projection and
coarse invalidation. Cache serialization and atomic publication are small in
this experiment. Start with shared calibration traversal, then reuse the
existing rollup traversal with canonical accounting semantics, then separate
calculation-input validity from publication metadata under an explicit contract.
Modern incremental extraction belongs to a later, separately justified stage.

No product fix, new schema, committed test fixture, full suite, package or restart
was performed. Experiments wrote only private copies or synthetic files. Future
implementation needs targeted parity and failure tests against the current v7
checkout, followed by separately authorized real refresh/artifact validation.

Documentation validation passed: `pnpm run docs:check`,
`pnpm run test:preflight` (20 documentation/guidance tests), and
`git diff --check`. These checks do not qualify product performance or the
unimplemented optimization.
