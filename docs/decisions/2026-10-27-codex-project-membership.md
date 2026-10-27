---
title: Classify projects by explicit Codex membership
date: 2026-10-27
type: decision
status: accepted
---

# Explicit Codex project membership

The owner approved this classification on 2026-10-27. A Codex project does not
require a Git repository. Git availability and repository membership do not
determine whether a task belongs to a Codex project.

The local work view reads only the project registry, explicit thread assignments
and explicit projectless markers from the owner-controlled Codex global-state
file. A valid direct assignment wins. An explicit projectless marker remains
Non-project tasks even inside a repository. Conflicting, unsupported or dangling
assignments stay Unassigned. Missing evidence is not a projectless marker.

A subworker without its own explicit assignment inherits the nearest explicit
ancestor's assignment only along a verified collaboration chain. The index's
retained source paths locate bounded session headers; arbitrary paths, titles,
task content, directory similarity and rollout-fork lineage cannot establish a
parent. Cycles, missing parents, conflicting source headers and depth limits
leave ancestry unresolved. Direct assignments are independent of ancestry.

These are current observed project assignments, not proof of historical
ownership at the time of usage. Reclassification changes the read projection;
it never rewrites usage facts, prices, totals, source cursors or original Codex
metadata. Project identifiers are device-keyed handles. Names and raw IDs remain
transient local metadata and never enter saved reports, exports or telemetry.

Global-state reads are limited to 8 MiB and revalidate file identity, size and
timestamps. Project/assignment counts and ancestor traversal are bounded. The
indexed source-header relation path never opens Codex's live SQLite database or
its WAL/SHM coordination files. Existing display-name readers have their own
separate source-access contract.

Source tests and a read against retained real data are separate evidence gates;
neither alone proves adoption by an installed or currently running artifact.
