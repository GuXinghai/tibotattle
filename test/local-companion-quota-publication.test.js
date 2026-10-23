import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
  LocalCompanionDataStore,
  readLocalCompanionQuota,
  buildLocalCompanionSnapshot,
} from "../src/local-companion-data.js";
import { commitLocalCollectorState, prepareLocalCollectorState } from "../src/local-collector-state.js";
import { readLocalCollectorProjection } from "../src/local-collector-projection.js";

const instant = (minute) => new Date(Date.UTC(2026, 9, 21) + minute * 60_000).toISOString();
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const quota = (minute, scopeToken = "synthetic-account-a") => {
  const observedAt = instant(minute);
  const window = {
    limitId: "codex", slot: "primary", planType: "pro",
    usedPercent: minute, remainingPercent: 100 - minute,
    durationMinutes: 300, resetAt: instant(120),
  };
  return {
    scopeToken: scopeToken === null ? null : createHash("sha256").update(scopeToken).digest("hex"),
    quota: { status: "available", observedAt,
      accountAttribution: scopeToken === null ? "unattributed" : "attributed_pseudonymous",
      windows: [window] },
    quotaWindows: [{ ...window, observedAt, status: "live" }],
    quotaFreshness: { status: "live", latestObservedAt: observedAt,
      ageSeconds: 0, staleAfterSeconds: 1_800, source: "content_free_collector_state" },
  };
};
const snapshot = (minute = 0, generation = 1) => ({
  schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
  mode: "real_local_evidence", generatedAt: instant(minute),
  overview: {
    evidenceStatus: "available", quota: quota(minute).quota,
    quotaWindows: quota(minute).quotaWindows,
    freshness: { status: "stale", latestObservedAt: instant(0), ageSeconds: 3_600 },
    usage: [{ id: "all", totalTokens: 42 }],
    accounting: { generation, generatedAt: instant(0), evaluatedAt: instant(0) },
    timeline: { usage: [{ tokens: 42 }], quota: [{ historicalUsedPercent: 99 }] },
    workload: { status: "available", evaluatedAt: instant(0), inputs: { quota: "old-input" } },
  },
  gradient: {}, weekly: {}, quality: {},
});

async function scopedCandidate(minute, scopeId, generation = 2) {
  const root = await mkdtemp(join(tmpdir(), "quota-scope-synthetic-"));
  const stateFile = join(root, "collector.sqlite");
  try {
    await prepareLocalCollectorState({ stateFile });
    await commitLocalCollectorState({ stateFile, checkpoint: {}, records: [{
      schemaVersion: "0.3", kind: "codex_quota_snapshot", provider: "openai_codex",
      source: "app_server_read", observedAt: instant(minute), receivedAt: instant(minute),
      accountScope: scopeId === null ? { status: "unavailable" } : {
        status: "available", version: "openai-account-v1", scopeId,
      },
      windows: [{ provider: "openai_codex", planType: "pro", limitId: "codex",
        slot: "primary", usedPercent: minute, windowDurationMins: 300,
        resetsAt: Date.parse(instant(120)) / 1_000 }],
    }] });
    const candidate = await buildLocalCompanionSnapshot({
      root, collectorStateFile: stateFile, now: () => Date.parse(instant(10)),
      unifiedProjectionMode: "deferred",
      unifiedProjectionReader: async () => ({ status: "unavailable", errorCode: "unified_index_missing" }),
      collectorProjectionReader: ({ stateFile: file, nowMs }) => readLocalCollectorProjection(
        file, nowMs, { summarizeUsageEvents: false },
      ),
    });
    candidate.overview.accounting.generation = generation;
    return candidate;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("quota publication reads and clones only its component, retaining usage evaluation and inputs", async () => {
  let builds = 0;
  let current = quota(1);
  const store = new LocalCompanionDataStore({
    builder: async () => { builds += 1; return snapshot(); },
    quotaReader: async () => current,
  });
  await store.initialize();
  const before = store.getOverview();
  const getOverview = store.getOverview.bind(store);
  store.getOverview = () => { throw new Error("quota publication must not clone history"); };
  assert.deepEqual(await store.publishQuota({ returnOverview: false }), {
    published: true, observedAt: instant(1),
  });
  const after = getOverview();
  assert.equal(builds, 1);
  for (const field of ["generatedAt", "usage", "accounting", "timeline", "workload", "freshness"]) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.equal(after.quota.observedAt, instant(1));
  assert.equal(after.quotaFreshness.latestObservedAt, instant(1));
  assert.equal(store.getDesktopShellDisplayEvidence().freshness.status, "live");
  assert.equal(store.getDesktopShellDisplayEvidence().windows[0].observedAt, instant(1));
  assert.doesNotMatch(JSON.stringify(after), /synthetic-account|scopeToken/u);
  current = { ...current, quotaFreshness: { ...current.quotaFreshness, ageSeconds: 50 } };
  assert.deepEqual(await store.publishQuota(), { published: false, observedAt: instant(1) });
  assert.equal(getOverview().quotaFreshness.ageSeconds, 0,
    "a cache reread cannot publish another observation");
});

test("a late full result retains a later quota only with direct matching scope evidence", async (t) => {
  for (const scope of ["synthetic-account-a", "synthetic-account-b", null]) {
    await t.test(scope ?? "unknown", async () => {
      let candidate = snapshot();
      let current = quota(1);
      let gate = null;
      const store = new LocalCompanionDataStore({
        builder: async () => { const captured = candidate; if (gate) await gate.promise; return captured; },
        quotaReader: async () => current,
      });
      await store.initialize();
      await store.publishQuota();
      candidate = await scopedCandidate(1, "synthetic-account-a");
      gate = deferred();
      const pending = store.reload({ returnOverview: false });
      current = quota(2, scope);
      await store.publishQuota();
      gate.resolve();
      if (scope === "synthetic-account-a") {
        await pending;
        assert.equal(store.getOverview().accounting.generation, 2);
      } else {
        await assert.rejects(pending,
          { code: "local_companion_snapshot_publication_scope_changed" });
        assert.equal(store.getOverview().accounting.generation, 1);
      }
      assert.equal(store.getOverview().quota.observedAt, instant(2));
    });
  }
});

test("same observedAt and displayed values cannot bind a full candidate from another account", async () => {
  let candidate = snapshot();
  let current = quota(1);
  let gate = null;
  const store = new LocalCompanionDataStore({
    builder: async () => { const captured = candidate; if (gate) await gate.promise; return captured; },
    quotaReader: async () => current,
  });
  await store.initialize();
  await store.publishQuota();
  candidate = await scopedCandidate(1, "synthetic-account-b");
  assert.deepEqual(candidate.overview.quota, current.quota,
    "neither the timestamp nor normalized display fields reveal the account change");
  gate = deferred();
  const pending = store.reload();
  current = quota(2);
  await store.publishQuota();
  gate.resolve();
  await assert.rejects(pending, { code: "local_companion_snapshot_publication_scope_changed" });
  assert.equal(store.getOverview().accounting.generation, 1);
  assert.equal(store.getOverview().quota.observedAt, instant(2));
});

test("a sequential full candidate cannot downgrade a just-published observation at the same timestamp", async () => {
  let candidate = snapshot();
  const store = new LocalCompanionDataStore({
    builder: async () => candidate,
    quotaReader: async () => quota(1),
  });
  await store.initialize();
  await store.publishQuota();
  candidate = await scopedCandidate(1, "synthetic-account-a");
  candidate.overview.quotaFreshness = { status: "stale", latestObservedAt: instant(1), ageSeconds: 9_999 };
  candidate.overview.quotaWindows[0].status = "stale";
  await store.reload();
  assert.equal(store.getOverview().accounting.generation, 2);
  assert.equal(store.getOverview().quotaFreshness.status, "live");
  assert.equal(store.getOverview().quotaWindows[0].status, "live");
});

test("unknown quota identity stays unknown through an ordinary sequential full reload", async () => {
  let candidate = snapshot();
  const store = new LocalCompanionDataStore({
    builder: async () => candidate,
    quotaReader: async () => quota(1, null),
  });
  await store.initialize();
  await store.publishQuota();
  candidate = await scopedCandidate(1, null);
  await store.reload();
  assert.equal(store.getOverview().accounting.generation, 2);
  assert.equal(store.getOverview().quota.accountAttribution, "unattributed");
});

test("full snapshot construction preserves future quota evidence with stale freshness and unknown age", async () => {
  const candidate = await scopedCandidate(20, "synthetic-account-a");
  assert.equal(candidate.overview.quota.observedAt, instant(20));
  assert.equal(candidate.overview.quotaFreshness.status, "stale");
  assert.equal(candidate.overview.quotaFreshness.ageSeconds, null);
  assert.equal(candidate.overview.quotaWindows[0].status, "stale");
});

test("same-timestamp unknown account evidence removes earlier attribution without refreshing observedAt", async () => {
  let current = quota(1);
  const store = new LocalCompanionDataStore({
    builder: async () => snapshot(), quotaReader: async () => current,
  });
  await store.initialize();
  await store.publishQuota();
  current = quota(1, null);
  const receipt = await store.publishQuota();
  assert.deepEqual(receipt, { published: true, observedAt: instant(1) });
  assert.equal(store.getOverview().quota.accountAttribution, "unattributed");
  assert.deepEqual(await store.publishQuota(), { published: false, observedAt: instant(1) });
});

test("a late full result with no original scope evidence cannot borrow a later identity", async () => {
  const gate = deferred();
  let hold = false;
  const store = new LocalCompanionDataStore({
    builder: async () => { if (hold) await gate.promise; return snapshot(); },
    quotaReader: async () => quota(1),
  });
  await store.initialize();
  hold = true;
  const pending = store.reload();
  await store.publishQuota();
  gate.resolve();
  await assert.rejects(pending, { code: "local_companion_snapshot_publication_scope_changed" });
  assert.equal(store.getOverview().quota.observedAt, instant(1));
});

test("quota publication rejects cancellation, stale runs and late readers", async (t) => {
  for (const reason of ["cancel", "stale-run", "newer-quota", "newer-full", "failed-read"]) {
    await t.test(reason, async () => {
      const gate = deferred();
      let hold = true;
      let candidate = snapshot();
      const abort = new AbortController();
      let isCurrent = true;
      const store = new LocalCompanionDataStore({
        builder: async () => candidate,
        quotaReader: async () => {
          if (hold) { await gate.promise; if (reason === "failed-read") throw new Error("synthetic failure"); return quota(1); }
          return quota(2);
        },
      });
      await store.initialize();
      const pending = store.publishQuota({ signal: abort.signal, isCurrent: () => isCurrent });
      if (reason === "cancel") abort.abort();
      if (reason === "stale-run") isCurrent = false;
      if (reason === "newer-quota") { hold = false; await store.publishQuota(); }
      if (reason === "newer-full") { candidate = snapshot(2, 2); await store.reload(); }
      gate.resolve();
      if (["cancel", "failed-read"].includes(reason)) await assert.rejects(pending);
      else assert.equal((await pending).published, false);
      assert.equal(store.getOverview().quota.observedAt,
        ["newer-quota", "newer-full"].includes(reason) ? instant(2) : instant(0));
    });
  }
});

test("full publication rejects superseded generations and cancelled builders", async (t) => {
  for (const reason of ["newer-full", "cancel", "stale-run"]) {
    await t.test(reason, async () => {
      const gate = deferred();
      let calls = 0;
      const store = new LocalCompanionDataStore({ builder: async () => {
        calls += 1;
        const generation = calls;
        if (generation === 2) await gate.promise;
        return snapshot(generation, generation);
      } });
      await store.initialize();
      const abort = new AbortController();
      let isCurrent = true;
      const pending = store.reload({ signal: abort.signal, isCurrent: () => isCurrent });
      if (reason === "newer-full") await store.reload();
      if (reason === "cancel") abort.abort();
      if (reason === "stale-run") isCurrent = false;
      gate.resolve();
      await assert.rejects(pending);
      assert.equal(store.getOverview().accounting.generation, reason === "newer-full" ? 3 : 1);
    });
  }
});

test("narrow collector projection uses existing normalization and preserves observed time and unknown identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-publication-synthetic-"));
  const stateFile = join(root, "collector.sqlite");
  try {
    const records = Array.from({ length: 300 }, (_, index) => ({
      schemaVersion: "0.3", kind: "codex_quota_snapshot", provider: "openai_codex",
      source: "app_server_read", observedAt: instant(index / 60), receivedAt: instant(index / 60),
      accountScope: index === 299 ? { status: "unavailable" } : {
        status: "available", version: "openai-account-v1", scopeId: "synthetic-account-a",
      },
      windows: [{ provider: "openai_codex", planType: "pro", limitId: "codex",
        slot: "primary", usedPercent: 23, windowDurationMins: 300,
        resetsAt: Date.parse(instant(120)) / 1_000, syntheticUnknownField: "omitted" }],
      syntheticUnknownField: "omitted",
    }));
    await commitLocalCollectorState({ stateFile, checkpoint: {}, records });
    const options = { collectorStateFile: stateFile, now: () => Date.parse(instant(10)) };
    const first = await readLocalCompanionQuota(options);
    assert.equal(first.scopeToken, null);
    assert.equal(first.quota.accountAttribution, "unattributed");
    assert.equal(first.quota.windows[0].remainingPercent, 77);
    assert.equal(first.quota.windows[0].durationMinutes, 300);
    assert.doesNotMatch(JSON.stringify(first), /syntheticUnknownField|omitted|scopeId/u);
    const reread = await readLocalCompanionQuota({ ...options, now: () => Date.parse(instant(20)) });
    assert.equal(reread.quota.observedAt, first.quota.observedAt);
    assert.ok(reread.quotaFreshness.ageSeconds > first.quotaFreshness.ageSeconds);
    const future = await readLocalCompanionQuota({ ...options, now: () => Date.parse(instant(1)) });
    assert.equal(future.quota.observedAt, first.quota.observedAt,
      "future evidence stays visible rather than borrowing an older observation");
    assert.equal(future.quotaFreshness.status, "stale");
    assert.equal(future.quotaFreshness.ageSeconds, null);
    assert.equal(future.quotaWindows[0].status, "stale");

    await commitLocalCollectorState({ stateFile, checkpoint: {}, records: [{
      ...records.at(-1), observedAt: instant(5), receivedAt: instant(5),
      accountScope: { status: "available", version: "openai-account-v1", scopeId: "synthetic-account-a" },
    }, {
      ...records.at(-1), observedAt: instant(5), receivedAt: instant(5),
      accountScope: { status: "available", version: "openai-account-v1", scopeId: "synthetic-account-b" },
    }, {
      ...records.at(-1), schemaVersion: "unrecognized", observedAt: instant(6), receivedAt: instant(6),
    }] });
    const conflicting = await readLocalCompanionQuota(options);
    assert.equal(conflicting.scopeToken, null);
    assert.equal(conflicting.quota.observedAt, instant(5));
    assert.equal(conflicting.quota.accountAttribution, "unattributed");
    const abort = new AbortController();
    setImmediate(() => abort.abort());
    await assert.rejects(readLocalCompanionQuota({ ...options, signal: abort.signal }),
      { code: "local_companion_snapshot_reload_aborted" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
