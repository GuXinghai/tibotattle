---
title: Windows test contract refresh and watchdog cleanup diagnosis
date: 2026-10-16
type: qa
status: verified-with-explicit-owner-fixture-gap
---

Scope: test-only follow-up to the existing failures recorded in
[automatic review attribution validation](2026-10-16-automatic-review-families.md).
Base: `0c175fd2`. Product source, native binaries, manifests, schemas and the
running candidate are unchanged. Only disposable synthetic fixtures are used;
real logs, index facts and profile permissions are not modified.

## Acceptance and changes

- Verify current desktop resources and deny website-only tank modules even when
  those files exist in the test resource directory. Preserve loopback, asset
  closure and response-content checks; assert the current closed capability DTO.
- Verify matched search totals, thread search, full-result pagination totals and
  shares, clearing filters, and reuse of the same report build.
- Observe actual native source opens rather than Node's unused `fs.open` path.
  Navigation ancestry must read only its database guard, never rollout headers
  or display names. Usage-only automatic review attribution remains separate.
- Use Windows absolute paths and real unsafe links instead of POSIX permission
  bits. Preserve independent safe-name fallback, sidecar/reparse/hardlink
  refusal, source-byte preservation, ambiguity, oversized values and invalid
  locations. Test both exactly 25,000 rows and refusal at 25,001 rows.
- Verify ordinary source ACL acceptance separately from protected derived-state
  ACLs. Add a native foreign-owner negative subtest with a positive repository
  lookup first, so refusal cannot pass because repository columns were absent.

No whole tests were removed: each still protects a relevant current contract.
Obsolete assertions were replaced at their owning boundaries.

## File occupancy: reproduced cause

The original watchdog test was reproduced twice with `EBUSY` while removing its
synthetic SQLite main or rollback-journal file. A warm Windows observer pinned
the exact child process before teardown. Node's PID probe had already returned
`ESRCH`, but the held process handle returned `WAIT_TIMEOUT` (258) while its
exit code was already zero. The process was exiting, not fully terminated;
resource teardown had not reached the kernel process signal yet. A subsequent
Restart Manager query found no persistent registered holder. This identifies
the reproduced race; it does not retrospectively identify a different external
holder in an older run.

The test now holds the exact process handle before deliberately ending the
synthetic parent, then waits at most five seconds for the Windows termination
signal and checks exit code zero and the closed loopback endpoint. Only then
does it remove its temporary state. There is no delete retry or increased
watchdog timeout. Failure cleanup is a separate test hook, so it does not replace
the original watchdog assertion; unconfirmed termination retains temporary state.

The new test-only observer also has negative checks: a nonzero child exit is
reported and a live child times out without the observer killing it. No product
lifecycle or shutdown logic was changed.

## Validation

Windows x64, Node.js 26.2.0, normal user execution outside the filesystem sandbox:

- Seven affected/native test files: 92 passed, zero failed, one skipped.
- Observer nonzero-exit and live-process timeout tests: two passed.
- Final metadata and route tests after strengthening share and owner-fixture
  preconditions: 28 passed, zero failed, one skipped.
- Final watchdog test: 20 consecutive passes, zero failures and zero `EBUSY`.
- Preflight: 20 passed, including the full documentation/layout contract.

The single skipped subtest is new native foreign-owner coverage. Windows refused
the fixture owner reassignment with `ERROR_INVALID_OWNER` (1307). The ordinary
source ACL positive case and existing native link, reparse, sidecar, protected
ACL and handle-bound checks passed. Foreign-owner rejection has not been
qualified with a real foreign-owned file on this runner; it is not counted as a
pass. All other fixture-setup errors remain failures.

An initial sandbox run refused native source access inside its sandbox-owned
temporary tree; it is not product-failure or qualification evidence. The normal
Windows runs above are the acceptance evidence. Local diagnostic/repeat logs
are in the ignored validation workspace; no real data became a fixture.

No application restart, candidate replacement, installer, release, or broad
whole-repository test run is claimed by this test-only change.
