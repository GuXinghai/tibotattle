import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createLocalIndexBackend } from "../src/local-index-backend.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { LOCAL_INDEX_STORE_APPLICATION_ID } from "../src/local-index-store.js";
import { createWorkspace, v2Facts } from "./helpers/local-index-facts.js";

const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");

test("an existing index never recreates a lost salt or changes facts before refusing it", async () => {
  const workspace = createWorkspace({ files: 3, events: 60 });
  const indexFile = join(workspace.state, "v2.sqlite");
  const options = { codexHome: workspace.codexHome, indexFile, secretFile: workspace.secretFile, workerCount: 1 };
  try {
    await refreshLocalIndex(options);
    const salt = readFileSync(workspace.secretFile);
    const facts = v2Facts(indexFile);
    const before = digest(indexFile);
    unlinkSync(workspace.secretFile);
    await assert.rejects(refreshLocalIndex(options), { code: "local_index_secret_unavailable" });
    assert.equal(existsSync(workspace.secretFile), false);
    assert.equal(digest(indexFile), before);
    assert.deepEqual(v2Facts(indexFile), facts);

    writeFileSync(workspace.secretFile, "invalid", { mode: 0o600 });
    await assert.rejects(refreshLocalIndex(options), { code: "local_index_secret_invalid" });
    assert.equal(readFileSync(workspace.secretFile, "utf8"), "invalid");
    assert.equal(digest(indexFile), before);
    // Recovery uses the preserved original salt, never a newly minted one.
    writeFileSync(workspace.secretFile, salt, { mode: 0o600 });
    assert.equal((await refreshLocalIndex(options)).unchanged, true);
    assert.deepEqual(v2Facts(indexFile), facts);
  } finally { workspace.cleanup(); }
});

test("legacy cutover requires the existing salt even before v2 has sources", async () => {
  const workspace = createWorkspace({ files: 1, events: 10 });
  const indexFile = join(workspace.state, "v2.sqlite");
  const legacyIndexFile = join(workspace.state, "legacy.sqlite");
  try {
    const database = new DatabaseSync(legacyIndexFile);
    database.exec("CREATE TABLE source_cursor(source_local BLOB, source_ordinal INTEGER)");
    database.prepare("INSERT INTO source_cursor VALUES (?, 7)").run(Buffer.alloc(32, 7));
    database.close();
    const before = digest(legacyIndexFile);
    const backend = createLocalIndexBackend({ indexFile, secretFile: workspace.secretFile, legacyIndexFile, workerCount: 1 });
    await assert.rejects(backend.refreshUnifiedIndex({ codexHome: workspace.codexHome }),
      { code: "local_index_secret_unavailable" });
    assert.equal(existsSync(workspace.secretFile), false);
    assert.equal(existsSync(indexFile), false);
    assert.equal(digest(legacyIndexFile), before);
  } finally { workspace.cleanup(); }
});

test("foreign and newer existing state are refused before salt creation or metadata mutation", async () => {
  const workspace = createWorkspace({ files: 1, events: 1 });
  try {
    for (const [applicationId, code] of [[0, "local_index_family_mismatch"],
      [LOCAL_INDEX_STORE_APPLICATION_ID, "local_index_newer_version"]]) {
      const indexFile = join(workspace.state, `incompatible-${applicationId}.sqlite`);
      const database = new DatabaseSync(indexFile);
      database.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = 999;
        CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserved')`);
      database.close();
      const before = digest(indexFile);
      await assert.rejects(refreshLocalIndex({ codexHome: workspace.codexHome, indexFile,
        secretFile: workspace.secretFile, workerCount: 1 }), { code });
      assert.equal(existsSync(workspace.secretFile), false);
      assert.equal(digest(indexFile), before);
    }
  } finally { workspace.cleanup(); }
});
