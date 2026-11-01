import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { refreshLocalIndex } from "../src/local-index-refresh.js";
import {
  createLocalIndexWriter,
  openLocalIndexStore,
} from "../src/local-index-store.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "local-index-impact-capture-"));
  return {
    root,
    file: join(root, "index.sqlite"),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function source(writer) {
  const sessionId = writer.internSession(Buffer.alloc(32, 1));
  const surfaceId = writer.internSurface({
    agentScope: "root", surface: "codex", threadSource: "cli",
    lineageDisposition: "standalone",
  });
  return writer.registerSource({
    sourceLocal: Buffer.alloc(32, 2), ordinal: 0, sessionId, surfaceId,
    path: "synthetic.jsonl", rolloutKey: "synthetic", sizeBytes: 100, mtimeMs: 1,
  }).id;
}

const change = sourceId => ({
  sourceId,
  mode: "append",
  reason: "test_append",
  oldFileId: "1:1",
  newFileId: "1:1",
  oldScannedBytes: 40,
  newScannedBytes: 100,
  oldSizeBytes: 40,
  newSizeBytes: 100,
  oldEventCount: 1,
  newEventCount: 2,
  confidence: "exact",
  factCounts: [
    { factKind: "usage", oldCount: 1, newCount: 2, oldMinAtMs: 10, oldMaxAtMs: 10, newMinAtMs: 10, newMaxAtMs: 20 },
    { factKind: "quota", oldCount: 0, newCount: 1, oldMinAtMs: null, oldMaxAtMs: null, newMinAtMs: 20, newMaxAtMs: 20 },
  ],
  partitions: [
    { partitionKind: "usage_time_range", partitionKey: "range:10-20", lowerMs: 10, upperMs: 20, basisKind: "fact_delta", status: "dirty" },
    { partitionKind: "session", partitionKey: "session:1", sessionId: 1, basisKind: "fact_delta", status: "pending" },
  ],
  gaps: [],
});

test("writer publishes one manifest change atomically with the publication", () => {
  const f = workspace();
  try {
    const db = openLocalIndexStore(f.file, { create: true });
    const writer = createLocalIndexWriter(db);
    try {
      const sourceId = (() => { writer.begin(); const id = source(writer); writer.commit({ bumpSeq: false }); return id; })();
      writer.begin();
      writer.recordSourceChange(change(sourceId));
      assert.equal(writer.commit(), 1);

      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM publication").get().n, 1);
      const publication = db.prepare("SELECT * FROM publication").get();
      assert.equal(publication.commit_seq, 1);
      assert.equal(publication.manifest_complete, 1);
      assert.equal(publication.source_change_count, 1);
      const row = db.prepare("SELECT * FROM source_change").get();
      assert.equal(row.commit_seq, 1);
      assert.equal(row.mode, "append");
      assert.equal(row.confidence, "exact");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM change_fact_count").get().n, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM impact_partition").get().n, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM integrity_gap").get().n, 0);
    } finally {
      db.close();
    }
  } finally {
    f.cleanup();
  }
});

test("rollback discards buffered manifest rows", () => {
  const f = workspace();
  try {
    const db = openLocalIndexStore(f.file, { create: true });
    const writer = createLocalIndexWriter(db);
    try {
      writer.begin();
      const sourceId = source(writer);
      writer.recordSourceChange(change(sourceId));
      writer.rollback();
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM publication").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_change").get().n, 0);
    } finally {
      db.close();
    }
  } finally {
    f.cleanup();
  }
});

test("a refresh publishes one manifest change for a new synthetic source", async () => {
  const w = createWorkspace({ files: 1, events: 3 });
  try {
    const indexFile = join(w.state, "impact.sqlite");
    await refreshLocalIndex({
      codexHome: w.codexHome, indexFile, secretFile: w.secretFile, workerCount: 1,
    });
    const db = openLocalIndexStore(indexFile, { readOnly: true });
    try {
      const publication = db.prepare(
        "SELECT * FROM publication ORDER BY commit_seq DESC LIMIT 1",
      ).get();
      assert.ok(publication);
      assert.equal(publication.manifest_complete, 1);
      const change = db.prepare(
        "SELECT * FROM source_change ORDER BY change_id DESC LIMIT 1",
      ).get();
      assert.ok(change);
      assert.equal(change.mode, "new");
      assert.ok(Number(change.new_event_count) > 0);
      assert.ok(Number(db.prepare(
        "SELECT COUNT(*) AS n FROM change_fact_count WHERE change_id = ? AND fact_kind = 'usage'",
      ).get(change.change_id).n) > 0);
      assert.ok(Number(db.prepare(
        "SELECT COUNT(*) AS n FROM impact_partition WHERE change_id = ?",
      ).get(change.change_id).n) > 0);
    } finally {
      db.close();
    }
  } finally {
    w.cleanup();
  }
});

test("cold lane builds record complete new-source changes", async () => {
  const w = createWorkspace({ files: 4, events: 6 });
  try {
    const indexFile = join(w.state, "lanes.sqlite");
    await refreshLocalIndex({
      codexHome: w.codexHome, indexFile, secretFile: w.secretFile, workerCount: 3,
    });
    const db = openLocalIndexStore(indexFile, { readOnly: true });
    try {
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS n FROM publication WHERE manifest_complete = 0",
      ).get().n, 0);
      assert.ok(Number(db.prepare(
        "SELECT COUNT(*) AS n FROM source_change WHERE mode = 'new'",
      ).get().n) > 0);
      assert.ok(Number(db.prepare(
        "SELECT COUNT(*) AS n FROM source_change WHERE mode = 'new' AND new_event_count > 0",
      ).get().n) > 0);
    } finally {
      db.close();
    }
  } finally {
    w.cleanup();
  }
});

test("a vanished source records an exact coverage change instead of an incomplete manifest", async () => {
  const w = createWorkspace({ files: 1, events: 3 });
  try {
    const indexFile = join(w.state, "presence.sqlite");
    const options = {
      codexHome: w.codexHome, indexFile, secretFile: w.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);
    const sourcePath = w.receipt.sources[0];
    await rename(sourcePath, `${sourcePath}.gone`);
    await refreshLocalIndex(options);
    const db = openLocalIndexStore(indexFile, { readOnly: true });
    try {
      const publication = db.prepare(
        "SELECT manifest_complete FROM publication ORDER BY commit_seq DESC LIMIT 1",
      ).get();
      assert.equal(publication.manifest_complete, 1);
      const change = db.prepare(`
        SELECT c.mode, c.reason, p.status
        FROM source_change c JOIN impact_partition p USING(change_id)
        WHERE c.mode = 'presence_changed' ORDER BY c.change_id DESC LIMIT 1`).get();
      assert.equal(change.mode, "presence_changed");
      assert.equal(change.reason, "discovery_absent");
      assert.equal(change.status, "unknown");
    } finally {
      db.close();
    }
  } finally {
    w.cleanup();
  }
});

test("an incomplete manifest is explicit and cannot be published without a sequence", () => {
  const f = workspace();
  try {
    const db = openLocalIndexStore(f.file, { create: true });
    const writer = createLocalIndexWriter(db);
    try {
      writer.begin();
      const sourceId = source(writer);
      writer.recordSourceChange(change(sourceId));
      assert.throws(() => writer.commit({ bumpSeq: false }), {
        code: "local_index_publication_required",
      });
      writer.rollback();

      writer.begin();
      writer.markManifestIncomplete();
      writer.commit();
      assert.equal(db.prepare("SELECT manifest_complete FROM publication").get().manifest_complete, 0);
    } finally {
      db.close();
    }
  } finally {
    f.cleanup();
  }
});
