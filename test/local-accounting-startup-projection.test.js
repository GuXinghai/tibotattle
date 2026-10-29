import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createWorkspace } from "./helpers/local-index-facts.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { readLocalIndexGenerationIdentity } from "../src/local-index-companion-source.js";
import { buildLocalIndexAccountingCache, projectLocalIndexAccountingTime } from "../src/local-index-accounting-cache.js";
import { writeLocalCollectorAccountingCache } from "../src/local-collector-state.js";
import { buildLocalCompanionSnapshot } from "../src/local-companion-data.js";

test("startup uses current index windows and retains the saved model-mix evaluation clock", async t => {
  const workspace = createWorkspace({ files: 3, events: 300, days: 1, fillerBytesPerEvent: 0 });
  t.after(() => workspace.cleanup());
  const indexFile = join(workspace.state, "index.sqlite"), stateFile = join(workspace.state, "collector.sqlite");
  await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile,
    secretFile: workspace.secretFile, workerCount: 1 });
  const expectedGeneration = readLocalIndexGenerationIdentity({ indexFile });
  const originalNow = Date.parse("2026-09-01T00:00:00.000Z"), later = originalNow + 15 * 86_400_000;
  const cache = await buildLocalIndexAccountingCache({ indexFile, codexHome: workspace.codexHome,
    expectedGeneration, now: () => originalNow, windowDays: 365 });
  assert.ok(cache.periods.find(row => row.id === "7d").events > 0);
  await writeLocalCollectorAccountingCache({ stateFile, cache });
  const snapshotOptions = { root: workspace.root, collectorStateFile: stateFile,
    unifiedIndexFile: indexFile, codexHome: workspace.codexHome, now: () => later };
  // This is also the read path after a failed time projection: the durable
  // cache still has the old moving windows and must not override current SQL.
  const startup = await buildLocalCompanionSnapshot(snapshotOptions);
  const sevenDay = startup.overview.accounting.periods.find(row => row.periodId === "7d");
  assert.equal(sevenDay.events, 0);
  assert.equal(sevenDay.reportingWindow.endAt, new Date(later).toISOString());
  assert.equal(startup.weekly.generatedAt, new Date(originalNow).toISOString());
  assert.equal(startup.overview.accounting.generatedAt, cache.generatedAt);

  const projected = await projectLocalIndexAccountingTime({ cache, indexFile,
    expectedGeneration, now: () => later });
  await writeLocalCollectorAccountingCache({ stateFile, cache: projected });
  const updated = await buildLocalCompanionSnapshot(snapshotOptions);
  assert.equal(updated.weekly.generatedAt, new Date(later).toISOString());
  assert.equal(updated.overview.accounting.generatedAt, cache.generatedAt,
    "the current mix projection cannot relabel the historical fit clock");
});
