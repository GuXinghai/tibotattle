import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const CLI_SOURCE = new URL("../src/cli.js", import.meta.url);

function commandBlock(source, command) {
  const start = source.indexOf(`  if (args.command === "${command}") {`);
  assert.notEqual(start, -1, `missing ${command} command branch`);
  const next = source.indexOf("\n  if (args.command === \"", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("CLI read/write commands preflight every input/output before their first mutation", async () => {
  const source = await readFile(CLI_SOURCE, "utf8");
  const firstMutation = new Map([
    ["transitions", "writeJsonOwnerOnlyAtomic"],
    ["infer", "writeJsonOwnerOnlyAtomic"],
    ["history", "writeJsonOwnerOnlyAtomic"],
    ["crosscheck", "prepareLocalCollectorState"],
    ["quality", "prepareLocalCollectorState"],
    ["calibrate-weekly", "writeJsonOwnerOnlyAtomic"],
    ["experiment", "runExperiment"],
    ["contamination", "writeJsonOwnerOnlyAtomic"],
    ["tools", "writeJsonOwnerOnlyAtomic"],
    ["migrate-corrections", "appendJsonLinesOwnerOnly"],
  ]);

  for (const [command, mutation] of firstMutation) {
    const block = commandBlock(source, command);
    const preflight = block.indexOf("assertInputOutputPathsDistinct");
    const write = block.indexOf(mutation);
    assert.notEqual(preflight, -1, `${command} lacks an input/output preflight`);
    assert.notEqual(write, -1, `${command} mutation boundary was not found`);
    assert.ok(preflight < write, `${command} mutates before input/output preflight`);
  }
});

test("atomic report commands check publisher availability after collisions and before durable mutation", async () => {
  const source = await readFile(CLI_SOURCE, "utf8");
  const commands = [
    "transitions", "infer", "history", "crosscheck", "quality",
    "calibrate-weekly", "contamination", "tools", "migrate-corrections",
  ];
  for (const command of commands) {
    const block = commandBlock(source, command);
    const collision = block.lastIndexOf("assertInputOutputPathsDistinct");
    const publisher = block.indexOf("assertOwnerOnlyAtomicPublisherAvailable");
    assert.notEqual(collision, -1, `${command} lacks an input/output collision guard`);
    assert.notEqual(publisher, -1, `${command} lacks an atomic publisher capability preflight`);
    assert.ok(collision < publisher, `${command} checks publisher capability before collision paths`);
    for (const mutation of [
      "prepareLocalCollectorState",
      "appendJsonLinesOwnerOnly",
      "mineCodexTransitions",
      "scanCodexLogEvents",
      "writeJsonOwnerOnlyAtomic",
    ]) {
      const position = block.indexOf(mutation);
      if (position !== -1) assert.ok(publisher < position, `${command} performs ${mutation} before publisher preflight`);
    }
  }
});

test("calibrate-weekly rejects input/output identity before publishing and preserves input bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhetrion-cli-path-safety-synthetic-"));
  const input = join(root, "transitions.json");
  const report = join(root, "weekly-calibration.md");
  const original = Buffer.from(`${JSON.stringify({
    parserVersion: "0.3.2",
    scope: {
      startAt: "2026-06-01T00:00:00.000Z",
      endAt: "2026-07-24T00:00:00.000Z",
      snapshotIntervalsIncluded: false,
    },
    pricing: { basis: "standard_openai_api_prices_not_codex_subscription_credits" },
    transitions: [],
  }, null, 2)}\n`);
  try {
    await writeFile(input, original);
    await assert.rejects(run([
      "calibrate-weekly",
      "--input", input,
      "--output", input,
      "--report-file", report,
    ]), { code: "CLI_PATH_SAFETY_INPUT_OUTPUT_COLLISION" });
    assert.deepEqual(await readFile(input), original);
    await assert.rejects(readFile(report), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrate-corrections fails publisher preflight before reading or appending its synthetic ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhetrion-cli-publisher-preflight-synthetic-"));
  const observations = join(root, "observations.jsonl");
  const transitions = join(root, "transitions.json");
  const corrections = join(root, "corrections.jsonl");
  const output = join(root, "effective.json");
  const report = join(root, "correction-report.md");
  const lock = `${corrections}.lock`;
  const knownComponents = {
    input_uncached_tokens: 40,
    input_cache_read_tokens: 50,
    input_cache_write_tokens: 0,
    output_text_tokens: 6,
    output_reasoning_tokens: 4,
  };
  const unknownComponents = {
    input_uncached_tokens: 2_685_437,
    input_cache_read_tokens: 68_264_192,
    input_cache_write_tokens: 0,
    output_text_tokens: 65_468,
    output_reasoning_tokens: 45_402,
  };
  const totalComponents = Object.fromEntries(Object.keys(knownComponents).map((key) => [
    key,
    knownComponents[key] + unknownComponents[key],
  ]));
  const observation = {
    schemaVersion: "0.1",
    kind: "codex_quota_observation",
    observationId: "synthetic-baseline",
    capturedAt: "2026-07-23T16:15:40.974Z",
    windows: [{ local: {
      runcost: {
        totalTokens: 71_060_599,
        totalUsd: 1.25,
        components: totalComponents,
        byModel: {
          "gpt-known": { components: knownComponents, events: 3, costUsd: 1.25, warningCounts: {} },
          unknown: { components: unknownComponents, events: 471, costUsd: 0, warningCounts: { unknown_model: 471 } },
        },
        warningCounts: { unknown_model: 471 },
      },
      diagnostics: { partiallyPricedEvents: 471 },
    } }],
  };
  const transitionDataset = {
    schemaVersion: "0.3",
    scope: { startAt: "2026-07-21T17:06:03.000Z", endAt: observation.capturedAt },
    pricing: { estimatorVersion: "runcost-api-price-v0.3", selectedSource: "synthetic" },
    summary: { filesScanned: 0, usageEvents: 0, pricedEvents: 0, partiallyPricedEvents: 0,
      unpricedModels: [], tokenComponentsByModel: { "gpt-known": knownComponents } },
    diagnostics: { forkReplayEventsSkipped: 0, malformedLines: 0, lineageParentsMissing: 0 },
  };
  const observationBytes = Buffer.from(`${JSON.stringify(observation)}\n`);
  const transitionBytes = Buffer.from(`${JSON.stringify(transitionDataset)}\n`);
  const correctionsBytes = Buffer.from("");
  const unavailableCode = process.platform === "win32"
    ? "OWNER_ONLY_ATOMIC_WINDOWS_ATOMIC_PUBLISHER_UNAVAILABLE"
    : "OWNER_ONLY_ATOMIC_PLATFORM_UNSUPPORTED";
  try {
    await writeFile(observations, observationBytes);
    await writeFile(transitions, transitionBytes);
    await writeFile(corrections, correctionsBytes);

    await assert.rejects(run([
      "migrate-corrections",
      "--observations", observations,
      "--transitions", transitions,
      "--corrections", corrections,
      "--output", output,
      "--report-file", report,
    ]), { code: unavailableCode });

    assert.deepEqual(await readFile(observations), observationBytes);
    assert.deepEqual(await readFile(transitions), transitionBytes);
    assert.deepEqual(await readFile(corrections), correctionsBytes);
    for (const path of [lock, output, report]) {
      await assert.rejects(lstat(path), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
