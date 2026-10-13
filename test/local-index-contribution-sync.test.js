import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  telemetryV1DayDigest,
  telemetryV1HistoryDigest,
} from "../src/contribution/telemetry-v1-chunks.js";
import { runIncrementalContributionSyncOnce } from "../src/contribution-incremental-sync.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import {
  createLocalIndexTelemetryV1IndexReader,
} from "../src/local-index-contribution.js";
import { openLocalIndexStore } from "../src/local-index-store.js";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION, OUTCOME_UNKNOWN } from "../src/codex-usage-vocabulary.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { createWorkspace } from "./helpers/local-index-facts.js";
import { localCodexLogScanner } from "../src/local-node-runtime.js";

// The hosted-continuity gate (C2) at the level of the real sync engine: a
// device that synced from one index must, after that index is deleted and
// rebuilt from the same rollouts in a different discovery order, upload
// nothing, and a later append must supersede only what it changes.

const ORIGIN = "https://usage.example";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const CORPUS = {
  variety: true, files: 30, events: 1_800, days: 6, seed: 23,
  fillerBytesPerEvent: 0, quotaRate: 1, endAt: "2026-09-01T00:00:00.000Z",
};

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}

/**
 * A fake contribution service with the worker's journal rules: chunk
 * revisions keyed by chunk id, digests by the shared functions, and record
 * ownership. A record may sit in one current chunk only; a chunk that claims a
 * record another current chunk still holds is refused, as the worker does.
 */
function createService() {
  const journal = new Map();
  const owners = new Map();
  const uploads = [];
  const refusals = [];
  const days = () => {
    const byDay = new Map();
    for (const chunk of journal.values()) {
      const list = byDay.get(chunk.day) ?? [];
      list.push(chunk);
      byDay.set(chunk.day, list);
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, chunks]) => ({
      day,
      dayDigest: telemetryV1DayDigest(chunks),
      chunks: chunks.sort((l, r) => (l.stream === r.stream
        ? l.chunkSeq - r.chunkSeq : l.stream < r.stream ? -1 : 1))
        .map((c) => ({ chunkId: c.chunkId, revision: c.revision, chunkDigest: c.chunkDigest, recordCount: c.recordCount })),
    }));
  };
  const recordId = (stream, record) => (
    stream === "usage" ? record.eventId : stream === "quota" ? record.observationId : record.sessionUuid
  );
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/device/sync/state") {
      const current = days();
      return response({
        schemaVersion: "device-sync-state-v1.0",
        contractVersion: "telemetry-contribution-v1.0",
        acknowledgedThroughDay: current.at(-1)?.day ?? null,
        historyDigest: telemetryV1HistoryDigest(current),
        dayCount: current.length,
        chunkCount: journal.size,
        admission: {
          schemaVersion: "telemetry-chunk-admission-v1.0", state: "available",
          windowDay: "2026-08-01", budget: "launch_week", acceptedChunks: 0,
          remainingChunks: 1_000_000, maximumChunks: 1_000_000,
          retryAt: "2026-09-02T00:00:00.000Z",
        },
      });
    }
    if (parsed.pathname === "/api/v1/device/sync/manifest") {
      const from = parsed.searchParams.get("fromDay");
      const to = parsed.searchParams.get("toDay");
      return response({
        schemaVersion: "device-sync-manifest-v1.0",
        contractVersion: "telemetry-contribution-v1.0",
        fromDay: from, toDay: to,
        days: days().filter((day) => day.day >= from && day.day <= to),
      });
    }
    if (parsed.pathname === "/api/v1/envelope-key") {
      return response({ algorithm: "RSA-OAEP-256", keyId: "key:test", publicJwk: { kty: "RSA" } });
    }
    if (parsed.pathname === "/api/v1/device/upload-authorizations") {
      return response({
        uploadAuthorization: `um_device_upload_22222222-2222-4222-8222-222222222222.${"B".repeat(43)}`,
        expiresAt: "2026-09-02T00:00:00.000Z",
      }, 201);
    }
    if (parsed.pathname === "/api/v1/contributions") {
      const chunk = JSON.parse(options.body).plaintext;
      const current = journal.get(chunk.chunkId);
      if (current !== undefined && current.chunkDigest === chunk.chunkDigest) {
        return response({
          schemaVersion: "telemetry-chunk-receipt-v1.0", contributionId: "chunk:33333333-3333-4333-8333-333333333333",
          chunkId: chunk.chunkId, chunkRevision: current.revision, status: "accepted", replayed: true,
          recordCounts: { declared: chunk.records.length, accepted: 0 },
          acknowledgedThroughDay: days().at(-1)?.day ?? null,
        }, 202);
      }
      const expected = current === undefined ? 1 : current.revision + 1;
      if (chunk.chunkRevision !== expected) {
        return response({ error: { code: "CHUNK_REVISION_CONFLICT" } }, 409);
      }
      const [stream, day, seq] = chunk.chunkId.split(":");
      const released = new Set(current?.recordIds ?? []);
      const claimed = chunk.records.map((record) => recordId(stream, record));
      for (const id of claimed) {
        const owner = owners.get(`${stream}\0${id}`);
        if (owner !== undefined && owner !== chunk.chunkId && !released.has(id)) {
          refusals.push({ chunkId: chunk.chunkId, owner });
          return response({ error: { code: "RECORD_OWNED_BY_OTHER_CHUNK" } }, 409);
        }
      }
      for (const id of released) owners.delete(`${stream}\0${id}`);
      for (const id of claimed) owners.set(`${stream}\0${id}`, chunk.chunkId);
      journal.set(chunk.chunkId, {
        chunkId: chunk.chunkId, stream, day, chunkSeq: Number(seq), revision: chunk.chunkRevision,
        chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length, recordIds: claimed,
      });
      uploads.push({ chunkId: chunk.chunkId, revision: chunk.chunkRevision });
      return response({
        schemaVersion: "telemetry-chunk-receipt-v1.0", contributionId: "chunk:33333333-3333-4333-8333-333333333333",
        chunkId: chunk.chunkId, chunkRevision: chunk.chunkRevision, status: "accepted",
        supersededRevision: current?.revision ?? null,
        recordCounts: { declared: chunk.records.length, accepted: chunk.records.length },
        acknowledgedThroughDay: days().at(-1)?.day ?? null,
        admission: { state: "available", retryAt: "2026-09-02T00:00:00.000Z" },
      }, 202);
    }
    throw new Error(`unexpected request ${parsed.pathname}`);
  };
  return { fetchImpl, journal, uploads, refusals, days };
}

const engineOptions = (file, service) => ({
  indexFile: file,
  origin: ORIGIN,
  backend: {},
  fetchImpl: service.fetchImpl,
  withDeviceSecret: async ({ expectedOrigin, operation }) => operation(
    Buffer.alloc(32, 7), { origin: expectedOrigin, deviceId: DEVICE_ID },
  ),
  createEnvelope: async ({ chunk }) => ({
    schemaVersion: "telemetry-envelope-v1.0", synthetic: false, keyId: "key:test", plaintext: chunk,
  }),
  openIndex: (file, options) => openLocalIndexStore(file, options),
  createIndexReader: (database, ports) => createLocalIndexTelemetryV1IndexReader(database, {
    ...ports,
    outcomeUnknownOrdinal: OUTCOME_UNKNOWN,
    parserVersionBase: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  }),
});

/** Discover as shipping does, then hand the rollouts over in reverse order. */
async function reversedDiscovery(options) {
  const infos = await localCodexLogScanner.discoverCodexRolloutInfos(options);
  const reversed = [...infos].reverse();
  for (const key of Reflect.ownKeys(infos)) {
    if (typeof key === "string" && /^\d+$/u.test(key)) continue;
    if (key === "length") continue;
    reversed[key] = infos[key];
  }
  return reversed;
}

test("a rebuilt index, discovered in another order, uploads nothing; an append supersedes only its day", async () => {
  const workspace = createWorkspace(CORPUS);
  try {
    const service = createService();
    const refreshOptions = {
      codexHome: workspace.codexHome, secretFile: workspace.secretFile, workerCount: 1,
    };

    // First sync from the first index.
    const first = join(workspace.state, "first.sqlite");
    await refreshLocalIndex({ ...refreshOptions, indexFile: first });
    const initial = await runIncrementalContributionSyncOnce(engineOptions(first, service));
    assert.equal(initial.status, "complete", JSON.stringify(initial.failure));
    assert.ok(initial.daysTotal >= 5 && initial.chunksUploaded > 10, "history was uploaded");
    const afterFirst = service.days();
    const digestsFirst = afterFirst.map((day) => [day.day, day.dayDigest]);
    const uploadsFirst = service.uploads.length;
    assert.equal(service.refusals.length, 0);

    // The index is deleted. A second build, from the same rollouts, discovers
    // them in reverse order; the salt is the device's and is unchanged.
    const second = join(workspace.state, "second.sqlite");
    await refreshLocalIndex({ ...refreshOptions, indexFile: second, discover: reversedDiscovery });
    const resumed = await runIncrementalContributionSyncOnce(engineOptions(second, service));
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.chunksUploaded, 0, "no chunk is re-sent");
    assert.equal(resumed.recordsUploaded, 0);
    assert.equal(service.uploads.length, uploadsFirst);
    assert.deepEqual(service.days().map((day) => [day.day, day.dayDigest]), digestsFirst);

    // Content-free append to one rollout: only the changed day's tail moves.
    appendSyntheticCodexEvents([workspace.receipt.sources.at(-1)], {
      seed: 99, events: 4, fillerBytesPerEvent: 0, atMs: Date.parse("2026-08-31T23:00:00.000Z"),
    });
    await refreshLocalIndex({ ...refreshOptions, indexFile: second });
    const grown = await runIncrementalContributionSyncOnce(engineOptions(second, service));
    assert.equal(grown.status, "complete");
    assert.ok(grown.chunksUploaded >= 1 && grown.chunksUploaded <= 3, `uploaded ${grown.chunksUploaded}`);
    const newer = service.uploads.slice(uploadsFirst);
    assert.ok(newer.every((upload) => upload.chunkId.split(":")[1] === "2026-08-31"),
      "only the day the append belongs to was re-sent");
    assert.ok(newer.every((upload) => upload.revision >= 1));
    assert.equal(service.refusals.length, 0, "no record was claimed by a second chunk");
    // History before the append is untouched.
    const finalDays = service.days();
    for (const [day, digest] of digestsFirst.filter(([day]) => day < "2026-08-31")) {
      assert.equal(finalDays.find((entry) => entry.day === day).dayDigest, digest);
    }
  } finally {
    workspace.cleanup();
  }
});
