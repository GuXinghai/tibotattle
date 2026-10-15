import { createHash } from "node:crypto";
import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import {
  createWorkUsageProjectResolver,
  readCodexLocalRepositoryOrigins,
  readCodexLocalThreadUsageRelations,
} from "./platform/index.js";
import { createWorkUsageAccumulator, workUsageError } from "./reporting/index.js";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import { usageProjection } from "./local-companion-usage-model.js";
import {
  committedPredicate,
  rollupKeyExpressions,
  storedContextStarts,
} from "./local-index-rollup.js";
import { readCommitSeq } from "./local-index-store.js";
import { defaultLocalUnifiedIndexSecretPath, localDigest, readExistingDeviceSalt } from "./local-device-salt.js";
import { createAccountingPricer } from "./replay-safe-accounting-cache.js";

// The work breakdown over the local index store.
//
// Per-fact inputs (working directory, session, model, tokens, provenance) are
// stored with each usage fact, so accounting reads them from the store.
// Review-family attribution separately verifies bounded session headers.
// Committed facts preserve per-event speed tiers; the old
// daily work rollups cannot price mixed-speed days because they omit tiers.

const MAX_WORK_CELLS = 50_000;
const WORK_RESOLVE_CONCURRENCY = 12;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;


/** Which token columns a rollup row reports as unknown, from its shape. */
function componentsOf(row) {
  const shape = Number(row.shape);
  const value = (bit, sum) => ((shape >> bit) & 1) === 1 ? null : Number(sum);
  return {
    input_uncached_tokens: value(0, row.in_uncached),
    input_cache_read_tokens: value(1, row.in_cache_read),
    input_cache_write_tokens: value(2, row.in_cache_write),
    output_text_tokens: value(3, row.out_text),
    output_reasoning_tokens: value(4, row.out_reasoning),
    output_combined_tokens: value(5, row.out_combined),
  };
}

function periodsFor(nowMs, intervals) {
  return intervals ?? [
    { id: "24h", fromMs: Math.max(0, nowMs - 86_400_000), toMs: nowMs },
    { id: "7d", fromMs: Math.max(0, nowMs - 7 * 86_400_000), toMs: nowMs },
    { id: "30d", fromMs: Math.max(0, nowMs - 30 * 86_400_000), toMs: nowMs },
    { id: "all", fromMs: 0, toMs: nowMs },
  ];
}

/**
 * Read the work-usage snapshots of every period and account scope.
 *
 * Returns what the shipping collector's `finish()` returns: `{ status, asOfMs,
 * periods }`, each period with its scopes and one snapshot per scope.
 */
export async function readLocalIndexWorkUsage({
  database,
  indexFile = null,
  codexHome,
  secretFile = null,
  nowMs = Date.now(),
  signal = null,
  intervals = null,
  maximumCells = MAX_WORK_CELLS,
  pricer = createAccountingPricer(),
  resolveProject = null,
  declaredSpeedBaselines = [],
} = {}) {
  if (!Number.isSafeInteger(maximumCells) || maximumCells < 1 || maximumCells > MAX_WORK_CELLS) {
    const error = new Error("work_usage_capacity_exceeded");
    error.code = "work_usage_capacity_exceeded";
    throw error;
  }
  const periods = periodsFor(nowMs, intervals);
  const scopeRows = database.prepare(
    "SELECT id, status, scope_local, reason, plan_type FROM account_scope ORDER BY id LIMIT 25001",
  ).all();
  if (scopeRows.length > 25_000) {
    const error = new Error("work_usage_capacity_exceeded");
    error.code = "work_usage_capacity_exceeded";
    throw error;
  }

  // Project resolution, once per distinct working directory.
  let deviceSalt = null;
  let metadataAvailable = true;
  let resolver = resolveProject;
  try {
    if (resolver === null) {
      deviceSalt = await readExistingDeviceSalt(
        secretFile ?? defaultLocalUnifiedIndexSecretPath(indexFile),
      );
      const repositoryOrigins = await readCodexLocalRepositoryOrigins(codexHome);
      resolver = createWorkUsageProjectResolver({
        repositoryOrigins,
        digest: (kind, value) => localDigest(deviceSalt, `work-usage-${kind}`, value).toString("hex"),
      });
    }
  } catch (error) {
    if (error?.code === "work_usage_capacity_exceeded" || signal?.aborted) throw error;
    metadataAvailable = false;
    resolver = async () => null;
  }
  const projects = {};
  const worktrees = {};
  const projectByDirectory = new Map([[0, null]]);
  const directoriesUsed = new Set(database.prepare(
    "SELECT DISTINCT work_directory_id AS id FROM work_rollup WHERE events > 0",
  ).all().map((row) => Number(row.id)));
  // Each distinct directory may cost a Git process, so they run side by side,
  // bounded. Results are applied in id order, so the output does not depend on
  // which finished first.
  const toResolve = database.prepare("SELECT id, path FROM work_directory ORDER BY id").all()
    .filter((row) => directoriesUsed.has(Number(row.id)));
  const resolved = new Array(toResolve.length);
  let nextIndex = 0;
  let fatal = null;
  await Promise.all(Array.from({ length: Math.min(WORK_RESOLVE_CONCURRENCY, toResolve.length) }, async () => {
    for (;;) {
      if (fatal !== null) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= toResolve.length) return;
      try {
        signal?.throwIfAborted();
        resolved[index] = { project: await resolver(toResolve[index].path) ?? null, failed: false };
      } catch (error) {
        if (error?.code === "work_usage_capacity_exceeded" || signal?.aborted) {
          fatal = error;
          return;
        }
        resolved[index] = { project: null, failed: true };
      }
    }
  }));
  if (fatal !== null) throw fatal;
  toResolve.forEach((row, index) => {
    const { project, failed } = resolved[index];
    if (failed) metadataAvailable = false;
    projectByDirectory.set(Number(row.id), project);
    if (project) {
      projects[project.project] = { name: project.projectName, method: project.method };
      worktrees[project.worktree] = { name: project.worktreeName };
    }
  });

  const commitSeq = readCommitSeq(database);
  const generation = Object.freeze({
    status: "complete",
    id: commitSeq,
    commitSeq,
    usageProvenanceComplete: true,
  });
  const core = createWorkUsageCollectorCore({
    generation,
    periods,
    scopeRows,
    maximumCells,
    signal,
    nowMs,
    codexHome,
    deviceSalt,
    projects,
    worktrees,
    metadata: () => ({
      discoveryFingerprint: null,
      observationDigest: null,
      status: metadataAvailable ? "available" : "partial",
      metadataAvailable,
      inspectedSources: Number(database.prepare(
        "SELECT COUNT(*) AS n FROM source WHERE quarantine_code IS NULL",
      ).get().n),
      indexedSources: Number(database.prepare(
        "SELECT COUNT(*) AS n FROM source WHERE quarantine_code IS NULL",
      ).get().n),
    }),
  });

  const tiers = new Map(database.prepare("SELECT id, codex_speed_mode, api_service_tier FROM tier_semantics").all().map(row => [Number(row.id), { codexSpeedMode: row.codex_speed_mode, apiServiceTier: row.api_service_tier }]));
  const models = new Map(database.prepare("SELECT id, model_id FROM model").all()
    .map((row) => [Number(row.id), row.model_id]));
  const sessions = new Map(database.prepare("SELECT id, session_local, session_uuid FROM session").all()
    .map((row) => [Number(row.id), { local: row.session_local, uuid: row.session_uuid }]));
  const priceOf = (record) => {
    const priced = usageProjection(record, declaredSpeedModeAt(declaredSpeedBaselines, Date.parse(record.observedAt)) ?? "unknown", pricer)?.speedPriced;
    return { amount: ["fully_priced", "partially_priced"].includes(priced?.coverageStatus) ? priced.totalUsd : null, status: priced?.coverageStatus ?? "unpriced" };
  };
  const allNull = (components) => Object.values(components).every((value) => value === null);

  // Aggregate facts with their tier and context band retained. The old work
  // rollup omits tiers, so it cannot price a mixed-speed day correctly. Query
  // one UTC day at a time and yield between days to keep cancellation and the
  // companion event loop responsive even for an all-history report.
  const lowest = Math.min(...periods.map(period => period.fromMs));
  const highest = Math.max(...periods.map(period => period.toMs));
  const dayMs = 86_400_000;
  const starts = storedContextStarts(database);
  const key = rollupKeyExpressions("u");
  const cuts = new Set([lowest, highest]);
  for (const period of periods) { cuts.add(period.fromMs); cuts.add(period.toMs); }
  for (const baseline of declaredSpeedBaselines) {
    for (const value of [baseline.firstSeenAt, baseline.lastSeenAt]) {
      const at = Date.parse(value);
      if (at > lowest && at < highest) { cuts.add(at); cuts.add(Math.min(at + 1, highest)); }
    }
  }
  const bounds = database.prepare(`SELECT MIN(u.observed_at_ms) AS first_at, MAX(u.observed_at_ms) AS last_at
    FROM usage_event u WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ? AND ${committedPredicate("u")}`).get(lowest, highest);
  if (bounds.first_at === null) return core.finish();
  const first = Math.max(lowest, Number(bounds.first_at));
  const last = Math.min(highest, Number(bounds.last_at) + 1);
  cuts.add(first); cuts.add(last);
  for (let at = (Math.floor(first / dayMs) + 1) * dayMs; at < last; at += dayMs) cuts.add(at);
  const ordered = [...cuts].filter(at => at >= first && at <= last).sort((a, b) => a - b);
  const grouped = database.prepare(`SELECT u.session_id, COALESCE(u.work_directory_id, 0) AS directory_id,
    u.model_id, u.account_scope_id, u.tier_id, ${key.shape} AS shape, ${key.ctx_class} AS ctx_class,
    ((u.flags & 1) | ((u.flags & 4) >> 1) | ((u.flags & 8) >> 1)) AS prov,
    COUNT(*) AS events, MIN(u.observed_at_ms) AS first_at, MAX(u.observed_at_ms) AS last_at,
    SUM(u.tokens_in_uncached) AS in_uncached, SUM(u.tokens_in_cache_read) AS in_cache_read,
    SUM(u.tokens_in_cache_write) AS in_cache_write, SUM(u.tokens_out_text) AS out_text,
    SUM(u.tokens_out_reasoning) AS out_reasoning, SUM(u.tokens_out_combined) AS out_combined
    FROM usage_event u WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ? AND ${committedPredicate("u")}
    GROUP BY u.session_id, directory_id, u.model_id, u.account_scope_id, u.tier_id, shape, ctx_class, prov`);
  for (let interval = 0; interval + 1 < ordered.length; interval += 1) {
    signal?.throwIfAborted();
    for (const row of grouped.iterate(ordered[interval], ordered[interval + 1])) {
      const components = componentsOf(row);
      const prov = Number(row.prov);
      const statusOnly = (prov & 4) !== 0 && allNull(components);
      const modelId = models.get(Number(row.model_id));
      const session = sessions.get(Number(row.session_id));
      const classIndex = Number(row.ctx_class);
      core.add({
        observedAtMs: Number(row.first_at), lastAtMs: Number(row.last_at),
        accountScopeId: Number(row.account_scope_id), sessionLocal: session.local, sessionUuid: session.uuid,
        modelId, components, statusOnly,
        project: projectByDirectory.get(Number(row.directory_id)) ?? null,
        cacheWriteAssumedZero: (prov & 2) !== 0, partial: (prov & 1) !== 0,
        price: statusOnly ? { amount: null, status: "unpriced" } : priceOf({
          observedAt: new Date(Number(row.first_at)).toISOString(), model: modelId,
          totalInputContextTokens: classIndex < 0 ? null : classIndex === 0 ? 0 : starts[classIndex - 1],
          components, tierSemantics: tiers.get(Number(row.tier_id)) ?? {}, surfaceClassification: {}, accountScope: {},
        }),
        weight: Number(row.events),
      });
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  return core.finish();
}

function scopeKey(row) {
  return `scope-${createHash("sha256")
    .update(
      JSON.stringify([
        row.status,
        row.scope_local ? Buffer.from(row.scope_local).toString("hex") : null,
        row.reason,
        row.plan_type,
      ]),
    )
    .digest("hex")}`;
}

/**
 * The accumulation and snapshot assembly shared by every source of work-usage
 * facts. A source resolves each fact's project and provenance and feeds
 * `add`; `finish` builds the per-period, per-scope snapshots.
 *
 * `add` takes one neutral fact (or one rollup row with `weight` equal facts
 * whose quantities are already summed): the project (`{project, projectName,
 * worktree, worktreeName, method}` or null), whether it is a status update,
 * its provenance, its summed components and its price.
 */
export function createWorkUsageCollectorCore({
  generation,
  periods,
  scopeRows,
  maximumCells = MAX_WORK_CELLS,
  signal = null,
  nowMs,
  codexHome,
  deviceSalt = null,
  projects = {},
  worktrees = {},
  metadata = () => ({
    discoveryFingerprint: null,
    observationDigest: null,
    status: "available",
    inspectedSources: 0,
    indexedSources: 0,
  }),
}) {
  const scopeStates = new Map(
    scopeRows.map((row) => [
      row.id,
      {
        id: scopeKey(row),
        status: row.status,
        threadLookup: {},
        threads: {},
        periods: new Map(),
      },
    ]),
  );
  let threadCount = 0;
  const cellKeys = new Set();
  function add(fact) {
    signal?.throwIfAborted();
    const at = fact.observedAtMs;
    const active = periods.filter((p) => at >= p.fromMs && at < p.toMs);
    if (active.length === 0) return;
    const state = scopeStates.get(fact.accountScopeId);
    if (!state) throw workUsageError("work_usage_scope_unavailable");
    const weight = fact.weight ?? 1;
    const thread = `t-${state.id.slice(-16)}-${Buffer.from(fact.sessionLocal).toString("hex")}`;
    const project = fact.project;
    if (!fact.statusOnly) {
      if (!state.threads[thread] && ++threadCount > 25_000)
        throw workUsageError("work_usage_capacity_exceeded");
      const uuid = UUID.test(fact.sessionUuid ?? "")
        ? fact.sessionUuid.toLowerCase()
        : null;
      if (uuid) state.threadLookup[uuid] = thread;
      state.threads[thread] = { uuid };
    }
    for (const period of active) {
      let bucket = state.periods.get(period.id);
      if (!bucket) {
        bucket = {
          accumulator: createWorkUsageAccumulator({ maximumCells }),
          models: new Set(),
          events: 0,
          excludedAllowanceUpdates: 0,
        };
        state.periods.set(period.id, bucket);
      }
      bucket.events += weight;
      if (fact.statusOnly) {
        bucket.excludedAllowanceUpdates += weight;
        continue;
      }
      const key = JSON.stringify([
        state.id,
        period.id,
        thread,
        project?.project,
        project?.worktree,
        fact.modelId,
      ]);
      if (!cellKeys.has(key)) {
        if (cellKeys.size >= maximumCells)
          throw workUsageError("work_usage_capacity_exceeded");
        cellKeys.add(key);
      }
      bucket.accumulator.add({
        thread,
        project: project?.project,
        worktree: project?.worktree,
        model: fact.modelId,
        // A rolled-up row stands for facts across a day: its newest instant
        // is what the cell reports, not the day it is filed under.
        at: fact.lastAtMs ?? at,
        components: fact.components,
        cacheWriteAssumedZero: fact.cacheWriteAssumedZero,
        partial: fact.partial || !generation.usageProvenanceComplete,
        price: fact.price,
        weight,
      });
      bucket.models.add(fact.modelId);
      if (bucket.models.size > 1000)
        throw workUsageError("work_usage_capacity_exceeded");
    }
  }
  async function finish() {
    const ids = [
      ...new Set(
        [...scopeStates.values()].flatMap((state) =>
          Object.values(state.threads)
            .map((t) => t.uuid)
            .filter(Boolean),
        ),
      ),
    ];
    const relations = await readCodexLocalThreadUsageRelations(codexHome, ids, { signal });
    for (const state of scopeStates.values()) {
      const { threads, threadLookup, id: selectedScope } = state;
      const threadFamilies = {};
      const autoReviewThreads = [];
      for (const [id, record] of Object.entries(threads)) {
        const relation = relations.get(record.uuid);
        if (relation?.autoReview) autoReviewThreads.push(id);
        const root = relation?.root;
        if (!root || root === record.uuid) {
          threadFamilies[id] = id;
          continue;
        }
        if (!threadLookup[root] && !deviceSalt) {
          threadFamilies[id] = id;
          continue;
        }
        const family =
          threadLookup[root] ??
          (deviceSalt
            ? `t-${selectedScope.slice(-16)}-family-${localDigest(deviceSalt, "work-family", root).toString("hex")}`
            : id);
        threadFamilies[id] = family;
        if (!threads[family] && ++threadCount > 25_000)
          throw workUsageError("work_usage_capacity_exceeded");
        threads[family] ??= { uuid: root };
        threadLookup[root] ??= family;
        threadFamilies[family] = family;
      }
      for (const length of [8, 12, 16, 36, 100]) {
        const counts = new Map();
        for (const [id, record] of Object.entries(threads)) {
          const suffix = (record.uuid ?? id).slice(-length);
          counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
        }
        for (const [id, record] of Object.entries(threads)) {
          const suffix = (record.uuid ?? id).slice(-length);
          if (!record.shortId && counts.get(suffix) === 1)
            record.shortId = suffix;
        }
      }

      state.threadFamilies = threadFamilies;
      state.autoReviewThreads = autoReviewThreads;
    }
    // Separate clones and folders may share a basename. Disambiguate against
    // the whole snapshot so the label remains stable across pages and filters.
    for (const records of [projects, worktrees]) {
      const names = new Map();
      for (const record of Object.values(records))
        names.set(record.name, (names.get(record.name) ?? 0) + 1);
      for (const [id, record] of Object.entries(records))
        if (names.get(record.name) > 1) record.shortId = id.slice(-12);
    }

    const described = metadata();
    const common = {
      pricing: {
        basis: "event_time",
        fingerprint: createHash("sha256")
          .update(JSON.stringify(["speed-api-prices-v1", APP_PRICE_REGISTRY_MANIFEST]))
          .digest("hex"),
      },
      metadata: {
        method: "last_observed_location",
        usageClassification: "verified-quota-status-v2",
        resolverVersion: "work-location-v4-review-families",
        discoveryFingerprint: described.discoveryFingerprint,
        observationDigest: described.observationDigest,
        observedAt: Date.now(),
        status: described.status,
        inspectedSources: described.inspectedSources,
        indexedSources: described.indexedSources,
        retained: false,
      },
    };
    const metadataAvailable = described.metadataAvailable !== false;
    const output = { status: "available", asOfMs: nowMs, periods: {} };
    for (const period of periods) {
      const states = [...scopeStates.values()].filter((state) =>
        state.periods.has(period.id),
      );
      const scopes = states.map((state) => ({
        id: state.id,
        status: state.status,
        events: state.periods.get(period.id).events,
      }));
      const snapshots = {};
      for (const state of states) {
        const bucket = state.periods.get(period.id);
        const excludedAllowanceUpdates = bucket.excludedAllowanceUpdates;
        snapshots[state.id] = {
          status: "available",
          generation,
          scope: state.id,
          scopes,
          fromMs: period.fromMs,
          toMs: period.toMs,
          cells: bucket.accumulator.finish(),
          models: [...bucket.models].sort(),
          threadLookup: state.threadLookup,
          threadFamilies: state.threadFamilies,
          autoReviewThreads: state.autoReviewThreads,
          display: { projects, worktrees, threads: state.threads },
          pricing: common.pricing,
          metadata: { ...common.metadata, excludedAllowanceUpdates },
        };
      }
      // An empty interval still has a selectable, empty snapshot.
      if (states.length === 0)
        snapshots["scope-0"] = {
          status: "available",
          generation,
          scope: "scope-0",
          scopes,
          cells: [],
          models: [],
          threadLookup: {},
          threadFamilies: {},
          display: { projects: {}, worktrees: {}, threads: {} },
          pricing: {
            basis: "event_time",
            fingerprint: createHash("sha256")
              .update(JSON.stringify(["speed-api-prices-v1", APP_PRICE_REGISTRY_MANIFEST]))
              .digest("hex"),
          },
          metadata: {
            status: metadataAvailable ? "available" : "partial",
            retained: false,
          },
        };
      output.periods[period.id] = {
        fromMs: period.fromMs,
        toMs: period.toMs,
        scopes,
        snapshots,
      };
    }
    return output;
  }
  return { add, finish };
}
