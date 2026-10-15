import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { capturePreservationBaseline, verifyPreservationBaseline } from "../scripts/lib/local-index-preservation.mjs";
import { parsePreservationArguments, runPreservation } from "../scripts/verify-local-index-preservation.mjs";

function fixture(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA application_id=1431128370; PRAGMA user_version=5;
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('family','local-index-store');
    CREATE TABLE source(id INTEGER PRIMARY KEY,source_local BLOB,scanned_bytes INTEGER);
    INSERT INTO source VALUES(1,zeroblob(32),100);
    CREATE TABLE quota_observation(id INTEGER PRIMARY KEY,observed_at_ms INTEGER,limit_id TEXT,slot TEXT,
      used_percent REAL, UNIQUE(observed_at_ms,limit_id,slot));
    INSERT INTO quota_observation VALUES(1,1000,'codex','weekly',30);
    INSERT INTO quota_observation VALUES(2,2000,'codex','weekly',31);
    CREATE TABLE usage_event(source_id INTEGER,source_offset INTEGER,quota_observation_id INTEGER REFERENCES quota_observation,
      tokens_in_uncached INTEGER,tokens_out_combined INTEGER,PRIMARY KEY(source_id,source_offset));
    INSERT INTO usage_event VALUES(1,50,1,100,NULL);
    CREATE TABLE quota_occurrence(source_id INTEGER,source_offset INTEGER,slot_order INTEGER,
      canonical_observation_id INTEGER REFERENCES quota_observation,used_percent REAL,plan_type TEXT,
      PRIMARY KEY(source_id,source_offset,slot_order));
    INSERT INTO quota_occurrence VALUES(1,50,0,1,30,'plus');
    CREATE TABLE work_lifecycle_fact(source_id INTEGER,source_offset INTEGER,duration_ms INTEGER,
      PRIMARY KEY(source_id,source_offset));
    INSERT INTO work_lifecycle_fact VALUES(1,80,5000);`);
  return db;
}

test("renumbered quota IDs pass with an explicit diagnostic and no writes by verifier", () => {
  const db = fixture();
  try {
    const baseline = capturePreservationBaseline(db);
    db.exec(`INSERT INTO quota_observation SELECT 99,observed_at_ms+1,limit_id,slot,used_percent FROM quota_observation WHERE id=1;
      UPDATE usage_event SET quota_observation_id=99;
      UPDATE quota_occurrence SET canonical_observation_id=99;
      DELETE FROM quota_observation WHERE id=1;
      UPDATE quota_observation SET observed_at_ms=1000 WHERE id=99;
      PRAGMA query_only=ON; BEGIN;`);
    const result = verifyPreservationBaseline(db, baseline);
    assert.equal(result.allOriginalFactsUnchanged, true);
    assert.equal(result.tables.usage_event.internalLinksRebuilt, true);
    assert.equal(result.tables.quota_occurrence.internalLinksRebuilt, true);
    assert.equal(result.tables.work_lifecycle_fact.internalLinksRebuilt, false);
    assert.equal(db.prepare("SELECT quota_observation_id AS id FROM usage_event").get().id, 99);
  } finally { db.close(); }
});

for (const [title, sql, code] of [
  ["token change", "UPDATE usage_event SET tokens_in_uncached=101", "preservation_fact_or_association_changed"],
  ["unknown becoming zero", "UPDATE usage_event SET tokens_out_combined=0", "preservation_fact_or_association_changed"],
  ["quota percentage change", "UPDATE quota_occurrence SET used_percent=31", "preservation_fact_or_association_changed"],
  ["plan change", "UPDATE quota_occurrence SET plan_type='pro'", "preservation_fact_or_association_changed"],
  ["work duration change", "UPDATE work_lifecycle_fact SET duration_ms=5001", "preservation_fact_or_association_changed"],
  ["wrong usage association", "UPDATE usage_event SET quota_observation_id=2", "preservation_fact_or_association_changed"],
  ["wrong occurrence association", "UPDATE quota_occurrence SET canonical_observation_id=2", "preservation_fact_or_association_changed"],
  ["reference becoming NULL", "UPDATE usage_event SET quota_observation_id=NULL", "preservation_fact_or_association_changed"],
  ["target identity change", "UPDATE quota_observation SET slot='other' WHERE id=1", "preservation_fact_or_association_changed"],
  ["deleted record", "DELETE FROM usage_event", "preservation_records_missing"],
  ["insert into old prefix", "INSERT INTO usage_event VALUES(1,49,1,100,NULL)", "preservation_records_added_in_original_scope"],
]) {
  test(`${title} fails explicitly`, () => {
    const db = fixture();
    try {
      const baseline = capturePreservationBaseline(db);
      db.exec(sql);
      const result = verifyPreservationBaseline(db, baseline);
      assert.equal(result.allOriginalFactsUnchanged, false);
      assert.equal(result.errors.some(error => error.code === code), true);
      assert.equal(Object.values(result.tables).some(table => table.internalLinksRebuilt), false);
    } finally { db.close(); }
  });
}

for (const [sql, code] of [
  ["UPDATE usage_event SET quota_observation_id=999", "preservation_quota_link_missing"],
  ["UPDATE quota_occurrence SET canonical_observation_id=NULL", "preservation_quota_link_missing"],
  ["DELETE FROM source", "preservation_source_missing"],
  ["UPDATE source SET source_local=randomblob(32)", "preservation_source_identity_changed"],
  ["UPDATE source SET scanned_bytes=99", "preservation_source_cursor_regressed"],
  ["ALTER TABLE usage_event ADD COLUMN unexpected INTEGER", "preservation_schema_changed"],
  ["PRAGMA user_version=6", "preservation_store_unsupported"],
]) {
  test(`${code} is distinguished`, () => {
    const db = fixture();
    try {
      const baseline = capturePreservationBaseline(db);
      // Deliberately corrupt only this disposable fixture for broken-FK tests.
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec(sql);
      assert.throws(() => verifyPreservationBaseline(db, baseline), { code });
    } finally { db.close(); }
  });
}

test("new committed suffixes and sources are outside the frozen prefix; canonical winner values are derived", () => {
  const db = fixture();
  try {
    const baseline = capturePreservationBaseline(db);
    db.exec(`UPDATE source SET scanned_bytes=200;
      INSERT INTO usage_event VALUES(1,150,2,200,10);
      INSERT INTO source VALUES(2,randomblob(32),100);
      INSERT INTO work_lifecycle_fact VALUES(2,50,2000);
      UPDATE quota_observation SET used_percent=32 WHERE id=1`);
    assert.equal(verifyPreservationBaseline(db, baseline).allOriginalFactsUnchanged, true);
    db.exec("UPDATE quota_occurrence SET used_percent=32");
    assert.equal(verifyPreservationBaseline(db, baseline).allOriginalFactsUnchanged, false);
  } finally { db.close(); }
});

test("NULL becoming a reference is a real association change", () => {
  const db = fixture();
  try {
    db.exec("UPDATE usage_event SET quota_observation_id=NULL");
    const baseline = capturePreservationBaseline(db);
    db.exec("UPDATE usage_event SET quota_observation_id=1");
    assert.equal(verifyPreservationBaseline(db, baseline).allOriginalFactsUnchanged, false);
  } finally { db.close(); }
});

test("legacy, future, malformed and unknown-field baselines fail closed", () => {
  const db = fixture();
  try {
    const baseline = capturePreservationBaseline(db);
    for (const input of [{ tables: {} }, { ...baseline, version: "future" }]) {
      assert.throws(() => verifyPreservationBaseline(db, input), { code: "preservation_baseline_unsupported" });
    }
    for (const input of [{ ...baseline, extra: true }, { ...baseline, sources: [...baseline.sources, ...baseline.sources] },
      { ...baseline, tables: {} }, { ...baseline, columns: {} }]) {
      assert.throws(() => verifyPreservationBaseline(db, input), { code: "preservation_baseline_invalid" });
    }
  } finally { db.close(); }
});

test("CLI uses a read-only snapshot, refuses overwrite, and reports changed records", async () => {
  const root = await mkdtemp(join(tmpdir(), "preservation-synthetic-"));
  const index = join(root, "index.sqlite"), baseline = join(root, "baseline.json");
  const db = fixture(index); db.close();
  try {
    assert.equal((await runPreservation({ mode: "capture", index, baseline })).captured, true);
    const bytes = await readFile(baseline);
    await assert.rejects(runPreservation({ mode: "capture", index, baseline }), { code: "EEXIST" });
    assert.deepEqual(await readFile(baseline), bytes);
    assert.equal((await runPreservation({ mode: "verify", index, baseline })).allOriginalFactsUnchanged, true);
    const write = new DatabaseSync(index);
    write.exec("UPDATE usage_event SET tokens_in_uncached=999"); write.close();
    assert.equal((await runPreservation({ mode: "verify", index, baseline })).allOriginalFactsUnchanged, false);
    const command = spawnSync(process.execPath, ["scripts/verify-local-index-preservation.mjs", "verify",
      "--index", index, "--baseline", baseline], { encoding: "utf8" });
    assert.equal(command.status, 1);
    assert.equal(JSON.parse(command.stdout).errors[0].code, "preservation_fact_or_association_changed");
    assert.equal(command.stdout.includes(root), false);
    assert.equal(command.stdout.includes("tokens_in_uncached"), false);
    await writeFile(baseline, "not JSON");
    await assert.rejects(runPreservation({ mode: "verify", index, baseline }), SyntaxError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI requires explicit mode and distinct index/baseline paths", () => {
  for (const args of [[], ["verify"], ["erase", "--index", "a", "--baseline", "b"],
    ["capture", "--index", "a", "--baseline", "a"], ["capture", "--index", "a", "--baseline", "a-wal"],
    ["capture", "--index", "a", "--baseline", "a-shm"], ["capture", "--index", "a", "--baseline", "a-journal"],
    ["verify", "--index", "a", "--index", "b"]]) {
    assert.throws(() => parsePreservationArguments(args), { code: "preservation_arguments_invalid" });
  }
  assert.equal(parsePreservationArguments(["verify", "--baseline", "b", "--index", "a"]).mode, "verify");
});
