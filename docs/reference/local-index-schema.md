---
title: Local Index Store Schema
date: 2026-10-12
type: reference
status: maintained
---

# Local index store schema

This is the maintained reference for the local index store that the companion
reads and writes: `src/local-index-store.js` (DDL, writer, open rules),
`src/local-index-rollup.js` and `src/local-index-work-rollup.js` (aggregates),
`src/local-index-pairing.js` (cache-impact pairs), `src/local-index-refresh.js`
(incremental refresh) and `src/local-index-backend.js` (the companion seam and
`audit()`). The retired unified v1 schema reference is superseded by this file;
its history is in Git. Recovery procedures are in
[the local index recovery runbook](../runbooks/local-index-recovery.md).

Path storage is governed by the accepted
[v2 decision](../decisions/2026-10-12-local-index-v2-and-local-paths.md). The
store holds no prompt, response, reasoning, command, or free text. It does hold
absolute rollout paths, rollout file names and working directories, which are
local-only and never leave the owner-only file.

## Identifiers

| Identifier | Value | Meaning |
| --- | --- | --- |
| File name | `local-index-store-v1.sqlite` | Stable machine path in the state root. The `v1` is a name, not the schema version. |
| `PRAGMA application_id` | `1431128370` (`0x554D4932`) | Format guard. A mismatch fails with `local_index_family_mismatch`. |
| `meta.family` | `local-index-store` | Logical family, written once at creation. |
| `PRAGMA user_version` | `11` | Format version. Ordinary runtime opens only 11. The first writable open of a v9 store runs v9→v10→v11; a v10 store runs v10→v11. Read-only older opens remain refused. The historical v8→v9 copy tool is retired under v11. |
| Parser stamp | `local-index-rollout-typed-v3+unified-rollout-typed-v22` | Bounds legacy overlap by occurrence, rejects conflicting response copies and retains captured request speed. Existing present sources reparse under the new semantics; original records and retained absent-source facts remain untouched. |
| Telemetry publication parser label | `unified-rollout-typed-v22` | The shared extractor revision fits the existing v1.1/v1.2 wire contract. Internal store stamps and the publication fingerprint retain store provenance; no hosted schema is widened. |
| Commit sequence | `store_state.commit_seq` | Monotonic publication counter. Readers key their caches and the companion generation id off it. |
| Calculation revision | `store_state.calculation_revision` | Monotonic semantic-change counter, committed with facts. Equality can support a calculation reuse proof; it does not replace the publication fence. |

Fail-closed rules, in the order `openLocalIndexStore` applies them:

- A wrong `application_id` refuses the file with `local_index_family_mismatch`.
  `meta.family` is written at creation and checked again inside the v8→v9
  conversion transaction.
- A `user_version` greater than 11 fails with `local_index_newer_version`. The
  guard runs before write-mode configuration and schema migration; the file
  must not be relabelled.
- Version 4 through version 8 are not migrated by ordinary runtime; they fail
  closed as reviewed historical predecessors. A writable open of version 9
  applies both steps in one transaction and advances directly to 11: it adds
  the impact manifest tables and indexes, then replaces the derived
  `work_rollup` with the tiered key, creates `workload_bucket` and marks both
  projections pending. Before installing the tiered definitions it drops the
  five legacy `work_rollup_*` triggers, which live on `usage_event` and
  `source` and therefore survive dropping the derived table. A version 10 open
  performs only the second step. An interrupted v9 open rolls back to 9; no
  intermediate v10 is published.
  Neither migration reads or rewrites source, fact or cursor rows. The
  standalone historical v8→v9 copy tool remains its own protected operation and
  is retired under version 11.
  Refresh first performs a bounded read-only identity inspection accepting only
  the one-time v9/v10 predecessors or current v11, validates the existing device
  salt, and only then opens the writer. This inspection exposes no database
  handle or old-format projection and makes no schema changes. Missing salt,
  foreign state, and newer versions are refused before any migration or salt
  creation. Version 4 through version 8 and read-only version-4 through
  version-10 opens fail with `local_index_family_mismatch`; readers never
  migrate state. Only a writable v9 or v10 open performs the additive migration.
  The [v11 migration decision](../decisions/2026-11-01-local-index-v11-migration.md)
  defines its protected-copy and claim boundary.
- A writer must see WAL mode after `PRAGMA journal_mode = WAL`, otherwise it
  fails with `local_index_journal_mode_refused`.

`upgradeLocalIndexV8ToV9(database)` is the shared connection-only conversion
transaction. It opens no file and does not select a journal mode, replay sources,
repair provisional facts or reconcile rollups. Its caller must establish copy
isolation, cold-state admission and the protected SQLite lifecycle separately.
It rejects an existing transaction and rechecks application, exact version 8 and
family under its own transaction before adding the nullable column. Ordinary
writer opens reuse the same conversion SQL; a one-time protected-copy tool can
run it without invoking the ordinary WAL writer. This helper alone is not a
filesystem, backup, activation or release qualification boundary.

The extractor's parser revisions set the meaning of each stored fact. A change
of extractor revision changes the parser stamp. Each source whose stamp differs
is rescanned on the next refresh (reason `parser_version`), and the companion
gives that first refresh the cold-build deadline.

### Reviewed model recognition recovery

When the reviewed model vocabulary gains an identity, sources with committed
unknown-model events and an older `source_diagnostic.modelRecognitionVersion`
are reparsed from their original records. No current or later model setting is
backfilled. The version-1 recovery includes GPT-5.1 Codex Max; it does not change
the store schema or global parser stamp. Known-model-only sources stay untouched.

Recovery shares the existing bounded model-attribution queue: at most eight
sources and 256 MiB per pass, with one larger source allowed to make progress.
The per-source recognition receipt commits with the replacement facts, so
cancellation or restart resumes the queue and still-unknown models do not loop.
The normal foreground refresh drains this queue before publishing. Token
quantities and unresolved speed modes retain their original evidence semantics.

### Runtime model evidence

`runtime_model_evidence` retains content-free native-log receipts: canonical model,
previous model where explicit, kind, timestamp, digest, and device-HMAC thread,
turn and response joins. `meta.runtime_model_capture_v1` commits the log source
identity and read high-water mark atomically with each batch. Neither raw log
bodies nor provider IDs are saved. Existing rollout parser stamps are unchanged;
adding this evidence does not trigger a corpus reparse.

The running companion samples every 30 seconds, up to four batches per tick;
each batch reads at most 1,000 log rows and 8 MiB, with a 1 MiB individual-body
ceiling. Backlog ticks wait one second; three consecutive failures suspend this
timer until a global refresh retries it. No UI report is published by the timer.
Queued receipts do not advance `calculation_revision`: accounting reads the
published usage facts, not this queue. Applying or retracting a model repair at
the foreground boundary updates `usage_event` and advances both the calculation
revision and publication sequence. A validated writable v11 open atomically
retires only the three earlier `calculation_runtime_model_evidence_*` triggers
when present. Read-only opens never perform this correction. It preserves all
receipts, facts, cursors, revision values and the v11 physical schema; repeated
opens do not repeat the DDL.
Missing logs, capture failures, replacement and observed coverage gaps remain
distinct. Closing the companion stops capture and cannot protect upstream logs
from cleanup while it is closed.

Request context and explicit model-fallback outcomes are retained separately.
Only an exact successful-response receipt with an explicit response model can
repair an unknown model. Time proximity, setting changes, fallback attempts and
compaction compatibility hashes cannot establish it. Runtime repairs carry flag
32; contradictory receipts retract only such repairs and report a conflict.
Model updates maintain the existing rollups transactionally without altering
usage identities, Token fields, pairing, or raw sources. A source reparse clears
the derived flag; retained exact receipts can be reapplied without rereading logs.
Reconciliation runs at the foreground index-publication boundary before the
generation descriptor is read; the capture timer never mutates accounting facts
or changes a report generation in progress.

A repair confined to known response-model gaps uses the separate
`RESPONSE_MODEL_RECOVERY_VERSION`, not a global parser-stamp bump. The version
is committed per source in `source_diagnostic` with its corrected facts. Only
previously unattributed, not-yet-evaluated sources enter the repair queue.

## Tables

| Group | Tables | Purpose |
| --- | --- | --- |
| Catalog and format | `meta`, `store_state`, `commit_log` | Family and parser stamp, rollup basis, the commit sequence, and the newest 100 commit summaries (`kind` is `cold`, `refresh` or `verify`). |
| Dimensions | `model`, `tier_semantics`, `surface_class`, `account_scope`, `session`, `work_directory` | Interned values. Each row is referenced by id from facts. |
| Quota | `quota_observation`, `quota_occurrence` | Canonical quota readings deduplicated across sources, and source-scoped occurrences. |
| Sources | `source`, `source_segment` | One row per rollout ever seen: identity, cursor, digests, carried state and quarantine. |
| Facts | `usage_event`, `usage_event_boundary`, `tool_class_fact`, `work_lifecycle_fact`, `lineage_snapshot` | Typed usage, request boundaries, tool classes, task lifecycle and fork-replay membership. |
| Diagnostics | `source_diagnostic` | Counts per closed diagnostic code, per source. |
| Aggregates | `rollup_context_start`, `usage_rollup`, `work_rollup`, `workload_bucket` | Derived sums maintained by triggers (see below). |
| Cache-impact pairs | `cache_candidate`, `session_positive` | Derived pair and count tables maintained by triggers (see below). |
| Impact manifest | `publication`, `source_change`, `change_fact_count`, `impact_partition`, `integrity_gap`, `projection_watermark`, `repair_queue` | Durable per-publication change summaries, bounded impact regions, unknown gaps and projection watermarks. These tables describe changes; they do not make facts authoritative. |

Reader-only secondary indexes are created after a bulk load and whenever a
store with sources is opened for writing: `usage_event_observed`,
`usage_event_session`, `usage_event_quota` (partial), `usage_event_pairing`
(partial, positive-input requests only), `quota_occurrence_canonical`,
`quota_occurrence_observed` and `quota_observation_series`.

### Key columns

- `session.session_local`, `source.source_local` and `account_scope.scope_local`
  are 32-byte HMAC-SHA-256 values keyed by the device salt, each with its own
  domain label. `session.session_uuid` is recorded only when the provider
  session identifier is strictly UUID-shaped.
- `source.source_ordinal` is unique, non-negative and assigned once per source
  (see Invariants). Hosted quota observation identifiers depend on it.
- `source.file_id` is the exact decimal `device:inode` text, or NULL when the
  platform reports no usable id. NTFS ids can exceed 2^53, so the store never
  compares them as doubles.
- `source.rollout_key` is the rollout file name (the last path segment) and
  `source.path` is the absolute path. Both are local-only.
- `source.presence` is `present` or `absent`. An absent source keeps its row,
  ordinal and facts.
- `source.scanned_bytes` is the commit marker for the source's facts (below).
  `size_bytes`, `mtime_ms`, `ctime_ms` and `birthtime_ms` are the stat tuple
  used to classify the next refresh.

### Facts

- `usage_event` is keyed by `(source_id, source_offset)`, where the offset is
  the end of the JSONL record. `event_key` is the 32-byte event identity, the usage
  `eventId` that hosted contribution uses (plan section 7.5). `reasoning_effort` is an ordinal into the
  append-only list `none, minimal, low, medium, high, xhigh, max, ultra,
  unknown`. `work_directory_id` NULL means unknown.
- Token columns are `tokens_in_uncached`, `tokens_in_cache_read`,
  `tokens_in_cache_write`, `tokens_out_text`, `tokens_out_reasoning`,
  `tokens_out_combined` and `total_input_context`. NULL means unavailable, and
  an unavailable component is never stored as zero. A combined output that
  contradicts its split is stored as extracted and is detectable through rollup
  shape bit 12.
- `usage_event.flags` bits: `1` partial parse, `2` model inherited from a
  logical parent, `4` cache-write count assumed zero, `8` status-only quota
  report with no spend, `16` reconciled per-response usage. Response identities
  use device-local digests and the partial `usage_event_response_identity` index;
  duplicate physical copies do not add spend. Conflicting quantities, dates,
  models, tier evidence or component availability across physical copies fail
  with `codex_response_usage_identity_conflict`; enumeration order cannot select
  their price. Re-evaluating the same source can correct its attribution under
  the versioned reparse policy while preserving its response quantities.
- `quota_observation` is unique on `(observed_at_ms, limit_id, slot)`. When two
  sources report the same tuple, the whole reading with the higher
  `used_percent` wins, then the later `resets_at_ms`, so arrival order cannot
  change the result.
- `quota_occurrence` is keyed by `(source_id, source_offset, slot_order)`.
  `admission` is `admitted`, `held` or `suppressed`. Only `admitted` rows feed
  the settled quota windows.
- `usage_event_boundary` records whether a compaction or turn-context boundary
  precedes an event. The pairing, report, contribution and cache-drop readers
  consult it.
- `tool_class_fact` holds the extractor's tool-category label and source kind
  for each tool event. It holds no command or tool payload.
- `source_diagnostic` holds counts for the closed code vocabulary in
  `src/local-index-store.js` (for example `malformedLines`, `partialLines`,
  `oversizedLines`, `compactionEvents`). Unknown codes are dropped.
  Response counters also retain `responseUsageEvents`, `responseDuplicateCopies`,
  `responseForeignThreadRecords`, `responseModelUnattributed` and
  `responseUnverifiedPrefixTurns`. The latter counts source/turn pairs whose
  first exact response begins after a structurally valid but unverified
  cumulative prefix; only the exact response raw usage is charged.
  `responseModelsRecovered` counts models recovered from request/checkpoint
  evidence; `responseModelRecoveryVersion` records the completed evaluation
  version, including evaluations that remain unknown. Both move atomically
  with the source cursor and facts; cancellation/failure commits neither.
  `cumulativePrefixUnattributed` counts initial positive legacy cumulative
  snapshots without an independently reported latest increment. Such a snapshot
  establishes a baseline, not a request's model, time or charge. Later supported
  deltas remain countable. Coverage readers report null for unevaluated sources;
  a known positive prefix count survives alongside older sources and prevents a
  complete-history claim.

### Response and legacy reconciliation

`token_usage_record.usage` is one response, including separately recorded
compaction and ordinary responses absent from `token_count`. The first response
in a physical turn may start after a nonnegative cumulative prefix; that prefix
is not charged and increments `responseUnverifiedPrefixTurns`. Every later
response must continue the chain exactly. A legacy spend row is suppressed only
when all its known per-response components match a distinct occurrence in a
complete modern turn. Matching consumes a vector occurrence once; several equal
legacy rows cannot all disappear against one response. A narrow continuation
exception accepts one preceding, same-thread/turn checkpoint whose retained
response ID is the compaction response ID and does not occur in the ordinary
response stream. Its explicit six-component raw and turn totals must equal the
first response's cumulative prefix. Each suppressed legacy row must be adjacent
to a distinct ordinary response at the same instant, with explicit latest usage
and a valid preceding thread-cumulative delta both equal to that response's raw
usage. Repeated, late, incomplete or contradictory checkpoint evidence does not
qualify. The checkpoint prefix is not charged, priced or marked complete;
`responseUnverifiedPrefixTurns` and model/speed uncertainty remain unchanged.
Other unknown-prefix overlap, missing per-response vectors and unmatched overlap
fail visibly. Legacy quota
observations and legacy-only turns remain. Identical
Token vectors with distinct response identities are distinct calls. Compaction
checkpoint copies and ancestor responses in forked physical history are not
new calls; cumulative thread/turn snapshots are never summed as spend.

The [2026-10-22 ledger audit](../reviews/2026-10-22-main-ledger-accuracy-audit.md)
identified reproducible overlap and attribution defects. The
[normalization repair record](../reviews/2026-10-22-ledger-normalization-fixes.md)
records source fixes and synthetic validation, not a revalidated historical
ledger. A total-only row overlapping a modern turn remains a conservative
conflict: paginated files can inherit a cumulative baseline, so the first
physical row cannot safely be discarded merely because it is first.

Changed modern files replay their retained prefix atomically. This includes a
first modern append after an earlier legacy publication. Ordinary unchanged
files still skip without a new transaction. Source-local segment hashing covers
the publication pass, independently of the bounded reconciliation prepass.
Foreign-thread response copies alone do not switch a source into own-response
accounting. If append reconciliation requires a full replay, the transaction
rolls back and retries that exact source once with replacement segments; it
does not publish a partial append or loop indefinitely on the same failure.

This continuation exception only admits previously rejected sources. It does
not change facts, identities or attribution for previously accepted inputs, so
the existing parser/model-recovery stamps remain valid. A rejected source has
no successful new cursor to invalidate; its next ordinary retry re-evaluates
the preserved source. No database format or accounting-cache relabel is needed.

The accounting reader preserves nullable components and canonical output
representation instead of substituting zero. Partial, assumed-zero and
conflicting evidence cannot establish fully observed pricing. Derived replay
caches use `local-replay-safe-accounting-v0.26`. Older cache formats require
the explicit copy-only conversion: their complete original values and dated
history are preserved in a new historical envelope before a new calculation
may publish. Runtime code does not interpret old cache schemas, relabel them,
or clear the collector database. The selected unknown-speed assumption and
custom ratio bind each new calculation and its allowance basis. This accounting-cache revision is
independent of the local-index schema migration above and does not delete
accumulated history. All six-place monetary margins use exact decimal
accumulation and half-up rounding, independent of whether events are grouped. Context partitions come
from reviewed model cards across tiers; a missing Priority long-context card
remains unpriced rather than inheriting the short-context rate.

The established model attribution remains when context and persisted settings
are coherent at the response. A setting written shortly after its context does
not invalidate that existing evidence. Additional recovery only fills gaps.
Ordinary responses can retain a fresh request context frozen before the response,
even when thread settings change while it runs. A context already contradictory
when captured, reused after a setting change, or preceding an unverified first
response prefix cannot prove that attribution. A compaction response can use
its exact checkpoint identity, matching raw/cumulative counters, record/time
order, and the next same-turn replacement context when the checkpoint's prior
model agrees. Different prior/replacement models or observed rerouting remain
unknown when recovery is needed. A checkpoint quantity/turn conflict fails explicitly with
`codex_response_usage_checkpoint_conflict`. Later UI/parent settings never fill
these gaps. Speed attribution remains independently evidenced by the captured
request context. Its explicit unknown value cannot fall back to a later mutable
setting. A fresh captured request can survive an in-flight speed change; reuse
after that change needs new evidence. Legacy settings apply only to preceding
physical records, with ordinal order breaking equal timestamps. A preceding
future-dated setting leaves speed unknown instead of borrowing an older value.
Compactor speed recovery requires independent prior-settings evidence agreeing
with the replacement context; the replacement alone proves no earlier speed.

The provider scanner is `codex-log-scan-v13` and the checkpoint scanner is
`codex-export-checkpoint-scan-v0.9`. Both reuse the provider's closed task
lifecycle normalizer and treat completion and cancellation as terminal within
the source's own task scope. Malformed terminals remain diagnostic, not closures;
future terminals cannot close an earlier window. Changed scanner compatibility
prevents old open-task checkpoints from resuming under the new semantics.
The checkpoint workspace retains a private,
domain-separated proof alongside each opaque response identity; identical copies
deduplicate and conflicting evidence poisons that workspace. Old proofless
checkpoints fail version compatibility rather than silently resuming. These
semantic revisions do not change the physical index schema version 11.

Unknown models and missing/conflicting evidence remain model `unknown`, with
unknown tier and unpriced amounts; Token counts remain available.
Invalid identities, quantities, timestamps, incomplete
chains, conflicting legacy evidence and exhausted bounds have distinct
`codex_response_usage_*` errors. Raw response/thread identifiers stay only in
scan-local memory, not diagnostics or persisted parser state. Limits are 100,000
distinct responses and 250,000 relevant records per retained source scan.

Supported modern accounting evidence is exact standalone response usage. A
first response may have a valid cumulative total that includes an unobserved
prefix: only that response's raw usage is counted, the prefix is never inferred
as spend, and response-usage coverage remains partial for that source/turn.
Every following response must continue the observed cumulative chain exactly.
Checkpoint history remains opaque. A complete supported compaction envelope
can project only its closed receipt suffix using a 512-byte header and at most
128 KiB of trailing bytes; no replacement history is retained or parsed.
Unsupported/missing/oversized metadata cannot establish a model. Checkpoint
copies are never a second source of additive spend.

Recovery reads at most eight affected sources or 256 MiB of source bytes per
batch (one larger source may progress alone). It does not fan out to other
unchanged files in the same session. The backend drains decreasing batches in
one cancellable update under the existing recovery deadline; stalled progress
fails explicitly. Successfully evaluated unchanged sources skip with no fact
write or content rescan, even if attribution remains unknown. Source content
changes and future recovery-version changes permit another evaluation. Existing
source identity, segment integrity, transaction and replay checks still apply.

### Source state

`work_lifecycle_fact` records cursor-bound task starts, completions and
cancellations, observed time, a device-HMAC task key, session relation and optional
reported duration. It retains no original task ID or content. Facts above a
source cursor are provisional; recovery and source replacement remove them with
the other affected facts. Work includes tools and necessary waiting, and parallel
intervals count once. Inference performance timing remains independent.

Workload policy `task-workload-v12` projects, rather than rewrites, these facts.
Retained unambiguous ancestry identifies copied task boundaries, including
paginated forks; a copied completion must also match the ancestor's reported
duration. New child work remains included, and unsupported/cyclic ancestry does
not establish replay. One shared ownership resolver applies this evidence to
replay, branch cancellation and child continuation. When an ancestor has exactly
one own start and one own completion with valid time order, descendant branch
aborts do not create another ending for that completed ancestor. The abort facts
remain stored and are not relabeled as copied events. Genuine child task
cancellation remains work; missing ancestor completion, unrelated sessions,
multiple own terminals, differing completions and ambiguous ancestry retain the
existing continuation or conflict behavior. Complete ordered timestamp boundaries define work even
when the reported timer differs by seconds. Missing starts still require a
valid reported duration; reversed or unpaired conflicting boundaries remain
errors. The projection reports replay and duration-difference counts.
An orphan contributes no historical continuous-work interval without terminal
evidence. Later same-session task starts bound its observation context, not an
inferred completion. Its uncertain context excludes already-proven parallel
union coverage; explicit boundary conflicts remain fail-closed. Fresh tasks
starting during this run remain provisionally active only while no newer task
context supersedes them. Session receipts cannot reactivate an old orphan.
Incomplete work cannot train or receive a workload class or current pace.
The deterministic three-partition fit keeps equal intensities atomic and uses
its fitted cuts for all assignments, retaining minimum bin-count and duration
constraints. Unsupported three-class fits remain unavailable. This changes the
projection policy only: lifecycle and usage facts remain intact, with
uncertainty surfaced as `work_boundary_incomplete`.
The reader supplements its display-window lookback with committed older facts
for the same tasks in established ancestor sessions. Lookups share the reporting
transaction, use batches of at most 128 task keys and refuse more than 100,000
supplementary candidate facts. Older evidence establishes replay only; output
displayed work coverage remains clipped to the seven-day range; complete change
intervals retain their earlier work context for rate denominators. Missing,
ambiguous or cyclic lineage never justifies deduplication.

Quota consumption pairs observations inside an account/plan/window stage.
The first confirmed plan observation establishes its baseline at that observed
percentage and time. Earlier consumption is never backfilled into that plan,
even when reset deadlines match. A first reading of 97% remaining followed by
95% therefore contributes two percentage points, not five. Plan-stage boundaries
and scheduled reset-window boundaries remain independent.
An increase in used percentage closes a consumption interval. A decrease starts
a new stage at that reading; it contributes neither negative consumption nor a
scheduled reset claim. For example, used percentages 30, 36, 21, 30 produce
6 + 9 = 15 percentage points. Historical high watermarks do not reject the
recovered balance. Equal readings refresh freshness without moving the
first-change allocation anchor. Complete interval usage denominators remain
available before display clipping; pending zero-change tails do not train rates.
The collector's durable record order distinguishes separate completed reads
at the same millisecond. Same-observation contradictions and unordered
simultaneous conflicts still break coverage. Source facts remain unchanged;
replaying them reconstructs the same stages and totals.

Overview groups committed usage timestamps into five-minute bins without
splitting fifteen-minute display rollups. The `overview-workload-v7` comparison
reports two startup totals in percentage points, without a rolling display
window or relative-ratio curve. Actual consumption sums only within each reset
identity and recovery stage; unmatched usage across reset boundaries
and simultaneous quota conflicts remain explicit. Expected consumption uses
the same covered intervals and the first known capacity frozen for that startup.
The seven-day history retains all plan periods. The
[owner-approved overview policy](../decisions/2026-10-19-overview-plan-period-inference.md)
`observed-plan-period-v1` assigns a missing plan label from the most
recent preceding explicit plan observation in the same quota family. It does
not fill before the first anchor, override explicit labels, or infer account
identity. Conflicting simultaneous labels or explicit account changes break
continuity. This is a marked, recomputable projection; stored occurrences remain
unchanged. Since the owner's 2026-10-23 decision, the startup comparison also
uses this same plan-period helper over its combined index, direct-read and saved
baseline observations. Its `comparison.inferred` boolean marks accepted pairs
with inherited labels and is disclosed beside the comparison. A missing label
after an explicit anchor alone no longer freezes cumulative totals. This grants
no account identity or reset authority. The reader retains a
preceding committed anchor for a period that starts outside the display range.
The response reports inferred/unresolved observations, per-day plan groups and
inferred markers. Same-day plan groups render separately, and pairing never
crosses plan-period or reset boundaries. Remaining-hour rates use only the most
recent period matching the current plan; sparse samples remain unavailable.
The result includes `segmentation` (`quota-recovery-stages-v2`) and `unallocated`.
Each segmentation plan reports `closedIntervals`, `observedPp`, `dailyPp`,
`outsidePp` and `unallocatedPp`; the last three conserve the observed total
within floating point tolerance. Plans are not pooled. Complete priced usage
allocates by local date and existing five-minute workload class. Incomplete
pricing never assigns unknown weight to known usages. Same-day fallback stays
unclassified in its daily group; an unassignable cross-day interval stays only
in `unallocated`. Its groups contain plan, total points and interval count;
at most twenty records expose only from/to, plan, points, inferred flag and a
closed reason (`history_incomplete`, `price_missing`, `usage_missing`). The
truncation flag does not truncate aggregate totals. The UI renders this section
last, outside all cards and diagnostics, with native keyboard disclosure.

History and startup comparison share chronological plan-period and weekly cycle
resolution, including the anchored five-minute deadline tolerance and validated
reset events, while keeping separate accumulation and identity policies. History
reset evidence has its own lookback and must not establish an older startup
account. A seven-day plus five-minute preceding context supplements the rolling
seven-day analysis. Usage reads refuse more than one million rows; quota and
initial work reads refuse more than one hundred thousand rows. Older plan anchors
can establish attribution but cannot turn omitted usage into zero. Incomplete
contexts qualify allocation and exclude affected hour samples. Read-only
analysis never refreshes or rewrites facts. Cancellation propagates; failures
preserve a marked last-good result.

The `overview-workload-v7` projection uses `current.windowMinutes: 15` for
API-equivalent workload. Receipt bounds are start-exclusive/end-inclusive;
`usdPerWorkHour` divides priced usage by clipped parallel union work time. At
least one minute of evidenced work is required. Incomplete history, unpriced
records and stale source evidence cannot produce a confident intensity or grade.
Numeric intensity can be known without fitted classification cuts. Completed
work can retain a grade until it leaves the window; idle requires complete evidence
with no recent work or usage. Capacity conversions still honor the plan boundary.

`trend.windowMinutes: 60` is independently observed quota consumption. Its state
is `available` or `unknown`; `ratePpPerHour` divides a positive observed quota
decrease by elapsed hours between `observedFrom` and `observedThrough`.
`coveredMinutes` describes that actual span, which can be shorter than sixty
minutes. Both endpoints must be inside the window and in one current plan period
and unexpired reset cycle. The shared marked plan projection supplies `inferred`;
identity changes, conflicts and ambiguous resets start a new pairing baseline.
Stale regressions and duplicates do not manufacture a decrease. Repeated identical
integers alone leave the rate unknown. Missing prices or work time cannot suppress
an independently evidenced quota trend. No API grade or work-hours forecast is
attached to this trend. Missing current-card values render as `-` without hint
text; specific errors remain in diagnostics.
The task-boundary detector retains its independent fifteen-minute unresolved
lookback. Neither window adds a scheduler or alters historical accounting.

Browser readers accept v2–v6 last-good results as stale, retaining v5+ unallocated
summaries without mixing older daily bars with new summaries. Legacy current
grades and trend units are not reinterpreted, and stale/unavailable
projections cannot display fresh recent grades or estimates. The next refresh
replaces the whole result with v7. Workload projections are recomputed and no independent durable
segmentation anchor or SQLite migration is introduced. Startup state remains v3.
Startup
reads extend beyond seven days when necessary. Its startup identity, frozen
capacity and capacity history persist in `private/overview-workload-state.json`
as `overview-workload-state-v3`, including the first accepted startup quota
baseline even when it came from a direct live read. Subsequent refreshes retain
that baseline instead of replacing it with a later indexed occurrence. A
baseline retains its source plan label, including `unknown`; projection never
persists an inherited label as an explicit observation. V1/v2
reads preserve capacity history, while writes are forward-only and refuse an
unknown newer state. Capacity history retains every validated plan and version;
plan selection and display-window slicing affect calculation inputs only.
The existing 4096-entry bound refuses a further version with a visible
resource-limit outcome and retains the last-good state rather than pruning it.
The same state
root, using the existing validated Windows protected private boundary. The
outer legacy state directory need not be rewritten. Write failures are visible
publication errors.

The startup comparison reads retained direct `app_server_read` quota snapshots
and their validated reset events through the secure collector facade, in addition
to committed rollout quota and the latest live reading. This bounded private
projection exports no account handles or raw records. It stops at changed/lost
established account continuity; notifications cannot supply reset authority.
Unreadable, malformed or over-budget history produces distinct quota-history
errors. Records, cursors and SQL schemas are never rewritten by this reader.

Cycles are resolved chronologically using explicit matching plan/limit metadata.
Validated `scheduled_reset`, `unknown_reset` and `banked_reset_used` events from
the corresponding direct observation can close a cycle before its old expiry.
The observed interval is evidence of a reset, not proof of its provider cause.
An unused zero window can report observation-time plus seven days repeatedly;
these readings remain one cycle until use/countdown anchors its deadline.
An anchored active cycle retains fixed first-deadline jitter bounds. Natural
renewal without an event still requires the old deadline to have elapsed and
a substantially advanced, plausible new weekly deadline. Retired-cycle
observations do not reopen a closed cycle. A recovery within the active window
starts a consumption stage independently of cycle resolution. Source occurrence
deduplication and deterministic replay prevent counting the same interval twice.

Unproven changes report `comparison_reset_ambiguous`; usage in an unpaired reset
interval reports `comparison_reset_gap`. Confirmed subtotals are retained, not
cleared. A confirmed reset permits subsequent new-cycle pairs even when the
boundary itself has a gap; ambiguous pairing stops until a confirmed reset.
Missing prices retain the known priced subtotal and remain explicit errors.
`comparison.coverage` is `complete`, `partial` or `unavailable`, and
`confirmedThrough` identifies the last confirmed pair. The comparison title
includes a small startup timestamp. The owner removed the separate startup and
partial-coverage paragraphs on 2026-10-23; the partial flag and unpaired-interval
errors remain in the projection and diagnostic details.
The browser accepts retained v2 snapshots and current v3, and refuses unknown
future versions. Private startup state remains v3. Seven-day and current-load
cards keep their existing data and semantics.

`source` carries everything a refresh needs to decide, without reading the
rollout header, what to do with a file:

- Cursor: `scanned_bytes`, `size_bytes`, and the stat tuple.
- Integrity: `head_digest`, `boundary_digest` and `tail_digest` (SHA-256 of the
  first 4 KiB, the 4 KiB before the cursor, and the open tail after the last
  complete segment). `source_segment` holds one SHA-256 per complete 256 KiB
  segment. `verified_at_ms` and `verified_bytes` record the last full
  verification.
- Carried state for the next append: `carry_model`, `carry_effort`,
  `carry_tier_raw`, `carry_tier_observed_at_ms`, nullable
  `carry_tier_source` (`turn_override` or `rollout_thread_settings`), the six `carry_total_*`
  counters, `carry_work_directory_id`, `turn_context_seen`,
  `turn_context_pending`, `compacted_at_ms` with `compaction_offset`, and
  `snapshots_persisted`.
  Version-8 carry rows have no source evidence; the v9 migration leaves their
  `carry_tier_source` NULL. A resumed event does not use that carry as an
  observed tier and remains `unobserved` until a new source declaration is read.
- `lineage_json`: the rollout lineage header, so an unchanged source needs no
  header read.
- `quarantine_code`: one of the extraction codes `codex_rollout_content_invalid`,
  `codex_rollout_tail_incomplete` and `codex_rollout_lineage_invalid`, or a
  discovery code `codex_rollout_compression_unsupported`,
  `codex_rollout_filename_identity_mismatch` and
  `codex_rollout_generation_ambiguous`. A quarantined source has no committed
  facts (`scanned_bytes` is 0) and is retried when its stat tuple changes.
- A stable unterminated JSONL tail is deferred rather than quarantining its
  valid complete prefix. `scanned_bytes` stops at the last complete line,
  `size_bytes` records the observed full size, and the closed diagnostic
  `deferredTailBytes` equals their difference. The tail contributes no facts,
  carried totals or lineage snapshots. Malformed complete accounting records,
  invalid headers, replacements and lineage failures retain their integrity checks.
  Compressed-source discovery and complete-export scans remain strict.
- Coverage counts only `scanned_bytes` as indexed bytes and includes deferred
  sources in `rolloutIssueCounts.codex_rollout_tail_incomplete`. They are not
  reported as wholly skipped or fully parsed; unknown response coverage stays
  explicit. Legacy tail quarantine codes remain readable for forward recovery.

## Invariants

- **Commit marker.** `source.scanned_bytes` is the publication point for a
  source. A fact whose `source_offset` is greater than it is provisional. Readers
  ignore it, and a writable open removes it (`repairProvisional`). Because fact
  offsets are record-end offsets, the last complete record can sit exactly at
  `scanned_bytes`.
- **One transaction per advance.** A source's facts, its cursor, its segment
  digests, its diagnostics, its carried state and its derived rows move in one
  `BEGIN IMMEDIATE` transaction. `commit_log` is written in the same transaction.
  A refresh that changes no source opens no write transaction.
- **Single writer, snapshot readers.** Writers take `BEGIN IMMEDIATE`. Readers
  run inside one read snapshot that pins a single `commit_seq`. A long reader
  pins the write-ahead log; see the WAL limits below.
- **Absence is not deletion.** A source that vanishes from disk becomes
  `absent` and keeps every fact. Rollouts are never modified.
- **Ordinals are never reassigned.** A new source takes the next unused
  ordinal, above the maximum already stored. The carried ordinal seed described
  below is reserved before any new source is registered.
- **Append-only closed vocabularies.** Reasoning-effort ordinals, flag bits,
  quarantine codes, diagnostic codes and admission states are part of the
  on-disk format. New values append; existing values never change meaning.
- **Replay-safe rescans.** A source is rescanned when its parser stamp, identity,
  cursor, quarantine state or digests disagree with its stat tuple, or when a
  segment digest or the head, boundary or open-tail digest fails. A rescan
  retreats the cursor before it removes the source's facts, so its counts are
  removed through the triggers and the replacement facts are counted only when
  the cursor advances again.

### Incremental refresh

`refreshLocalIndex` discovers rollouts under `sessions` and `archived_sessions`
below the Codex home, compares each with its catalog row by stat tuple, and
reads only what changed:

| Classification | Action |
| --- | --- |
| New source | Full read, registration with a new ordinal, one commit. |
| Same size, same stat | Skip. |
| Same size, different mtime or ctime | Rescan (`same_size_changed`). |
| Larger, not quarantined (including a deferred tail) | Append from `scanned_bytes` after the head, boundary and tail digests match (`append`). |
| Smaller, or cursor inconsistent | Rescan (`shrink`, `cursor_invalid`). |
| Identity changed (`file_id`, birth time) | Rescan (`identity_changed`). |
| Append candidate whose head, boundary or open-tail digests no longer match, or that cannot be read | Rescan (`boundary_changed`). |
| Compressed representation changed | Rescan (`compressed_changed`). |
| Closed segment digest mismatch (forced or due verification) | Rescan (`segment_mismatch`). |

Closed segments are verified in the background, not on every refresh. A segment
is due when the source has grown since its last verification, has been stable
for 10 minutes, and was last verified at least 24 hours earlier. A source with
at least one complete segment and no quarantine is verified at least every 7
days, whether or not it grew. A forced verification (`verify.force`) checks
every closed segment regardless of age. The companion does not pass it; it is
available to a direct `refreshLocalIndex` call.

An unchanged deferred tail skips without rereading it. A changed tail resumes
only after identity/stat and committed-prefix digest checks; a mismatching
prefix rescans instead of retaining stale facts. The cursor can remain below
`size_bytes` only with the exact persisted deferred-byte diagnostic. Completing
the newline atomically publishes the record, new cursor, totals and digests;
repeated refreshes do not count it again. A v11 store refuses older readers and
writers through the version gate; do not relabel it to run an older app.

Cold builds read new sources in parallel lanes. Those lanes write facts beyond
their cursor before the cursor moves, and `repairProvisional` clears the
leftovers after a crash. Between refreshes, the cursor, the stat tuple and the
digests are the only state that carries over from one refresh to the next.

### Write-ahead log limits

`LOCAL_INDEX_WAL_LIMITS` sets a soft limit of 64 MiB and a hard limit of
1 GiB. The hard limit is lowered to 10 % of free disk when that is smaller, and
never below the soft limit. A refresh checks the log before each write
transaction. At the hard limit it stops starting transactions and returns
`status: "deferred"`. Everything it committed stays valid and resumes from its
cursor. The backend turns a deferred refresh into
`local_unified_index_publication_busy`, which is never reported as a
publication. The store must sit on a local volume; roaming or network profiles
are unsupported for WAL (plan section 14).

## Aggregates

Aggregates are sums of the facts at or below each source's cursor. Triggers keep
them current: an insert or delete on `usage_event` adjusts its group, and an
advance or retreat of `source.scanned_bytes` adds or removes the facts it
crosses. A group whose event count reaches zero is pruned.

### `usage_rollup`

Key: `bucket_ms` (15-minute UTC bucket), `model_id`, `tier_id`, `surface_id`,
`account_scope_id`, `shape`, `ctx_class`.

- `shape` is a bit set: bits 0-5 mark which of the six token columns are NULL,
  bits 6-11 mark which are positive, and bit 12 marks a combined output that
  contradicts its split.
- `ctx_class` is `-1` when total input context is unavailable. Otherwise it is
  the number of price-registry thresholds at or below the total. The thresholds
  are each registry boundary and the token after it (`rollup_context_start`).
- Measures: `events` and the six token sums, with NULL counted as zero inside a
  sum only because the shape key keeps NULL and zero groups apart.
- The only supported production mutation of `usage_event` is runtime model
  attribution, which changes `model_id` and `flags`. `model_id` has its own
  update trigger; `flags` is not part of this key. No production path updates a
  token, observed-time or context column. A future path that does must add the
  matching update trigger rather than rely on this closed set.

Nothing stored here is a price. The registry fingerprint is kept in
`meta.rollup_basis`. When a writable open finds that the fingerprint differs
from the current registry, the rollups are regrouped from the facts. Rollups
are never regrouped from rollouts.

### `work_rollup`

Schema 11 key: `day_ms` (UTC day), `session_id`, `work_directory_id` (0 for
unknown), `model_id`, `tier_id`, `account_scope_id`, `shape`, `ctx_class`,
`prov`.

- `prov` bits: `0` partial parse, `1` cache-write assumed zero, `2` status-only
  quota report.
- Measures: `events`, the six token sums and `last_at_ms`. `last_at_ms` is the
  one non-additive value. A delete that removes a group's latest event clears
  it to NULL, and the reader falls back to raw events for that day. A key or
  measure update also clears it rather than claiming the new event time is the
  group maximum.
- Insert, delete, cursor advance/retreat and every participating key/measure
  update are trigger-covered. The update trigger removes the old contribution,
  prunes an emptied row and accumulates the new one.
- It is rebuilt together with `usage_rollup` when the registry basis moves.
  The v10→v11 migration discards the old untiered rows, replaces the five
  legacy trigger definitions before the new table is usable, and marks the
  projection pending; a bounded backfill rebuilds it from committed facts.

### `workload_bucket`

Five-minute UTC projection for the overview workload reader. Key:
`bucket_start_ms`, `session_id`, `model_id`, `tier_id`, `account_scope_id`,
`shape`, `ctx_class`. Measures: `events`, the six token sums and `last_at_ms`.
No price is stored. `account_scope_id` keeps a future account-scoped view from
silently mixing scopes.

The same insert/delete/cursor/update trigger matrix applies. A cleared
`last_at_ms` is explicit and recomputed or expanded by the reader; it is never
treated as zero activity. `workload_bucket` has its own pending/ready watermark
and is not part of the work-usage rollup. It is rebuilt with `work_rollup` when
the registry context basis moves.

### Cache-impact pairs

- `cache_candidate` holds one row per qualifying pair: a positive-input request
  and the offset of its predecessor in the same source. A pair is in the table
  only while both facts are committed.
- `session_positive` counts positive-input requests per `(session_id,
  source_id)`, so a session that spans several sources can be checked without a
  scan.

A source belongs to one session. That makes "the previous request in the
source" the previous request in the session.

### Audit contract

`audit()` on the backend (`src/local-index-backend.js`) compares every derived
table with a fresh derivation from the committed facts, inside one read
snapshot. It is read-only, returns counts only, and never repairs:

| Oracle | Compares | Counts |
| --- | --- | --- |
| `auditRollups` | `usage_rollup` with a regrouping of committed usage events | Rows missing, extra or different, plus rows with `events <= 0` |
| `auditWorkRollups` | `work_rollup` with a regrouping of committed usage events, including `last_at_ms` where stored | Rows missing, extra or different, `last_at_ms` mismatches, and rows with `events <= 0` |
| `auditWorkloadBuckets` | `workload_bucket` with a regrouping of committed usage events, including `last_at_ms` where stored | Rows missing, extra or different, `last_at_ms` mismatches, and rows with `events <= 0` |
| `auditPairing` | `cache_candidate` and `session_positive` with a regrouping of committed facts | Rows missing or extra in either direction, and rows with `events <= 0` |

The result is `{ status: "audited", commitSeq, rollup, work, workload, pairing,
projections, consistent }`. Each projection also reports its watermark status.
`consistent` is true only when all four counts are zero and both projections
are `ready`; an empty `pending` projection is not called consistent. A missing
or unreadable store returns `{ status: "unavailable", consistent: false }`. The
audit does not create a store, does not take a write lock and does not change
`commit_seq`.

The backend runs a separate maintenance worker after its first completed
ingestion in each process, including a restart after an unclean shutdown, and
at the next completed refresh at least 24 hours after the last successful audit.
Clean restarts also audit; no clean-shutdown marker is inferred. This is an
idle ingestion boundary before generation/accounting reads, not a report path
or an independent timer. Failed or cancelled maintenance remains due. A
pending projection is retried on the next refresh so bounded backfill batches
can finish; a fully consistent audit caches the daily interval.

The worker audits a read snapshot first. On drift it acquires `BEGIN IMMEDIATE`,
rechecks the oracles under the writer lock, rebuilds only mismatched ready
derived tables from committed facts and verifies them again. A pending
projection is built by bounded range batches instead of a competing full
rebuild. Each batch commits separately and leaves its queue cursor at the last
completed range, so cancellation or WAL pressure resumes rather than restarting.
Only the final readiness transition publishes a `verify` commit; per-batch
commits do not advance `commit_seq`. A `stale` projection is rebuilt from
committed facts under the same WAL gates and becomes ready in the atomic
`verify` publication. Repair and that publication are atomic, so
publication-dependent caches cannot reuse the pre-repair generation. Clean
audits never advance the sequence. No rollout is read, no source ordinal is
changed, and no schema, salt or absent-source fact is replaced. Cancellation
terminates the worker; SQLite rolls back any uncommitted transaction. Failure
preserves the last committed state and blocks this refresh's downstream
publication.

Maintenance returns counts only, with `status: "audited"`, `"repaired"` or
`"pending"`. For a repair the counts describe the pre-repair differences and
`consistent` is true only after verification. A missing or incompatible store
fails closed.
Before repair, the worker uses the refresher's WAL/free-disk ceiling and reserves
twice the current store page footprint, including WAL frame overhead, under
the writer lock. Insufficient headroom returns
`local_index_maintenance_deferred`, rolls back and leaves maintenance due. This
is a conservative admission budget, not a measured schema-v4 WAL soak result.
SQLite's native lock wait may delay cancellation until its five-second timeout.

## Impact manifest

Schema 10 added the durable impact manifest tables and schema 11 keeps them
unchanged. The serial per-source refresh path writes `publication`,
`source_change`, `change_fact_count`, `impact_partition` and `integrity_gap`
rows in the same transaction as the facts and cursor. Cold lane builds,
discovery rejections, presence changes and direct runtime model corrections
record their own changes. A correction with more than 256 affected sources, or
with no attributable source, marks the publication `manifest_complete = 0`
rather than claiming a complete list. The manifest is descriptive: readers use
committed facts or a projection whose watermark and basis agree, under the
existing publication fence. `projection_watermark` records each work
projection's pending/building/ready/stale state, and `repair_queue` holds the
bounded backfill cursor keyed by projection name.

`publication.manifest_complete` is the durable completeness record that
`commit_log` cannot provide after its 100-row trim. A change with no safe upper
bound records an explicit `integrity_gap`; it is never converted to zero usage
or zero activity. Per-fact-kind counts cover usage, quota, tool, work, lineage
snapshot and diagnostic rows. A changed canonical `quota_observation` adds a
`quota_observation` partition and the referencing usage ranges from every
source, never only the source that produced the occurrence.

Maintenance retains the newest 50,000 `source_change` rows by default. Older
changes, their child counts/partitions and unreferenced older publications are
removed; `meta.impact_manifest_since_change_id` advances to the highest removed
change. A watermark at or below that floor cannot prove it saw every change and
must rebuild its bounded component instead of assuming no impact.

The manifest does not contain source paths, raw session UUIDs or account
identifiers. Modes, reasons, partition kinds, basis kinds, statuses and repair
scopes are closed vocabularies enforced by both the DDL and the writer; impact
keys use internal store ids and time ranges.

## Work projections

Schema 11 replaces `work_rollup` with the tiered v2 key and adds
`workload_bucket`. Both are derived from committed `usage_event` rows; the
migration never reads a rollout. Their `projection_watermark` rows start
`pending` and are built by bounded, resumable backfill ranges:

- ranges align to a UTC day for `work_rollup` and five minutes for
  `workload_bucket`;
- each range deletes and regroups only its own derived rows, then commits and
  advances the `repair_queue` cursor;
- a source append or rescan after a range was built is handled by the normal
  projection triggers, not by replaying the range;
- cancellation or WAL exhaustion leaves the last completed range and the queue
  cursor pending;
- audit runs when all ranges finish. Zero differences marks both projections
  `ready` and publishes exactly one `verify` commit; nonzero differences mark
  the projection `stale` for a full derived rebuild.

Readers use the projection only while the relevant watermark is `ready` and
the registry context basis still matches. Work usage reads a whole UTC day from
`work_rollup` only when the day lies inside one cut interval and every row has
an exact `last_at_ms`; partial days, cleared last instants and a pending
projection stay on committed events. Work usage directory discovery likewise
falls back to committed `usage_event` rows while the rollup is pending, so a
partially built projection cannot make a project directory disappear.

The workload reader uses `workload_bucket` for buckets that contain no quota
observation/reset, declared-speed boundary, work/task boundary, local-midnight
crossing, display/current/trend/comparison window edge, exact five-minute start
event or cleared `last_at_ms`; those buckets are expanded to raw events.
`priced` coverage is combined across buckets exactly as across events.

## Generation and publication

There is no staged generation, snapshot file or publication pointer. A commit
is the publication. The companion's generation descriptor uses `commit_seq` as
its id and `generation-v2-<64 hex>` as its fingerprint, computed from the
committed snapshot. Companion-only projection caches also require unchanged
options and proven time-window membership. Work-usage projections additionally
read external thread and repository metadata; the database proof alone cannot
retain a completed work-usage result. Identical in-flight reads can still share
one build. Rediscovered unchanged sources restore `present` in a transaction
without replaying retained facts; that transition advances publication and
calculation revisions.

The v11 `calculation_revision` advances transactionally for material fact,
dimension, ownership/order, coverage and diagnostic changes. Metadata-only
cursor/stat updates may leave it unchanged; the global publication sequence
still advances. Background runtime-evidence capture is an unapplied queue and
does not invalidate accounting; its eventual usage-fact repairs do. Eligible
quota-free, lineage-snapshot-free rescans compare
bounded temporary candidate tables against all existing fact columns. An equal
candidate retains durable facts; uncertain quota/lineage reconciliation follows
the existing full replay path. Genuine changes may require candidate extraction
followed by replay. No source evidence is removed by this optimization.

The refresh runner retains one bounded process-local calculation proof. Reuse
requires the same semantic revision, database identity, applicable speed
windows and independently checked origin evidence. A complete, consistent
metadata read may establish a stable unknown origin when a thread is absent.
The proof distinguishes ordinary, automatic-review and unknown origins and binds
the unknown membership; unchanged unknown evidence can reuse an equally qualified
result without promoting its uncertainty. Failed, incomplete or changing metadata
reads cannot establish this proof. It validates the cache,
preserves its original evaluation time and age, and composes fresh publication
metadata through the existing atomic writer. A restart, unavailable origin proof,
changed input (including a resolved or newly unknown origin) or expired age forces rebuilding outside explicitly labelled budget
backoff. This proof does not persist identities or relax generation checks.
Budget backoff does not itself qualify a result as reused. A validated old
generation can be read only through an explicit stale channel, retaining its
original generation, fingerprint, calculation time and coverage. Its cache
never becomes current, and its allowance inputs do not feed the current plan.

Accounting uses the existing rollup traversal only for safe whole groups;
partial/assumed-zero/conflicting evidence and time or speed-boundary buckets
remain event-based. Group quantities are summed once and event counts weighted
separately. Its initial generation/coverage read uses a metadata projection,
without constructing or pricing a presentation report. Metadata event counts
sum committed whole-bucket counts and inspect the future-cutoff bucket exactly;
observed-time bounds use the same queries as the full report. A stale rollup
basis still refuses the read. Current and historical plan fits share one ordered calibration
traversal while retaining separate results and failures; weekly intervals and
transition ranges keep their own required passes and bounds.

The reuse proof reads its minimum and maximum usage timestamps with separate
index-boundary subqueries in one statement and snapshot. A failed live
generation/file/revision check, including an ordinary identity read failure,
clears the retained process proof. It cannot subsequently authorize the
runner's durable-cache fallback; cancellation still propagates.

The derived Work Usage saved-report cache retains the latest covered instant
per reporting period and account scope. Completing an older exact-window query
does not roll back that fallback, either in memory, in queued writes, or after
restart. Older windows remain queryable; authoritative corrections at the same
covered instant may replace their saved projection. The browser retains the
newer visible report and its date when a replacement returns an older saved
fallback, while continuing to poll the replacement or displaying its failure.
No source records or accounting timestamps are rewritten by this ordering rule.

## Compressed Codex histories

Cold `.jsonl.zst` rollouts are read by streaming native Zstandard decompression.
No source is rewritten, and no decoded transcript is written to disk. Canonical
rollout identity does not depend on compression.

- `physicalSize` is the compressed length. `size`, cursors and offsets use
  decompressed JSONL bytes.
- A byte-identical plain and compressed pair collapses to one source, with the
  plain file preferred. A representation change forces a rescan (`compressed_changed`),
  never an append into compressed bytes.
- Limits per stream: 2 GiB compressed, 16 GiB decoded, a 128 MiB decoder window
  (window log 27), 120 seconds, and decoded expansion of at most 4096 times the
  compressed length with a 64 MiB floor. Discovery runs at most two decoders at a
  time and reads at most a 1 MiB metadata prefix. These are refusal ceilings,
  not performance targets.
- Node 22.15.0 and later (and 23.8.0 and later) provide the streaming API. The
  project's minimum, Node 22.13, still imports, and reports
  `codex_rollout_compression_unsupported` for compressed groups. The packaged
  runtime is Node 26.2.0. This is source and runtime compatibility, not
  installed-artifact qualification.
- Truncated input can end with empty output on some native builds. The adapter
  therefore validates frame and block boundaries itself and requires a complete
  JSONL tail.

## Identity and privacy boundary

- The device salt is the file `local-unified-index-device-salt-v1` in the same
  directory as the store. Every local join key and every hosted pseudonym derives
  from it. It is never rotated or regenerated by the store.
- Salt creation is allowed only for a new/empty identity domain. Before salt
  creation, refresh inspects an existing store read-only; registered sources or
  a published commit require `readExistingDeviceSalt`. A carried ordinal map or
  an existing legacy index also requires the preserved salt before v2 creation.
  Missing/malformed salts and incompatible existing files fail without minting
  a new salt or opening the store writable. The store still cannot identify a
  different valid-length salt substituted for the original; recovery must
  verify the preserved salt and its digest before refresh.
- Hosted upload pseudonyms are derived at send time from the export secret and
  the local identity. They are not stored in the store.
- Paths stay in the store. Exports, contributions, diagnostics, logs, crash
  output and snapshots carry no path or working directory. The
  [privacy reference](./local-data-and-privacy.md) describes the boundary.

## Change contract

A change to the store's DDL, closed vocabularies, parser stamp, identity
derivation or derived-table semantics requires, in one change:

- a `user_version` bump when the physical format changes, with the fail-closed
  open rules above and tests for older and newer files;
- a parser-stamp change when general fact meaning changes, and the matching
  extractor revision in `src/codex-usage-vocabulary.js`; a scoped response-model
  repair may instead advance its independently persisted recovery version when
  it demonstrably targets every affected prior source without invalidating
  unrelated history;
- updates to the DDL, writer, readers, audit oracle and rollup keys together,
  with tests that call `audit()` after each mutation;
- the recovery runbook, this reference and the privacy reference, when the
  recovery, identity or path boundary changes.

Do not revive the deleted unified v1 schema as current documentation. Schema
history for the retired physical format remains in Git.
