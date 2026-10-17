---
title: Accounting test contracts on Windows
date: 2026-10-16
type: plan
status: completed-with-product-failures
---

# Scope and acceptance

Change tests and test documentation only. Preserve existing production changes,
original records and the frozen v1 golden fixture. Replace POSIX permission
assertions with native Windows ACL checks; retain genuine permission failures.
Exercise both main and fallback scan calls, exact source limits and last-good
retention. Compare historical Standard values to the frozen fixture, and current
speed-tier reports and complete work cells to an independent per-event public
pricing oracle. Keep unknown speeds, unavailable rates, missing components,
historical dates and context boundaries explicit. Run affected files, native
permission checks and documentation/preflight validation without restarting or
mutating the real application profile.

Initial investigation found a genuine boundary: newly created legacy collector
SQLite caches do not acquire a protected owner-only DACL, even under a protected
fixture directory. Tests must expose this rather than prepare or repair the
resulting cache's ACL. Production remediation is outside this task's authority.

Test updates and targeted validation are complete. Retention cases start from
a native-provisioned private fixture; new production cache creation remains a
separate failing security check. The independent pricing oracle also exposes a
Fast long-context memoization defect. See the [validation record](../qa/2026-10-16-accounting-test-contracts.md)
for the four retained product failures, passing checks and unchanged-source proof.
