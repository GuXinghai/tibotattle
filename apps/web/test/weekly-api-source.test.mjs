import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDashboardPayload, selectAllowancePlanPopulation } from '../public/data-client.js';
import { validateWeeklyApiIntervals } from '../public/weekly-api-intervals.js';

const start = Date.parse('2026-10-10T00:00:00.000Z'), hour = 3_600_000;
const fingerprint = `generation-v2-${'a'.repeat(64)}`;
function fixture() {
  const row = (planType, offset, weeklyUsd, reason = null) => ({
    planType, startMs: start + offset * hour, endMs: start + (offset + 1) * hour,
    segment: offset, quotaPp: reason ? null : 1, apiUsd: '1',
    weeklyUsd: reason ? null : weeklyUsd, reason,
    usageEvents: 1, unknownSpeedEvents: 0, excludedReviewEvents: 0,
    excludedReviewUsd: '0', priceCardIds: ['synthetic-card'],
  });
  const population = (planType, value) => ({
    planType, status: value === null ? 'insufficient_evidence' : 'available',
    planAttribution: { methodVersion: 'plan-era-v1', status: 'historical_plan_conditional', accountVerified: false },
    datasets: { summary: [{ plan_type: planType, median_weekly_value_usd: value }],
      weekly_values: value === null ? [] : [{ plan_type: planType, value_usd: value }] },
  });
  return {
    overview: {
      generatedAt: new Date(start + 4 * hour).toISOString(),
      accounting: { sourceMode: 'unified', generationMatched: true, generation: 17, generationFingerprint: fingerprint },
      timeline: {
        // As immediately after an upgrade, quota fits are unavailable and the
        // partial collector timeline carries no accounting-generation metadata.
        history: { status: 'partial' },
        weeklyApiIntervals: {
          schemaVersion: 'weekly-api-interval-v1', status: 'available', reason: null,
          generatedAt: new Date(start + 4 * hour).toISOString(),
          sourceGeneration: '17', sourceFingerprint: fingerprint,
          rows: [row('prolite', 0, 100), row('prolite', 1, null, 'plan_conflict'), row('pro', 2, 100)],
        },
      },
    },
    weekly: { ...population('pro', null), selectedPlanType: 'pro',
      planPopulations: [population('prolite', 100), population('pro', null)] },
  };
}

test('unified intervals use accounting provenance when optional plan fits and history cannot supply it', () => {
  const payload = fixture();
  validateWeeklyApiIntervals(payload.overview.timeline.weeklyApiIntervals);
  const result = normalizeDashboardPayload(payload);
  assert.equal(result.timeline.weeklyApiIntervals.status, 'available');
  assert.equal(result.timeline.weeklyApiIntervals.rows.length, 3);
  assert.equal(result.timeline.planScoped.status, 'unavailable');
  assert.equal(result.timeline.allowanceCapacity.status, 'unavailable');
  payload.overview.accounting.generation = '17.0';
  assert.equal(normalizeDashboardPayload(payload).timeline.weeklyApiIntervals.status, 'available');
});

test('missing, unverified and malformed accounting provenance cannot borrow timeline provenance', () => {
  for (const mutate of [
    a => { delete a.generation; }, a => { delete a.generationFingerprint; },
    a => { a.generationMatched = false; }, a => { delete a.generationMatched; },
    a => { a.generation = Number.MAX_SAFE_INTEGER + 1; },
    a => { a.generationFingerprint = 'malformed'; },
  ]) {
    const payload = fixture();
    Object.assign(payload.overview.timeline.history, { generation: 17, generationFingerprint: fingerprint });
    mutate(payload.overview.accounting);
    const result = normalizeDashboardPayload(payload).timeline.weeklyApiIntervals;
    assert.equal(result.reason, 'weekly_api_source_unavailable');
    assert.deepEqual(result.rows, []);
  }
});

test('actual source-generation and fingerprint mismatches still fail closed', () => {
  for (const mutate of [a => { a.generation = 18; },
    a => { a.generationFingerprint = `generation-v2-${'b'.repeat(64)}`; }]) {
    const payload = fixture(); mutate(payload.overview.accounting);
    const result = normalizeDashboardPayload(payload).timeline.weeklyApiIntervals;
    assert.equal(result.reason, 'weekly_api_source_mismatch'); assert.deepEqual(result.rows, []);
  }
  const payload = fixture();
  payload.overview.timeline.weeklyApiIntervals.rows[0].weeklyUsd = 200;
  assert.equal(normalizeDashboardPayload(payload).timeline.weeklyApiIntervals.reason, 'weekly_api_validation_failed',
    'valid source metadata cannot authorize malformed interval evidence');
});

test('non-unified payloads retain their existing history-based source fence', () => {
  const payload = fixture(); delete payload.overview.accounting;
  assert.equal(normalizeDashboardPayload(payload).timeline.weeklyApiIntervals.reason, 'weekly_api_source_unavailable');
  payload.overview.timeline.history = { generation: 17, generationFingerprint: fingerprint };
  assert.equal(normalizeDashboardPayload(payload).timeline.weeklyApiIntervals.status, 'available');
  payload.overview.timeline.history.generation = 18;
  assert.equal(normalizeDashboardPayload(payload).timeline.weeklyApiIntervals.reason, 'weekly_api_source_mismatch');
});

test('upgrading to Pro 10x preserves selectable Pro Lite 5x history without borrowing its fit', () => {
  const payload = fixture(), original = structuredClone(payload);
  const root = normalizeDashboardPayload(payload), before = structuredClone(root);
  const current = selectAllowancePlanPopulation(root);
  assert.equal(current.allowancePlanSelection.planType, 'pro');
  assert.equal(current.weekly.status, 'insufficient_evidence');
  assert.equal(current.weekly.summary.median_weekly_value_usd, null);
  assert.deepEqual(current.timeline.selectedWeeklyApiIntervals.rows.map(r => r.planType), ['pro']);
  const history = selectAllowancePlanPopulation(current, 'prolite');
  assert.equal(history.allowancePlanSelection.isCurrentPlan, false);
  assert.equal(history.weekly.summary.median_weekly_value_usd, 100);
  assert.deepEqual(history.weekly.planPopulations.map(p => p.planType), ['prolite', 'pro']);
  validateWeeklyApiIntervals(history.timeline.selectedWeeklyApiIntervals);
  assert.deepEqual(history.timeline.selectedWeeklyApiIntervals.rows.map(r => [r.planType, r.weeklyUsd, r.reason]),
    [['prolite', 100, null], ['prolite', null, 'plan_conflict']]);
  assert.equal(history.weekly.paceForecast, null);
  assert.deepEqual(history.quotaWindows, []);
  assert.strictEqual(selectAllowancePlanPopulation(history, 'pro'), current);
  assert.strictEqual(history.accounting, root.accounting);
  assert.strictEqual(history.timeline.usage, root.timeline.usage);
  assert.deepEqual(root, before); assert.deepEqual(payload, original);
});
