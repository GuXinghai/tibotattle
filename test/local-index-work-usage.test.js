import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { readLocalIndexWorkUsage } from "../src/local-index-work-usage.js";
import { auditWorkRollups } from "../src/local-index-work-rollup.js";
import { openLocalIndexStore } from "../src/local-index-store.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

const END_MS = Date.parse("2026-09-01T00:00:00.000Z");
const CORPUS = {
  variety: true, files: 50, events: 3_000, days: 12, seed: 29,
  fillerBytesPerEvent: 0, quotaRate: 1, endAt: "2026-09-01T00:00:00.000Z",
};

test("the work breakdown from stored facts keeps its invariants at every boundary", async () => {
  const workspace = createWorkspace(CORPUS);
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const database = openLocalIndexStore(v2File, { readOnly: true });
    try {
      assert.equal(auditWorkRollups(database), 0);
      let cells = 0;
      let statusExcluded = 0;
      for (const nowMs of [
        END_MS + 3_600_000,
        END_MS - 3 * 86_400_000 - 7 * 60_000 - 13_123,
        END_MS - 8 * 86_400_000 + 5,
      ]) {
        const actual = await readLocalIndexWorkUsage({
          database, indexFile: v2File, codexHome: workspace.codexHome,
          secretFile: workspace.secretFile, nowMs,
        });
        assert.equal(actual.status, "available");
        assert.deepEqual(Object.keys(actual.periods).sort(), ["24h", "30d", "7d", "all"]);
        // A wider window never holds fewer events for any scope.
        const eventsOf = (id) => new Map(actual.periods[id].scopes.map((s) => [s.id, s.events]));
        for (const [narrow, wide] of [["24h", "7d"], ["7d", "30d"], ["30d", "all"]]) {
          const small = eventsOf(narrow);
          const large = eventsOf(wide);
          for (const [scope, events] of small) {
            assert.ok((large.get(scope) ?? 0) >= events, `${narrow} <= ${wide} for ${scope} at ${nowMs}`);
          }
        }
        for (const id of ["24h", "7d", "30d", "all"]) {
          const period = actual.periods[id];
          assert.deepEqual(
            Object.keys(period.snapshots).sort(),
            period.scopes.map((scope) => scope.id).sort(),
          );
          for (const snapshot of Object.values(period.snapshots)) {
            cells += snapshot.cells.length;
            statusExcluded += snapshot.metadata.excludedAllowanceUpdates;
          }
        }
      }
      assert.ok(cells > 100, `cells compared: ${cells}`);
      assert.ok(statusExcluded > 0, "status updates were classified and excluded");
    } finally {
      database.close();
    }
  } finally {
    workspace.cleanup();
  }
});
