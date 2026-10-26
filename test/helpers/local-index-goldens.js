import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { refreshLocalIndex } from "../../src/local-index-refresh.js";
import {
  buildCalibrationLayer,
  openLocalIndexCalibrationCorpus,
} from "../../src/local-index-calibration.js";
import { readLocalIndexReport } from "../../src/local-index-report.js";
import { openLocalIndexStore, withReadSnapshot } from "../../src/local-index-store.js";
import { readLocalIndexWorkUsage } from "../../src/local-index-work-usage.js";
import { createWorkspace } from "./local-index-facts.js";
import { readPricingOracleFacts, reportSpeedOracle, workPricingOracle } from "./local-index-pricing-oracle.js";

// Golden outputs of the shipping (v1) implementation at commit cf94e9a8, over
// one committed synthetic corpus. They were generated once, while that
// implementation existed, so the successor keeps being held to it after the
// implementation is removed. Everything here is derived from the content-free
// generator; nothing private is involved.

export const GOLDEN_CORPUS = Object.freeze({
  variety: true,
  files: 90,
  events: 9_000,
  days: 49,
  seed: 101,
  fillerBytesPerEvent: 0,
  quotaRate: 1,
  endAt: "2026-09-01T00:00:00.000Z",
});
export const GOLDEN_END_MS = Date.parse(GOLDEN_CORPUS.endAt);
export const GOLDEN_CLOCKS = Object.freeze([
  ["after-the-corpus", GOLDEN_END_MS + 3_600_000],
  ["unaligned-inside", GOLDEN_END_MS - 9 * 86_400_000 - 11 * 60_000 - 4_321],
]);
export const GOLDEN_LEDGER = Object.freeze([
  { mode: "fast", firstSeenAt: "2026-08-02T05:00:00.000Z", lastSeenAt: "2026-08-12T07:30:00.123Z" },
  { mode: "standard", firstSeenAt: "2026-08-15T01:15:00.000Z", lastSeenAt: "2026-08-24T21:00:00.000Z" },
]);
export const GOLDEN_LIMITS = Object.freeze({
  usageEvents: 750_000, weeklySnapshots: 750_000, combinedInputs: 1_500_000,
  retainedBytes: 320 * 1024 * 1024,
});

/**
 * The device salt roots every local digest, so the goldens pin one. It is a
 * fixed public constant: this index holds only synthetic, content-free data.
 */
export function pinGoldenSalt(workspace) {
  writeFileSync(
    workspace.secretFile,
    createHash("sha256").update("usagemonitor local index goldens").digest(),
    { mode: 0o600, flag: "wx" },
  );
}

/** Key order is not part of the meaning of an object. */
const canonicalText = (value) => JSON.stringify(value, (key, item) => (
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]))
    : item));
const digest = (value) => createHash("sha256").update(canonicalText(value)).digest("hex");

/** Large series are held as a digest plus enough to see what moved. */
function series(rows, pick) {
  return {
    count: rows.length,
    first: rows.length === 0 ? null : pick(rows[0]),
    last: rows.length === 0 ? null : pick(rows.at(-1)),
    digest: digest(rows),
  };
}

const MONEY_KEYS = new Set(["apiPriceEquivalentUsd", "costUsd"]);

/** Key-sorted copy of a value with every money figure moved into `sink`. */
function withoutMoney(value, sink) {
  if (Array.isArray(value)) return value.map((item) => withoutMoney(item, sink));
  if (value === null || typeof value !== "object") return value;
  const copy = {};
  for (const key of Object.keys(value).sort()) {
    if (MONEY_KEYS.has(key) && typeof value[key] === "number") {
      sink.push(value[key]);
      copy[key] = "$";
    } else {
      copy[key] = withoutMoney(value[key], sink);
    }
  }
  return copy;
}

/**
 * A series whose rows carry money: the digest covers everything but the money,
 * which is held beside it in traversal order so it can be compared within the
 * sanctioned float-rounding tolerance.
 */
function moneySeries(rows, pick) {
  const money = [];
  const canonical = withoutMoney(rows, money);
  return {
    count: rows.length,
    first: rows.length === 0 ? null : pick(rows[0]),
    last: rows.length === 0 ? null : pick(rows.at(-1)),
    digest: digest(canonical),
    apiPriceEquivalentUsd: money,
  };
}

const CONDENSE_BYTES = 1_500;

/**
 * Cache impacts are derived by one shared analyzer over the same rows, so their
 * figures compare exactly: a large breakdown is held as a digest, while every
 * scalar and every small subtree stays readable.
 */
function condensePeriods(impact) {
  return {
    ...impact,
    periods: impact.periods.map((period) => Object.fromEntries(Object.entries(period)
      .map(([key, value]) => {
        if (value === null || typeof value !== "object") return [key, value];
        const text = canonicalText(value);
        return text.length <= CONDENSE_BYTES
          ? [key, value]
          : [key, { digest: createHash("sha256").update(text).digest("hex"), bytes: text.length }];
      }))),
  };
}

export function goldenReportView(report) {
  return JSON.parse(JSON.stringify({
    coveredAt: report.coveredAt,
    usageEvents: report.usageEvents,
    quotaObservations: report.quotaObservations,
    latestExportableRecordAt: report.latestExportableRecordAt,
    tools: report.tools,
    toolCoverageStatus: report.toolCoverageStatus,
    toolCoverageBlockReason: report.toolCoverageBlockReason,
    usage: report.usage,
    cacheSwitchImpact: condensePeriods(report.cacheSwitchImpact),
    cacheContinuityImpact: condensePeriods(report.cacheContinuityImpact),
    timeline: {
      bucketMinutes: report.timeline.bucketMinutes,
      coveredAt: report.timeline.coveredAt,
      usage: moneySeries(report.timeline.usage, (row) => [row.startAt, row.usageEvents]),
      sparkUsage: moneySeries(report.timeline.sparkUsage, (row) => [row.startAt, row.usageEvents]),
      quota: series(report.timeline.quota, (row) => [row.observedAt, row.usedPercent]),
      sparkQuota: series(report.timeline.sparkQuota, (row) => [row.observedAt, row.usedPercent]),
    },
  }));
}

export function goldenLayerView(layer) {
  const { usageMetadataBytes, estimatedRetainedBytes, ...input } = layer.weeklyCalibrationInput;
  void usageMetadataBytes;
  void estimatedRetainedBytes;
  return JSON.parse(JSON.stringify({
    weeklyCalibration: layer.weeklyCalibration,
    allowanceCapacityByScenario: layer.allowanceCapacityByScenario,
    fiveHourAllowanceCalibration: layer.fiveHourAllowanceCalibration,
    // The frozen golden predates explicit excluded intervals; its accounting
    // fields remain exact. New plan projections have independent regression tests.
    planScopedTimeline: Object.fromEntries(Object.entries(layer.planScopedTimeline).filter(([key]) => !["excludedIntervals", "observedQuota"].includes(key))),
    weeklyCalibrationInput: input,
  }));
}

export function goldenWorkView(work) {
  const periods = {};
  for (const [id, period] of Object.entries(work.periods)) {
    periods[id] = {
      fromMs: period.fromMs,
      toMs: period.toMs,
      scopes: period.scopes,
      snapshots: Object.fromEntries(Object.entries(period.snapshots).map(([scope, snapshot]) => {
        const cells = [...snapshot.cells].sort((left, right) => (
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        return [scope, {
          cellCount: cells.length,
          cellsDigest: digest(cells),
          models: snapshot.models,
          threadCount: Object.keys(snapshot.display.threads).length,
          threadLookupDigest: digest(snapshot.threadLookup),
          familiesDigest: digest(snapshot.threadFamilies),
          totals: cells.reduce((sum, cell) => ({
            events: sum.events + cell.events,
            tokens: sum.tokens + (cell.tokens ?? 0),
            incomplete: sum.incomplete + cell.incompleteEvents,
            unpriced: sum.unpriced + cell.unpricedEvents,
          }), { events: 0, tokens: 0, incomplete: 0, unpriced: 0 }),
          excluded: snapshot.metadata.excludedAllowanceUpdates,
        }];
      })),
    };
  }
  return JSON.parse(JSON.stringify(periods));
}

/** Build the store for the golden corpus and read every view from it. */
export async function readGoldenViewsFromStore() {
  const workspace = createWorkspace(GOLDEN_CORPUS);
  try {
    pinGoldenSalt(workspace);
    const file = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const database = openLocalIndexStore(file, { readOnly: true });
    try {
      const views = { corpus: workspace.receipt.digest, reports: {}, layers: {}, work: {}, standardWork: {}, speedWork: {}, speedReports: {} };
      const facts = readPricingOracleFacts(database);
      for (const [name, nowMs] of GOLDEN_CLOCKS) {
        views.reports[name] = goldenReportView(withReadSnapshot(database, () => readLocalIndexReport(
          database, { nowMs, declaredSpeedBaselines: GOLDEN_LEDGER },
        )));
        views.work[name] = goldenWorkView(await readLocalIndexWorkUsage({
          database, indexFile: file, codexHome: workspace.codexHome,
          secretFile: workspace.secretFile, nowMs,
        }));
        const oracleOptions = { nowMs, codexHome: workspace.codexHome, secretFile: workspace.secretFile };
        views.standardWork[name] = goldenWorkView(await workPricingOracle(database, facts, { ...oracleOptions, standard: true }));
        views.speedWork[name] = goldenWorkView(await workPricingOracle(database, facts, oracleOptions));
        views.speedReports[name] = reportSpeedOracle(facts, nowMs, GOLDEN_LEDGER);
      }
      database.close();
      for (const [name, baselines] of [["no-ledger", []], ["ledger", GOLDEN_LEDGER]]) {
        const endMs = GOLDEN_END_MS + 3_600_000;
        const corpus = await openLocalIndexCalibrationCorpus({
          indexFile: file, endMs, limits: GOLDEN_LIMITS, declaredSpeedBaselines: baselines,
        });
        views.layers[name] = goldenLayerView(await buildCalibrationLayer({
          calibrationCorpus: corpus, endMs, limits: GOLDEN_LIMITS,
          declaredSpeedBaselines: baselines,
          generation: "golden", generationFingerprint: "golden",
        }));
      }
      return views;
    } finally {
      if (database.isOpen) database.close();
    }
  } finally {
    workspace.cleanup();
  }
}
