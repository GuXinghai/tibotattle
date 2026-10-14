import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
  INFORMATIONAL_HISTORY_GAP_MAX_SHARE,
  LocalCompanionDataStore,
  RETAINED_EVIDENCE_RELABELED_WARNINGS,
  RETAINED_PROJECTION_SURFACE_PATHS,
  buildLocalCompanionSnapshot,
  isInformationalTerminalHistoryGap,
} from "../src/local-companion-data.js";
import {
  createAccountingPricer,
} from "../src/replay-safe-accounting-cache.js";
import { openLocalIndexStore } from "../src/local-index-store.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import {
  readLocalIndexCompanionProjection,
} from "../src/local-index-companion-source.js";
import { readLocalIndexProjection } from "../src/local-index-backend.js";
import { usageProjection } from "../src/local-companion-usage-model.js";
import { readLocalIndexWindowBreakdown } from "../src/local-index-window-breakdown.js";

const ARTIFACT_FILES = {
  gradient: "2026-07-24-simple-quota-gradient-artifact.json",
  weekly: "2026-07-24-weekly-7-day-calibration-artifact.json",
  quality: "2026-07-24-monitoring-quality-artifact.json",
};

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "local-companion-data-"));
  const reportDirectory = join(root, ".usage-monitor", "legacy-reports");
  await mkdir(reportDirectory, { recursive: true });
  for (const [kind, file] of Object.entries(ARTIFACT_FILES)) {
    await writeFile(join(reportDirectory, file), JSON.stringify({
      privateTopLevel: "/Users/private/source",
      snapshot: {
        status: "complete",
        generatedAt: "2026-07-24T12:00:00.000Z",
        datasets: kind === "gradient" ? {
          summary: [{
            capacity_usd: 100,
            lower_80_usd: 80,
            upper_80_usd: 130,
            private_field: "person@example.com",
          }],
          reset_calendar: [{
            announced_at_utc: "2026-07-23T00:00:00.000Z",
            event_type: "global_reset",
            source_url: "https://private.example/",
          }],
        } : kind === "weekly" ? {
          summary: [{ median_weekly_value_usd: 112, qualifying_resets: 8 }],
        } : {
          summary: [{ known_speed_fraction: 0.8 }],
          opportunities: [{
            id: "collector_continuity",
            priority: "P0",
            title: "Keep collection fresh",
            evidence: "No arbitrary content.",
            action: "Collect again.",
          }],
        },
      },
    }));
  }
  for (const file of [
    "2026-07-24-simple-quota-gradient-report.html",
    "2026-07-24-weekly-7-day-calibration-report.html",
    "2026-07-24-monitoring-quality-report.html",
    "2026-07-24-codex-work-account-usage-report.html",
  ]) {
    await writeFile(join(reportDirectory, file), "<!doctype html><title>report</title>");
  }
  return root;
}

function rolloutUsage(input, output = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function rolloutToken(timestamp, total, last, usedPercent) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: {
          used_percent: usedPercent,
          window_minutes: 300,
          resets_at: 1_785_433_600,
        },
        secondary: {
          used_percent: usedPercent,
          window_minutes: 10_080,
          resets_at: 1_785_433_600,
        },
      },
    },
  });
}

test("usage projection preserves explicit context and absent-field pricing at 272k", () => {
  const pricer = createAccountingPricer();
  const cases = [
    { input: 272_000, context: {}, cost: "2.7209" },
    { input: 271_999, context: {}, cost: "1.360595" },
    { input: 272_000, context: { totalInputContextTokens: 0 }, cost: "1.3606" },
    { input: 272_000, context: { totalInputContextTokens: 271_999 }, cost: "1.3606" },
    { input: 271_999, context: { totalInputContextTokens: 272_000 }, cost: "2.72089" },
    ...[undefined, null, -1, 1.5, "0", Number.NaN, Number.POSITIVE_INFINITY]
      .map((value) => ({
        input: 272_000,
        context: { totalInputContextTokens: value },
        cost: "2.7209",
      })),
  ];
  for (const { input, context, cost } of cases) {
    const record = {
      observedAt: "2026-07-25T12:00:00.000Z",
      model: "gpt-5.6-sol",
      components: { input_uncached_tokens: input, input_cache_read_tokens: 0,
        input_cache_write_tokens: 0, output_text_tokens: 20, output_reasoning_tokens: 0 },
      ...context,
    };
    for (const price of [null, pricer]) {
      const projection = usageProjection(record, "unknown", price);
      assert.equal(projection.totalTokens, input + 20);
      assert.equal(projection.apiPriceEquivalentUsdExact, cost);
      assert.equal(projection.pricingCoverageStatus, "fully_priced");
    }
  }
});

test("usage projection preserves missing inputs and known context in full and memoized pricing", () => {
  const cases = [
    { name: "absent inputs and context", inputs: {}, context: undefined, status: "unpriced", cost: null },
    { name: "null inputs and context", inputs: {
      input_uncached_tokens: null, input_cache_read_tokens: null, input_cache_write_tokens: null,
    }, context: null, status: "unpriced", cost: null },
    { name: "known zero inputs", inputs: {
      input_uncached_tokens: 0, input_cache_read_tokens: 0, input_cache_write_tokens: 0,
    }, context: null, status: "fully_priced", cost: "0.0002" },
    { name: "explicit zero context with missing inputs", inputs: {}, context: 0,
      status: "partially_priced", cost: "0.0002" },
    { name: "explicit long context with missing inputs", inputs: {}, context: 272_001,
      status: "partially_priced", cost: "0.0003" },
  ];
  const pricer = createAccountingPricer();
  for (const { name, inputs, context, status, cost } of cases) {
    const record = {
      observedAt: "2026-09-29T12:00:00.000Z",
      model: "gpt-6.1-sol",
      totalInputContextTokens: context,
      components: { ...inputs, output_text_tokens: 20, output_reasoning_tokens: 0 },
    };
    const projections = [null, pricer].map((price) => usageProjection(record, "unknown", price));
    for (const projection of projections) {
      assert.equal(projection.totalTokens, 20, name);
      assert.equal(projection.components.output_text_tokens, 20, name);
      assert.equal(projection.apiPriceEquivalentUsdExact, cost, name);
      assert.equal(projection.apiPriceEquivalentUsd, Number(cost ?? 0), name);
      assert.equal(projection.pricingCoverageStatus, status, name);
      assert.equal(projection.priceCardIds.length, cost === null ? 0 : 1, name);
    }
    assert.deepEqual(projections[1], projections[0], name);
  }
});

test("usage projection prices selected split output once when its combined alias is also observed", () => {
  const record = {
    observedAt: "2026-09-29T12:00:00.000Z",
    model: "gpt-6.1-sol",
    totalInputContextTokens: 0,
    components: {
      input_uncached_tokens: 0, input_cache_read_tokens: 0, input_cache_write_tokens: 0,
      output_text_tokens: 20, output_reasoning_tokens: 10, output_combined_tokens: 30,
    },
  };
  for (const price of [null, createAccountingPricer()]) {
    const projection = usageProjection(record, "unknown", price);
    assert.equal(projection.totalTokens, 30);
    assert.equal(projection.components.output_combined_tokens, 0);
    assert.equal(projection.apiPriceEquivalentUsdExact, "0.0003");
    assert.equal(projection.pricingCoverageStatus, "fully_priced");
  }
});

test("local companion reconstructs reset kinds and prefers prospective banked evidence", async () => {
  const root = await fixtureRoot();
  const accountScope = {
    status: "available",
    version: "openai-account-v1",
    scopeId: "openai-account:v1:synthetic-reset-projection",
    planType: "pro",
  };
  const window = ({ duration, usedPercent, resetsAt }) => ({
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    slot: duration === 300 ? "primary" : "secondary",
    usedPercent,
    windowDurationMins: duration,
    resetsAt: Date.parse(resetsAt) / 1_000,
  });
  const record = (observedAt, weeklyUsed, fiveHourUsed, resetEvents = undefined) => ({
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    source: "app_server_read",
    observedAt,
    receivedAt: observedAt,
    accountScope,
    windows: [
      window({
        duration: 10_080,
        usedPercent: weeklyUsed,
        resetsAt: observedAt < "2026-07-25T00:00:00.000Z"
          ? "2026-07-25T00:00:00.000Z"
          : "2026-08-01T00:00:00.000Z",
      }),
      window({
        duration: 300,
        usedPercent: fiveHourUsed,
        resetsAt: "2026-07-26T00:00:00.000Z",
      }),
    ],
    ...(resetEvents === undefined ? {} : { resetEvents }),
  });
  const banked = {
    schemaVersion: "quota-reset-event-v0.1",
    kind: "banked_reset_used",
    occurredAt: "2026-07-25T02:00:00.000Z",
    observedAt: "2026-07-25T02:00:00.000Z",
    intervalStartedAt: "2026-07-25T01:00:00.000Z",
    precision: "observation_interval",
    reason: "credit_count_decreased_before_expiry",
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    windowDurationMins: 10_080,
  };
  const oldGrant = {
    schemaVersion: "quota-reset-event-v0.1",
    kind: "reset_credit_granted",
    occurredAt: "2026-06-20T00:00:00.000Z",
    observedAt: "2026-06-20T01:00:00.000Z",
    intervalStartedAt: "2026-06-19T23:00:00.000Z",
    precision: "provider_timestamp",
    reason: "reset_credit_id_added",
    provider: "openai_codex",
    planType: null,
    limitId: null,
    windowDurationMins: null,
  };
  try {
    const ledger = [
      {
        ...record("2026-06-20T01:00:00.000Z", 20, 20, [oldGrant]),
        source: "app_server_notification",
      },
      record("2026-07-24T23:50:00.000Z", 88, 20),
      record("2026-07-25T00:10:00.000Z", 2, 25),
      record("2026-07-25T01:00:00.000Z", 80, 80),
      record("2026-07-25T02:00:00.000Z", 3, 3, [banked]),
      record("2026-07-25T02:05:00.000Z", 4, 4),
    ];
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${ledger.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { mode: 0o600 },
    );
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-25T03:00:00.000Z"),
    });
    assert.deepEqual(
      snapshot.overview.timeline.resetEvents.map((event) => [
        event.kind,
        event.windowDurationMins,
        event.occurredAt,
      ]),
      [
        ["reset_credit_granted", null, "2026-06-20T00:00:00.000Z"],
        ["scheduled_reset", 10_080, "2026-07-25T00:00:00.000Z"],
        ["banked_reset_used", 10_080, "2026-07-25T02:00:00.000Z"],
        ["unknown_reset", 300, "2026-07-25T02:00:00.000Z"],
      ],
    );
    assert.equal(
      Date.parse(snapshot.overview.timeline.resetEvents[0].occurredAt)
        < Date.parse("2026-06-24T03:00:00.000Z"),
      true,
      "durable reset events remain available beyond the 31-day chart cache",
    );
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("reset-credit-id"), false);
    assert.equal(serialized.includes("availableCount"), false);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("local reset reconstruction breaks at an unattributed account read", async () => {
  const root = await fixtureRoot();
  const accountScope = {
    status: "available",
    version: "openai-account-v1",
    scopeId: "openai-account:v1:synthetic-reset-attribution-gap",
    planType: "pro",
  };
  const record = (hour, usedPercent, scope = accountScope) => {
    const observedAt = `2026-07-25T0${hour}:00:00.000Z`;
    return {
      schemaVersion: "0.3",
      kind: "codex_quota_snapshot",
      provider: "openai_codex",
      source: "app_server_read",
      observedAt,
      receivedAt: observedAt,
      accountScope: scope,
      windows: [{
        provider: "openai_codex",
        planType: "pro",
        limitId: "codex",
        slot: "secondary",
        usedPercent,
        windowDurationMins: 10_080,
        resetsAt: Date.parse("2026-08-01T00:00:00.000Z") / 1_000,
      }],
    };
  };
  try {
    const ledger = [
      record(0, 88),
      record(1, 4, { status: "unavailable" }),
      record(2, 4),
      record(3, 5),
      record(4, 80),
      record(5, 3),
      record(6, 4),
    ];
    await writeFile(join(root, ".usage-monitor", "collector-events.jsonl"),
      `${ledger.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { mode: 0o600 });
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-25T07:00:00.000Z"),
    });
    assert.deepEqual(snapshot.overview.timeline.resetEvents.map((event) => ({
      kind: event.kind,
      intervalStartedAt: event.intervalStartedAt,
      occurredAt: event.occurredAt,
    })), [{
      kind: "unknown_reset",
      intervalStartedAt: "2026-07-25T04:00:00.000Z",
      occurredAt: "2026-07-25T05:00:00.000Z",
    }], "only the later uninterrupted account track can establish a reset");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("local companion relays bounded durations and selects a deterministic primary window", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-generic-quota-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${JSON.stringify({
        kind: "codex_quota_snapshot",
        observedAt: "2026-07-25T11:45:00.000Z",
        windows: [
          {
            limitId: "codex",
            slot: "secondary",
            planType: "go",
            usedPercent: 20,
            windowDurationMins: 43_200,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "codex",
            slot: "primary",
            planType: "arbitrary-plan-name",
            usedPercent: 30,
            windowDurationMins: 43_200,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "codex",
            slot: "primary",
            planType: "prolite",
            usedPercent: 40,
            windowDurationMins: 300,
            resetsAt: 1_784_916_000,
          },
          {
            limitId: "codex",
            slot: "secondary",
            planType: "pro",
            usedPercent: 50,
            windowDurationMins: 10_080,
            resetsAt: 1_785_376_800,
          },
          {
            limitId: "codex_bengalfox",
            slot: "primary",
            planType: "edu",
            usedPercent: 60,
            windowDurationMins: 43_200,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "future_alpha",
            limitName: "Future Alpha",
            slot: "primary",
            planType: "plus",
            usedPercent: 61,
            windowDurationMins: 1_440,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "future_beta",
            limitName: "Account alice@example.com",
            slot: "primary",
            planType: "plus",
            usedPercent: 62,
            windowDurationMins: 43_200,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "codex",
            slot: "primary",
            planType: "pro",
            usedPercent: 70,
            windowDurationMins: 0,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "codex",
            slot: "primary",
            planType: "pro",
            usedPercent: 80,
            windowDurationMins: 525_601,
            resetsAt: 1_784_980_800,
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    const windows = snapshot.overview.quota.windows;
    assert.deepEqual(
      windows.map((window) => [
        window.limitId,
        window.slot,
        window.durationMinutes,
        window.planType,
      ]),
      [
        ["codex", "primary", 43_200, "unknown"],
        ["codex", "secondary", 43_200, "go"],
        ["codex", "primary", 300, "prolite"],
        ["codex", "secondary", 10_080, "pro"],
        ["codex_bengalfox", "primary", 43_200, "edu"],
        ["future_alpha", "primary", 1_440, "plus"],
        ["future_beta", "primary", 43_200, "plus"],
      ],
    );
    assert.equal(windows.find((window) => window.limitId === "future_alpha").limitName, "Future Alpha");
    assert.equal(
      Object.hasOwn(windows.find((window) => window.limitId === "future_beta"), "limitName"),
      false,
    );
    assert.equal(new Set(windows.map((window) => window.limitId)).has("unknown"), false);
    assert.equal(snapshot.overview.quotaWindows[0].durationMinutes, 43_200);
    assert.equal(snapshot.overview.quotaWindows[0].status, "live");
    assert.equal(
      JSON.stringify(snapshot).includes("monthly"),
      false,
    );
    assert.equal(
      Object.hasOwn(snapshot.overview.quota.windows[0], "planType"),
      true,
    );
    assert.equal(snapshot.overview.quota.windows[0].planType, "unknown");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("fresh local usage does not relabel an old Codex quota observation as live", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(join(root, ".usage-monitor", "collector-events.jsonl"), [
      JSON.stringify({
        kind: "codex_quota_snapshot",
        observedAt: "2026-07-25T10:00:00.000Z",
        windows: [{
          limitId: "codex",
          slot: "primary",
          usedPercent: 70,
          windowDurationMins: 10_080,
          resetsAt: 1_785_376_800,
        }],
      }),
      JSON.stringify({
        schemaVersion: "0.3",
        kind: "codex_rollout_usage_snapshot",
        observedAt: "2026-07-25T11:59:00.000Z",
        model: "gpt-5.6-sol",
        components: { input_uncached_tokens: 100 },
      }),
    ].map((line) => `${line}\n`).join(""), { mode: 0o600 });
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.overview.freshness.status, "live");
    assert.equal(snapshot.overview.quotaWindows.length, 1);
    assert.equal(snapshot.overview.quotaWindows[0].status, "stale");
    assert.equal(snapshot.overview.quotaWindows[0].observedAt, "2026-07-25T10:00:00.000Z");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("local companion excludes invalid quota windows before presentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-invalid-quota-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    const validWindow = {
      limitId: "codex",
      slot: "primary",
      planType: "go",
      usedPercent: 20,
      windowDurationMins: 300,
      resetsAt: 1_784_916_000,
    };
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${JSON.stringify({
        kind: "codex_quota_snapshot",
        observedAt: "2026-07-25T11:45:00.000Z",
        windows: [
          validWindow,
          { ...validWindow, resetsAt: 0 },
          { ...validWindow, resetsAt: Number.MAX_SAFE_INTEGER },
          { ...validWindow, resetsAt: "not-a-date" },
          { ...validWindow, windowDurationMins: -1 },
          { ...validWindow, windowDurationMins: 525_601 },
          { ...validWindow, usedPercent: -1 },
          { ...validWindow, usedPercent: 101 },
        ],
      })}\n${JSON.stringify({
        kind: "codex_quota_snapshot",
        observedAt: "not-a-date",
        windows: [validWindow],
      })}\n`,
      { mode: 0o600 },
    );

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });

    assert.deepEqual(
      snapshot.overview.quota.windows.map((window) => [
        window.planType,
        window.usedPercent,
        window.durationMinutes,
        window.resetAt,
      ]),
      [[
        "go",
        20,
        300,
        new Date(1_784_916_000 * 1_000).toISOString(),
      ]],
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a completed bounded tail is projected as useful partial recent coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-partial-tail-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${JSON.stringify({
        kind: "codex_rollout_usage_snapshot",
        observedAt: "2026-07-25T11:00:00.000Z",
        model: "gpt-5.6-sol",
        components: {
          input_uncached_tokens: 10,
          input_cached_tokens: 0,
          cache_write_tokens: 0,
          output_visible_tokens: 1,
          output_reasoning_tokens: 0,
          output_combined_tokens: 1,
          total_tokens: 11,
        },
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, ".usage-monitor", "collector-checkpoint-v0.3.json"),
      JSON.stringify({
        collectionStartedAt: "2026-07-18T12:00:00.000Z",
        files: {},
        diagnostics: {},
        indexing: {
          status: "recent_7d_partial",
          phase: "complete",
          mode: "recent_7d",
          boundedBy: "modified_at_and_collection_start",
          filesDiscovered: 1,
          filesSelected: 1,
          filesProcessed: 1,
          recordsWritten: 1,
          coveredAt: {
            startAt: "2026-07-25T11:00:00.000Z",
            endAt: "2026-07-25T12:00:00.000Z",
          },
        },
      }),
      { mode: 0o600 },
    );
    const snapshot = await buildLocalCompanionSnapshot({ root });
    assert.equal(
      snapshot.overview.collector.indexingState,
      "recent_7d_partial",
    );
    assert.equal(snapshot.overview.collector.indexing.phase, "complete");
    assert.deepEqual(snapshot.overview.collector.indexing.coveredAt, {
      startAt: "2026-07-25T11:00:00.000Z",
      endAt: "2026-07-25T11:00:00.000Z",
    });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("missing and malformed artifacts fail closed while collector evidence remains available", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-missing-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    await writeFile(join(root, ".usage-monitor", "collector-events.jsonl"), "", { mode: 0o600 });
    await writeFile(
      join(root, ".usage-monitor", "collector-checkpoint-v0.3.json"),
      JSON.stringify({
        collectionStartedAt: "2026-07-25T12:00:00.000Z",
        indexing: {
          mode: "recent_7d",
          status: "recent_7d_complete",
          phase: "paused",
          boundedBy: "modified_at_and_collection_start",
          filesDiscovered: 1,
          filesSelected: 2,
          filesProcessed: 3,
          recordsWritten: 4,
          coveredAt: {
            startAt: "not-an-instant",
            endAt: null,
          },
        },
      }),
      { mode: 0o600 },
    );
    await mkdir(join(root, ".usage-monitor", "legacy-reports"), { recursive: true });
    await writeFile(
      join(root, ".usage-monitor", "legacy-reports", ARTIFACT_FILES.gradient),
      "{malformed",
    );
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      allowDevelopmentArtifactFallback: true,
    });
    assert.equal(snapshot.gradient.status, "unavailable");
    assert.equal(snapshot.gradient.errorCode, "artifact_malformed");
    assert.equal(snapshot.weekly.status, "unavailable");
    assert.equal(
      snapshot.weekly.errorCode,
      "allowance_capacity_cache_unavailable",
    );
    assert.equal(Object.hasOwn(snapshot, "reports"), false);
    assert.equal(snapshot.overview.collector.indexingState, "not_started");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("data store retains its last good snapshot when a reload fails", async () => {
  let calls = 0;
  const store = new LocalCompanionDataStore({
    builder: async () => {
      calls += 1;
      if (calls > 1) throw new Error("private internal failure");
      return {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        mode: "real_local_evidence",
        generatedAt: "2026-07-25T12:00:00.000Z",
        overview: { marker: "last-good" },
        gradient: {},
        weekly: {},
        quality: {},
        reports: [],
      };
    },
  });
  await store.initialize();
  await assert.rejects(() => store.reload(), /private internal failure/);
  assert.equal(store.getOverview().marker, "last-good");
});

test("desktop shell display evidence is a cached bounded projection of current normal Codex lanes", async () => {
  const observedAt = "2026-09-05T11:59:00.000Z";
  const store = new LocalCompanionDataStore({
    builder: async () => ({
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      mode: "real_local_evidence",
      generatedAt: "2026-09-05T12:00:00.000Z",
      overview: {
        evidenceStatus: "available",
        freshness: { status: "live", staleAfterSeconds: 1_800 },
        quotaWindows: [
          // Another provider pool cannot become a compact-shell fallback.
          {
            limitId: "codex_bengalfox",
            slot: "primary",
            usedPercent: 1,
            remainingPercent: 99,
            durationMinutes: 10_080,
            observedAt,
            resetAt: "2026-09-05T14:00:00.000Z",
          },
          // The native selection prefers a primary slot when both report the
          // same normal Codex duration, even at exactly 0% remaining.
          {
            limitId: "codex",
            slot: "secondary",
            usedPercent: 25,
            remainingPercent: 75,
            durationMinutes: 10_080,
            observedAt,
            resetAt: "2026-09-05T14:00:00.000Z",
          },
          {
            limitId: "codex",
            slot: "primary",
            usedPercent: 100,
            remainingPercent: 0,
            durationMinutes: 10_080,
            observedAt,
            resetAt: "2026-09-05T14:00:00.000Z",
          },
          {
            limitId: "codex",
            slot: "secondary",
            usedPercent: 58,
            remainingPercent: 42,
            durationMinutes: 300,
            observedAt,
            resetAt: "2026-09-05T12:30:00.000Z",
          },
          // A malformed complement must not make the cache or the shell lie.
          {
            limitId: "codex",
            slot: "primary",
            usedPercent: 25,
            remainingPercent: 76,
            durationMinutes: 300,
            observedAt,
            resetAt: "2026-09-05T12:30:00.000Z",
          },
        ],
        accounting: {
          projection: { status: "retained" },
          privateDiagnostic: "/Users/private/retained-history.json",
        },
        timeline: { usage: [{ private: "not projected" }] },
      },
      gradient: {},
      weekly: {},
      quality: {},
      reports: [],
    }),
  });

  // `reload` would normally return the full cloned overview. Suppress that
  // response, then make any accidental accessor call fail, proving this path
  // serves the cached small projection instead.
  await store.reload({ returnOverview: false });
  store.getOverview = () => {
    throw new Error("full overview clone is forbidden in the shell poll path");
  };
  const evidence = store.getDesktopShellDisplayEvidence();

  assert.deepEqual(evidence, {
    evidenceStatus: "available",
    freshness: { status: "live", staleAfterSeconds: 1_800 },
    windows: [
      {
        durationMinutes: 300,
        slot: "secondary",
        usedPercent: 58,
        remainingPercent: 42,
        observedAt,
        resetAt: "2026-09-05T12:30:00.000Z",
      },
      {
        durationMinutes: 10_080,
        slot: "primary",
        usedPercent: 100,
        remainingPercent: 0,
        observedAt,
        resetAt: "2026-09-05T14:00:00.000Z",
      },
    ],
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.freshness), true);
  assert.equal(Object.isFrozen(evidence.windows), true);
  assert.equal(JSON.stringify(evidence).includes("private"), false);
  assert.equal(JSON.stringify(evidence).includes("bengalfox"), false);
});

test("an aborted candidate cannot publish after its projection completes", async () => {
  let calls = 0;
  let releaseCandidate;
  let candidateStarted;
  const candidateGate = new Promise((resolve) => {
    releaseCandidate = resolve;
  });
  const candidateEntered = new Promise((resolve) => {
    candidateStarted = resolve;
  });
  const snapshot = (marker) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-07-25T12:00:00.000Z",
    overview: { marker },
    gradient: {},
    weekly: {},
    quality: {},
    reports: [],
  });
  const store = new LocalCompanionDataStore({
    builder: async () => {
      calls += 1;
      if (calls === 1) return snapshot("last-good");
      candidateStarted();
      await candidateGate;
      return snapshot("must-not-publish");
    },
  });
  await store.reload();
  const controller = new AbortController();
  const reload = store.reload({
    purpose: "full",
    signal: controller.signal,
  });
  await candidateEntered;
  controller.abort();
  releaseCandidate();
  await assert.rejects(
    reload,
    (error) => error?.code === "local_companion_snapshot_reload_aborted",
  );
  assert.equal(store.getOverview().marker, "last-good");
});

test("a deferred quick reload keeps the projection surfaces it cannot rebuild", async () => {
  // A quick reload is answered with a DEFERRED unified projection, whose
  // gradient/weekly datasets come back as empty arrays rather than absent.
  // Publishing that wholesale blanked both charts on every refresh cycle and
  // refilled them at completion, which reads as data repeatedly vanishing.
  const snapshotFor = (purpose) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-20T21:00:00.000Z",
    overview: { marker: purpose },
    gradient: {
      datasets: ["startup", "quick"].includes(purpose)
        ? { rolling: [], curve: [] }
        : { rolling: [{ at: 1 }, { at: 2 }], curve: [{ at: 1 }] },
    },
    weekly: {
      datasets: ["startup", "quick"].includes(purpose)
        ? { weekly_values: [] }
        : { weekly_values: [{ sequence: 1 }] },
    },
    quality: {},
    reports: [],
  });
  const store = new LocalCompanionDataStore({
    builder: async ({ purpose = "full" } = {}) => snapshotFor(purpose),
  });

  await store.reload({ purpose: "full" });
  assert.equal(store.getGradient().datasets.rolling.length, 2);
  assert.equal(store.getWeekly().datasets.weekly_values.length, 1);

  // The quick pass publishes its fresh overview but must not blank the charts.
  await store.reload({ purpose: "quick" });
  assert.equal(store.getOverview().marker, "quick");
  assert.equal(store.getGradient().datasets.rolling.length, 2);
  assert.equal(store.getGradient().datasets.curve.length, 1);
  assert.equal(store.getWeekly().datasets.weekly_values.length, 1);

  // A FULL reload is still authoritative in both directions: a genuine
  // transition to empty must land, or this would pin stale figures forever.
  const emptying = new LocalCompanionDataStore({
    builder: async ({ purpose = "full" } = {}) => ({
      ...snapshotFor(purpose),
      gradient: { datasets: { rolling: [], curve: [] } },
      weekly: { datasets: { weekly_values: [] } },
    }),
  });
  await emptying.reload({ purpose: "full" });
  assert.equal(emptying.getGradient().datasets.rolling.length, 0);
  assert.equal(emptying.getWeekly().datasets.weekly_values.length, 0);
});

test("weekly pace reads re-project the strict forecast at request time", async () => {
  const nowMs = Date.parse("2026-08-03T12:00:00.000Z");
  const resetsAt = new Date(nowMs + 100 * 60 * 60_000).toISOString();
  const forecast = {
    schemaVersion: "local-weekly-pace-forecast-v0.2",
    status: "will_reach_reset_first",
    currentUsedPercent: 50,
    remainingPercent: 50,
    resetsAt,
    pace: {
      method: "median_adjacent_quota_slope",
      sampleCount: 2,
      elapsedHours: 2,
      movementPp: 0.4,
      activePercentagePointsPerHour: 0.2,
      overallPercentagePointsPerHour: 0.2,
    },
    observationCount: 3,
    etaAt: null,
    hoursToExhaustion: null,
    hoursToReset: 100,
  };
  let builds = 0;
  const store = new LocalCompanionDataStore({
    builder: async () => {
      builds += 1;
      return {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        mode: "real_local_evidence",
        generatedAt: new Date(nowMs).toISOString(),
        overview: {},
        gradient: {},
        weekly: {
          datasets: {},
          paceForecast: forecast,
          paceOutlook: { marker: "must-not-be-served" },
        },
        quality: {},
        reports: [],
      };
    },
  });
  await store.reload();

  const initial = store.getWeeklyPaceOutlook({ nowMs });
  const oneHourLater = store.getWeeklyPaceOutlook({
    nowMs: nowMs + 60 * 60_000,
  });
  assert.equal(builds, 1);
  assert.equal(initial.status, "available");
  assert.equal(initial.standing, "under");
  assert.equal(initial.projection.hoursToReset, 100);
  assert.equal(oneHourLater.projection.hoursToReset, 99);
  assert.ok(oneHourLater.projection.sparePercent > initial.projection.sparePercent);
  assert.deepEqual(
    store.getWeekly({ nowMs: nowMs + 60 * 60_000 }).paceOutlook,
    oneHourLater,
  );
  assert.doesNotMatch(JSON.stringify(oneHourLater), /marker|account|path/iu);
});

test("unified companion and window readers preserve output-only context evidence end to end", async () => {
  const root = await fixtureRoot();
  const start = "2026-09-29T12:00:00.000Z";
  try {
    const stateDirectory = join(root, ".usage-monitor");
    const indexFile = join(stateDirectory, "output-only-index.sqlite");
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    const samples = [
      { output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 20 },
      rolloutUsage(0, 20),
      { input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 20 },
      { input_tokens: 272_001, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 272_021 },
    ];
    await writeFile(join(sessions, "rollout-2026-09-29T12-00-00-output-only.jsonl"), `${[
      { timestamp: start, type: "session_meta", payload: { id: "synthetic-output-only-session", thread_source: "user" } },
      { timestamp: start, type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high" } },
      ...samples.map((usage, index) => ({
        timestamp: new Date(Date.parse(start) + index * 60_000).toISOString(),
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: null } },
      })),
    ].map(JSON.stringify).join("\n")}\n`);
    const built = await refreshLocalIndex({
      codexHome: root, indexFile,
      secretFile: join(stateDirectory, "output-only-device-salt"),
      workerCount: 1,
    });
    assert.equal(built.usageEvents, samples.length);
    const database = openLocalIndexStore(indexFile, { readOnly: true });
    try {
      const rows = database.prepare(`
        SELECT total_input_context AS context, tokens_in_uncached AS input
        FROM usage_event ORDER BY observed_at_ms
      `).all();
      assert.deepEqual(rows.map((row) => row.context), [null, 0, 0, 272_001]);
      assert.deepEqual(rows.map((row) => row.input), [null, 0, null, null]);
    } finally {
      database.close();
    }
    const companion = await readLocalIndexCompanionProjection({
      indexFile, nowMs: Date.parse("2026-09-29T13:00:00.000Z"),
    });
    assert.equal(companion.status, "available");
    const total = companion.usage.find((period) => period.id === "all");
    assert.equal(total.events, 4);
    assert.equal(total.totalTokens, 80);
    assert.equal(total.apiPriceEquivalentUsdExact, "0.0007");
    assert.deepEqual(total.pricingCoverage, {
      fullyPricedEvents: 1, partiallyPricedEvents: 2, unpricedEvents: 1,
    });
    const window = await readLocalIndexWindowBreakdown({
      indexFile, fromMs: Date.parse(start), toMs: Date.parse(start) + 5 * 60_000,
    });
    assert.equal(window.status, "available");
    assert.equal(window.events, 4);
    assert.equal(window.tokens, 80);
    assert.equal(window.costUsd, 0.0007);
    assert.equal(window.unpricedEvents, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("closed v2 real-data projection exposes no session, account, path or filename identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-data-v2-closure-"));
  try {
    const stateDirectory = join(root, ".usage-monitor");
    const codexHome = join(root, "codex-home");
    const sessions = join(codexHome, "sessions");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(sessions, { recursive: true });
    const indexFile = join(stateDirectory, "local-unified-index-v1.sqlite");
    // Synthetic identifier-shaped and path-shaped values. None may reach the
    // serialized projection: they live only in the owner-only local index.
    const privateValues = [
      "/Users/private-owner/clients/confidential-merger",
      "synthetic-private-session-7f3a9c",
      "acct-private-0042",
      "private-rollout-name-0042",
    ];
    const cwd = privateValues[0];
    const start = "2026-09-29T12:00:00.000Z";
    await writeFile(
      join(sessions, `rollout-2026-09-29T12-00-00-${privateValues[3]}.jsonl`),
      `${[
        {
          timestamp: start,
          type: "session_meta",
          payload: {
            id: privateValues[1],
            cwd,
            account_id: privateValues[2],
            thread_source: "user",
          },
        },
        {
          timestamp: start,
          type: "turn_context",
          payload: { model: "gpt-6.1-sol", effort: "high", cwd },
        },
        ...[rolloutUsage(100, 20), rolloutUsage(50, 10)].map((usage, index) => ({
          timestamp: new Date(Date.parse(start) + (index + 1) * 60_000).toISOString(),
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: usage, total_token_usage: null },
          },
        })),
      ].map(JSON.stringify).join("\n")}\n`,
    );
    const built = await refreshLocalIndex({
      codexHome,
      indexFile,
      secretFile: join(stateDirectory, "local-unified-index-device-salt-v1"),
      workerCount: 1,
    });
    assert.equal(built.usageEvents, 2);
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      unifiedIndexFile: indexFile,
      now: () => Date.parse("2026-09-29T13:00:00.000Z"),
    });
    const serialized = JSON.stringify(snapshot);
    // Positive control: the projection really read this workspace, so the
    // absence checks below are not vacuous.
    assert.ok(serialized.includes("gpt-6.1-sol"));
    for (const value of privateValues) {
      assert.equal(serialized.includes(value), false, "projection must not expose private identifiers or paths");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deferred unified projection publishes a loading history receipt", async () => {
  const root = await fixtureRoot();
  try {
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      unifiedProjectionMode: "deferred",
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.deepEqual(snapshot.overview.timeline.history, {
      status: "loading",
      reason: "unified_index_deferred",
      source: "insufficient_evidence",
      coveredAt: {
        startAt: null,
        endAt: null,
      },
    });
    assert.ok(snapshot.overview.warnings.some((warning) => (
      warning.includes("Full indexed history is loading")
    )));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("snapshot construction delegates the selected unified projection mode", async () => {
  const root = await fixtureRoot();
  const calls = [];
  const controller = new AbortController();
  try {
    await buildLocalCompanionSnapshot({
      root,
      unifiedProjectionMode: "deferred",
      unifiedProjectionReader: async (options, controls) => {
        calls.push({ options, controls });
        return readLocalIndexProjection(options);
      },
      signal: controller.signal,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.mode, "deferred");
    assert.equal(
      calls[0].options.nowMs,
      Date.parse("2026-07-25T12:00:00.000Z"),
    );
    assert.equal(calls[0].controls.signal, controller.signal);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("only coherent terminal history gaps at or below one percent are informational", () => {
  const coverage = {
    status: "partial",
    phase: "partial_terminal",
    sourceCount: 100,
    indexedSourceCount: 99,
    pendingSourceCount: 0,
    skippedSourceCount: 1,
  };
  assert.equal(INFORMATIONAL_HISTORY_GAP_MAX_SHARE, 0.01);
  assert.equal(isInformationalTerminalHistoryGap(coverage), true);
  assert.equal(isInformationalTerminalHistoryGap({
    ...coverage,
    indexedSourceCount: 98,
    skippedSourceCount: 2,
  }), false);
  assert.equal(isInformationalTerminalHistoryGap({
    ...coverage,
    indexedSourceCount: 0,
    skippedSourceCount: 100,
  }), false);
  assert.equal(isInformationalTerminalHistoryGap({
    ...coverage,
    pendingSourceCount: 1,
  }), false);
  assert.equal(isInformationalTerminalHistoryGap({
    ...coverage,
    indexedSourceCount: 98,
  }), false);
});

test("unified mode with no valid generation withholds the provisional collector projection", async () => {
  const root = await fixtureRoot();
  try {
    const usage = JSON.stringify({
      schemaVersion: "0.3",
      kind: "codex_rollout_usage_snapshot",
      observedAt: "2026-07-25T11:00:00.000Z",
      model: "gpt-5.6-sol",
      components: { input_uncached_tokens: 100 },
    });
    const tool = JSON.stringify({
      kind: "codex_tool_class_event",
      observedAt: "2026-07-25T11:01:00.000Z",
      toolClass: "subagent",
    });
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${usage}\n${tool}\n`,
      { mode: 0o600 },
    );
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      accountingSourceMode: "unified",
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.overview.timeline.source, "insufficient_evidence");
    assert.deepEqual(snapshot.overview.timeline.usage, []);
    assert.equal(
      snapshot.overview.accounting.accountingSource,
      "insufficient_evidence",
    );
    assert.equal(snapshot.overview.pricing.totalCostUsd, 0);
    assert.equal(snapshot.overview.pricing.eventCount, 0);
    assert.equal(snapshot.overview.tools.status, "unavailable");
    assert.equal(snapshot.overview.tools.total, null);
    assert.equal(snapshot.overview.activity.toolEvents, null);
    assert.deepEqual(snapshot.overview.collector.exportableCoveredAt, {
      startAt: null,
      endAt: null,
    });
    assert.ok(snapshot.overview.warnings.some((warning) => (
      warning.includes("Usage totals and timelines remain unavailable")
    )));
    assert.ok(!snapshot.overview.warnings.some((warning) => (
      warning.includes("live collector projection")
    )));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a deferred quick reload keeps the usage figures and both usage timelines", () => {
  // 0.1.14 protected gradient/weekly and left these three live, because they
  // sit inside `overview` rather than at the top level. Reported against the
  // shipped 0.1.14 build as usage still appearing and disappearing while the
  // charts held still.
  //
  // The usage PERIODS matter most here: a deferred build does not empty them,
  // it replaces them with four fully-formed zeroed placeholders, so any check
  // based on array length reads them as present and lets zeroes overwrite real
  // totals.
  const period = (events) => ({ id: "7d", label: "Last 7 days", events });
  const snapshotFor = (purpose) => {
    const deferred = ["startup", "quick"].includes(purpose);
    return {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      mode: "real_local_evidence",
      generatedAt: "2026-08-20T21:00:00.000Z",
      overview: {
        marker: purpose,
        quota: { windows: [{ remainingPercent: purpose === "quick" ? 41 : 77 }] },
        usage: deferred ? [period(0)] : [period(12)],
        timeline: {
          usage: deferred ? [] : [{ at: 1 }, { at: 2 }],
          sparkUsage: deferred ? [] : [{ at: 1 }],
          calibrationUsage: deferred ? [] : [{ at: 1 }],
          quota: [{ at: 9 }],
        },
      },
      gradient: { datasets: deferred ? { rolling: [] } : { rolling: [{ at: 1 }] } },
      weekly: { datasets: deferred ? { weekly_values: [] } : { weekly_values: [{ sequence: 1 }] } },
      quality: {},
      reports: [],
    };
  };
  const store = new LocalCompanionDataStore({
    builder: async ({ purpose = "full" } = {}) => snapshotFor(purpose),
  });

  return (async () => {
    await store.reload({ purpose: "full" });
    await store.reload({ purpose: "quick" });
    const overview = store.getOverview();

    // Retained: the surfaces a deferred build could not rebuild.
    assert.equal(overview.usage[0].events, 12, "usage totals must not drop to zero");
    assert.equal(overview.timeline.usage.length, 2);
    assert.equal(overview.timeline.sparkUsage.length, 1);
    assert.equal(overview.timeline.calibrationUsage.length, 1);
    assert.equal(store.getGradient().datasets.rolling.length, 1);
    assert.equal(store.getWeekly().datasets.weekly_values.length, 1);

    // Still fresh: the fast-moving figures the quick pass exists to deliver.
    assert.equal(overview.marker, "quick");
    assert.equal(overview.quota.windows[0].remainingPercent, 41);

    // A surface the build omits entirely stays omitted rather than being
    // conjured back: absence is a configuration choice, not emptiness.
    const withoutCalibration = new LocalCompanionDataStore({
      builder: async ({ purpose = "full" } = {}) => {
        const next = snapshotFor(purpose);
        if (["startup", "quick"].includes(purpose)) delete next.overview.timeline.calibrationUsage;
        return next;
      },
    });
    await withoutCalibration.reload({ purpose: "full" });
    await withoutCalibration.reload({ purpose: "quick" });
    assert.equal(
      Object.hasOwn(withoutCalibration.getOverview().timeline, "calibrationUsage"),
      false,
    );

    // A FULL reload stays authoritative in both directions, so a genuine
    // transition to empty still lands and this can never pin stale figures.
    const emptying = new LocalCompanionDataStore({
      builder: async () => {
        const next = snapshotFor("full");
        next.overview.usage = [period(0)];
        next.overview.timeline.usage = [];
        return next;
      },
    });
    await emptying.reload({ purpose: "full" });
    await emptying.reload({ purpose: "full" });
    assert.equal(emptying.getOverview().usage[0].events, 0);
    assert.equal(emptying.getOverview().timeline.usage.length, 0);
  })();
});

test("usage timeline retention keeps its matching metadata without retaining current quota lanes", async (t) => {
  const metadataKeys = [
    "source", "coveredAt", "bucketMinutes", "history", "allowanceWeightingEncoding",
  ];
  const snapshot = ({ generation, matched, populated }) => {
    const generatedAt = generation === 1
      ? "2026-08-28T12:00:00.000Z"
      : "2026-08-28T12:15:00.000Z";
    const coveredAt = populated
      ? { startAt: "2026-08-28T00:00:00.000Z", endAt: generatedAt }
      : { startAt: null, endAt: null };
    return {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      mode: "real_local_evidence",
      generatedAt,
      overview: {
        quota: { observedAt: generatedAt, windows: [{ remainingPercent: 90 - generation }] },
        accounting: {
          sourceMode: "unified",
          generation,
          generationMatched: matched,
          generationFingerprint: `synthetic-generation-${generation}`,
          accountingCacheStatus: matched ? "available" : "unavailable",
          generatedAt,
          coveredAt,
          events: populated ? generation : 0,
          projection: {
            status: matched ? "current" : "loading",
            reason: matched ? null : "unified_index_deferred",
            terminal: matched,
          },
        },
        usage: [{ id: "7d", events: populated ? generation : 0 }],
        timeline: {
          source: populated ? "unified_local_index" : "insufficient_evidence",
          coveredAt,
          bucketMinutes: generation === 1 ? 15 : 30,
          history: { status: populated ? "complete" : "loading", coveredAt, generatedAt },
          allowanceWeightingEncoding: {
            schemaVersion: "quota-weighted-timeline-v0.1",
            scenarioOrder: generation === 1
              ? ["unresolved_as_standard", "unresolved_as_fast"]
              : ["unresolved_as_fast", "unresolved_as_standard"],
            selectedScenario: "unresolved_as_standard",
          },
          usage: populated ? [{ at: generatedAt, totalTokens: generation * 100 }] : [],
          quota: [{ at: generatedAt, usedPercent: generation }],
          sparkQuota: [{ at: generatedAt, usedPercent: generation * 2 }],
          sparkUsage: [{ at: generatedAt, totalTokens: generation * 10 }],
          calibrationUsage: [{ at: generatedAt, totalTokens: generation * 20 }],
          allowanceCapacity: { status: "available", marker: generation },
          marker: generation,
        },
      },
      gradient: { datasets: {} },
      weekly: { datasets: {} },
      quality: {},
    };
  };
  const storeWith = (snapshots) => {
    let call = 0;
    return new LocalCompanionDataStore({
      builder: async () => snapshots[Math.min(call++, snapshots.length - 1)],
    });
  };

  for (const purpose of ["startup", "quick", "full"]) {
    await t.test(`${purpose} retains usage and metadata as one projection`, async () => {
      const previous = snapshot({ generation: 1, matched: true, populated: true });
      const incoming = snapshot({ generation: 2, matched: false, populated: false });
      const unmodified = structuredClone([previous, incoming]);
      const store = storeWith([previous, incoming]);
      await store.reload({ purpose: "full" });
      await store.reload({ purpose });
      const held = store.getOverview();
      const expectedTimeline = { ...incoming.overview.timeline, usage: previous.overview.timeline.usage };
      for (const key of metadataKeys) expectedTimeline[key] = previous.overview.timeline[key];
      assert.deepEqual(held.timeline, expectedTimeline,
        "retained usage needs its old metadata; quota, Spark, and other incoming lanes stay fresh");
      assert.deepEqual(held.quota, incoming.overview.quota);
      assert.equal(held.generatedAt, incoming.generatedAt);
      assert.equal(held.accounting.generation, 2);
      assert.equal(held.accounting.generationMatched, false);
      assert.equal(held.accounting.generationFingerprint, "synthetic-generation-2");
      assert.equal(held.accounting.accountingCacheStatus, "unavailable");
      assert.deepEqual(held.accounting.projection, {
        ...incoming.overview.accounting.projection,
        status: "retained",
        retainedAt: previous.generatedAt,
        coveredAt: previous.overview.accounting.coveredAt,
      });
      assert.deepEqual([previous, incoming], unmodified, "retention must not mutate builder snapshots");
    });
  }

  await t.test("missing old metadata is not borrowed from the incoming projection", async () => {
    const previous = snapshot({ generation: 1, matched: true, populated: true });
    for (const key of metadataKeys) delete previous.overview.timeline[key];
    const incoming = snapshot({ generation: 2, matched: false, populated: false });
    const store = storeWith([previous, incoming]);
    await store.reload({ purpose: "full" });
    await store.reload({ purpose: "quick" });
    const held = store.getOverview();
    assert.deepEqual(held.timeline.usage, previous.overview.timeline.usage);
    for (const key of metadataKeys) {
      assert.equal(Object.hasOwn(held.timeline, key), false, `${key} cannot be invented for old rows`);
    }
    assert.deepEqual(held.timeline.quota, incoming.overview.timeline.quota);
  });

  await t.test("malformed old coverage stays unavailable rather than being repaired from accounting dates", async () => {
    const previous = snapshot({ generation: 1, matched: true, populated: true });
    const malformedMetadata = {
      source: null,
      coveredAt: { startAt: "not-a-date", endAt: null },
      bucketMinutes: -1,
      history: null,
      allowanceWeightingEncoding: null,
    };
    Object.assign(previous.overview.timeline, malformedMetadata);
    const incoming = snapshot({ generation: 2, matched: false, populated: false });
    const store = storeWith([previous, incoming]);
    await store.reload({ purpose: "full" });
    await store.reload({ purpose: "full" });
    const held = store.getOverview();
    assert.deepEqual(held.timeline.usage, previous.overview.timeline.usage);
    for (const key of metadataKeys) assert.deepEqual(held.timeline[key], malformedMetadata[key]);
    assert.deepEqual(held.accounting.projection.coveredAt, previous.overview.accounting.coveredAt);
    assert.notDeepEqual(held.timeline.coveredAt, held.accounting.projection.coveredAt);
  });

  for (const [name, matched, populated] of [
    ["authoritative empty", true, false],
    ["authoritative populated", true, true],
    ["non-authoritative populated", false, true],
  ]) {
    await t.test(`${name} replaces both usage and its metadata`, async () => {
      const previous = snapshot({ generation: 1, matched: true, populated: true });
      const incoming = snapshot({ generation: 2, matched, populated });
      const store = storeWith([previous, incoming]);
      await store.reload({ purpose: "full" });
      await store.reload({ purpose: "full" });
      assert.deepEqual(store.getOverview().timeline, incoming.overview.timeline);
      assert.deepEqual(store.getOverview().accounting, incoming.overview.accounting);
    });
  }

  await t.test("an omitted usage surface does not trigger metadata retention", async () => {
    const previous = snapshot({ generation: 1, matched: true, populated: true });
    const incoming = snapshot({ generation: 2, matched: false, populated: false });
    delete incoming.overview.timeline.usage;
    const store = storeWith([previous, incoming]);
    await store.reload({ purpose: "full" });
    await store.reload({ purpose: "quick" });
    assert.deepEqual(store.getOverview().timeline, incoming.overview.timeline);
  });

  await t.test("a first refresh without previous usage cannot manufacture timeline metadata", async () => {
    const previous = snapshot({ generation: 1, matched: true, populated: false });
    const incoming = snapshot({ generation: 2, matched: false, populated: false });
    const store = storeWith([previous, incoming]);
    await store.reload({ purpose: "startup" });
    assert.deepEqual(store.getOverview().timeline, previous.overview.timeline);
    await store.reload({ purpose: "quick" });
    assert.deepEqual(store.getOverview().timeline, incoming.overview.timeline);
  });
});

test("a non-authoritative FULL build keeps the evidence it could not rebuild", async () => {
  // Reproduced 2026-08-21 against the owner's real index (repro-blank.mjs):
  // a full-mode snapshot built while the generation row is not ready — the
  // exact row shape an in-flight ingest produces — publishes an empty-array
  // timeline and zeroed usage placeholders even though the complete history is
  // readable in the same file. Full reloads bypassed retention by design, so
  // one full reload racing an ingest blanked the dashboard AND PINNED the
  // blank until the next authoritative reload. Intermittent, persisting across
  // refreshes: the exact behavior reported against 0.1.13 through 0.1.15.
  //
  // Authority is the snapshot's own accounting block: generationMatched can
  // only be true once the generation passed the readiness gate and the cache
  // was rebuilt against exactly that generation.
  const period = (events) => ({ id: "7d", label: "Last 7 days", events });
  const snapshot = ({ matched, empty, sourceMode = "unified" }) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-21T14:30:00.000Z",
    overview: {
      marker: matched ? "authoritative" : "not-ready",
      accounting: { sourceMode, generationMatched: matched },
      usage: empty ? [period(0)] : [period(12)],
      timeline: { usage: empty ? [] : [{ at: 1 }, { at: 2 }] },
    },
    gradient: { datasets: empty ? { rolling: [] } : { rolling: [{ at: 1 }] } },
    weekly: { datasets: empty ? { weekly_values: [] } : { weekly_values: [{ sequence: 1 }] } },
    quality: {},
    reports: [],
  });
  const storeWith = (sequence) => {
    let call = 0;
    return new LocalCompanionDataStore({
      builder: async () => snapshot(sequence[Math.min(call++, sequence.length - 1)]),
    });
  };

  // M2/M3: a not-ready full build must not blank a populated dashboard.
  const notReady = storeWith([
    { matched: true, empty: false },
    { matched: false, empty: true },
  ]);
  await notReady.reload({ purpose: "full" });
  await notReady.reload({ purpose: "full" });
  assert.equal(notReady.getOverview().timeline.usage.length, 2,
    "a not-ready full build must not blank the timeline");
  assert.equal(notReady.getOverview().usage[0].events, 12);
  // The build's own status fields still publish — staleness stays labeled.
  assert.equal(notReady.getOverview().marker, "not-ready");

  // Authoritative empty: a ready, matched build with genuinely no data lands.
  const wiped = storeWith([
    { matched: true, empty: false },
    { matched: true, empty: true },
  ]);
  await wiped.reload({ purpose: "full" });
  await wiped.reload({ purpose: "full" });
  assert.equal(wiped.getOverview().timeline.usage.length, 0,
    "an authoritative empty build must land");

  // M1: fresh evidence always wins — a mismatched build that still carries
  // its buckets replaces, never resurrects older data over newer.
  const mismatchOnly = storeWith([
    { matched: true, empty: false },
    { matched: false, empty: false },
  ]);
  await mismatchOnly.reload({ purpose: "full" });
  await mismatchOnly.reload({ purpose: "full" });
  assert.equal(mismatchOnly.getOverview().marker, "not-ready");
  assert.equal(mismatchOnly.getOverview().timeline.usage.length, 2);

  // Legacy rollback mode never had this gate and keeps full-replace semantics.
  const legacy = storeWith([
    { matched: true, empty: false, sourceMode: "legacy" },
    { matched: false, empty: true, sourceMode: "legacy" },
  ]);
  await legacy.reload({ purpose: "full" });
  await legacy.reload({ purpose: "full" });
  assert.equal(legacy.getOverview().timeline.usage.length, 0,
    "legacy full reloads replace unconditionally");
});

test("a non-authoritative build keeps the allowance capacity the chart selects by", async () => {
  // Captured live 2026-08-21 during a user-visible blank: buckets, weighting
  // arrays, and quota rows all present and retained, while
  // timeline.allowanceCapacity published as {status:"unavailable", reason:
  // "allowance_capacity_cache_unavailable"}. The dashboard's capacity selector
  // returns null on anything but "available", which excludes every window as
  // "speed-adjusted allowance weighting unavailable" in one stroke — 0 of
  // 1,482 matched. A row count cannot see a status object, which is how this
  // field survived two rounds of retention fixes around it.
  const capacityOf = (status) => ({
    status,
    ...(status === "available"
      ? { selectedScenario: "unresolved_as_standard", scenarios: {} }
      : { reason: "allowance_capacity_cache_unavailable", selectedScenario: null }),
  });
  const snapshot = ({ matched, capacity }) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-21T15:30:00.000Z",
    overview: {
      accounting: { sourceMode: "unified", generationMatched: matched },
      usage: [{ id: "7d", label: "Last 7 days", events: 12 }],
      timeline: {
        usage: [{ at: 1 }],
        allowanceCapacity: capacityOf(capacity),
      },
    },
    gradient: { datasets: { rolling: [{ at: 1 }] } },
    weekly: { datasets: { weekly_values: [{ sequence: 1 }] } },
    quality: {},
    reports: [],
  });
  const storeWith = (sequence) => {
    let call = 0;
    return new LocalCompanionDataStore({
      builder: async () => snapshot(sequence[Math.min(call++, sequence.length - 1)]),
    });
  };

  // The captured incident: a non-authoritative full publish degrades capacity
  // while everything else survives. The chart must keep selecting.
  const degraded = storeWith([
    { matched: true, capacity: "available" },
    { matched: false, capacity: "unavailable" },
  ]);
  await degraded.reload({ purpose: "full" });
  await degraded.reload({ purpose: "full" });
  assert.equal(
    degraded.getOverview().timeline.allowanceCapacity.status,
    "available",
    "a non-authoritative publish must not strip the capacity the chart keys on",
  );

  // The same protection on the quick pass, which publishes mid-refresh.
  const quick = storeWith([
    { matched: true, capacity: "available" },
    { matched: false, capacity: "unavailable" },
  ]);
  await quick.reload({ purpose: "full" });
  await quick.reload({ purpose: "quick" });
  assert.equal(quick.getOverview().timeline.allowanceCapacity.status, "available");

  // An AUTHORITATIVE build that genuinely cannot produce capacity lands: a
  // matched cache with an insufficient fit is a true state, not a transient.
  const genuine = storeWith([
    { matched: true, capacity: "available" },
    { matched: true, capacity: "unavailable" },
  ]);
  await genuine.reload({ purpose: "full" });
  await genuine.reload({ purpose: "full" });
  assert.equal(genuine.getOverview().timeline.allowanceCapacity.status, "unavailable");
});

test("a mismatch window keeps the cost figures while the truth fields stay current", async () => {
  // The Usage-and-costs page renders overview.accounting directly. Confirmed
  // live on dogfood 1021 (2026-08-21): during each mismatch window the page
  // zeroed — $0.00, 0 tokens, "No model usage in this period" — then refilled
  // at $4,982.79 / 12.6B tokens the moment authority returned. The accounting
  // node was the last unretained surface of the class.
  //
  // It cannot use the generic swap: the same object carries generationMatched
  // and the cache status. Retaining those would republish yesterday's
  // "matched: true" over a live mismatch — the app lying about its own state.
  const accountingFor = ({ matched, zeroed }) => ({
    sourceMode: "unified",
    generationMatched: matched,
    accountingCacheStatus: matched ? "available" : "unavailable",
    generationFingerprint: matched ? "generation-v2-current" : "generation-v2-next",
    events: zeroed ? 0 : 95636,
    totalTokens: zeroed ? 0 : 12596645828,
    apiPriceEquivalentUsd: zeroed ? 0 : 4982.785667,
    byModel: zeroed ? [] : [{ model: "gpt-5.4", events: 90000 }],
    periods: zeroed
      ? [{ periodId: "7d", events: 0 }]
      : [{ periodId: "7d", events: 95636 }],
  });
  const snapshot = (shape) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-21T15:50:00.000Z",
    overview: {
      accounting: accountingFor(shape),
      usage: [{ id: "7d", label: "Last 7 days", events: shape.zeroed ? 0 : 12 }],
      timeline: { usage: [{ at: 1 }] },
    },
    gradient: { datasets: { rolling: [{ at: 1 }] } },
    weekly: { datasets: { weekly_values: [{ sequence: 1 }] } },
    quality: {},
    reports: [],
  });
  const storeWith = (sequence) => {
    let call = 0;
    return new LocalCompanionDataStore({
      builder: async () => snapshot(sequence[Math.min(call++, sequence.length - 1)]),
    });
  };

  // The captured incident: figures retained, truth fields current.
  const window = storeWith([
    { matched: true, zeroed: false },
    { matched: false, zeroed: true },
  ]);
  await window.reload({ purpose: "full" });
  await window.reload({ purpose: "full" });
  const held = window.getOverview().accounting;
  assert.equal(held.events, 95636, "cost figures must survive the mismatch window");
  assert.equal(held.apiPriceEquivalentUsd, 4982.785667);
  assert.equal(held.byModel.length, 1);
  // The truth fields must NOT be retained: the window is real and stays
  // visible, which is what keeps the staleness labeled.
  assert.equal(held.generationMatched, false);
  assert.equal(held.accountingCacheStatus, "unavailable");
  assert.equal(held.generationFingerprint, "generation-v2-next");

  // An authoritative zero is a true state and lands.
  const wiped = storeWith([
    { matched: true, zeroed: false },
    { matched: true, zeroed: true },
  ]);
  await wiped.reload({ purpose: "full" });
  await wiped.reload({ purpose: "full" });
  assert.equal(wiped.getOverview().accounting.events, 0,
    "an authoritative empty accounting must land");
});

test("a build serving retained evidence does not claim its figures are loading", async () => {
  // Captured live 2026-08-21 on the owner's machine: every ~5-minute refresh
  // pass republishes a quick-milestone snapshot for the first ~2 minutes.
  // Retention keeps the page's figures complete and current through that
  // window, but the build's own warnings — "Full indexed history is loading",
  // "History indexing is still advancing. Complete historical totals stay
  // hidden" — were served verbatim alongside them. On the Usage-and-costs
  // page the banners therefore showed on a ~40% duty cycle forever, always
  // claiming figures were hidden that were plainly on screen.
  const UNRELATED_WARNING =
    "Usage accounting is complete, but typed tool history is partial. Tool totals are withheld rather than reported as zero.";
  const snapshot = ({ matched, empty, warnings }) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-21T20:32:51.918Z",
    overview: {
      accounting: {
        sourceMode: "unified",
        generationMatched: matched,
        events: empty ? 0 : 95636,
        byModel: empty ? [] : [{ model: "gpt-5.4", events: 90000 }],
        periods: empty
          ? [{ periodId: "7d", events: 0 }]
          : [{ periodId: "7d", events: 95636 }],
      },
      usage: [{ id: "7d", label: "Last 7 days", events: empty ? 0 : 12 }],
      timeline: { usage: empty ? [] : [{ at: 1 }] },
      warnings,
    },
    gradient: { datasets: { rolling: empty ? [] : [{ at: 1 }] } },
    weekly: { datasets: { weekly_values: empty ? [] : [{ sequence: 1 }] } },
    quality: {},
    reports: [],
  });
  const storeWith = (sequence) => {
    let call = 0;
    return new LocalCompanionDataStore({
      builder: async () => snapshot(sequence[Math.min(call++, sequence.length - 1)]),
    });
  };
  const [deferredLoading, withheldPartial, , , historyHidden] =
    RETAINED_EVIDENCE_RELABELED_WARNINGS;

  // The captured cycle: an authoritative full, then the quick milestone. Both
  // loading sentences are dropped and unrelated warnings kept in place. No
  // sentence replaces them: the projection's retained status labels the
  // figures, and background work is the refresh state's to report (owner-
  // reported 2026-10-14: a "still recalculating" replacement stood for an
  // hour while no recalculation was running).
  const quick = storeWith([
    { matched: true, empty: false, warnings: [] },
    {
      matched: false,
      empty: true,
      warnings: [deferredLoading, UNRELATED_WARNING, historyHidden],
    },
  ]);
  await quick.reload({ purpose: "full" });
  await quick.reload({ purpose: "quick" });
  assert.deepEqual(quick.getOverview().warnings, [UNRELATED_WARNING],
    "loading claims must not outlive the evidence they describe");

  // The mismatch-window full build (M3) gets the same treatment: its withheld
  // sentence is false of the retained figures the page keeps showing.
  const mismatch = storeWith([
    { matched: true, empty: false, warnings: [] },
    { matched: false, empty: true, warnings: [withheldPartial] },
  ]);
  await mismatch.reload({ purpose: "full" });
  await mismatch.reload({ purpose: "full" });
  assert.deepEqual(mismatch.getOverview().warnings, []);

  // A true cold start retains nothing, so "loading" is exactly right and the
  // build's own sentences stand untouched.
  const cold = storeWith([
    {
      matched: false,
      empty: true,
      warnings: [deferredLoading, historyHidden],
    },
  ]);
  await cold.reload({ purpose: "startup" });
  assert.deepEqual(cold.getOverview().warnings, [deferredLoading, historyHidden],
    "a cold start genuinely is loading and must say so");

  // A deferred build with no false sentence gains nothing: retention drops
  // false claims, it never adds a standing banner to a pass.
  const quiet = storeWith([
    { matched: true, empty: false, warnings: [] },
    { matched: false, empty: true, warnings: [UNRELATED_WARNING] },
  ]);
  await quiet.reload({ purpose: "full" });
  await quiet.reload({ purpose: "quick" });
  assert.deepEqual(quiet.getOverview().warnings, [UNRELATED_WARNING]);

  // An authoritative build keeps its own words even when they include these
  // sentences: nothing was retained over it, so nothing is relabeled.
  const authoritative = storeWith([
    { matched: true, empty: false, warnings: [] },
    { matched: true, empty: true, warnings: [historyHidden] },
  ]);
  await authoritative.reload({ purpose: "full" });
  await authoritative.reload({ purpose: "full" });
  assert.deepEqual(authoritative.getOverview().warnings, [historyHidden],
    "an authoritative build's own sentences are its own to make");
});

test("every surface a withheld projection empties is registered for retention", async () => {
  // The completeness gate for this defect class. `unifiedAccountingWithheld`
  // is the single condition under which the builder substitutes evidence-free
  // values, so enumerating its substitution sites enumerates the class.
  //
  // Two of the eight sites yield real data surfaces as bare empty arrays and
  // one yields the zeroed placeholder periods; the remaining five yield
  // metadata rather than rows. Usage coverage/source metadata is retained with
  // the exact usage rows it describes; accounting truth fields remain current.
  // If a new evidence-bearing substitution appears,
  // this fails until it is registered in PROJECTION_SURFACES — which is the
  // point, because reviewing the retention list is not something anyone
  // remembers to do when adding a surface.
  const source = await readFile(
    new URL("../src/local-companion-data.js", import.meta.url),
    "utf8",
  );
  const emptyArraySites = source.match(/unifiedAccountingWithheld\s+\?\s+\[\]/gu) ?? [];
  const placeholderPeriodSites =
    source.match(/unifiedAccountingWithheld\s+\?\s+insufficientEvidenceUsagePeriods\(\)/gu) ?? [];

  assert.equal(
    emptyArraySites.length,
    2,
    "new `unifiedAccountingWithheld ? []` surface — register it in PROJECTION_SURFACES",
  );
  assert.equal(
    placeholderPeriodSites.length,
    1,
    "new placeholder-period substitution — register it in PROJECTION_SURFACES",
  );

  assert.deepEqual(RETAINED_PROJECTION_SURFACE_PATHS, [
    // allowanceCapacity: registered 2026-08-21 after a live capture showed a
    // non-authoritative publish stripping it to status "unavailable" and
    // blanking every Trends window at once, while every array surface here
    // survived. It is a status OBJECT, so its evidence counter is
    // availableStatusRows, not a row count.
    "gradient",
    "weekly",
    "overview.usage",
    "overview.timeline.usage",
    "overview.timeline.sparkUsage",
    "overview.timeline.calibrationUsage",
    "overview.timeline.allowanceCapacity",
    "overview.timeline.planScoped",
  ]);
});


test("Trends retains plan-scoped history through refresh only with its matching capacity", async (t) => {
  const scope = {
    methodVersion: "plan-era-v1", planType: "pro", basisFamilyId: "synthetic-basis",
    cohortId: "a".repeat(64), sourceGeneration: 35,
    sourceGenerationFingerprint: "synthetic-generation-35",
  };
  const available = {
    schemaVersion: "local-plan-scoped-accounting-timeline-v1",
    status: "available", reason: null, encoding: "plan_bucket_v1", planScope: scope,
    usage: [[Date.parse("2026-09-07T11:45:00.000Z"), 1,
      1000, 0, 0, 0, 0, 0, 4, 4, 8, 0, 0, 1, 0, 1000]],
    quota: [[Date.parse("2026-09-07T11:45:00.000Z"),
      Date.parse("2026-09-08T00:00:00.000Z") / 1000, 30]],
    comparisonIntervals: [[Date.parse("2026-09-07T11:45:00.000Z"),
      Date.parse("2026-09-07T12:00:00.000Z")]],
  };
  const unavailable = {
    schemaVersion: available.schemaVersion, status: "unavailable",
    reason: "plan_scoped_timeline_unavailable", planScope: null,
    usage: [], quota: [], comparisonIntervals: [],
  };
  const snapshot = (matched, planScoped, capacity = { status: "unavailable" }) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence", generatedAt: "2026-09-07T12:00:00.000Z",
    overview: {
      accounting: { sourceMode: "unified", generationMatched: matched },
      timeline: { usage: [1], planScoped, allowanceCapacity: capacity, quota: ["current quota"] },
    },
    gradient: { datasets: {} }, weekly: { datasets: {} }, quality: {}, reports: [],
  });
  const initial = snapshot(true, available, { status: "available", planScope: scope });
  async function reload(next, purpose = "full") {
    const originals = structuredClone([initial, next]);
    let call = 0;
    const store = new LocalCompanionDataStore({ builder: async () => call++ === 0 ? initial : next });
    await store.reload({ purpose: "full" });
    await store.reload({ purpose });
    assert.deepEqual([initial, next], originals, "builder snapshots remain immutable");
    return store.getOverview();
  }
  for (const purpose of ["full", "quick", "startup"]) {
    await t.test(`${purpose} reuses the scoped history and capacity together`, async () => {
      const result = await reload(snapshot(false, unavailable), purpose);
      assert.deepEqual(result.timeline.planScoped, available);
      assert.deepEqual(result.timeline.allowanceCapacity.planScope, scope);
      assert.deepEqual(result.timeline.quota, ["current quota"]);
      assert.equal(result.accounting.generationMatched, false);
      const { selectAllowancePlanPopulation } = await import("../apps/web/public/data-client.js");
      const selected = selectAllowancePlanPopulation({ ...result, weekly: {
        planAttribution: { methodVersion: "plan-era-v1" }, selectedPlanType: "pro",
        planPopulations: [{ planType: "pro", status: "available" }],
      } });
      assert.equal(selected.allowancePlanSelection.comparisonAvailable, true,
        "the actual Trends selector still accepts the retained comparison");
      assert.deepEqual(selected.timeline.selectedPlanUsage, available.usage);
      assert.deepEqual(selected.timeline.comparisonIntervals, available.comparisonIntervals);
    });
  }
  for (const key of Object.keys(scope)) {
    await t.test(`changed capacity ${key} cannot borrow previous scoped history`, async () => {
      const changed = { ...scope, [key]: key === "sourceGeneration" ? 36 : "different" };
      const result = await reload(snapshot(false, unavailable, { status: "available", planScope: changed }));
      assert.deepEqual(result.timeline.planScoped, unavailable);
      assert.deepEqual(result.timeline.allowanceCapacity.planScope, changed);
    });
  }
  await t.test("authoritative empty and fresh scoped history replace retained data", async () => {
    assert.deepEqual((await reload(snapshot(true, unavailable))).timeline.planScoped, unavailable);
    const fresh = { ...available, usage: [[6, 7]], comparisonIntervals: [[6, 8]] };
    assert.deepEqual((await reload(snapshot(false, fresh))).timeline.planScoped, fresh);
  });
  await t.test("cold start, absent capacity scope and omitted surface do not manufacture history", async () => {
    const incoming = snapshot(false, unavailable);
    const cold = new LocalCompanionDataStore({ builder: async () => incoming });
    await cold.reload({ purpose: "quick" });
    assert.deepEqual(cold.getOverview().timeline.planScoped, unavailable);
    const noScope = await reload(snapshot(false, unavailable, { status: "available" }));
    assert.deepEqual(noScope.timeline.planScoped, unavailable);
    delete incoming.overview.timeline.planScoped;
    assert.equal(Object.hasOwn((await reload(incoming)).timeline, "planScoped"), false);
  });
});
