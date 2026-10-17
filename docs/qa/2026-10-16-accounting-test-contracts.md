---
title: Windows accounting test contract refresh
date: 2026-10-16
type: qa
status: completed-with-product-failures
---

# Scope

This is a test-only follow-up to the historical-plan comparison acceptance.
Production modules and the running application were not changed; this work did
not operate on original logs or the real profile. All new permission grants and SQLite work use disposable,
synthetic fixtures. The frozen v1 `views.json` was not regenerated or edited.

# Test changes

Five former POSIX mode checks now use the existing native Windows ACL assertion:
owner, protected DACL, no broad or non-owner grants, no reparse points, single
link and resolved final path. The fresh-cache test starts with protected
directories but never repairs the database created by production. Retention
tests instead provision an already valid, private SQLite fixture through native
storage before exercising refresh failure or replacement; both the initial and
final ACLs must pass. This isolates retention from the separate creation defect
without allowing that defect to disappear. Cleanup is registered before each
possible failure. A negative fixture proves the assertion rejects Everyone read.
Cache content, typed errors and last-good serving are checked before the final
ACL assertion, so that failure no longer prevents those functional checks.

The file-count scanner now distinguishes the guarded main pass from the archive
fallback call. Both calls must complete honestly; the 4,880-file synthetic plan,
the exact file ceiling and ceiling plus one are exercised. Byte-limit, memory,
cancellation and retained-cache checks remain in place.

The frozen Standard report still checks all old values. Only five named additive
speed fields are removed from its period, model and combined-model projections;
those fields are verified separately against public per-event ledger prices.
The historical Standard work-cell digest is reproduced by an independent raw-fact
Standard pass. Current speed-priced work-cell digests and coverage counts are
compared to a separate raw-fact pass. These passes reuse identity/family assembly
and the exact accumulator, but bypass grouped reads, speed selection helpers and
the memoized production pricer. Both clocks, all four periods, Spark, model
aliases, components, unknown speeds, missing prices and partial observations are
covered. Comparisons collect differences across the entire matrix before failing.

# Genuine failures exposed

The native security assertion finds that a newly created collector SQLite cache
has `daclProtected: false`. Its protected parent passes. The legacy writer uses
Node creation and `chmod(0600)` rather than the native protected-state creation
boundary, so POSIX mode is not sufficient on Windows. This is a product permission
contract failure, not evidence that unauthorized access has occurred. No real
profile ACL was modified, and no assertion was weakened to accept it.

An independent pricing comparison also exposes a real memoization error.
The reviewed `gpt-5.4` priority card covers the short context band only. The fast
pricer derives thresholds only from minimum-token conditions; because this tier
has no long-band card, it uses an infinite threshold and constructs a short-band
template even for long inputs. A synthetic event at 2026-07-24T12:00:00Z with
272,000 input-context tokens and 100 output tokens is unpriced by the public
ledger (`long_context_rule_missing`), while the memoized pricer returns 1.363 USD
as fully priced. The 271,999-token case agrees. A focused test checks all four
boundary inputs before reporting mismatches. Report and work-cell comparisons
also expose this instead of treating every old snapshot mismatch as harmless.

Fixing either production issue is outside this test-only change. Their failures
remain visible; this record must not be described as an all-green validation.

# Validation

Final per-file results on Windows x64 with Node.js 26.2.0:

| File | Passed | Failed | Meaning of remaining failures |
| --- | ---: | ---: | --- |
| `test/replay-safe-accounting-cache.test.js` | 66 | 1 | New SQLite cache DACL is not protected |
| `test/local-index-goldens.test.js` | 2 | 2 | Independent speed-tier report and complete work-cell comparisons expose the memoization defect |
| `test/speed-api-cost.test.js` | 5 | 1 | Focused Fast context-boundary regression reproduces the same defect |
| `test/windows-owner-only-state-security.test.js` | 3 | 0 | Native protected settings, locks and unsafe-root refusals pass |

The latest affected-file results total 80 tests, 76 passes, four failures and no
skips. They use the final cache-only rerun plus the unchanged pricing/native
files' combined run; they are not represented as a new combined all-green run.
The earlier combined receipt, before separating private retention fixtures from
new cache creation, is retained rather than overwritten. Source-plan exact and
over-limit checks, typed byte/resource failures, last-good serving, private ACL
retention and the Everyone-negative fixture all execute successfully.

Preflight passed 20 tests. Documentation governance and `git diff --check`
passed. A before/after SHA-256 over all current production files matched, and
the frozen golden fixture has no diff. No production permissions, accounting,
pricing registry or application state were changed to satisfy a test.

Owner-local ignored receipts are in `.release-build/overview-validation/`:
`accounting-test-contracts-final.log`, `accounting-cache-contracts-final.log`
and `accounting-test-contracts-preflight.log`. Native fixture evidence does not
qualify the live profile, an installed package, signing or release behavior.
