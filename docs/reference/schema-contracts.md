---
title: Schema and Contract Lifecycle
date: 2026-08-27
type: reference
status: maintained
last_reviewed: 2026-10-31
---

# Schema and contract lifecycle

The local product uses closed schemas and exact version/hash checks. Legacy
telemetry, contribution preparation, encrypted upload and browser consent
contracts have been removed from source. Existing opt-outs, credentials,
identities, receipts and prepared files are preserved untouched. This source
removal does not change remote services or their data/privacy obligations.

## Ownership map

Personal Pro display names use `prolite` → Pro 100, `pro` → Pro 200 and
`promax` → Pro 500. These names were verified in official Windows Codex package
26.1027.3384.0's numbered-tier billing and usage messages on 2026-10-31.
The local catalog owns the display mapping and generates the browser mirror;
CLI enum display names in the upstream contract ledger remain source evidence,
not an override of these product labels. Names do not establish quota capacity.

Codex quota ingress validates a single app-server response before merging its
canonical `rateLimits` entry with `rateLimitsByLimitId`. Repeated non-null slots
for the same limit must agree on percentage, duration and reset deadline; the
same limit/duration/reset window cannot carry different percentages across slots.
Contradictions fail as `malformed_output` before constructing a collector record,
instead of silently overwriting an entry. This check is local to one response:
successive valid responses may report a lower used percentage, and distinct
limit families or durations are independent observations. Matching duplicates
remain accepted. It does not establish that a contradictory response has been
observed from the provider.

Upstream protocol calls `rateLimits` the historical single-bucket view and
`rateLimitsByLimitId` the multi-bucket view. Both are constructed from the same
usage-read snapshot list, not separate quota requests. With unique limit IDs,
the `codex` entries agree by construction. The public client does not enforce
uniqueness: it appends additional snapshots, selects the first `codex` for the
single view, and collects a last-entry-wins map for the multi view. A duplicate
backend `codex` entry could therefore produce a discrepancy; this is a
conditional source-level path, not an observed backend incident or an expected
quota-recovery condition. See the reviewed
[protocol](https://github.com/openai/codex/blob/f79b26ccbb3116b052544666a181012fb45dc49b/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L356-L368),
[response construction](https://github.com/openai/codex/blob/f79b26ccbb3116b052544666a181012fb45dc49b/codex-rs/app-server/src/request_processors/account_processor.rs#L1220-L1237),
and [snapshot construction](https://github.com/openai/codex/blob/f79b26ccbb3116b052544666a181012fb45dc49b/codex-rs/backend-client/src/client.rs#L642-L680).

Quota RPCs use one process-wide queue, including direct client `request` calls.
The next request starts only after completion, failure or timeout. A timeout
removes its pending response ID, so a late reply cannot resolve a subsequent
read. Closed clients cancel their wait and release their ordered queue slot.
Collection also holds its existing per-state lease. Both account reads bracket
the quota read; known account or plan disagreement rejects the result with a
bounded `request_failed` error. Missing identity remains explicitly unattributed
and cannot establish account-bound calculation continuity.

Local collector record IDs order separate observations sharing a timestamp.
They remain private iteration/publication metadata, including worker transport,
and never enter dashboard DTOs. Current quota publication is independent of
history generation; the overview balance uses the independently published weekly
`codex` window. A new balance invalidates previously computed remaining-hour
outputs until analysis recomputes them. `task-workload-v15` uses recovery stages
instead of historical percentage high watermarks; see
[workload semantics](./local-index-schema.md#source-state).

| Contract | Canonical source | Output and validation |
| --- | --- | --- |
| Current local export v1 | `schemas/local-export-v1/` and `contracts/local-export-v1/field-policy.json` | `generated/local-export-v1-field-dictionary.json`, `generated/local-export-v1-compatibility.json`; `pnpm run export:contract:check` |
| Current local export set v1 | `schemas/local-export-set-v1/manifest.schema.json` | Exact schema digest, compressed artifact and record verification; export tests |
| Local Codex plan/model vocabulary | `packages/codex-catalog/` public root | `apps/web/public/codex-catalog.generated.js`; `pnpm run codex:browser:check` |
| Recoverable export deletion | `schemas/export-deletion-v0.4/journal.schema.json` plus earlier transaction schemas | New v0.4 journals only for local export set v1; original journal/commit validators retained only for exact interrupted-transaction recovery |
| Workspace discard | `schemas/export-workspace-discard-v0.1/` | Journal, preflight, commit marker and receipt; isolated discard tests |
| Historical accounting snapshot | `schemas/provider-accounting-snapshot-v0.1.schema.json` | Retained accounting readback only; no retired provider collection |
| Historical synthetic evidence | `schemas/product-synthetic-v0.1/` | Frozen evidence readback, no preparation or transport entrypoint |
| Release evidence | `schemas/release-evidence-v1/manifest.schema.json` | Exact candidate manifest/artifact validator; release gates remain separate |
| Frozen R7 release/resource evidence | `schemas/r7-release-evidence-v0.1/`, `schemas/r7-resource-benchmark-v0.1/` | Original `generated/r7-*.json` bytes remain historical readback; generation is retired |

Root schemas are canonical, not copies of a telemetry workspace package. The
local export generator inventories exactly six schemas and requires a reviewed
purpose, privacy class, retention class, local-only eligibility, Codex provenance
and limitation for every declared field. Its outputs are deterministic. Change
canonical inputs and run `pnpm run export:contract:generate`; never edit generated
artifacts by hand. The local browser catalog has its own generator and contains
no consent or upload API.

## Local export v1

Bundles use `local-usage-metadata-bundle-v1`; record and receipt versions also
have distinct local v1 identities. The compatibility tuple is
`local-export-compatibility-v1`, with exact schema/policy/registry hashes and
Codex-only adapter declarations. It carries no sharing consent, enrollment,
hosted destination or retired-provider adapter. Its contract is `local_only`,
`transportReady: false`, `backwardCompatibility: none`.

The current plan allowlist comes from the reviewed Codex vocabulary, including
`sci` and `sci_plus`. The current model vocabulary uses the independent catalog.
Neither registry defines an allowance capacity or entitlement. Unknown models
are withheld/fingerprinted and unknown plans remain explicit. Provider windows
and measured percentages remain observations, never a fixed quota.

Local sets use `local-export-set-manifest-v1`, an independent contract/schema
digest and `local-export-set-manifest-receipt-v1`. Current producers and verifiers
reject prior telemetry bundles, receipts, compatibility tuples and export-set
v0.1/v0.2/v0.3. There is no reader, conversion, retry adapter or relabeling for
those payloads. Regenerating from available source is a new operation; existing
files and identity material are not overwritten or removed by this cutover.
Record/byte/chunk/time/memory ceilings, canonical packing, gzip integrity and
exact replay/deduplication checks remain in force. The source-file ceiling is
100,000. Windows is the only current export platform.

Deletion planning accepts only a currently verified local export set. A new
v0.4 journal binds that version and exact filesystem identities. Previously
committed deletion journals retain their original validators, hashes and fixed
filename resolution so an interrupted transaction can finish against its exact
inventory. This is file-transaction recovery, not acceptance or conversion of
old telemetry payloads. Uncommitted old exports cannot enter a new deletion plan.
Unknown journals, replacement files, digest or identity mismatches fail closed.
No deletion is performed by schema generation or ordinary tests.

## Closed privacy boundary

Export starts with a fresh allowlist, never a copy-and-redact operation. Objects
are closed; fields, strings, timestamps, arrays and numbers are bounded. Unknown
source properties are omitted. Prompt/response content, commands, credentials,
raw identities, private paths and free text stay excluded from derived artifacts.
Negative tests cover nested unknown keys, unsafe values, unsupported versions,
wrong providers and bounded content-free validation errors.

Schema changes require coordinated producers, consumers, policy, public APIs,
generated outputs, rejection/replay tests and maintained documentation. Use a new
version whenever valid bytes would acquire a different meaning. Never silently
reinterpret old versions or weaken a validator to admit invalid state.

## Accounting and retained local state

Local API valuation methodology is `provider-neutral-api-price-equivalent-v0.4`
and replay materialization is `local-replay-safe-accounting-v0.26`. Current
companion readers and writers require `source_native` context behavior: absent
context remains unavailable rather than becoming observed zero. An inferred
input total is usable only when its component observations are complete; known
explicit context, including observed zero, remains authoritative. The memoized
pricer derives context thresholds from the reviewed public cards and falls back
to the full ledger for incomplete evidence. Old materialization is withheld for
rebuild; the retired `legacy_zero` adapter and legacy source mode are refused.
Missing input context cannot become observed zero. This does not
rewrite stored source observations or alter retained price-card evidence.
Old formats are accepted only by the explicit one-time copy converter;
v0.24/v0.25 results are retained losslessly as historical evidence in a new envelope,
not interpreted by runtime compatibility or relabelled as v0.26. Settings v6
likewise require explicit conversion from v5. The selected unknown-speed policy
and active custom ratio are part of cache calculation identity. Missing or empty token observations
are unavailable, while explicitly observed zero remains zero. Valid `Date`
timestamps and their canonical ISO strings select the same event-time prices.


## Local model performance

`model-performance-daily-v1` groups qualified measurements by UTC completion
day, provider, model, reasoning effort, speed method, speed mode/evidence source
and API tier. Its independent TPS, TTFT and full-completion histograms retain
eligible sample counts, conservative integer extrema and speed token/duration
sums. Completion is positive integer milliseconds; measured zero TTFT is valid. `performance-histogram-v1` fixes the bucket
edges for every contributor/client and includes explicit tails. Counts and integer units remain bounded by
JavaScript's safe-integer range. Typed storage retains only populated bucket
indexes/counts, typed cohort dimensions and the bounded integer summaries.

The helper merges already-qualified distributions and returns approximate
Type-7 P10/P25/median/P75/P90 estimates with bounds and method metadata. Bands
are null below five observations; a sparse median remains available. It does
not deduplicate turns across devices. Compatible reports may be pooled as
reported samples; copied histories can overlap. No per-turn membership artifact
is collected. A measurement digest identifies canonical content, not unique
source membership.

This family is staged independently of usage v1.2. Its source includes separate
capability and authorization routes, encrypted report delivery, typed cohort and
bucket storage, idempotent per-device report revisions, and owner-erasure/restore
coverage. Usage consent cannot authorize performance. Local timing source and
scheduler integration are qualified separately from hosted chart publication.
Timing SQLite schemas are primary 12 and supplement 13 while measurement methods remain 2/3. The single correlation-key record is bound to `usage-monitor-timing-identity-v1`. Existing stores are inspected read-only before any writable connection or journal pragma. Unknown identity markers, duplicate metadata, older schemas 2–11 and newer schemas are refused without in-place conversion. A separate transition package must reconcile all source/turn digests, fingerprints and parser state; changing a schema number cannot convert an HMAC namespace. Missing preimages or ambiguous mappings block cutover and preserve the old store. The physical schema boundary also prevents older writers from reopening new stores. Source parser version 18 recognizes GPT-6.1 Sol and Ultrafast and is unchanged by compressed-source recovery. Plain and Zstd representations retain one logical source identity, with plaintext preferred when both exist. Both timing stores share a bounded in-memory decoder; durable staging and logical cursors resume after restart, and completed unchanged compressed sources skip decoding. No decoded transcript is persisted. Still-present, verified sources replay through bounded staging; completed old rows remain readable through cancellation and restart until the final verified chunk atomically replaces them. Missing sources and failed or unfinished replacements retain their last good rows and prior parser provenance. Older writers refuse the upgraded stores.
Old rows retain existing TPS/TTFT
with unavailable new fields. Receipt timing
wins when qualified; tool-free timing is a single-sample fallback, never a
second speed sample for the same turn. The retired upload field dictionary is not a local runtime dependency.
The [performance specification](../design/2026-09-20-performance-telemetry-contract.md)
records the measurement, overlap, policy, delivery, erasure, restore and UI requirements.
Those gates must not delay continuity collection or alter cache calculations.


### Exact local filesystem identities

New collector source plans v0.2 serialize `device` and `inode` as canonical
unsigned decimal strings, bounded to 64 bits. The platform reads these values
from BigInt stats before conversion of unrelated bounded numeric metadata.
Legacy plan versions continue to validate only safe integer identities; unsafe
Number values cannot be repaired by rounding. Checkpoint restoration and slicing
preserve the original plan version and digest. Existing Claude transcript and
status-line workspace metadata is legacy immutable state: inspection may identify
it without reading its source paths, while resume fails closed before source
access. No new Claude source plan is created. Account/session pseudonym derivation
and secrets are unchanged.

Supplemental source plan v2 carries these exact file-prefix bindings, retaining
its U64 limit. Local export workspace v1 uses physical schema 7. Codex source
identities are exact canonical decimal strings: volume identities are bounded
to U64 and file identities to U128. They are private workspace bindings and do
not enter the public source summary. Supplemental identities retain their
tagged `u64:` encoding. Numeric affinity must never coerce either identity.
Only physical schema 7 is executable in the current reader. Earlier schema 4/5/6 workspaces
are refused before writable configuration and retained unchanged as archives;
there is no compatibility reader, conversion or schema relabeling. Start new
preparation from available sources, retaining any earlier sealed evidence and
identity metadata. Source ordinals remain stable. The completed tier scan stores
its exact line count atomically with the phase transition; a resumed auxiliary
scan reserves that count durably before reading. An interrupted attempt can
consume its reservation but cannot evade the cumulative line budget. Missing
or contradictory counts fail closed. Committed deletion recovery remains
available for its exact records.


## Evidence and validation

`pnpm run export:contract:check`, `pnpm run codex:browser:check`, isolated export,
privacy, deletion/recovery and browser tests, architecture checks and documentation
preflight establish source behavior. Runtime, native Windows filesystem/credential,
installed application, CI, signed artifact and remote deployment gates remain
separate. R7 is frozen historical readback: no new receipt/evidence generation or v0.2 schema
is supported. Frozen R7 receipt bytes are never regenerated to accommodate this change;
see the [R7 preservation runbook](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md).
