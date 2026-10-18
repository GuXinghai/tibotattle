import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocalCompanionSnapshot } from "../src/local-companion-data.js";
import {
  commitLocalCollectorState,
  defaultLocalCollectorStatePath,
  prepareLocalCollectorState,
} from "../src/local-collector-state.js";
import {
  isExactWeeklyPaceForecast,
  projectWeeklyPaceForecast,
  projectWeeklyPaceOutlook,
  weeklyPaceSnapshotsFromCollectorRecord,
} from "../src/weekly-pace-projection.js";
import {
  normalizeDashboardPayload,
} from "../apps/web/public/data-client.js";

const NOW = Date.parse("2026-08-03T12:30:00.000Z");
const RESETS_AT = Math.floor(Date.parse("2026-08-10T12:00:00.000Z") / 1_000);

function accountScope(letter) {
  return {
    status: "available",
    reason: null,
    version: "openai-account-v1",
    scopeId: `openai-account:v1:${letter.repeat(43)}`,
    planType: "pro",
  };
}

function quotaRecord({
  observedAt,
  usedPercent,
  account = "A",
  source = "app_server_read",
}) {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt,
    receivedAt: observedAt,
    stalenessMs: 0,
    source,
    accountScope: account === null ? {
      status: "unavailable",
      reason: "missing_secret",
      version: "openai-account-v1",
      scopeId: null,
      planType: "pro",
    } : accountScope(account),
    windows: [{
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot: "secondary",
      windowDurationMins: 10_080,
      resetsAt: RESETS_AT,
      usedPercent,
    }],
  };
}

// These fixtures exercise the current owner-only SQLite state directly.
// Legacy JSON migration remains covered by local-collector-state.test.js.
async function writeCollectorState(root, records) {
  const stateFile = defaultLocalCollectorStatePath(root);
  await prepareLocalCollectorState({ stateFile, clock: () => NOW });
  await commitLocalCollectorState({
    stateFile,
    checkpoint: {},
    records,
    clock: () => NOW,
  });
}

test("local companion sends a private account-scoped pace ETA as a safe public projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "weekly-pace-local-companion-"));
  const stateFile = defaultLocalCollectorStatePath(root);
  const records = [
    quotaRecord({ observedAt: "2026-08-03T12:15:00.000Z", usedPercent: 20 }),
    quotaRecord({ observedAt: "2026-08-03T12:30:00.000Z", usedPercent: 30 }),
  ];
  try {
    await writeCollectorState(root, records);
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      now: () => NOW,
      allowDevelopmentArtifactFallback: false,
    });
    assert.deepEqual(snapshot.weekly.paceForecast, {
      schemaVersion: "local-weekly-pace-forecast-v0.2",
      status: "available",
      currentUsedPercent: 30,
      remainingPercent: 70,
      resetsAt: "2026-08-10T12:00:00.000Z",
      pace: {
        method: "median_adjacent_quota_slope",
        sampleCount: 1,
        elapsedHours: 0.25,
        movementPp: 10,
        // One 15-minute interval that moved, so the working rate and the
        // wall-clock rate are the same 40pp/hour here.
        activePercentagePointsPerHour: 40,
        overallPercentagePointsPerHour: 40,
      },
      observationCount: 2,
      etaAt: "2026-08-03T14:15:00.000Z",
      hoursToExhaustion: 1.75,
      hoursToReset: 167.5,
    });
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(accountScope("A").scopeId), false);
    assert.equal(serialized.includes("accountScope"), false);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the local pace adapter refuses an unattributed or non-app-server current observation", () => {
  const prior = quotaRecord({
    observedAt: "2026-08-03T12:15:00.000Z",
    usedPercent: 20,
  });
  const current = quotaRecord({
    observedAt: "2026-08-03T12:30:00.000Z",
    usedPercent: 30,
    account: null,
  });
  const observations = [prior, current].flatMap(
    weeklyPaceSnapshotsFromCollectorRecord,
  );
  assert.equal(projectWeeklyPaceForecast({
    currentRecord: current,
    observations,
    nowMs: NOW,
  }).status, "unavailable");

  const untrustedCurrent = quotaRecord({
    observedAt: "2026-08-03T12:30:00.000Z",
    usedPercent: 30,
    source: "rollout_log",
  });
  assert.equal(projectWeeklyPaceForecast({
    currentRecord: untrustedCurrent,
    observations,
    nowMs: NOW,
  }).status, "unavailable");
});

test("refused pace estimates always use the canonical public unavailable DTO", () => {
  const current = quotaRecord({ observedAt: "2026-08-03T12:30:00.000Z", usedPercent: 30 });
  for (const prior of [
    quotaRecord({ observedAt: "2026-08-03T12:15:00.000Z", usedPercent: 40 }),
    quotaRecord({ observedAt: "2026-08-03T12:15:00.000Z", usedPercent: 30 }),
    quotaRecord({ observedAt: "2026-08-03T12:31:00.000Z", usedPercent: 29 }),
    { ...quotaRecord({ observedAt: "2026-08-03T12:15:00.000Z", usedPercent: 20 }),
      receivedAt: "2026-08-03T12:25:00.000Z" },
  ]) {
    const result = projectWeeklyPaceForecast({ currentRecord: current,
      observations: weeklyPaceSnapshotsFromCollectorRecord(prior), nowMs: NOW });
    assert.equal(result.status, "unavailable");
    assert.ok(isExactWeeklyPaceForecast(result));
    assert.deepEqual(result, projectWeeklyPaceForecast());
  }
});

test("an observed exhausted pool stays distinct from absent evidence, including a flat 100% series", () => {
  const current = quotaRecord({ observedAt: "2026-08-03T12:30:00.000Z", usedPercent: 100 });
  for (const usedPercent of [null, 90, 100]) {
    const observations = usedPercent === null ? [] : weeklyPaceSnapshotsFromCollectorRecord(
      quotaRecord({ observedAt: "2026-08-03T12:15:00.000Z", usedPercent }));
    const result = projectWeeklyPaceForecast({ currentRecord: current, observations, nowMs: NOW });
    assert.equal(result.status, "exhausted");
    assert.equal(result.hoursToExhaustion, 0);
    assert.equal(result.etaAt, null);
    assert.ok(isExactWeeklyPaceForecast(result));
    const outlook = projectWeeklyPaceOutlook({ forecast: result, nowMs: NOW });
    assert.equal(outlook.status, "exhausted");
    assert.equal(outlook.remainingPercent, 0);
    assert.equal(outlook.rates.ratio, null);
    assert.equal(outlook.track.coveredFraction, 0);
    assert.equal(outlook.critical, true);
    assert.equal(outlook.projection.dryHours, outlook.projection.hoursToReset);
    assert.deepEqual(normalizeDashboardPayload({ weekly: { paceForecast: result, paceOutlook: outlook } }).weekly.paceOutlook, outlook);
  }
  const stale = projectWeeklyPaceForecast({ currentRecord: current, nowMs: NOW + 31 * 60_000 });
  assert.equal(stale.status, "unavailable");
  assert.equal(projectWeeklyPaceOutlook({ forecast: stale, nowMs: NOW }).remainingPercent, null);
  const nearly = projectWeeklyPaceForecast({ currentRecord: { ...current,
    windows: [{ ...current.windows[0], usedPercent: 99.9999999 }] }, nowMs: NOW });
  assert.notEqual(nearly.status, "exhausted");
});

test("local companion retains one safe observation as a non-predictive waiting state", async () => {
  const root = await mkdtemp(join(tmpdir(), "weekly-pace-waiting-state-"));
  const stateFile = defaultLocalCollectorStatePath(root);
  const records = [
    quotaRecord({ observedAt: "2026-08-03T12:15:00.000Z", usedPercent: 20 }),
  ];
  try {
    await writeCollectorState(root, records);
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      now: () => NOW,
      allowDevelopmentArtifactFallback: false,
    });
    assert.deepEqual(snapshot.weekly.paceForecast, {
      schemaVersion: "local-weekly-pace-forecast-v0.2",
      status: "insufficient_observations",
      currentUsedPercent: 20,
      remainingPercent: 80,
      resetsAt: "2026-08-10T12:00:00.000Z",
      pace: {
        method: "median_adjacent_quota_slope",
        sampleCount: 0,
        elapsedHours: 0,
        movementPp: 0,
        activePercentagePointsPerHour: null,
        overallPercentagePointsPerHour: null,
      },
      observationCount: 1,
      etaAt: null,
      hoursToExhaustion: null,
      hoursToReset: 167.75,
    });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the projection the companion publishes survives the browser boundary", () => {
  // Three files hold an independent exact-key check on this payload: the
  // engine builds it, `publicForecast` republishes it, and the browser's
  // `normalizeWeeklyPaceForecast` refuses anything whose shape or schema
  // version it does not recognise. Each layer has its own tests, and all of
  // them would still pass if a field were renamed in two places out of three -
  // the card would simply stop rendering, silently, in production only.
  //
  // This is the assertion that closes that gap: a real projection, run through
  // the real browser validator, must come back byte-identical.
  const observations = [];
  for (let minute = 0; minute < 240; minute += 10) {
    observations.push(quotaRecord({
      observedAt: new Date(Date.parse("2026-08-03T08:00:00.000Z") + minute * 60_000)
        .toISOString(),
      usedPercent: minute < 20 ? 0 : 1,
    }));
  }
  const snapshots = observations.flatMap(weeklyPaceSnapshotsFromCollectorRecord);
  const forecast = projectWeeklyPaceForecast({
    currentRecord: quotaRecord({
      observedAt: "2026-08-03T12:00:00.000Z",
      usedPercent: 1,
    }),
    observations: snapshots,
    nowMs: NOW,
  });

  // Dense polling with one moving interval: the two rates must be far apart,
  // or this fixture is not exercising the thing it exists to protect.
  assert.equal(forecast.pace.activePercentagePointsPerHour, 6);
  assert.equal(forecast.pace.overallPercentagePointsPerHour, 0.25);

  const normalized = normalizeDashboardPayload({
    weekly: { paceForecast: forecast },
  });
  assert.deepEqual(normalized.weekly.paceForecast, forecast);
});
