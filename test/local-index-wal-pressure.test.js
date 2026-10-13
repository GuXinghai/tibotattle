import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { LOCAL_INDEX_WAL_LIMITS, refreshLocalIndex } from "../src/local-index-refresh.js";
import { openLocalIndexStore } from "../src/local-index-store.js";
import {
  assertSameFacts, createWorkspace, v2Facts, withoutOrdinals,
} from "./helpers/local-index-facts.js";

// A reader that keeps one snapshot open pins the write-ahead log.
function pinReader(file) {
  const reader = new DatabaseSync(file, { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) AS n FROM store_state").get();
  return {
    release() {
      reader.exec("ROLLBACK");
      reader.close();
    },
  };
}

for (const [label, workerCount] of [["sequential", 1], ["lanes", 3]]) {
  test(`a pinned reader defers ${label} ingestion at the log limit and loses nothing`, async () => {
    const workspace = createWorkspace({
      files: 24, events: 900, days: 6, fillerBytesPerEvent: 900,
    });
    try {
      const live = join(workspace.state, "live.sqlite");
      openLocalIndexStore(live, { create: true }).close();
      const options = {
        codexHome: workspace.codexHome, indexFile: live,
        secretFile: workspace.secretFile, workerCount,
      };
      const reader = pinReader(live);
      let deferredRun;
      try {
        deferredRun = await refreshLocalIndex({
          ...options,
          walLimits: { softBytes: 64 * 1024, hardBytes: 256 * 1024, freeDiskFraction: null },
        });
      } finally {
        reader.release();
      }
      assert.equal(deferredRun.status, "deferred");
      assert.equal(deferredRun.deferred.reason, "wal_limit");
      assert.ok(deferredRun.deferred.walBytes >= 256 * 1024);
      assert.ok(deferredRun.walBytesPeak >= 256 * 1024);
      assert.equal(deferredRun.walPinned, true);

      // Nothing was lost: once the reader is gone the next refresh completes
      // and matches a cold build of the same files.
      const resumed = await refreshLocalIndex(options);
      assert.equal(resumed.status, "refreshed");
      assert.equal(resumed.deferred, null);
      const cold = join(workspace.state, "cold.sqlite");
      await refreshLocalIndex({ ...options, indexFile: cold, workerCount: 1 });
      const facts = v2Facts(live);
      assert.equal(facts.provisional, 0);
      assertSameFacts(
        withoutOrdinals(facts), withoutOrdinals(v2Facts(cold)), `${label} after deferral`,
      );
    } finally {
      workspace.cleanup();
    }
  });
}

test("the default limits sit between the measured unpinned and pinned bulk builds", () => {
  // Measured: an unpinned cold build of 2,400 sources peaked at 4.1 MB of
  // log and one with a reader pinned throughout at 456 MB.
  const { softBytes, hardBytes } = LOCAL_INDEX_WAL_LIMITS;
  assert.ok(softBytes > 4.1 * 1024 * 1024);
  assert.ok(hardBytes >= 2 * 456 * 1024 * 1024);
  assert.ok(softBytes < hardBytes);
});

test("a healthy refresh reports an unpinned log", async () => {
  const workspace = createWorkspace({ files: 6, events: 120 });
  try {
    const result = await refreshLocalIndex({
      codexHome: workspace.codexHome,
      indexFile: join(workspace.state, "index.sqlite"),
      secretFile: workspace.secretFile,
      workerCount: 1,
    });
    assert.equal(result.status, "refreshed");
    assert.equal(result.deferred, null);
    assert.equal(result.walPinned, false);
  } finally {
    workspace.cleanup();
  }
});
