import test from "node:test";
import { createHash } from "node:crypto";
import { buildPlanAttributionIndex, planAttributionContextKey } from "@app-usagemonitor/quota-analysis";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION, OUTCOME_UNKNOWN, outcomeName, reasoningEffortName } from "../src/codex-usage-vocabulary.js";
import { compactQuotaPlanEvidence } from "../src/local-index-contribution-attribution.js";
import {
  createLocalIndexTelemetryV11Reader,
  createLocalIndexTelemetryV1IndexReader,
} from "../src/local-index-contribution.js";
import { createLocalIndexWriter, LOCAL_INDEX_STORE_USER_VERSION, openLocalIndexStore } from "../src/local-index-store.js";
import { createTelemetryV11Day, createTelemetryV12Day } from "../src/contribution/index.js";

const DAY = "2026-08-01";
const START = Date.parse(`${DAY}T12:00:00.000Z`);
const RESET = Date.parse("2026-08-08T12:00:00.000Z");
const ports = { outcomeName, reasoningEffortName, fallbackParserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  outcomeUnknownOrdinal: OUTCOME_UNKNOWN, parserVersionBase: LOCAL_UNIFIED_INDEX_PARSER_VERSION };
const binding = { destinationOrigin: "https://telemetry.example", enrollmentNamespace: "synthetic_enrollment_0001" };
const secret = Buffer.alloc(32, 9);
const stamp = (offset) => new Date(START + offset).toISOString();
const eventKey = (id) => { const key = Buffer.alloc(32); key.writeUInt32BE(id, 28); return key; };
const scope = (id = 7, planType = "pro") => ({
  status: "available", reason: null, version: "openai-account-v1",
  scopeId: `openai-account:v1:${Buffer.alloc(32, id).toString("base64url")}`, planType,
});
const marker = (options = {}) => ({
  version: "provisional-account-marker-v2", capturedAt: stamp(-1), receivedAt: stamp(2_000),
  accountScope: scope(), source: "app_server_read", observationBinding: binding, ...options,
});


// Stores opened by a test close before its directory is removed (Windows locks).
const openStores = new Set();
function openStore(file, options) {
  const database = openLocalIndexStore(file, options);
  openStores.add(database);
  return database;
}
async function closeStores() {
  for (const database of openStores) if (database.isOpen) database.close();
  openStores.clear();
}

async function writeFixture(t, { records = [], sources = [1], file = null, size = 4096 } = {}) {
  if (file === null) {
    const root = await mkdtemp(join(tmpdir(), "telemetry-v11-local-proof-"));
    t.after(async () => { await closeStores(); await rm(root, { recursive: true, force: true }); });
    file = join(root, "index.sqlite");
  }
  const database = openLocalIndexStore(file, { create: true });
  try {
    const writer = createLocalIndexWriter(database);
    writer.begin();
    const accountScopeId = writer.internAccountScope({ status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null });
    const modelId = writer.internModel("gpt-5.6-sol", "recognized");
    const tierId = writer.internTier({ apiServiceTier: "unknown", billingSurface: "chatgpt_subscription",
      codexSpeedMode: "standard", tierSource: "unknown", providerTierRaw: null });
    const surfaceId = writer.internSurface({ agentScope: "root", surface: "cli_exec", threadSource: "user", lineageDisposition: "standalone" });
    const coordinates = new Map();
    for (const source of sources) {
      const sessionLocal = Buffer.alloc(32, source + 20);
      const sessionId = writer.internSession(sessionLocal, `11111111-2222-4333-8444-${String(source).padStart(12, "0")}`);
      const { id: sourceId } = writer.registerSource({ sourceLocal: Buffer.alloc(32, source), sessionId, surfaceId,
        path: `synthetic-${source}`, rolloutKey: `synthetic-${source}`, sizeBytes: size, mtimeMs: START });
      writer.commitSourceState(sourceId, { sessionId, surfaceId, path: `synthetic-${source}`,
        rolloutKey: `synthetic-${source}`, sizeBytes: size, mtimeMs: START, scannedBytes: size,
        snapshotsPersisted: true, turnContextSeen: true, carryModel: "gpt-5.6-sol", carryEffort: "high", diagnostics: {} });
      coordinates.set(source, { sourceId, sessionId });
      if (records.length) writer.writeToolFact({ sourceId, sourceOffset: 1, toolOrdinal: 0,
        eventKey: Buffer.alloc(32, source + 71), sessionId, observedAtMs: START, toolClass: "localShell",
        sourceKind: "response_item" });
    }
    for (const [index, record] of records.entries()) {
      const { sourceId, sessionId } = coordinates.get(record.source ?? 1);
      const at = START + (record.at ?? index * 1_000);
      const offset = record.offset ?? index + 1;
      let quotaObservationId = null;
      for (const [slotOrder, quota] of (record.quotas ?? []).entries()) {
        const window = {
          observedAtMs: at, limitId: quota.limitId ?? "codex", slot: quota.slot ?? (slotOrder ? "secondary" : "primary"),
          planType: quota.plan ?? null, usedPercent: quota.percent ?? 10, resetsAtMs: quota.missingReset ? null : RESET,
          durationMins: quota.duration ?? 10_080,
        };
        const canonicalObservationId = writer.internQuota(window);
        quotaObservationId ??= canonicalObservationId;
        writer.writeQuotaOccurrence({ sourceId, sourceOffset: offset, slotOrder, surfaceId, canonicalObservationId,
          ...window, provider: "openai_codex", admission: quota.admission ?? "admitted" });
      }
      if (record.usage !== false) {
        writer.writeUsageEvent({ sourceId, sourceOffset: offset, observedAtMs: at, eventKey: eventKey(record.id ?? index + 1),
          sessionId, accountScopeId, modelId, tierId, surfaceId, quotaObservationId, tierObservedAtMs: null,
          reasoningEffort: 4, tokensInUncached: record.tokens ?? 10, tokensInCacheRead: 20, tokensInCacheWrite: 0,
          tokensOutText: 1, tokensOutReasoning: 0, tokensOutCombined: null, totalInputContext: null });
        if (record.boundaryFlags) writer.writeBoundary({ sourceId, sourceOffset: offset,
          turnContextBefore: Boolean(record.boundaryFlags & 1), compactionBefore: Boolean(record.boundaryFlags & 2),
          compactedAtMs: record.boundaryFlags & 2 ? at - 1 : null });
      }
    }
    writer.commit({ kind: "cold" });
  } finally {
    database.close();
  }
  return { file };
}

function readFixture(t, file, options = {}, readOnly = true) {
  const database = openStore(file, { readOnly });
  return { database, reader: createLocalIndexTelemetryV11Reader(database, { ...ports, ...options }) };
}

function project(day, options = {}) {
  return createTelemetryV11Day({ day: DAY, ...day, accountObservationSecret: secret, binding,
    parserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION, ...options });
}
const stream = (result, name) => result.chunks.filter((chunk) => (chunk.stream ?? chunk.chunkId.split(":")[0]) === name).flatMap((chunk) => chunk.records);

test("exact historical plans survive canonical collisions while usage/session identities and totals stay unchanged", async (t) => {
  const { file } = await writeFixture(t, { sources: [1, 2], records: [
    { source: 1, at: 0, tokens: 23, quotas: [{ plan: "pro", duration: 300 }, { plan: "pro" }] },
    { source: 2, at: 0, tokens: 47, quotas: [{ plan: "plus", duration: 300, percent: 90 }, { plan: "plus", percent: 90 }] },
  ] });
  const { database, reader } = readFixture(t, file);
  assert.deepEqual(database.prepare("SELECT DISTINCT plan_type FROM quota_observation").all().map((row) => row.plan_type), ["plus"]);
  const base = createLocalIndexTelemetryV1IndexReader(database, ports).deriveDay(DAY);
  const legacyDay = reader.readDay(DAY);
  assert.equal(Object.hasOwn(legacyDay, "telemetryV12Evidence"), false);
  const day = reader.readDayWithV12Evidence(DAY);
  assert.deepEqual(day.recordsByStream.usage, stream(base, "usage"));
  assert.deepEqual(day.recordsByStream.session, stream(base, "session"));
  assert.equal(day.telemetryV12Evidence.boundaryLookupComplete, true);
  assert.deepEqual(day.recordsByStream.usage.map((record) =>
    day.telemetryV12Evidence.continuityForRecord("usage", record)), [
    { boundaryFlags: 0, tieOrder: 0 },
    { boundaryFlags: 0, tieOrder: 0 },
  ]);
  assert.equal(day.recordsByStream.quota.length, 4);
  assert.equal(new Set(day.recordsByStream.quota.map((row) => row.observationId)).size, 4);
  const result = project(day);
  assert.deepEqual(stream(result, "usage").map((row) => row.accountPlanAttribution), ["pro", "plus"].map((planType) => ({
    accountBasis: "unavailable", accountTrackId: null, planBasis: "same_source_occurrence", planType, planEraId: null,
  })));
  assert.equal(stream(result, "usage").reduce((sum, row) => sum + row.components.inputUncachedTokens, 0), 70);
  const successor = createTelemetryV12Day({
    day: DAY,
    recordsByStream: day.recordsByStream,
    attributionForRecord: day.attributionForRecord,
    accountObservationSecret: secret,
    binding,
    parserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    activationTime: `${DAY}T00:00:00.000Z`,
    continuityForRecord: day.telemetryV12Evidence.continuityForRecord,
  });
  const successorUsage = successor.chunks.filter((chunk) => chunk.chunkId.startsWith("usage:"))
    .flatMap((chunk) => chunk.records);
  assert.deepEqual(successorUsage.map((record) => [record.boundaryFlags, record.tieOrder]), [
    [0, 0], [0, 0],
  ]);
  assert.deepEqual(reader.days(), [DAY]);
  assert.deepEqual(project(reader.readDay(DAY)), result);
});

test("exact index boundary joins reach v1.2 preparation across clock ties and the activation cutoff", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { id: 1, at: 0, offset: 40, boundaryFlags: 0 },
    { id: 2, at: 0, offset: 10, boundaryFlags: 1 },
    { id: 3, at: 0, offset: 30, boundaryFlags: 2 },
    { id: 4, at: 0, offset: 20, boundaryFlags: 3 },
  ] });
  const { reader } = readFixture(t, file);
  const legacy = reader.readDay(DAY);
  const day = reader.readDayWithV12Evidence(DAY);
  const prepare = (activationTime) => createTelemetryV12Day({
    day: DAY, recordsByStream: day.recordsByStream,
    attributionForRecord: day.attributionForRecord,
    accountObservationSecret: secret, binding,
    parserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    activationTime, continuityForRecord: day.telemetryV12Evidence.continuityForRecord,
  });
  assert.deepEqual(stream(prepare(stamp(-1)), "usage")
    .map((record) => [record.boundaryFlags, record.tieOrder]), [
    [0, 3], [1, 0], [2, 2], [3, 1],
  ]);
  assert.deepEqual(stream(prepare(stamp(1)), "usage")
    .map((record) => [record.boundaryFlags, record.tieOrder]), [
    [null, null], [null, null], [null, null], [null, null],
  ]);
  assert.equal(Object.hasOwn(legacy, "telemetryV12Evidence"), false);
  assert.deepEqual(project(day), project(legacy));
});

test("held/suppressed quota cannot attribute usage and quota-only plan changes are retained", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { quotas: [{ plan: "plus", admission: "held" }] },
    { quotas: [{ plan: "plus", admission: "suppressed" }] },
    { usage: false, quotas: [{ plan: "plus" }] },
    { quotas: [{ plan: "pro" }, { plan: "plus" }] },
    { quotas: [{ plan: null }] },
    { quotas: [{ plan: "pro", missingReset: true }] },
  ] });
  const { reader } = readFixture(t, file);
  const day = reader.readDay(DAY);
  const result = project(day);
  assert.equal(stream(result, "usage").length, 5);
  assert.equal(stream(result, "quota").length, 5);
  assert.equal(stream(result, "quota").find((row) => row.observedTime === stamp(5_000)).resetsAt, null);
  assert.deepEqual(day.excluded, { usage: 0, quota: 0, session: 0 });
  assert.deepEqual(stream(result, "usage").map((row) => [row.accountPlanAttribution.planBasis, row.accountPlanAttribution.planType]), [
    ["unavailable", "unknown"], ["unavailable", "unknown"], ["conflicted", "unknown"],
    ["unavailable", "unknown"], ["same_source_occurrence", "pro"],
  ]);
});

test("captured consent/account bracket labels only fully contained intervals and deduplicates paired quota era anchors", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { at: 0, quotas: [{ plan: "pro", duration: 300 }, { plan: "pro" }] },
    { at: 1_000, quotas: [{ plan: "pro", duration: 300 }, { plan: "pro" }] },
  ] });
  const { reader } = readFixture(t, file, { accountMarkers: [marker()] });
  const day = reader.readDay(DAY);
  const result = project(day);
  const [first, second] = stream(result, "usage").map((row) => row.accountPlanAttribution);
  assert.equal(first.planType, "pro");
  assert.equal(first.accountTrackId, null, "first cumulative interval has no proven lower bound");
  assert.equal(second.accountBasis, "provisional_marker");
  assert.match(second.accountTrackId, /^account-track:v2:/u);
  assert.notEqual(second.planEraId, null);
  const quotaEras = stream(result, "quota").map((row) => row.accountPlanAttribution.planEraId);
  assert.deepEqual(new Set(quotaEras), new Set([second.planEraId]));
  assert.equal(day.attributionForRecord("session", day.recordsByStream.session[0]), null);
  assert.equal(day.attributionForRecord("quota", day.recordsByStream.usage[1]).planType, "unknown");
  assert.equal(day.attributionForRecord("usage", { ...day.recordsByStream.usage[1] }).planType, "unknown");
  assert.throws(() => { day.recordsByStream.usage[1].components.inputUncachedTokens = 999; }, TypeError);
  const serialized = JSON.stringify(result);
  for (const forbidden of [scope().scopeId, binding.enrollmentNamespace, binding.destinationOrigin,
    "source_local", "source_offset", "source_ordinal", "accountScope", "observationBinding"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  const rebound = project(day, { binding: { ...binding, enrollmentNamespace: "synthetic_enrollment_0002" } });
  assert.ok(stream(rebound, "usage").every((row) => row.accountPlanAttribution.accountTrackId === null));
  assert.ok(stream(rebound, "usage").every((row) => row.accountPlanAttribution.planType === "pro"));
});

test("untrusted plan and marker extras cannot enter content-free prepared records", async (t) => {
  const canary = "PRIVATE_CONTENT_CANARY";
  const { file } = await writeFixture(t, { records: [{ quotas: [{ plan: canary }] }, { quotas: [{ plan: "pro" }] }] });
  const { database, reader } = readFixture(t, file, {
    accountMarkers: [marker({ rawPath: `/${canary}/session.jsonl`,
      accountScope: { ...scope(), rawEmail: `${canary}@example.test` } })],
  }, false);
  database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("synthetic_private_canary", canary);
  const result = project(reader.readDay(DAY));
  assert.equal(stream(result, "usage")[0].accountPlanAttribution.planType, "unknown");
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(JSON.stringify(result).includes("rawEmail"), false);
  assert.equal(JSON.stringify(result).includes("rawPath"), false);
});

test("private projection evidence is stable for equivalent markers and binds every effective attribution input", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { at: 0, quotas: [{ plan: "pro" }] }, { at: 1_000, quotas: [{ plan: "pro" }] },
  ] });
  const markers = [marker(), marker({ capturedAt: stamp(500) })];
  const readEvidence = (accountMarkers, selectedBinding = binding) => {
    const { reader } = readFixture(t, file, { accountMarkers });
    return reader.projectionEvidence({ binding: selectedBinding });
  };
  const evidence = readEvidence(markers);
  assert.deepEqual(Object.keys(evidence).sort(), ["boundDays", "fingerprint"]);
  assert.match(evidence.fingerprint, /^[0-9a-f]{64}$/u);
  assert.deepEqual(evidence.boundDays, [DAY]);
  assert.ok(Object.isFrozen(evidence) && Object.isFrozen(evidence.boundDays));
  assert.deepEqual(readEvidence([...markers].reverse().map((value) => ({ ...value,
    source: "active-account", rawPath: "/PRIVATE_SYNTHETIC_CONTENT",
    accountScope: { ...value.accountScope, rawEmail: "PRIVATE_SYNTHETIC_CONTENT@example.test" },
  }))), evidence);
  assert.equal(readEvidence([...markers, marker({ observationBinding: null })]).fingerprint, evidence.fingerprint);
  for (const changed of [
    [marker({ accountScope: scope(8) }), markers[1]],
    [marker({ receivedAt: stamp(1_500) }), markers[1]],
    [marker({ observationBinding: { ...binding, enrollmentNamespace: "synthetic_enrollment_0002" } }), markers[1]],
    [markers[0]],
  ]) assert.notEqual(readEvidence(changed).fingerprint, evidence.fingerprint);
  assert.deepEqual(readEvidence(markers, { ...binding, enrollmentNamespace: "synthetic_enrollment_0002" }).boundDays, []);
  assert.deepEqual(readEvidence([marker({ accountScope: scope(7, "plus") })]), readEvidence([]),
    "a marker contradicted by indexed quota cannot affect projection");
  const { reader } = readFixture(t, file, { accountMarkers: markers });
  assert.throws(() => reader.projectionEvidence({ binding: null }), { code: "local_telemetry_v11_invalid_binding" });
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|scopeId|accountScope|enrollment|destination|account:v1/iu);
});

test("old, future, expired, conflicting, and reversed-clock markers do not acquire historical ownership", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { at: 0, quotas: [{ plan: "pro" }] }, { at: 1_000, quotas: [{ plan: "pro" }] },
  ] });
  const invalidCases = [
    [marker({ observationBinding: null })],
    [marker({ receivedAt: undefined })],
    [marker({ capturedAt: stamp(1_500), receivedAt: stamp(2_000) })],
    [marker({ capturedAt: stamp(-600_000) })],
    [marker({ capturedAt: stamp(2_000), receivedAt: stamp(-1) })],
    [marker(), marker({ accountScope: scope(8), capturedAt: stamp(500) })],
    [marker({ accountScope: scope(7, "plus") })],
  ];
  for (const accountMarkers of invalidCases) {
    const { reader } = readFixture(t, file, { accountMarkers });
    const attribution = stream(project(reader.readDay(DAY)), "usage")[1].accountPlanAttribution;
    assert.equal(attribution.accountTrackId, null);
    assert.equal(attribution.planEraId, null);
    assert.equal(attribution.planType, "pro");
  }
});

test("quota-only intervening changes and reversed source clocks retain ending plan without interval-era claims", async (t) => {
  const { file } = await writeFixture(t, { records: [
    { at: 0, offset: 1, quotas: [{ plan: "pro" }] },
    { at: 500, offset: 2, usage: false, quotas: [{ plan: "plus", duration: 300 }] },
    { at: 1_000, offset: 3, quotas: [{ plan: "pro" }] },
    { at: 900, offset: 4, quotas: [{ plan: "pro" }] },
  ] });
  const { reader } = readFixture(t, file, { accountMarkers: [marker()] });
  const result = project(reader.readDay(DAY));
  assert.equal(stream(result, "quota").length, 4);
  assert.equal(stream(result, "usage").length, 3);
  assert.ok(stream(result, "usage").every((row) => row.accountPlanAttribution.planType === "pro"));
  assert.ok(stream(result, "usage").every((row) => row.accountPlanAttribution.planEraId === null));
  assert.ok(stream(result, "usage").every((row) => row.accountPlanAttribution.accountTrackId === null));
});

test("acquisition bounds fail closed without dropping records or mutating the index", async (t) => {
  const { file } = await writeFixture(t, { records: [{ quotas: [{ plan: "pro" }] }, { quotas: [{ plan: "pro" }] }] });
  const { database, reader } = readFixture(t, file, { limits: { dayRows: 1 } });
  const before = database.prepare("SELECT * FROM usage_event ORDER BY event_key").all();
  assert.throws(() => reader.readDay(DAY), { code: "local_telemetry_v11_day_limit_exceeded" });
  assert.throws(() => reader.readDayWithV12Evidence(DAY), { code: "local_telemetry_v11_day_limit_exceeded" });
  assert.deepEqual(database.prepare("SELECT * FROM usage_event ORDER BY event_key").all(), before);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, LOCAL_INDEX_STORE_USER_VERSION);
  assert.throws(() => reader.readDay("2026-02-30"), { code: "local_telemetry_v11_invalid_day" });
  assert.throws(() => createLocalIndexTelemetryV11Reader(database, { ...ports, limits: { dayRows: Infinity } }), {
    code: "local_telemetry_v11_invalid_limits",
  });
});


test("streamed quota anchors match the eager policy across runs, unknowns and equal-time contradictions", () => {
  const hash = parts => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const contextKey = planAttributionContextKey("openai_codex", "account-plan");
  // Repeated positive anchors, ignored unknowns, tied same-plan different
  // sources, paired slots, contradictions and subsequent era restarts.
  const cases = [
    ["unknown", "unknown", "unknown"],
    ["pro", "pro", "unknown", "pro", "plus", "plus", "pro"],
    ["unknown", ["pro", "unknown"], "pro", ["unknown", "plus"], "plus"],
    ["pro", ["pro", "pro"], ["pro", "plus"], "pro", "pro", "unknown"],
    [["pro", "pro"], "pro", "plus", "unknown", "plus"],
  ];
  for (const plans of cases) {
    const rows = plans.flatMap((entry, time) => (Array.isArray(entry) ? entry : [entry])
      .map((plan, tie) => ({ observed_at_ms: START + time, plan_type: plan, limit_id: "codex",
        source_local: Buffer.alloc(32, tie + 1), source_offset: time + 1, source_ordinal: tie })));
    const eager = rows.map(row => ({ contextKey, accountScopeId: null,
      observedAtMs: row.observed_at_ms, planType: row.plan_type, planVariant: "unknown" }));
    const expected = buildPlanAttributionIndex(eager);
    const compact = compactQuotaPlanEvidence(rows.values(), [], 100);
    const actual = buildPlanAttributionIndex(compact.observations);
    assert.deepEqual(actual.eras, expected.eras);
    assert.deepEqual(actual.conflicts, expected.conflicts);
    assert.deepEqual(actual.contexts, expected.contexts);
    for (const era of expected.eras) {
      const anchors = rows.filter(row => row.observed_at_ms === era.firstObservedAtMs && row.plan_type === era.planType);
      const digests = new Set(anchors.map(row => hash(["local-quota-record-v1", row.source_local.toString("hex"),
        row.source_offset, row.source_ordinal, row.observed_at_ms])));
      assert.equal(compact.seeds.get(JSON.stringify([contextKey, null, era.planType, era.firstObservedAtMs])),
        digests.size === 1 ? [...digests][0] : null);
    }
  }
});

test("quota iteration retains two anchors beyond the former acquisition cap and refuses genuine transition overflow", () => {
  let acquired = 0;
  function* repeated() {
    for (let i = 0; i < 1_000_001; i += 1) {
      acquired += 1;
      yield { observed_at_ms: START + i, plan_type: "pro", limit_id: "codex",
        source_local: Buffer.alloc(32, 1), source_offset: i, source_ordinal: 0 };
    }
  }
  const compact = compactQuotaPlanEvidence(repeated(), [], 2);
  assert.equal(acquired, 1_000_001);
  assert.equal(compact.observations.length, 2);
  assert.equal(compact.seeds.size, 1);
  assert.equal(compact.observations[0].observedAtMs, START);
  assert.equal(compact.observations[1].observedAtMs, START + 1_000_000);
  const alternating = ["pro", "plus", "pro"].map((plan, i) => ({observed_at_ms: START+i,
    plan_type:plan,limit_id:"codex",source_local:Buffer.alloc(32,1),source_offset:i,source_ordinal:0}));
  assert.throws(() => compactQuotaPlanEvidence(alternating, [], 2), {code:"local_telemetry_v11_quota_limit_exceeded"});
});

test("small anchor budget exports every quota record and preserves marker conflicts without eager corpus acquisition", async t => {
  const records = Array.from({length:40}, (_, i) => ({at:i*1_000,quotas:[{plan:"pro"}]}));
  // A contradictory observation invalidates the captured account bracket,
  // including earlier records; streaming must inspect the entire bracket.
  records.at(-1).quotas = [{plan:"plus"}];
  const {file} = await writeFixture(t, {records});
  const markers = [marker({receivedAt:stamp(39_000)})];
  const reference = readFixture(t,file,{accountMarkers:markers});
  const expected = project(reference.reader.readDay(DAY));
  const database = openStore(file, { readOnly: true });
  let streamed = 0;
  const guarded = new Proxy(database, {get(target,key) {
    if (key !== "prepare") { const value=Reflect.get(target,key,target); return typeof value === "function" ? value.bind(target) : value; }
    return sql => {
      const statement=target.prepare(sql);
      const corpusQuota=sql.includes("FROM quota_occurrence q") && sql.includes("ORDER BY q.observed_at_ms") && !sql.includes("q.observed_at_ms >=");
      if (!corpusQuota) return statement;
      return new Proxy(statement,{get(inner,method) {
        if(method==="all") return () => assert.fail("quota corpus must never be acquired eagerly");
        if(method==="iterate") return (...args) => {streamed+=1; return inner.iterate(...args);};
        const value=Reflect.get(inner,method,inner);return typeof value === "function" ? value.bind(inner):value;
      }});
    };
  }});
  const reader=createLocalIndexTelemetryV11Reader(guarded,{...ports,accountMarkers:markers,limits:{quotaObservations:3}});
  assert.deepEqual(reader.days(),[DAY]);
  assert.deepEqual(project(reader.readDay(DAY)),expected);
  assert.equal(reader.readDay(DAY).recordsByStream.quota.length,40);
  assert.equal(streamed,2,"two streaming passes in one pinned snapshot, reused by later day reads");
  assert.ok(stream(expected,"quota").every(row=>row.accountPlanAttribution.accountTrackId===null));
});
