---
title: Composition-aware expected-line contract
date: 2026-08-10
type: design
status: maintained
last_verified_commit: 52399658f28303f6af00259f921c2c46a881978f
last_verified_date: 2026-08-27
---

# Composition-aware expected-line contract

## Outcome

The composition-aware expected line, allowance-pool saturation guard, and
lineage-scoped speed carry-forward are implemented. This document records the
maintained interpretation contract; it is not a live allowance measurement or
a provider-capacity claim.

The earlier constant expected line could mistake model mix for quota drift:
API-price-equivalent cost and provider allowance consumption are different
quantities, and their ratio varies by model. A saturated allowance also cannot
supply further observed percentage movement. The maintained model keeps those
limitations explicit instead of turning them into confident residuals.

## Contract

### Current selected-policy allowance comparison

The [2026-10-28 decision](../decisions/2026-10-28-desktop-calculation-and-unknown-speed.md)
requires desktop allowance comparison and runtime to use the selected policy's
capacity with costs from that same basis. A Standard-priced composition blend
must not override a speed-weighted selected-policy capacity. The independent
composition model and its per-model evidence remain retained; the composition
method below describes that separate model, not an interchangeable allowance
numerator/denominator.

### Composition-aware calibration

Fit a non-negative per-model API-price-equivalent capacity vector from the same
eligible calibration corpus used for the weekly report. Expected movement for a
bucket is the sum of each model's cost divided by that model's fitted capacity.
The headline rate is a cost-weighted blend for the observed mix; it is not a
universal allowance price.

Unknown, insufficient, stale, incompatible, or unidentifiable calibration
evidence stays unavailable. It must not silently fall back to a precise
constant or an invented zero.

### Saturation and reset handling

When a bucket begins at the provider-reported ceiling, both observed and
expected movement are unavailable for residual accumulation and the row is
marked as pool-saturated. Cost incurred after the ceiling must not be booked as
negative drift merely because the percentage cannot rise.

A reset or a new allowance-pool identity starts a new segment. Residual and
signed-area calculations exclude saturated spans rather than smoothing through
them. The dashboard renders the excluded state explicitly.

Dashboard rolling comparisons require two distinct quota observations. Observed
movement and cost-implied movement share their actual observation endpoints;
an older end observation does not authorize including later cost. Cumulative
comparison uses the same endpoint boundary, establishes cycle anchors before
clipping the display range, and retains explicit gaps and re-anchors. These
presentation rules do not change the estimator's eligible population or pricing
basis.

### Lineage-scoped speed carry-forward

A rollout may inherit the most recent reviewed speed tier from its own resume
history or reachable fork ancestry. It must never inherit from an unrelated
session, a process-global default, or a concurrent thread. When no reachable
declaration exists, speed remains unobserved.

This carry-forward changes pricing only where lineage supplies evidence. It
does not change token quantities, provider quota observations, model identity,
or replay suppression.

## Implementation map

- [Model-composition fitting](../../packages/quota-analysis/src/model-composition.js)
  owns per-model fitting and the blended-rate projection.
- [Weekly calibration](../../src/reporting/weekly-calibration.js) integrates the
  composition-aware vector into retained report evidence.
- [Expected-line construction](../../src/simple-quota-gradient.js) applies the
  vector and pool-saturation rules.
- `Unified-index ingestion` and
  [extraction](../../src/local-index-extract.js) implement
  lineage-scoped tier seeding.
- [Dashboard rendering](../../apps/web/public/app.js) displays per-model rates
  and explicit saturated states.
- [Focused regression tests](../../test/simple-quota-gradient.test.js) cover
  mixed-model calibration, historical synthetic fixtures, saturation, resets,
  and residual exclusion.
- [Package-boundary tests](../../test/quota-analysis-package-boundary.test.js)
  pin the public analysis implementation.

## Claim boundary

These checks establish deterministic local interpretation for the tested
source and fixtures. They do not establish a provider-published numeric
allowance, billing total, universal dollar-per-point constant, or live capacity
change. A new model family, quota identity, parser version, or provider
accounting policy must remain unknown until source-backed calibration and
regression evidence are reviewed.

## Maintenance triggers

Revalidate this contract when any of the following changes:

- model normalization or pricing semantics;
- quota-pool identity, duration, reset, or saturation handling;
- weekly calibration eligibility or fitting code;
- session lineage, fork replay, or speed-tier inheritance; or
- dashboard residual, signed-area, or unavailable-state rendering.


## Historical plan comparison populations

The local report publishes separate, bounded usage lanes for observed historical
plans as well as the latest plan. Plus/Pro upgrades, downgrades and later returns
to an earlier plan are permitted under the owner's single-account, continuous-
subscription assumption; that assumption does not certify account identity.
Each lane uses its own plan's existing calibration population and is fenced by
pricing basis, reset cohort and committed source generation. It is a comparison
projection of the replay-safe ledger, never another accounting input.

A quantity interval that crosses an uncertain plan change is not assigned from
its ending label alone. Ambiguous buckets are omitted individually and exposed
as dated excluded intervals. Sound usage and quota observations remain visible
when another interval or the capacity estimate is unavailable. Historical fits
use the existing plan-specific scalar when no plan-specific model vector exists;
the latest plan's vector cannot fill that gap. Refresh publishes all lanes in the
same report; there is no per-plan timer or source re-ingestion.


Plan-scoped reports retain complete observed quota separately from comparable
quota. A historical last observation cannot depend on the generic chart sampler
or disappear because its final partial bucket has an unresolved usage interval.
Only comparison arithmetic uses the eligibility intervals; the observation chart
and last-reading headline keep the original observation and timestamp.
