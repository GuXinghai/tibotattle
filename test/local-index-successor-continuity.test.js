import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { telemetryV11RequiredConsent, telemetryV12RequiredConsent } from "@app-usagemonitor/telemetry-contract";
import { runIncrementalContributionSyncOnce } from "../src/contribution-incremental-sync.js";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION } from "../src/codex-usage-vocabulary.js";
import { readLegacyOrdinalMap } from "../src/local-index-cutover.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { createWorkspace } from "./helpers/local-index-facts.js";
import { attributionFixtureSeams, ATTRIBUTION_FIXTURE_BINDING as binding,
  ATTRIBUTION_FIXTURE_START as start,
} from "./helpers/local-index-attribution-fixture.js";
import { createAttributionFixtureDevice, createAttributionFixtureService } from "./helpers/attribution-transport-fixture.js";

// Real dispatcher, publication readers and successor engines over two v2
// stores. A synthetic legacy ordinal table exercises the migration input.
// This is engine replay evidence, not a differential run of the retired v1
// implementation or proof of Windows Credential Manager protection. Device
// leasing and journal persistence are real; the protected-secret backend,
// encryption and service are synthetic test ports.
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

for (const successor of [false, true]) test(`${successor ? "v1.2" : "v1.1"} engine carries legacy ordinals, skips identical replay and uploads only an appended day`, async () => {
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
    const service = createAttributionFixtureService({ successor, fromDay: "2026-07-30", throughDay: "2026-08-01" });
    const stateFile = join(workspace.state, "device.json");
    const backend = await createAttributionFixtureDevice(stateFile);
    const options = {
      ...attributionFixtureSeams(), origin: binding.destinationOrigin, backend, stateFile,
      consent: { ...(successor ? telemetryV12RequiredConsent() : telemetryV11RequiredConsent()),
        destinationOrigin: binding.destinationOrigin },
      fetchImpl: service.fetchImpl, now: () => start,
      ...(successor ? { createV12Envelope: service.createEnvelope } : { createV11Envelope: service.createEnvelope }),
      loadExistingAccountObservationSecret: async () => assert.fail("Unattributed synthetic history must not load account identity"),
    };
    const database = options.openIndex(firstFile, { readOnly: true });
    try {
      assert.equal(options.readPublication(database).parserVersion, LOCAL_UNIFIED_INDEX_PARSER_VERSION,
        "wire parser remains the extractor label; store format is fenced by the fingerprint");
    } finally { database.close(); }
    for (const parserVersion of ["C:\\synthetic\\source", "https://synthetic.example/source", "synthetic private text"]) {
      const rejected = await runIncrementalContributionSyncOnce({ ...options, indexFile: firstFile,
        readPublication: (database) => ({ ...options.readPublication(database), parserVersion }),
      });
      assert.equal(rejected.status, "failed");
      assert.equal(rejected.failure.code, "index_unavailable");
      assert.equal(rejected.chunksUploaded, 0);
    }
    assert.equal(service.calls.some(({ path }) => path === "/api/v1/contributions"), false);
    const initial = await runIncrementalContributionSyncOnce({ ...options, indexFile: firstFile });
    assert.equal(initial.status, "complete", JSON.stringify({ failure: initial.failure, calls: service.calls.map(({ path }) => path) }));
    assert.ok(initial.chunksUploaded > 0 && initial.recordsUploaded > 0);
    const manifests = service.calls.filter(({ path }) => path.endsWith("/day-manifests"))
      .map(({ body }) => [body.day, body.manifestDigest]);
    const uploaded = service.calls.filter(({ path }) => path === "/api/v1/contributions").length;
    const quotaIds = [...service.envelopes.values()].flatMap(({ records }) => records)
      .filter(({ schemaVersion }) => schemaVersion === `quota-observation-${successor ? "v1.2" : "v1.1"}`)
      .map(({ observationId }) => observationId);
    assert.ok(quotaIds.length > 0, "quota identities actually exercise ordinal carry");

    const secondFile = join(workspace.state, "second.sqlite");
    await refreshLocalIndex({ ...refreshOptions, indexFile: secondFile, ordinalSeed: seed, discover: reversedDiscovery });
    assert.deepEqual(ordinalRows(secondFile), ordinalRows(firstFile));
    const replayCalls = service.calls.length;
    const replay = await runIncrementalContributionSyncOnce({ ...options, indexFile: secondFile });
    assert.equal(replay.status, "complete", JSON.stringify(replay.failure));
    assert.equal(replay.chunksUploaded, 0);
    assert.equal(replay.recordsUploaded, 0);
    assert.equal(service.calls.filter(({ path }) => path === "/api/v1/contributions").length, uploaded);
    assert.deepEqual(service.calls.slice(replayCalls).filter(({ path }) => path.endsWith("/day-manifests"))
      .map(({ body }) => [body.day, body.manifestDigest]), manifests);

    appendSyntheticCodexEvents([workspace.receipt.sources.at(-1)], {
      seed: 99, events: 4, fillerBytesPerEvent: 0, atMs: Date.parse("2026-08-01T23:00:00.000Z"),
    });
    await refreshLocalIndex({ ...refreshOptions, indexFile: secondFile });
    const appendCalls = service.calls.length;
    const grown = await runIncrementalContributionSyncOnce({ ...options, indexFile: secondFile });
    assert.equal(grown.status, "complete", JSON.stringify(grown.failure));
    assert.ok(grown.chunksUploaded > 0);
    const changed = service.calls.slice(appendCalls).filter(({ path }) => path.endsWith("/day-manifests"));
    for (const { body } of changed) {
      const before = manifests.find(([day]) => day === body.day)?.[1];
      assert.equal(body.manifestDigest === before, body.day !== "2026-08-01", "only appended day changes");
    }
    const newEnvelopes = [...service.envelopes.values()].slice(uploaded);
    assert.ok(newEnvelopes.length > 0);
    assert.ok(newEnvelopes.every(({ chunkId }) => chunkId.split(":")[1] === "2026-08-01"));
    assert.deepEqual(ordinalRows(secondFile), ordinalRows(firstFile));
  } finally { workspace.cleanup(); }
});
