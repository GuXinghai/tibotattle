---
title: Command-Line Reference
date: 2026-08-27
type: reference
status: maintained
last_reviewed: 2026-10-27
---

# Command-line reference

`usage-monitor` is the repository's local research, export and collection CLI.
Codex is its only supported usage provider. Claude callback, transcript,
collection, and pricing commands and options are retired.
The Rhetrion desktop app does not require users to run these commands. Command
coverage is checked against `src/cli.js` by
`test/cli-reference.test.js`; the CLI's own usage output remains the authority
for exact flags.

Analysis commands reject input/output/report paths that identify the same file,
including canonical parent, case, symbolic-link, and hard-link aliases, before
their first persistent mutation. An explicitly selected independent report may
still be updated; selecting an input as the report is never an update request.
Generic reports use the separate `windows-report-publication-v1` native
capability, verified against the adjacent binary manifest. Missing or mismatched
capability returns `OWNER_ONLY_ATOMIC_WINDOWS_ATOMIC_PUBLISHER_UNAVAILABLE`
before destination creation. Only fixed local drives are accepted; mapped
network and removable drives are refused before directory creation. Reports
are limited to 64 MiB, 32767 UTF-16 path units and 256 path components. Newly created parent
directories and staged files have protected current-owner-only DACLs; existing
unsafe directories or targets are refused without permission repair. Publication
flushes and validates the stage, then atomically renames it relative to the held
parent. New targets use no-clobber rename; replacements recheck the old identity.
A dedicated same-session mutex serializes cooperating report writers. This is
not compare-and-swap against a hostile same-user process or a cross-session lock.
Pre-commit failures clean only this operation's stage. A
`OWNER_ONLY_ATOMIC_COMMIT_UNCERTAIN` error can mean publication already occurred;
do not delete the destination or blindly retry. Cleanup failure is reported as
`OWNER_ONLY_ATOMIC_CLEANUP_FAILED`. General production/path-walk approval and
installed-artifact qualification remain separate.

Local export workspace v1 (physical schema 7) preserves exact Windows volume/file
identities as private canonical decimal strings, bounded to U64/U128
respectively. The public source summary omits these identities. Older workspace
schemas are refused before writable configuration and preserved unchanged;
they are not relabeled or automatically converted. Compatibility is scoped to a
[one-time controlled pre-release migration](../decisions/2026-10-27-pre-release-state-migration.md),
not a permanent legacy writer. That migration is not an implemented CLI command.
The separate collector v0.2
plan retains its U64-per-identity contract and rejects larger file IDs. These
source-level contracts are not installed native qualification.

Commands operate on local files or the reviewed local Codex subprocess. Codex
may itself need provider network access for fresh account evidence. A live
research experiment requires an explicit `--execute-live` and reviewed manifest;
there is no hosted contribution `--origin` command. Paths can contain sensitive
derived evidence: keep them out of commits, issues, logs, and documentation.

## Read and analysis

| Command | Purpose | Durable effect |
| --- | --- | --- |
| `doctor` | Inspect local source/tool readiness without exposing content. | None. |
| `capture` | Capture one bounded account observation. | Appends to the selected local observation file. |
| `report` | Summarize captured observations and corrections. | None unless output is redirected by the caller. |
| `explain-usage-plans` | Describe the usage-explainer plans and request contract as JSON. | Read-only; does not open or refresh the unified index. |
| `explain-usage` | Run one named, bounded usage-evidence plan against the committed unified index. | Read-only; emits compact content-free JSON and never refreshes the index. |
| `explain-usage-evidence` | Resolve one generation-bound opaque selector returned by `explain-usage`. | Read-only; stale or unresolvable selectors fail closed without exposing local identities. |
| `transitions` | Mine bounded Codex quota transitions. | Writes only explicitly selected output/audit paths. |
| `infer` | Infer capacity from a transition artifact. | Writes selected JSON/Markdown outputs. |
| `history` | Build weekly-limit history from an input artifact. | Writes selected JSON/Markdown outputs. |
| `crosscheck` | Compare local history with provider UI evidence. | Writes selected JSON/Markdown outputs. |
| `quality` | Evaluate monitoring quality. | Writes selected JSON/Markdown outputs. |
| `calibrate-weekly` | Calibrate the rolling seven-day model. | Writes selected JSON/Markdown outputs. |
| `contamination` | Analyze experiment/observation contamination. | Writes selected JSON/Markdown outputs. |
| `tools` | Analyze bounded tool-mechanism observations. | Writes selected JSON/Markdown outputs. |
| `migrate-corrections` | Plan and materialize additive correction state. | Writes selected correction/report outputs; does not rewrite source evidence. |

Usage explanation initially supports `data_health`, `current_usage`,
`top_work`, `period_drivers`, `model_effort_mix`, `pricing_coverage`,
`parent_subworker_usage`, and `allowance_movement`. The output separates exact
facts, deterministic calculations, configured estimates, coverage,
limitations, and prohibited claims. Task/project names, paths, commands, raw
session identifiers, and source coordinates are excluded. Responses are capped
at 16 KiB with at most 25 rows per page. `explain-usage-plans` exposes the
current plan catalog, supported periods, limits, evidence availability, and
pagination fields without opening the index. `period_drivers` compares equal
adjacent windows and therefore does not accept `all`.

Default read-only explainer discovery uses a closed production-first order:
`%APPDATA%\UsageMonitor\profiles\stable\companion-state`, then the standalone
CLI state at `%LOCALAPPDATA%\app-usagemonitor`. Former-name profiles are not
compatibility discovery paths; their conversion belongs to a separate one-time
package. `coverage.sourceKind` reports which class was selected without exposing a local
path. `USAGE_MONITOR_STATE_ROOT` overrides discovery and `--index-file` is an
explicit development/recovery override; the corresponding device-salt file
must be beside it for plans that return evidence selectors. `--codex-home`
changes only the local metadata-discovery root. Neither command advances the
index.

Every result compares the committed generation time with its fixed query
window. A recent window not reached by that generation returns
`usage_explainer_window_uncovered` instead of a misleading zero; stale
historical results are marked partial. A selector is valid only for the
committed generation and exact window that produced it. When `nextCursor` is
non-null, pass it back with the same plan, period, and limit using `--cursor`.
The cursor preserves the original window across CLI invocations and fails
closed if the index generation or bound query changes. `nextCursor: null` ends
the pageable result. Allowance pages order compatible observed movement before
non-monotonic, missing-reset, and single-observation groups, while aggregate
facts count every unresolved class without combining reset identities. A true
`truncated` with no continuation means a stated source bound remains, not that
another page is available. The maintained agent workflow is the
[usage explainer agent protocol](./usage-explainer-agent-protocol.md).

## Local activity and export

| Command | Purpose | Safety boundary |
| --- | --- | --- |
| `mark-activity` | Record a fixed-vocabulary surface activity marker. | Appends a content-free local marker. |
| `inspect-export` | Preview the exact allowlisted metadata for a time range. | Read-only. Run before export. |
| `export-local` | Write one reviewed local metadata bundle. | Requires an explicit output path; excludes prompt/response content. |
| `verify-bundle` | Verify a bundle and optional receipt. | Read-only. |
| `export-set` | Create or resume a resource-bounded export workspace/set. | Staged, locked, replay-safe writes to explicit workspace/directory paths. |
| `inspect-export-workspace` | Inspect workspace state and pending actions. | Read-only. |
| `verify-export-set` | Verify manifests, chunks, hashes, and boundaries. | Read-only. |
| `delete-local-export` | Delete an exact verified export set. | Two-step confirmation token and journaled recovery contract. |
| `recover-local-export-deletion` | Complete or recover an interrupted export-set deletion. | Acts only on the explicit journaled workspace/directory pair. |
| `discard-export-workspace` | Discard an exact export workspace. | Two-step confirmation token and recoverable discard transaction. |
| `recover-export-workspace-discard` | Complete or recover an interrupted workspace discard. | Acts only on the explicit workspace transaction. |
| `recover-exports` | Recover incomplete export transactions in one directory. | Bounded to the explicit directory. |
| `rotate-local-identity` | Rotate the export pseudonym secret. | Requires confirmation; does not rewrite the local unified index. |

Never use deletion or discard commands against an unresolved path, an only copy
of evidence, or a workspace owned by another running process. Inspect first and
retain the generated receipt.

## Retained historical exports

Previously persisted records in existing versioned legacy formats may be
inspected only as historical readback. Existing export workspaces with a retired Claude source
plan can be inspected, but cannot be resumed; refusal occurs before new source
path reads. The CLI does not install, uninstall, repair, rotate, remove, or
clean up Claude callback state, profiles, settings, or credentials. See the
[Codex-only provider decision](../decisions/2026-10-27-codex-only-product.md).

## Retired hosted commands

Hosted pairing and contribution delivery are not CLI capabilities.
`pair-contribution-device` and the `sync-contributions-*` command family are
removed and return `Unknown command`. Retained local queue/receipt schemas do
not make those commands callable or grant upload authority. This retirement
neither deletes accepted remote history nor changes saved local consent, opt-out,
credential or identity state. Historical remote responsibility is described in
[the privacy inventory](./local-data-and-privacy.md#historical-remote-state-and-responsibility).

## Collector lifecycle

| Command | Purpose | Durable effect |
| --- | --- | --- |
| `collect-once` | Run one replay-safe local collection pass. | Updates the selected collector state and derived local evidence. |
| `collect-foreground` | Reconcile on a bounded foreground cadence. | Updates the selected collector state until duration/cancellation. |
| `collector-state-status` | Inspect collector state and staleness. | Read-only. |
| `plan-collector-retention` | Plan what a retention cutoff would remove. | Read-only plan; it does not delete retained evidence. |

Display horizons are not retention policy. No collector command in this list
authorizes wiping AppData or deleting the unified index.

## Experiments and release evidence

| Command | Purpose | Safety boundary |
| --- | --- | --- |
| `experiment` | Validate or run a manifest-defined experiment. | Dry by default; live execution requires `--execute-live`, and the manifest still bounds every action. |

## Exact invocation synopsis

```text
usage-monitor doctor
usage-monitor capture [--label TEXT] [--controlled] [--offline] [--data-file PATH]
usage-monitor report [--json] [--data-file PATH] [--corrections PATH]
usage-monitor explain-usage-plans
usage-monitor explain-usage --plan data_health|current_usage|top_work|period_drivers|model_effort_mix|pricing_coverage|parent_subworker_usage|allowance_movement [--period 24h|7d|30d|all] [--limit N] [--cursor CURSOR] [--index-file PATH] [--codex-home PATH]
usage-monitor explain-usage-evidence --selector SELECTOR [--index-file PATH] [--codex-home PATH]
usage-monitor transitions --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--offline] [--compact] [--window-minutes N] [--output PATH] [--audit-file PATH]
usage-monitor infer [--input PATH] [--output PATH] [--report-file PATH]
usage-monitor history [--input PATH] [--output PATH] [--report-file PATH]
usage-monitor crosscheck --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--input LOCAL_HISTORY_PATH] [--allow-stale-cache] [--offline] [--provider-ui PATH] [--output PATH] [--report-file PATH]
usage-monitor quality [--input TRANSITIONS_PATH] [--collector-file PATH] [--output PATH] [--report-file PATH]
usage-monitor calibrate-weekly [--input TRANSITIONS_PATH] [--output PATH] [--report-file PATH]
usage-monitor mark-activity --surface SURFACE --state start|end|pulse [--experiment-id ID] [--activity-file PATH]
usage-monitor inspect-export --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]
usage-monitor export-local --since ISO_TIMESTAMP --until ISO_TIMESTAMP --output PATH [--receipt PATH] [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]
usage-monitor verify-bundle --input PATH [--receipt PATH]
usage-monitor export-set --workspace PATH --directory PATH [--resume] [--since ISO_TIMESTAMP --until ISO_TIMESTAMP] [--codex-home PATH] [--collector-file PATH] [--activity-file PATH] [--secret-file PATH] [--max-records-per-chunk N] [--max-bundle-bytes N] [--max-artifact-bytes N]
usage-monitor inspect-export-workspace --workspace PATH
usage-monitor verify-export-set --directory PATH
usage-monitor delete-local-export --workspace PATH --directory PATH [--confirm-deletion TOKEN]
usage-monitor recover-local-export-deletion --workspace PATH --directory PATH
usage-monitor discard-export-workspace --workspace PATH [--confirm-discard TOKEN]
usage-monitor recover-export-workspace-discard --workspace PATH
usage-monitor recover-exports --directory PATH
usage-monitor rotate-local-identity [--secret-file PATH] [--confirm]
usage-monitor collect-once [--stale-after-ms N] [--no-refresh] [--backfill] [--state-file PATH]
usage-monitor collect-foreground [--stale-after-ms N] [--reconciliation-ms N] [--duration-ms N] [--state-file PATH]
usage-monitor collector-state-status [--state-file PATH] [--json]
usage-monitor plan-collector-retention --before ISO_TIMESTAMP [--state-file PATH] [--json]
usage-monitor experiment --manifest PATH [--execute-live] [--offline] [--result-file PATH]
usage-monitor contamination [--transitions PATH] [--inference PATH] [--experiments PATH] [--observations PATH] [--output PATH] [--report-file PATH]
usage-monitor tools --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--output PATH] [--report-file PATH]
usage-monitor migrate-corrections [--observations PATH] [--transitions PATH] [--corrections PATH] [--output PATH] [--report-file PATH]
```

The removed `register-account` package script and command are not part of the
CLI. No enrollment or delivery replacement is configured. The maintained CLI
reference tests match synopsis lines against the current source and verify that
retired commands and options cannot be invoked.
