---
title: Bounded timing source recovery validation
date: 2026-10-17
type: qa
status: validated-local
---

# Scope and claim boundary

Source-level and protected-copy validation of per-file timing recovery. No raw
records were modified, no accounting ledger was rebuilt, and no real timing
store was opened for writing by the rehearsal. Normal application startup and
post-start acceptance are separate; the owner will perform post-start acceptance.

# Implemented contract

File identity changes, truncation, or detected prior-prefix edits trigger bounded
replay of only that source into staging. Prior live measurements remain readable
until a stable EOF scan publishes the replacement atomically. Cancellation,
read failures, and mutations during a read roll back that batch. Committed staged
progress survives restart; a subsequent replacement restarts only that source.
Normal append and discovery budgets are retained. The parser version is unchanged;
this fix does not trigger a full-history parser replay.

Timing schema methods 8/9 add a durable rebuild marker and migrate reviewed
2/4/6 and 3/5/7 stores forward. Older writers reject the newer versions. Partial
rebuilds remain pending; controlled recovery failures are visible without raw
paths, identifiers, content, or stack traces. Existing source validation does
not prove absence of every historical unsampled edit; rebuilding produces the
current verified projection rather than asserting byte equality with an unavailable
original file. No file-identity or native security check was relaxed.

# Real-data rehearsal

The normal profile's two timing stores were opened read-only and copied using
SQLite backup into newly created owner-protected files. Native source handles
read original logs without writing them. Metadata discovery matched 839 indexed
sources; only the two diagnosed changed identities were parsed.

For each primary and supplemental copy:

- Two sources completed in five bounded reads, totaling 8,423,991 bytes.
- Their retained turn counts changed from 36 to 37; two final revision changes
  published the completed replacements.
- All other 3,009 sources and their measurement rows retained identical hashes.
- Repeating ingestion of the two sources read zero bytes and left results unchanged.
- Staging and active rebuild counts ended at zero; SQLite quick checks returned ok.

The combined projection remained readable with 14,505 rows. Reopened read-only
connections confirmed original source metadata and measurement hashes unchanged.
The receipt records numeric aggregates only. It does not claim rendered UI or
installed-app qualification.

# Validation

- Timing store recovery tests: 9/9 passed using synthetic SQLite/native orchestration.
- Diagnostic recovery tests: 11/11 passed in normal Windows execution.
- Windows timing orchestration tests: 10/10 passed; these injected-native tests do
  not qualify physical ACL enforcement. The protected-copy run exercised the real adapter.
- Local companion gate: 304 passed, one skipped, zero failed.
- UI gate: 1,024/1,024 passed under normal Windows permissions. A first restricted
  run failed only the synthetic mirror rename with EPERM; no product change was made for it.
- Three existing tool-free integration tests fail during initial synthetic store
  acquisition with security_policy, before their measurement assertions. Their
  fixture setup and retired nested sidecar assumptions remain a separate test
  maintenance gap; no production guard was weakened to pass them. Other six tests
  in that file passed. Schema assertions were updated to 8/9.
- Architecture, translation mirror and documentation gates are recorded with the
  local candidate preparation evidence; artifact verification is separate from
  post-launch acceptance.

# Handoff

Prepare build 2026101702 with Node.js 26.2.0, preserve the prior candidate, verify
its exact source/ASAR/native closure, then launch the new executable without
profile overrides. Do not use an older candidate as a database downgrade after
normal-profile timing stores migrate. Startup/UI/runtime acceptance remains the
owner's requested gate.
