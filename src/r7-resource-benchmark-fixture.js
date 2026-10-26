import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "./storage.js";

export const R7_FIXTURE_VERSION = "g1-r7-structural-fixture-v0.1";
export const R7_FIXTURE_START_AT = "2026-07-24T11:00:00.000Z";
export const R7_FIXTURE_END_AT = "2026-07-24T13:00:00.000Z";
export const R7_FIXTURE_CREATED_AT = "2026-07-24T13:00:00.000Z";
export const R7_FIXTURE_SECRET = Buffer.alloc(32, 0x72);
const SYNTHETIC_CANARY = "R7_SYNTHETIC_CONTENT_CANARY_NEVER_EXPORT";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function codexUsage(input, cached, output, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function collectorRecord(observedAt, usedPercent) {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt,
    receivedAt: observedAt,
    stalenessMs: 0,
    source: "app_server_read",
    windows: [{
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot: "secondary",
      usedPercent,
      windowDurationMins: 10_080,
      resetsAt: 1_785_430_800,
    }],
    providerSurface: "account_shared_unallocated",
    accountScope: {
      status: "unavailable",
      reason: "missing_secret",
      version: "openai-account-v1",
      scopeId: null,
      planType: "pro",
    },
    officialDailyTokens: [],
    officialUsageSummary: null,
    controlledState: "unknown",
    eventKey: "e".repeat(64),
  };
}

async function artifactEvidence(bytesByCategory) {
  const categories = [];
  for (const [category, byteArrays] of Object.entries(bytesByCategory).sort(([a], [b]) => a.localeCompare(b))) {
    const digest = createHash("sha256");
    digest.update(`app-usagemonitor/r7-fixture/${category}/v1\0`);
    let bytes = 0;
    for (const value of byteArrays) {
      digest.update(String(value.length));
      digest.update("\0");
      digest.update(value);
      bytes += value.length;
    }
    categories.push({ category, files: byteArrays.length, bytes, sha256: digest.digest("hex") });
  }
  const projection = { fixtureVersion: R7_FIXTURE_VERSION, categories };
  return { ...projection, manifestSha256: sha256(stableJson(projection)) };
}

export async function createR7StructuralFixture(root) {
  const codexHome = join(root, "codex-home");
  const collectorPath = join(root, "collector.jsonl");
  await chmod(root, 0o700);
  await mkdir(join(codexHome, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true, mode: 0o700 });

  const first = codexUsage(100, 20, 40, 8);
  const second = codexUsage(150, 30, 60, 11);
  const codexBytes = Buffer.from(`${[
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "r7-synthetic-session", prompt: SYNTHETIC_CANARY },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.001Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: first, last_token_usage: first } },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:04:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: second, last_token_usage: codexUsage(50, 10, 20, 3) } },
    }),
  ].join("\n")}\n`);
  await writeFile(
    join(codexHome, "sessions", "rollout-2026-07-24T12-00-00-r7.jsonl"),
    codexBytes,
    { mode: 0o600 },
  );

  const collectorBytes = Buffer.from(`${[
    collectorRecord("2026-07-24T12:10:00.000Z", 10),
    collectorRecord("2026-07-24T12:11:00.000Z", 11),
  ].map(JSON.stringify).join("\n")}\n`);
  await writeFile(collectorPath, collectorBytes, { mode: 0o600 });

  const evidence = await artifactEvidence({
    codex_collector: [collectorBytes],
    codex_rollout: [codexBytes],
  });
  return {
    paths: { codexHome, collectorPath },
    evidence,
    syntheticCanary: SYNTHETIC_CANARY,
  };
}

export async function inspectR7StructuralFixture(paths) {
  return artifactEvidence({
    codex_collector: [await readFile(paths.collectorPath)],
    codex_rollout: [await readFile(join(
      paths.codexHome,
      "sessions",
      "rollout-2026-07-24T12-00-00-r7.jsonl",
    ))],
  });
}
