---
title: Desktop calculation and explicit unknown-speed assumptions
date: 2026-10-28
type: decision
status: accepted
---

# Decision

Ordinary desktop calculation produces bounded product results without executing
the complete historical research report. Shared grouping, eligibility, capacity
fitting and basic validation remain common; delay experiments, forecast method
comparisons, online checkpoints, regime hypotheses, research error rankings and
frozen-baseline reproduction belong only to the independent research entrypoint.
Research entrypoints remain available for a later separate redesign.

The owner selects the assumption for unresolved speed: Standard, Fast, or a
custom Fast percentage from 0 through 100 with at most two decimal places.
Observed speed, including Ultrafast, and valid timestamped declaration evidence
retain their existing precedence. The setting never rewrites recorded evidence.
The default is Standard. A custom ratio mixes endpoint costs before capacity
fitting, not fitted capacities. Allowance costs, capacity and runtime projections
must agree on their full calculation basis, including the custom ratio.
Independent API-price-equivalent accounting and token facts keep their meaning.

Saving changes applies to the next ordinary or manual refresh, without starting
work or lifting pause. A running calculation keeps its captured policy. Old
results retain their actual policy and evaluation time until replaced.

# Preservation and conversion

Settings and derived caches use a one-time, copy-only conversion rather than
runtime old-format compatibility. A version change does not authorize deleting
facts, checkpoints, settings, history, salts, source catalogs or last surviving
results. The collector database is not a disposable cache directory.

Conversion preserves the complete previous cache in a protected historical
envelope, with original evaluation, coverage and pricing provenance. A new
bounded historical projection can present original API and token totals; it is
never current allowance evidence. Normal publication refuses overwriting an
unmigrated cache of another schema. Unknown versions fail closed.

The [preservation inventory and conversion boundary](../plans/2026-10-28-desktop-calculation-preservation.md)
defines the retained fields and isolated synthetic acceptance checks. Developing
the converter does not execute a migration or activate a user profile.
