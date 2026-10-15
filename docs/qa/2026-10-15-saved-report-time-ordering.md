---
title: Saved usage report time ordering verification
date: 2026-10-15
type: qa
status: completed-local-runtime
---

# Saved usage report time ordering

Scope: source `fe2cc389ca969f95af740fe564bfea599c6d6ae8`, Windows x64,
default real profile. This fixes a reproducible saved-report ordering defect.
The user's transient incident had stopped before investigation; its original
request trace was not captured, so this is not proof of that incident's exact
request sequence. The proposed Usage UI redesign is not part of this change.

## Reproduction and repair

Two synthetic regression tests failed before repair: completing an older exact
window displaced the latest report in memory and in the durable fallback read
after restart. Both now pass. Covered time determines the latest fallback per
period/account query, including coalesced and in-flight writes. Historical
queries remain usable and same-instant authoritative corrections remain allowed.

The browser keeps newer visible figures and their date when an older retained
fallback arrives. It follows the replacement's pending ID and still exposes a
replacement failure. Exact shared-window validation and request cancellation
fences remain in place. No source facts or accounting timestamps are rewritten.

## Validation

- Focused saved-report, restart, slow-write, and browser regressions: 22 passed.
- UI surface: 995 tests, 978 passed, 17 failed. Failure-title multiset is identical
  to the pre-change real-permission UI run; no new failure titles.
- Local surface: 299 tests, 297 passed, 1 failed, 1 skipped. The failure is the
  pre-existing `allowance-tanks.js` static-resource 404; the previous transient
  startup timeout did not recur in this run.
- Architecture: 577 production files, 2306 imports, no approved debt edges.
- Preflight: 20 passed under normal Windows permissions. The first sandbox run
  could not create a synthetic Git config; that is not a product assertion.
- Existing preservation baseline: all 686,894 original facts retained unchanged;
  SQLite integrity and foreign keys valid, no internal link rebuilds.

## Real runtime

Fresh unsigned local candidate, build `2026101510`, Node 26.2.0 and Electron
43.5.0. No installer was executed and nothing was signed or published.

- ASAR SHA-256: `afec4c33399440b04498e5014365231e8f19c238a40a819ce4a51eb1c7aa6644`.
- Executable SHA-256: `df5079d5af34a17ca4a39b89d8aaacfac6c454bf93508d997f9f1af0e1b5aa95`.
- Normal default-profile launch: 2026-10-15 18:36:33 JST; no isolation arguments.
- Initial refresh completed at 18:38:42 JST. The real browser report advanced
  from 18:23 to 18:36. Manual report refresh retained 18:36; switching to 30 days
  and back to 7 days returned to the same 18:36 covered instant.

Background observation covered the next automatic overview refresh at
18:43:42–18:44:21 JST, which succeeded without an error code. No report-bound
regression was observed in 31 valid samples from 18:39:16 through 18:45:31 JST.
Nine earlier observer samples failed to read a cache file that did not exist;
they were preserved and excluded from valid runtime samples. This was an
observer-path assumption, not a product failure. The final rendered check
confirmed the seven-day report remained at 18:36 after automatic refresh.
At 18:44:51 JST the normal app remained alive and its
stderr log was empty. The real durable
Work Usage cache file has not been created during the observed run; its ordering
and restart guarantees are established by synthetic tests, not a live file read.
Browser rendering does not qualify native-window pixels, signing, installation,
updater operation or release readiness.
