import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readLegacyOrdinalMap } from "../src/local-index-cutover.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

// A synthetic legacy ordinal table exercises the migration input: source
// ordinals carry into a rebuilt store, stay stable under reversed discovery and
// are not disturbed when an appended source grows.
async function reversedDiscovery(options) {
  const infos = await localCodexLogScanner.discoverCodexRolloutInfos(options);
  const reversed = [...infos].reverse();
  for (const key of Reflect.ownKeys(infos)) {
    if (key !== "length" && !(typeof key === "string" && /^\d+$/u.test(key))) reversed[key] = infos[key];
  }
  return reversed;
}

function ordinalRows(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("SELECT hex(source_local) AS local, source_ordinal AS ordinal FROM source ORDER BY local").all()
      .map(({ local, ordinal }) => [local.toLowerCase(), ordinal]);
  } finally { database.close(); }
}

function syntheticLegacyMap(file, rows) {
  const database = new DatabaseSync(file);
  try {
    database.exec("CREATE TABLE source_cursor (source_local BLOB, source_ordinal INTEGER)");
    const insert = database.prepare("INSERT INTO source_cursor VALUES (?, ?)");
    // Sparse ordinals intentionally differ from cold discovery allocation.
    rows.forEach(([local], index) => insert.run(Buffer.from(local, "hex"), 100 + index * 3));
  } finally { database.close(); }
  return readLegacyOrdinalMap(file).ordinalSeed;
}

test("legacy ordinals carry into a rebuilt store, survive reversed discovery and an appended day", async () => {
  const workspace = createWorkspace({ variety: true, files: 6, events: 120, days: 3,
    fillerBytesPerEvent: 0, quotaRate: 1, endAt: "2026-08-02T00:00:00.000Z" });
  try {
    const refreshOptions = { codexHome: workspace.codexHome, secretFile: workspace.secretFile, workerCount: 1 };
    const discoveryFile = join(workspace.state, "discovery.sqlite");
    await refreshLocalIndex({ ...refreshOptions, indexFile: discoveryFile });
    const seed = syntheticLegacyMap(join(workspace.state, "legacy.sqlite"), ordinalRows(discoveryFile));
    assert.equal(seed.size, 6);
    const firstFile = join(workspace.state, "first.sqlite");
    await refreshLocalIndex({ ...refreshOptions, indexFile: firstFile, ordinalSeed: seed });
    assert.deepEqual(ordinalRows(firstFile), [...seed].sort(([a], [b]) => a.localeCompare(b)));

    const secondFile = join(workspace.state, "second.sqlite");
    await refreshLocalIndex({ ...refreshOptions, indexFile: secondFile, ordinalSeed: seed, discover: reversedDiscovery });
    assert.deepEqual(ordinalRows(secondFile), ordinalRows(firstFile));

    appendSyntheticCodexEvents([workspace.receipt.sources.at(-1)], {
      seed: 99, events: 4, fillerBytesPerEvent: 0, atMs: Date.parse("2026-08-01T23:00:00.000Z"),
    });
    await refreshLocalIndex({ ...refreshOptions, indexFile: secondFile });
    assert.deepEqual(ordinalRows(secondFile), ordinalRows(firstFile));
  } finally { workspace.cleanup(); }
});
