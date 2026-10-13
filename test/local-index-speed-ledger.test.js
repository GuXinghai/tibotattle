import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { refreshLocalIndex } from "../src/local-index-refresh.js";
import {
  buildCalibrationLayer,
  createCalibrationLayerMemo,
  openLocalIndexCalibrationCorpus,
} from "../src/local-index-calibration.js";
import { readLocalIndexReport } from "../src/local-index-report.js";
import { openLocalIndexStore, withReadSnapshot } from "../src/local-index-store.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

// Gate C1: a change to the declared-speed ledger alone, with no change to the
// index, must change every figure that depends on it, and nothing may hold a
// ledger-derived value that outlives the ledger it came from.
//
// The ledger is mutable: its newest window is extended in place on every
// reading, it keeps at most 64 windows and can be erased. The shipping
// accounting cache fingerprints none of that. These tests pin the successor's
// property: figures are a pure function of (one store snapshot, the clock, the
// ledger), and the store carries no ledger-derived column.

const END_MS = Date.parse("2026-09-01T00:00:00.000Z");
const DAY = 86_400_000;
const LIMITS = Object.freeze({
  usageEvents: 750_000, weeklySnapshots: 750_000, combinedInputs: 1_500_000,
  retainedBytes: 320 * 1024 * 1024,
});
const CORPUS = {
  variety: true, files: 110, events: 12_000, days: 56, seed: 13,
  fillerBytesPerEvent: 0, quotaRate: 1, endAt: "2026-09-01T00:00:00.000Z",
};

const window = (mode, firstMs, lastMs) => ({
  mode,
  firstSeenAt: new Date(firstMs).toISOString(),
  lastSeenAt: new Date(lastMs).toISOString(),
});

function readReport(file, options) {
  const database = openLocalIndexStore(file, { readOnly: true });
  try {
    return withReadSnapshot(database, () => readLocalIndexReport(database, options));
  } finally {
    database.close();
  }
}

const declared = (report, id = "all") => report.usage.find((period) => period.id === id)
  .declaredSpeedWeighting;
const declaredEvents = (report, id = "all") => Object.values(declared(report, id))
  .flatMap((row) => Object.values(row))
  .reduce((sum, cell) => sum + cell.events, 0);

async function layer(file, baselines) {
  const nowMs = END_MS + 3_600_000;
  const corpus = await openLocalIndexCalibrationCorpus({
    indexFile: file, endMs: nowMs, limits: LIMITS, declaredSpeedBaselines: baselines,
  });
  return buildCalibrationLayer({
    calibrationCorpus: corpus, endMs: nowMs, limits: LIMITS,
    declaredSpeedBaselines: baselines, generation: "1", generationFingerprint: "fingerprint",
  });
}
const calibrationDigest = (value) => JSON.stringify([
  value.weeklyCalibration, value.allowanceCapacityByScenario,
  value.fiveHourAllowanceCalibration, value.planScopedTimeline,
]);

test("the report follows the ledger across erase, in-place extension and the window cap", async () => {
  const workspace = createWorkspace(CORPUS);
  try {
    const file = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const nowMs = END_MS + 3_600_000;
    const baselines = [window("fast", END_MS - 20 * DAY, END_MS - 10 * DAY)];

    const withLedger = readReport(file, { nowMs, declaredSpeedBaselines: baselines });
    const without = readReport(file, { nowMs, declaredSpeedBaselines: [] });
    assert.ok(declaredEvents(withLedger) > 0, "the declaration covered unobserved events");
    assert.equal(declaredEvents(without), 0, "erasing the ledger removes the attribution");

    // The newest window is extended in place; the next report reflects it.
    const extended = [window("fast", END_MS - 20 * DAY, END_MS - 4 * DAY)];
    const grown = readReport(file, { nowMs, declaredSpeedBaselines: extended });
    assert.ok(declaredEvents(grown) > declaredEvents(withLedger), "a longer window covers more");
    assert.deepEqual(
      declared(readReport(file, { nowMs, declaredSpeedBaselines: baselines })),
      declared(withLedger),
      "the same ledger always gives the same figures",
    );

    // Sixty-five windows: the oldest is dropped, and its coverage with it. The
    // oldest here is the long one, so the loss is certain to show.
    const many = [window("fast", END_MS - 50 * DAY, END_MS - 30 * DAY)];
    const short = DAY / 24;
    for (let index = 1; index < 64; index += 1) {
      const start = END_MS - 29 * DAY + index * (DAY / 4);
      many.push(window(index % 2 === 0 ? "fast" : "standard", start, start + short));
    }
    const before = readReport(file, { nowMs, declaredSpeedBaselines: many });
    const capped = many.slice(1);
    const next = END_MS - 29 * DAY + 64 * (DAY / 4);
    capped.push(window("ultrafast", next, next + short));
    const after = readReport(file, { nowMs, declaredSpeedBaselines: capped });
    assert.ok(declaredEvents(before) > declaredEvents(after), "the dropped window's coverage is gone");
    assert.notDeepEqual(declared(after), declared(before));

    // Nothing in the store derives from the ledger.
    const database = openLocalIndexStore(file, { readOnly: true });
    try {
      const definitions = database.prepare(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL",
      ).all().map((row) => row.sql).join("\n");
      assert.doesNotMatch(definitions, /declared|ledger|baseline/iu);
    } finally {
      database.close();
    }
  } finally {
    workspace.cleanup();
  }
});

test("the calibration layer is a pure function of the snapshot and the ledger", async () => {
  const workspace = createWorkspace(CORPUS);
  try {
    const file = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const fast = [window("fast", END_MS - 30 * DAY, END_MS - 5 * DAY)];
    const ultra = [window("ultrafast", END_MS - 30 * DAY, END_MS - 5 * DAY)];
    const none = calibrationDigest(await layer(file, []));
    const fastA = calibrationDigest(await layer(file, fast));
    const fastB = calibrationDigest(await layer(file, fast));
    const ultraDigest = calibrationDigest(await layer(file, ultra));
    assert.equal(fastB, fastA, "no hidden state: the same ledger gives the same layer");
    assert.notEqual(fastA, none, "adding a declaration changes the layer with no index change");
    assert.notEqual(ultraDigest, fastA, "changing a declaration's mode changes it again");
    assert.equal(calibrationDigest(await layer(file, [])), none, "erasing returns the original");
  } finally {
    workspace.cleanup();
  }
});

test("the memo reuses a layer only for the same snapshot, ledger and clock", async () => {
  const workspace = createWorkspace({ ...CORPUS, files: 40, events: 2_000, days: 20 });
  try {
    const file = join(workspace.state, "v2.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile,
      workerCount: 1,
    };
    await refreshLocalIndex(options);
    let opened = 0;
    const memo = createCalibrationLayerMemo({
      maximumEntries: 2,
      open: (parameters) => { opened += 1; return openLocalIndexCalibrationCorpus(parameters); },
    });
    const endMs = END_MS + 3_600_000;
    const ledger = [window("fast", END_MS - 12 * DAY, END_MS - 5 * DAY)];
    const read = (baselines, at = endMs) => memo.read({
      indexFile: file, endMs: at, limits: LIMITS, declaredSpeedBaselines: baselines,
      generation: "1", generationFingerprint: "fingerprint",
    });

    const first = await read(ledger);
    assert.equal(first.memoized, false);
    const again = await read(ledger);
    assert.equal(again.memoized, true);
    assert.equal(again.layer, first.layer, "the same snapshot, ledger and clock share one result");
    assert.equal(opened, 1);

    // The ledger is part of the key: an edited or erased ledger recomputes.
    const edited = await read([window("fast", END_MS - 12 * DAY, END_MS - 4 * DAY)]);
    assert.equal(edited.memoized, false);
    const erased = await read([]);
    assert.equal(erased.memoized, false);
    assert.equal(opened, 3);
    // Two entries are retained: the original was evicted and recomputes.
    assert.equal((await read(ledger)).memoized, false);

    // A committed refresh changes the snapshot; the clock is part of the key.
    const beforeAppend = (await read(ledger)).commitSeq;
    appendSyntheticCodexEvents(workspace.receipt.sources.slice(0, 2), {
      seed: 99, events: 5, fillerBytesPerEvent: 0, atMs: END_MS + 1_000,
    });
    await refreshLocalIndex(options);
    const afterAppend = await read(ledger);
    assert.ok(afterAppend.commitSeq > beforeAppend);
    assert.equal(afterAppend.memoized, false);
    assert.equal((await read(ledger, endMs + 1)).memoized, false);

    // Concurrent callers with one key share the computation in flight.
    memo.clear();
    opened = 0;
    const [left, right] = await Promise.all([read(ledger), read(ledger)]);
    assert.equal(opened, 1);
    assert.equal(left.layer, right.layer);
  } finally {
    workspace.cleanup();
  }
});
