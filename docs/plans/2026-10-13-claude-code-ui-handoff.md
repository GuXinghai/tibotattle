---
title: Claude Code UI restructuring execution handoff
date: 2026-10-13
type: plan
status: ready
---

# Claude Code UI restructuring handoff

Read `AGENTS.md` and the [English UI restructuring plan](./2026-10-13-dashboard-ui-restructure.md).
Inspect the current checkout and follow applicable scoped guidance before editing.
The goal is to complete the approved UI restructuring, not to resume unrelated
release work. The English plan and the owner's subsequent instructions define
the implementation scope; historical handoffs are supporting context only.

## Starting state

- Branch at handoff preparation: `fix/windows-codex-refresh`.
- Source investigation baseline: `8b0e5646`.
- Original UI plan: `1bb83bc9`; English rewrite: `c2ef79db`.
- The four-entry concept was approved, with explicit preservation of omitted
  analytical details and valuable existing design references.
- UI restructuring has not started. No build, restart, push, or publication
  was performed for this planning handoff.
- The previous untracked root `CODEX_HANDOFF.md` is preserved in an ignored
  local archive under `.usage-monitor/handoffs/`. It describes earlier migration
  work and is not the current UI execution entrypoint. Do not delete its archive
  or treat its old HEAD, failure counts, or build state as current evidence.

## Agent structure

- Main agent: **Opus 5.5, medium reasoning**. Coordinate, supervise, integrate,
  and review; verify significant delegated conclusions before accepting them.
- **Haiku 5.5, high reasoning**: bounded code reading, reference tracing,
  feature inventories, and small implementation tasks with explicit constraints.
- **Sonnet 5.5, high reasoning**: complex implementation, cross-component
  changes, state handling, and difficult boundaries. Escalate from Haiku when
  actual complexity warrants it, rather than assigning everything to Sonnet.
- Use supported model identifiers and reasoning settings. Report an unavailable
  requested configuration rather than silently substituting it.

Delegate concrete tasks with scope, file ownership, constraints, and acceptance
criteria. Keep parallel work independent. Avoid overlapping edits, duplicated
investigation, excessive agents, and elaborate orchestration. Require concise
results: changes, relevant files, verification evidence, and unresolved issues.

## Execution priorities

Follow the plan's stages and migration inventory. The concept specifies visual
and navigation direction, not permission to remove omitted features. Preserve
filters, drill-downs, pagination, chart interactions, evidence detail, state and
scope semantics, cancellation, and retry. Preserve useful design references.

Remove the desktop Community module while retaining sharing settings, necessary
notices, durable opt-outs, and backend contracts. Preserve unrelated work and
user-owned files. Do not modify real profiles or persistent data. Commit
verified independent changes locally. Do not push, publish, deploy, or install
into system application locations.

Spend most effort implementing and reviewing the UI. Use focused existing checks
and representative runtime inspection for actual risks. Add or change tests
only to protect a meaningful changed contract or discovered regression. Do not
chase a globally green suite, repeatedly pursue obsolete expectations, or change
tests merely to mirror implementation. Do not weaken assertions, increase
timeouts, or bypass required gates. Distinguish source, browser, packaged Windows,
and release evidence; report limitations honestly.

## Stage boundaries

Start with a concise current-state assessment and the next unfinished stage.
Reuse the completed investigation, and proceed within the stage without repeated
requests for routine implementation approval.

After each stage, review and integrate changes, perform the smallest meaningful
validation, and commit verified independent work. Report completed scope,
preserved features, validation results, remaining issues, commit IDs, and the
proposed next stage. **Stop and wait for the owner's instruction to continue.**
Also stop when a genuine blocker requires an owner decision.
