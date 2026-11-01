import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

function comparableWorkUsage(value) {
  const copy = structuredClone(value);
  for (const period of Object.values(copy.periods)) {
    for (const snapshot of Object.values(period.snapshots)) {
      delete snapshot.metadata.observedAt;
      snapshot.cells.sort((left, right) => left.id.localeCompare(right.id));
      for (const cell of snapshot.cells) {
        for (const key of ["threads", "projects", "worktrees", "models"]) {
          cell[key]?.sort();
        }
      }
      snapshot.autoReviewThreads?.sort();
    }
  }
  return copy;
}

test("the v11 day rollup read is exact against raw events, including a cleared last instant", async () => {
  const workspace = createWorkspace({ ...CORPUS, files: 6, events: 180, days: 5 });
  try {
    const file = join(workspace.state, "rollup-diff.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile,
      workerCount: 1,
    };
    await refreshLocalIndex(options);
    const readNow = async () => {
      const database = openLocalIndexStore(file, { readOnly: true });
      try {
        return await readLocalIndexWorkUsage({
          database, indexFile: file, codexHome: workspace.codexHome,
          secretFile: workspace.secretFile, nowMs: END_MS,
        });
      } finally {
        database.close();
      }
    };
    const setStatus = (status) => {
      const database = new DatabaseSync(file);
      try {
        database.prepare(
          "UPDATE projection_watermark SET status=? WHERE projection_name='work_rollup'",
        ).run(status);
      } finally {
        database.close();
      }
    };

    setStatus("pending");
    const raw = await readNow();
    setStatus("ready");
    const rolled = await readNow();
    assert.deepEqual(comparableWorkUsage(rolled), comparableWorkUsage(raw));

    const database = new DatabaseSync(file);
    let day;
    try {
      day = database.prepare(
        "SELECT day_ms FROM work_rollup WHERE events > 0 ORDER BY day_ms LIMIT 1",
      ).get().day_ms;
      database.prepare("UPDATE work_rollup SET last_at_ms=NULL WHERE day_ms=?").run(day);
    } finally {
      database.close();
    }
    const fallback = await readNow();
    assert.deepEqual(comparableWorkUsage(fallback), comparableWorkUsage(raw),
      "a cleared last instant falls back to raw events for that day");
  } finally {
    workspace.cleanup();
  }
});

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
        const spans = [];
        const actual = await readLocalIndexWorkUsage({
          database, indexFile: v2File, codexHome: workspace.codexHome,
          secretFile: workspace.secretFile, nowMs,
          onTiming: value => spans.push(value),
        });
        for (const stage of ["work_memberships", "work_origins", "work_projects", "work_aggregate", "work_finalize"]) {
          assert.ok(spans.some(row => row.stage === stage && row.outcome === "completed"));
        }
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
