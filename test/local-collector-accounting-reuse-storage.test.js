import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defaultLocalCollectorStatePath,
  readLocalCollectorAccountingReuse,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";

const cache = { schemaVersion: "synthetic-v1", historical: [1, 2, null], generatedAt: "2026-01-01T00:00:00.000Z" };
const proof = { schemaVersion: "local-accounting-reuse-proof-v1", key: "a".repeat(64), generation: 3,
  fingerprint: "generation-v2-synthetic", evaluatedAt: cache.generatedAt };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "accounting-reuse-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return defaultLocalCollectorStatePath(root);
}

test("reuse storage binds a certificate to the exact saved calculation and ordinary writes revoke it", async t => {
  const stateFile = await fixture(t);
  assert.deepEqual(await readLocalCollectorAccountingReuse({ stateFile }), { status: "missing", cache: null, proof: null });
  await writeLocalCollectorAccountingCache({ stateFile, cache, reuseProof: proof });
  assert.deepEqual(await readLocalCollectorAccountingReuse({ stateFile }), { status: "available", cache, proof });
  const changed = { ...cache, historical: [1, 5, null] };
  await writeLocalCollectorAccountingCache({ stateFile, cache: changed });
  assert.deepEqual(await readLocalCollectorAccountingReuse({ stateFile }), { status: "available", cache: changed, proof: null });
});

test("missing, malformed and mismatched certificates preserve historical cache", async t => {
  const stateFile = await fixture(t);
  await writeLocalCollectorAccountingCache({ stateFile, cache, reuseProof: proof });
  const database = new DatabaseSync(stateFile);
  try {
    database.prepare("UPDATE meta SET value_json=? WHERE key='accounting_cache'").run(JSON.stringify({ ...cache, historical: [99] }));
  } finally { database.close(); }
  assert.equal((await readLocalCollectorAccountingReuse({ stateFile })).proof, null);
  assert.deepEqual((await readLocalCollectorAccountingReuse({ stateFile })).cache.historical, [99]);
  for (const raw of ["{", JSON.stringify({ proof, cacheSha256: "a".repeat(64), extra: true }), "null"]) {
    const db = new DatabaseSync(stateFile);
    try { db.prepare("UPDATE meta SET value_json=? WHERE key='accounting_reuse_proof'").run(raw); }
    finally { db.close(); }
    const read = await readLocalCollectorAccountingReuse({ stateFile });
    assert.equal(read.proof, null);
    assert.deepEqual(read.cache.historical, [99]);
  }
});

test("invalid or cancelled publication leaves the previous pair intact", async t => {
  const stateFile = await fixture(t);
  await writeLocalCollectorAccountingCache({ stateFile, cache, reuseProof: proof });
  await assert.rejects(writeLocalCollectorAccountingCache({ stateFile, cache, reuseProof: { ...proof, unexpected: true } }), TypeError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(writeLocalCollectorAccountingCache({ stateFile, cache: { ...cache, historical: [] }, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(await readLocalCollectorAccountingReuse({ stateFile }), { status: "available", cache, proof });
});

test("certificate write failure rolls back the calculation replacement", async t => {
  const stateFile = await fixture(t);
  await writeLocalCollectorAccountingCache({ stateFile, cache, reuseProof: proof });
  const database = new DatabaseSync(stateFile);
  try {
    database.exec(`CREATE TRIGGER synthetic_certificate_failure BEFORE INSERT ON meta
      WHEN NEW.key='accounting_reuse_proof' BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END`);
  } finally { database.close(); }
  await assert.rejects(writeLocalCollectorAccountingCache({ stateFile,
    cache: { ...cache, historical: [7] }, reuseProof: { ...proof, generation: 4 } }), /synthetic publication failure/);
  assert.deepEqual(await readLocalCollectorAccountingReuse({ stateFile }), { status: "available", cache, proof });
});
