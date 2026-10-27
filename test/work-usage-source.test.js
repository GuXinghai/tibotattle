import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { readLocalIndexWorkUsage } from "../src/local-index-work-usage.js";
import { openLocalIndexStore } from "../src/local-index-store.js";
import { createLocalIndexUsageExplainerReaders } from "../src/local-index-usage-explainer.js";
import { extractRolloutWorkContexts } from "../src/local-index-extract.js";
import { queryWorkUsageSnapshot } from "../src/reporting/index.js";

const { readAllowance } = createLocalIndexUsageExplainerReaders();

const execFileAsync = promisify(execFile);
const THREAD_ID = "11111111-1111-4111-8111-111111111111";

function usage(input, output = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function sessionMeta(cwd) {
  return {
    timestamp: "2026-08-24T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: THREAD_ID,
      session_id: THREAD_ID,
      thread_source: "user",
      originator: "codex_cli_rs",
      cwd,
    },
  };
}

function turnContext(timestamp, cwd, index) {
  return {
    timestamp,
    type: "turn_context",
    payload: {
      turn_id: `turn-${index}`,
      cwd,
      model: "gpt-5.6-sol",
      effort: "high",
    },
  };
}

function tokenCount(timestamp, total, last) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(total),
        last_token_usage: usage(last),
      },
    },
  };
}

function quotaRateLimits(usedPercent = 12, resetsAt = 1_785_433_600) {
  return {
    limit_id: "codex",
    plan_type: "pro",
    primary: {
      used_percent: usedPercent,
      window_minutes: 300,
      resets_at: resetsAt,
    },
    secondary: {
      used_percent: usedPercent,
      window_minutes: 10_080,
      resets_at: resetsAt,
    },
  };
}

function quotaTokenCount(
  timestamp,
  infoMode = "null",
  usedPercent = 12,
  resetsAt = 1_785_433_600,
) {
  const payload = {
    type: "token_count",
    rate_limits: quotaRateLimits(usedPercent, resetsAt),
  };
  if (infoMode === "null") payload.info = null;
  if (infoMode === "object") {
    payload.info = {
      total_token_usage: null,
      last_token_usage: null,
    };
  }
  return { timestamp, type: "event_msg", payload };
}

function quotaTokenCountWithInfo(timestamp, total, last) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
      rate_limits: quotaRateLimits(),
    },
  };
}

function contradictoryUsage() {
  return {
    input_tokens: 110,
    cached_input_tokens: 60,
    cache_write_input_tokens: 60,
    output_tokens: 5,
    reasoning_output_tokens: 6,
    total_tokens: 115,
  };
}

async function git(args, cwd) {
  await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 64 * 1024,
  });
}

async function modifySourceSameSize(path) {
  const bytes = await readFile(path);
  const marker = Buffer.from("gpt-5.6-sol");
  const offset = bytes.indexOf(marker);
  assert.ok(offset >= 0, "synthetic model marker must be present");
  const last = offset + marker.length - 1;
  bytes[last] = bytes[last] === 0x6c ? 0x6d : 0x6c;
  await writeFile(path, bytes, { mode: 0o600 });
}

async function makeFixture({ events, useCustomSecret = false }) {
  const root = await mkdtemp(join(tmpdir(), "work-usage-source-"));
  const codexHome = join(root, "codex");
  const sessions = join(codexHome, "sessions", "2026", "08", "24");
  const archived = join(codexHome, "archived_sessions");
  const repository = join(root, "main");
  const worktree = join(root, "feature-worktree");
  const secretFile = useCustomSecret ? join(root, "custom-device-salt") : null;
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await mkdir(archived, { recursive: true, mode: 0o700 });
  await mkdir(repository, { recursive: true });
  await git(["init", "-q"], repository);
  await git(["config", "user.email", "fixture@example.invalid"], repository);
  await git(["config", "user.name", "Synthetic Fixture"], repository);
  await writeFile(join(repository, "README.md"), "synthetic fixture\n");
  await git(["add", "README.md"], repository);
  await git(["commit", "-qm", "fixture"], repository);
  await git(["branch", "-M", "main"], repository);
  await git(
    ["worktree", "add", "-q", "-b", "feature", worktree, "HEAD"],
    repository,
  );

  const lines = [sessionMeta(repository)];
  for (const [index, item] of events.entries()) {
    const cwd = item.cwd === "WORKTREE" ? worktree : (item.cwd ?? repository);
    if (item.context === "settings") {
      lines.push({ timestamp: item.timestamp, type: "event_msg", payload: {
        type: "thread_settings_applied", thread_settings: { cwd, model: "gpt-5.6-sol", service_tier: "default" },
      } });
    } else if (item.context !== "none") {
      lines.push(turnContext(item.timestamp, cwd, index + 1));
    }
    if (item.kind === "quota-only") {
      lines.push(quotaTokenCount(
        item.timestamp,
        item.infoMode ?? "null",
        item.usedPercent ?? 12,
        item.resetsAt ?? 1_785_433_600,
      ));
    } else if (item.kind === "all-null-info-quota") {
      lines.push(quotaTokenCount(item.timestamp, "object"));
    } else if (item.kind === "quota-repeat") {
      lines.push(
        quotaTokenCountWithInfo(
          item.timestamp,
          usage(item.total),
          usage(item.last),
        ),
      );
    } else if (item.kind === "quota-first-baseline") {
      lines.push(
        quotaTokenCountWithInfo(item.timestamp, usage(item.total), null),
      );
    } else if (item.kind === "quota-contradictory") {
      const value = contradictoryUsage();
      lines.push(quotaTokenCountWithInfo(item.timestamp, value, value));
    } else {
      lines.push(tokenCount(item.timestamp, item.total, item.last));
    }
  }
  const rolloutPath = join(
    sessions,
    "rollout-2026-08-24T00-00-00-thread.jsonl",
  );
  await writeFile(
    rolloutPath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    { mode: 0o600 },
  );
  const indexFile = join(root, "index.sqlite");
  if (secretFile !== null) {
    await writeFile(secretFile, Buffer.alloc(32, 0x5a), { mode: 0o600 });
  }
  const buildOptions = {
    codexHome,
    indexFile,
    workerCount: 1,
  };
  if (secretFile !== null) buildOptions.secretFile = secretFile;
  await refreshLocalIndex(buildOptions);
  await writeFile(join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { synthetic: { id: "synthetic", name: "main", rootPaths: [repository] } },
    "thread-project-assignments": { [THREAD_ID]: { projectKind: "local", projectId: "synthetic" } },
    "projectless-thread-ids": [],
  }), { mode: 0o600 });
  return {
    root,
    codexHome,
    sessions,
    repository,
    worktree,
    rolloutPath,
    indexFile,
    secretFile,
  };
}

// One scope's work snapshot of [fromMs, toMs) from the v2 store. The scope is
// the explicit one, else the first unavailable scope, else the first scope.
async function readSnapshot({
  indexFile, codexHome, secretFile = null, fromMs, toMs, scope = null,
}) {
  const database = openLocalIndexStore(indexFile, { readOnly: true });
  try {
    const result = await readLocalIndexWorkUsage({
      database, indexFile, codexHome, secretFile, nowMs: toMs,
      intervals: [{ id: "custom", fromMs, toMs }],
    });
    const period = result.periods.custom;
    const selected = scope ?? period.scopes.find((s) => s.status === "unavailable")?.id
      ?? period.scopes[0]?.id ?? "scope-0";
    if (!period.snapshots[selected]) throw new Error("work_usage_scope_unavailable");
    return period.snapshots[selected];
  } finally {
    database.close();
  }
}

function interval(start, end) {
  return { fromMs: Date.parse(start), toMs: Date.parse(end) };
}

function query(result, grouping) {
  return queryWorkUsageSnapshot(result, {
    grouping,
    sort: "tokens",
    offset: 0,
    pageSize: 100,
  });
}

test("canonical source resolves main and linked worktree to one project and conserves 100/300", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        cwd: null,
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:03.000Z",
        cwd: "WORKTREE",
        total: 400,
        last: 300,
      },
    ],
  });

  try {
    const beforeRollout = await readFile(fixture.rolloutPath);
    const beforeIndex = await readFile(fixture.indexFile);
    const result = await readSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:05.000Z"),
    });
    assert.equal(result.status, "available");
    assert.deepEqual(await readFile(fixture.rolloutPath), beforeRollout);
    assert.deepEqual(await readFile(fixture.indexFile), beforeIndex);

    const projectEntries = Object.entries(result.display.projects);
    const worktreeEntries = Object.entries(result.display.worktrees);
    assert.equal(projectEntries.length, 1);
    assert.equal(projectEntries[0][1].name, "main");
    assert.equal(projectEntries[0][1].method, "codex_project");
    assert.deepEqual(worktreeEntries.map(([, value]) => value.name).sort(), [
      "feature-worktree",
      "main",
    ]);

    const projects = query(result, "project");
    const worktrees = query(result, "worktree");
    const threads = query(result, "thread");
    assert.equal(projects.totals.tokens, 400);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 400);
    assert.deepEqual(
      worktrees.rows.map((row) => row.tokens).sort((a, b) => a - b),
      [100, 300],
    );
    assert.equal(
      worktrees.rows.reduce((sum, row) => sum + row.tokens, 0),
      400,
    );
    assert.equal(threads.rows.length, 1);
    assert.equal(threads.rows[0].tokens, 400);
    assert.equal(threads.rows[0].projects.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-inode append growth leaves the indexed prefix attributable and excludes new usage", async () => {
  const fixture = await makeFixture({
    events: [{
      timestamp: "2026-08-24T00:00:01.000Z",
      total: 100,
      last: 100,
    }],
  });
  try {
    const beforeIndex = await readFile(fixture.indexFile);
    const database = openLocalIndexStore(fixture.indexFile, { readOnly: true });
    let indexedBytes;
    try {
      indexedBytes = Number(database.prepare(
        "SELECT scanned_bytes FROM source ORDER BY id LIMIT 1",
      ).get().scanned_bytes);
    } finally {
      database.close();
    }
    const beforeRollout = await readFile(fixture.rolloutPath);
    assert.equal(indexedBytes, beforeRollout.length);
    await appendFile(fixture.rolloutPath, `${[
      JSON.stringify(turnContext("2026-08-24T00:00:04.000Z", fixture.repository, 2)),
      JSON.stringify(tokenCount("2026-08-24T00:00:05.000Z", 200, 100)),
    ].join("\n")}\n`);
    assert.ok((await readFile(fixture.rolloutPath)).length > indexedBytes);

    const result = await readSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:06.000Z"),
    });
    assert.equal(result.status, "available");
    assert.equal(result.metadata.status, "available");
    assert.equal(result.metadata.inspectedSources, 1);
    assert.equal(result.metadata.indexedSources, 1);
    const projectEntries = Object.entries(result.display.projects);
    assert.equal(projectEntries.length, 1);
    assert.equal(projectEntries[0][1].name, "main");
    assert.equal(projectEntries[0][1].method, "codex_project");
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 100);
    assert.equal(projects.totals.events, 1);
    assert.equal(projects.totals.incompleteEvents, 0);
    assert.equal(projects.rows[0].tokens, 100);
    assert.deepEqual(await readFile(fixture.indexFile), beforeIndex);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("quota-only token counts stay retained in the index without changing known work usage", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:02.000Z",
        kind: "quota-only",
        infoMode: "null",
      },
      {
        timestamp: "2026-08-24T00:00:03.000Z",
        kind: "quota-only",
        infoMode: "absent",
      },
    ],
  });
  try {
    const beforeIndex = await readFile(fixture.indexFile);
    const database = openLocalIndexStore(fixture.indexFile, { readOnly: true });
    let quotaUsageRows;
    let quotaObservations;
    try {
      quotaUsageRows = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM usage_event WHERE quota_observation_id IS NOT NULL",
      ).get().count);
      quotaObservations = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM quota_observation",
      ).get().count);
    } finally {
      database.close();
    }
    assert.equal(quotaUsageRows, 2);
    assert.ok(quotaObservations >= 2);

    const result = await readSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:04.000Z"),
    });
    assert.equal(result.status, "available");
    assert.deepEqual(await readFile(fixture.indexFile), beforeIndex);
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 100);
    assert.equal(projects.totals.events, 1);
    assert.equal(projects.totals.incompleteEvents, 0);
    assert.equal(projects.totals.unknownEvents, 0);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 100);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("all-null token info with quota remains an unknown work event", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:02.000Z",
        kind: "all-null-info-quota",
      },
    ],
  });
  try {
    const result = await readSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:03.000Z"),
    });
    assert.equal(result.status, "available");
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 100);
    assert.equal(projects.totals.events, 2);
    assert.equal(projects.totals.incompleteEvents, 1);
    assert.equal(projects.totals.unknownEvents, 1);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 100);
    assert.equal(projects.rows[0].incompleteEvents, 1);
    assert.equal(projects.rows[0].unknownEvents, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an exact repeated cumulative snapshot with quota is status-only, while growth remains usage", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:02.000Z",
        kind: "quota-repeat",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:03.000Z",
        kind: "quota-repeat",
        total: 200,
        last: 100,
      },
    ],
  });
  try {
    const beforeIndex = await readFile(fixture.indexFile);
    const database = openLocalIndexStore(fixture.indexFile, { readOnly: true });
    let usageRows;
    let quotaUsageRows;
    try {
      usageRows = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM usage_event",
      ).get().count);
      quotaUsageRows = Number(database.prepare(
        "SELECT COUNT(*) AS count FROM usage_event WHERE quota_observation_id IS NOT NULL",
      ).get().count);
    } finally {
      database.close();
    }
    assert.equal(usageRows, 3);
    assert.equal(quotaUsageRows, 2);

    const result = await readSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:04.000Z"),
    });
    assert.equal(result.status, "available");
    assert.deepEqual(await readFile(fixture.indexFile), beforeIndex);
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 200);
    assert.equal(projects.totals.events, 2);
    assert.equal(projects.totals.incompleteEvents, 0);
    assert.equal(projects.totals.unknownEvents, 0);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 200);
    assert.equal(projects.rows[0].events, 2);
    assert.equal(projects.rows[0].incompleteEvents, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a quota row used as the first cumulative baseline without last usage stays unknown", async () => {
  const fixture = await makeFixture({
    events: [{
      timestamp: "2026-08-24T00:00:01.000Z",
      kind: "quota-first-baseline",
      total: 100,
    }],
  });
  try {
    const result = await readSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:02.000Z"),
    });
    assert.equal(result.status, "available");
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, null);
    assert.equal(projects.totals.events, 1);
    assert.equal(projects.totals.incompleteEvents, 1);
    assert.equal(projects.totals.unknownEvents, 1);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, null);
    assert.equal(projects.rows[0].unknownEvents, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("contradictory complete counters that canonicalize to all-null stay unknown with quota", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 100,
        last: 100,
      },
      {
        timestamp: "2026-08-24T00:00:02.000Z",
        kind: "quota-contradictory",
      },
    ],
  });
  try {
    const result = await readSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:03.000Z"),
    });
    assert.equal(result.status, "available");
    const projects = query(result, "project");
    assert.equal(projects.totals.tokens, 100);
    assert.equal(projects.totals.events, 2);
    assert.equal(projects.totals.incompleteEvents, 1);
    assert.equal(projects.totals.unknownEvents, 1);
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].tokens, 100);
    assert.equal(projects.rows[0].unknownEvents, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("usage explainer reads compatible allowance movement from committed occurrences", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        kind: "quota-only",
        usedPercent: 12,
      },
      {
        timestamp: "2026-08-24T00:00:03.000Z",
        kind: "quota-only",
        usedPercent: 18,
      },
    ],
  });
  try {
    const result = readAllowance({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:05.000Z"),
      limit: 1,
    });
    assert.equal(result.status, "available");
    assert.equal(result.windows.length, 1);
    assert.equal(result.rowCount, 2);
    assert.equal(result.observedMovementCount, 2);
    assert.equal(result.resetIdentityMissingCount, 0);
    assert.equal(result.singleObservationCount, 0);
    assert.equal(result.nonMonotonicCount, 0);
    assert.equal(result.nextOffset, 1);
    const second = readAllowance({
      indexFile: fixture.indexFile,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:05.000Z"),
      offset: result.nextOffset,
      limit: 1,
    });
    assert.equal(second.windows.length, 1);
    assert.equal(second.rowCount, 2);
    assert.equal(second.nextOffset, null);
    assert.notEqual(second.windows[0].durationMins, result.windows[0].durationMins);
    const weekly = [...result.windows, ...second.windows]
      .find((row) => row.durationMins === 10_080);
    assert.ok(weekly);
    assert.equal(weekly.firstUsedPercent, 12);
    assert.equal(weekly.lastUsedPercent, 18);
    assert.equal(weekly.movementPercentagePoints, 6);
    assert.equal(weekly.observationCount, 2);
    assert.equal(weekly.movementStatus, "observed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("allowance pages prioritize compatible movement and count unresolved classes", async () => {
  const fixture = await makeFixture({
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        kind: "quota-only",
        usedPercent: 12,
      },
      {
        timestamp: "2026-08-24T00:00:03.000Z",
        kind: "quota-only",
        usedPercent: 18,
      },
      {
        timestamp: "2026-08-24T00:00:04.000Z",
        kind: "quota-only",
        usedPercent: 4,
        resetsAt: 1_786_038_400,
      },
      {
        timestamp: "2026-08-24T00:00:04.100Z",
        kind: "quota-only",
        usedPercent: 4,
        resetsAt: 1_786_038_400,
      },
      {
        timestamp: "2026-08-24T00:00:04.200Z",
        kind: "quota-only",
        usedPercent: 2,
        resetsAt: 1_786_643_200,
      },
    ],
  });
  try {
    const result = readAllowance({
      indexFile: fixture.indexFile,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:05.000Z"),
      limit: 6,
    });
    assert.equal(result.status, "available");
    assert.equal(result.rowCount, 6);
    assert.equal(result.observedMovementCount, 4);
    assert.equal(result.singleObservationCount, 2);
    assert.equal(result.resetIdentityMissingCount, 0);
    assert.equal(result.nonMonotonicCount, 0);
    assert.deepEqual(
      result.windows.map((row) => row.movementStatus),
      [
        "observed",
        "observed",
        "observed",
        "observed",
        "single_observation",
        "single_observation",
      ],
    );
    assert.deepEqual(
      result.windows.map((row) => row.movementPercentagePoints),
      [6, 6, 0, 0, null, null],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source honors an existing custom salt and keeps account scope handles stable", async () => {
  const fixture = await makeFixture({
    useCustomSecret: true,
    events: [
      {
        timestamp: "2026-08-24T00:00:01.000Z",
        total: 120,
        last: 120,
      },
    ],
  });
  try {
    const beforeSecret = await readFile(fixture.secretFile);
    const request = {
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      secretFile: fixture.secretFile,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:02.000Z"),
    };
    const first = await readSnapshot(request);
    const second = await readSnapshot({
      ...request,
      scope: first.scope,
    });
    assert.equal(first.status, "available");
    assert.equal(second.status, "available");
    assert.match(first.scope, /^scope-[0-9a-f]{64}$/u);
    assert.equal(first.scope, second.scope);
    assert.deepEqual(first.scopes, second.scopes);
    assert.equal(first.scopes[0].id, first.scope);
    assert.equal(query(first, "project").totals.tokens, 120);
    assert.equal(query(second, "project").totals.tokens, 120);
    assert.deepEqual(await readFile(fixture.secretFile), beforeSecret);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("workspace observations preserve sparse updates and invalidate explicit malformed changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-context-"));
  try {
    const lines = [
      sessionMeta("/synthetic/initial"),
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { type: "response_item", payload: { type: "turn_context", cwd: "/synthetic/ignored" } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { cwd: "/synthetic/next" } } },
      { type: "turn_context", payload: { cwd: "/synthetic/bad\u0000path" } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-sol" } } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: [] } },
      { type: "turn_context", payload: { cwd: "/synthetic/restored" } },
    ].map(row => JSON.stringify(row)).concat('{"type":"turn_context","payload":');
    const bytes = Buffer.from(`${lines.join("\n")}\n`);
    const path = join(root, "synthetic.jsonl");
    await writeFile(path, bytes);
    const observations = [];
    await extractRolloutWorkContexts(path, { end: bytes.length, onContext: row => observations.push(row) });
    assert.deepEqual(observations.map(row => row.cwd), [
      "/synthetic/initial", "/synthetic/next", null, null, "/synthetic/restored", null,
    ]);
    assert.ok(observations.every((row, i) => i === 0 || row.offset > observations[i - 1].offset));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skipping undecoded message lines never changes which workspace observations are found", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-context-prefilter-"));
  try {
    const big = "x".repeat(64 * 1024);
    const lines = [
      JSON.stringify(sessionMeta("/synthetic/initial")),
      // Skipped without decoding: a large message with no metadata marker.
      JSON.stringify({ type: "response_item", payload: { type: "message", content: big } }),
      // Mentions a marker in its content, so it is decoded and still ignored.
      JSON.stringify({ type: "response_item", payload: { type: "message", content: `turn_context ${big}` } }),
      // A JSON escape can spell a kind; this one must be decoded and observed.
      '{"type":"\\u0074urn_context","payload":{"cwd":"/synthetic/escaped"}}',
      // Duplicate discriminators: JSON keeps the last, which is a turn context.
      '{"type":"response_item","payload":{"cwd":"/synthetic/duplicate"},"type":"turn_context"}',
      JSON.stringify({ type: "compacted", payload: { message: big } }),
      // Malformed lines with an unknown header still reset to an unknown directory.
      '{"payload": {"cwd": "/synthetic/never"}, broken',
      JSON.stringify({ type: "turn_context", payload: { cwd: "/synthetic/last" } }),
    ];
    const bytes = Buffer.from(`${lines.join("\n")}\n`);
    const path = join(root, "synthetic.jsonl");
    await writeFile(path, bytes);
    const observations = [];
    await extractRolloutWorkContexts(path, { end: bytes.length, onContext: row => observations.push(row) });
    assert.deepEqual(observations.map(row => row.cwd), [
      "/synthetic/initial", "/synthetic/escaped", "/synthetic/duplicate", null, "/synthetic/last",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initial session and applied settings directories attribute usage without a turn context", async () => {
  const fixture = await makeFixture({ events: [
    { timestamp: "2026-08-24T00:00:01.000Z", total: 120, last: 120, context: "none" },
    { timestamp: "2026-08-24T00:00:02.000Z", total: 150, last: 30, context: "settings", cwd: "WORKTREE" },
  ] });
  try {
    const result = await readSnapshot({
      indexFile: fixture.indexFile, codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:00.000Z", "2026-08-24T00:00:03.000Z"),
    });
    const projects = query(result, "project");
    assert.equal(projects.rows.length, 1);
    assert.notEqual(projects.rows[0].id, "unassigned");
    assert.equal(projects.totals.tokens, 150);
    const worktrees = query(result, "worktree");
    assert.deepEqual(worktrees.rows.map(row => [result.display.worktrees[row.id].name, row.tokens]).sort(),
      [["feature-worktree", 30], ["main", 120]]);
    // A directory observation cannot manufacture a missing historical model
    // or price, nor apply the later model to the first event.
    const unknown = result.cells.find(cell => cell.models.includes("unknown"));
    assert.equal(unknown.tokens, 120);
    assert.equal(unknown.costUsdExact, null);
    assert.ok(result.cells.some(cell => cell.costUsdExact !== null));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source query uses a half-open [fromMs, toMs) boundary", async () => {
  const fixture = await makeFixture({
    events: [
      { timestamp: "2026-08-24T00:00:01.000Z", total: 10, last: 10 },
      { timestamp: "2026-08-24T00:00:02.000Z", total: 30, last: 20 },
      { timestamp: "2026-08-24T00:00:03.000Z", total: 70, last: 40 },
    ],
  });
  try {
    const result = await readSnapshot({
      indexFile: fixture.indexFile,
      codexHome: fixture.codexHome,
      ...interval("2026-08-24T00:00:01.000Z", "2026-08-24T00:00:03.000Z"),
    });
    assert.equal(result.status, "available");
    assert.equal(query(result, "project").totals.tokens, 30);
    assert.deepEqual(
      query(result, "worktree").rows.map((row) => row.tokens),
      [30],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("row enrichment preserves explicit worker ancestry using the shared local metadata reader", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { chmod } = await import("node:fs/promises");
  const { enrichWorkUsageRows } = await import(
    "../src/work-usage-display.js"
  );
  const home = await mkdtemp(join(tmpdir(), "work-usage-names-"));
  const parent = "33333333-3333-4333-8333-333333333333";
  const child = "11111111-1111-4111-8111-111111111111";
  try {
    const file = join(home, "state_5.sqlite");
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, agent_nickname TEXT, source TEXT)",
      );
      const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)");
      insert.run(parent, "Parent task", null, null);
      insert.run(
        child,
        "Child task",
        "Luna",
        JSON.stringify({
          subagent: { thread_spawn: { parent_thread_id: parent } },
        }),
      );
    } finally {
      db.close();
    }
    await chmod(file, 0o600);
    const before = await readFile(file);
    const display = await enrichWorkUsageRows({
      codexHome: home,
      rows: [{ id: "worker", kind: "thread" }],
      result: {
        display: { threads: { worker: { uuid: child, shortId: "11111111" } } },
      },
    });
    assert.deepEqual(display.worker.thread, {
      id: child,
      name: "Child task",
      nickname: "Luna",
      parent: { id: parent, name: "Parent task" },
    });
    assert.equal(display.worker.codexUrl, `codex://threads/${child}`);
    assert.deepEqual(await readFile(file), before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("bounded collaboration ancestry follows nested workers, preserves absent roots and fails closed on cycles", async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const {chmod}=await import('node:fs/promises');
  const {readCodexLocalThreadAncestry}=await import('../src/platform/index.js');
  const home=await mkdtemp(join(tmpdir(),'work-family-'));
  const ids=[1,2,3,4,5,6].map(n=>`${n}0000000-0000-4000-8000-000000000000`);
  try {
    const file=join(home,'state_5.sqlite');const db=new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, title TEXT)');
      const insert=db.prepare('INSERT INTO threads VALUES (?, ?, ?)');
      for(const [child,parent] of [[0,null],[1,0],[2,1],[3,4],[4,3]]) insert.run(ids[child],parent===null?'cli':JSON.stringify({subagent:{thread_spawn:{parent_thread_id:ids[parent]}}}),'SYNTHETIC EXCLUDED TITLE');
    } finally {db.close();}
    await chmod(file,0o600);
    const roots=await readCodexLocalThreadAncestry(home,[ids[2],ids[3],ids[4],ids[5]]);
    assert.equal(roots.get(ids[2]),ids[0]);
    assert.equal(roots.get(ids[3]),ids[3]);assert.equal(roots.get(ids[4]),ids[4]);
    assert.equal(roots.get(ids[5]),ids[5]);
    assert.deepEqual(await readCodexLocalThreadAncestry(home,['invalid']),new Map());
  } finally {await rm(home,{recursive:true,force:true});}
});

test("explicit project membership survives Git changes and is reread on every report", async () => {
  const fixture = await makeFixture({ events: [
    { timestamp: "2026-08-24T00:01:00Z", total: 100, last: 100 },
    { timestamp: "2026-08-24T00:02:00Z", kind: "quota-repeat", total: 100, last: 100 },
  ] });
  const options = { ...fixture, ...interval("2026-08-24T00:00:00Z", "2026-08-25T00:00:00Z") };
  try {
    const cold = await readSnapshot(options);
    assert.equal(cold.status, "available");
    const warm = await readSnapshot(options);
    assert.deepEqual(query(warm, "project"), query(cold, "project"));
    await rename(join(fixture.repository, ".git"), join(fixture.repository, ".git-saved"));
    const remapped = await readSnapshot(options);
    assert.equal(query(remapped, "project").totals.tokens, 100);
    assert.equal(query(remapped, "project").rows[0].id, query(cold, "project").rows[0].id,
      "Git changes do not change explicit Codex ownership");
    const file = join(fixture.codexHome, ".codex-global-state.json");
    const metadata = JSON.parse(await readFile(file, "utf8"));
    metadata["thread-project-assignments"] = {};
    metadata["projectless-thread-ids"] = [THREAD_ID];
    await writeFile(file, JSON.stringify(metadata), { mode: 0o600 });
    const changed = await readSnapshot(options);
    assert.equal(query(changed, "project").rows[0].id, "non-project");
    assert.equal(query(changed, "project").totals.tokens, 100);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("non-repository and unavailable locations share one project while retaining location detail", async () => {
  const { createWorkUsageProjectResolver } = await import("../src/platform/index.js");
  const root = await mkdtemp(join(tmpdir(), "work-usage-nonproject-"));
  const resolveProject = createWorkUsageProjectResolver({ digest: (kind, value) => `${kind}:${value}` });
  try {
    const first = join(root, "first", "scratch");
    const second = join(root, "second", "scratch");
    const removed = join(root, "removed", "scratch");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const locations = await Promise.all([first, second, removed].map(resolveProject));
    for (const location of locations) {
      assert.equal(location.project, "non-project");
      assert.equal(location.projectName, "Non-project tasks");
      assert.equal(location.method, "non_project");
      assert.equal(location.worktreeName, "scratch");
    }
    assert.equal(new Set(locations.map(location => location.worktree)).size, 3);
    assert.equal(await resolveProject(first), locations[0], "per-location resolution remains cached");
    for (const invalid of [null, undefined, "", "relative/path", `${root}\0bad`, `${root}\nbad`, `${root}\tbad`, `${root}\x7fbad`]) {
      assert.equal(await resolveProject(invalid), null, "missing or malformed location remains Unassigned");
    }
    const file = join(root, "file");
    await writeFile(file, "fixture");
    assert.equal(await resolveProject(file), null, "a regular file is not a workspace");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository grouping joins linked worktrees but keeps distinct clones separate", async () => {
  const { createWorkUsageProjectResolver } = await import("../src/platform/index.js");
  const fixture = await makeFixture({ events: [] });
  const resolveProject = createWorkUsageProjectResolver({ digest: (kind, value) => `${kind}:${value}` });
  try {
    const clone = join(fixture.root, "clone");
    await git(["clone", "-q", fixture.repository, clone], fixture.root);
    const [main, linked, separate] = await Promise.all(
      [fixture.repository, fixture.worktree, clone].map(resolveProject),
    );
    assert.equal(main.method, "git_observation");
    assert.equal(linked.project, main.project);
    assert.notEqual(linked.worktree, main.worktree);
    assert.notEqual(separate.project, main.project);
    assert.notEqual(separate.project, "non-project");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

for (const { platform, paths, root, newline } of [
  { platform: "macOS", paths: posix, root: "/synthetic", newline: "\n" },
  { platform: "Windows", paths: win32, root: "C:\\synthetic", newline: "\r\n" },
]) {
  test(`${platform} Git paths group linked worktrees with the repository name`, async () => {
    const { createWorkUsageProjectResolver } = await import("../src/platform/index.js");
    const main = paths.join(root, "main");
    const linked = paths.join(root, "feature");
    const common = paths.join(main, ".git");
    const calls = [];
    const resolveProject = createWorkUsageProjectResolver({
      digest: (kind, value) => `${kind}:${value}`,
      paths,
      filesystem: {
        async realpath(path) {
          assert.ok(!path.includes("\r"), "line terminators must not become path bytes");
          return paths.normalize(path);
        },
        async stat() { return { isDirectory: () => true, dev: 1, ino: 2, birthtimeMs: 3 }; },
      },
      async runCommand(command, args) {
        calls.push(args);
        assert.equal(command, "git");
        if (args.includes("config")) throw Object.assign(new Error("no_origin"), { code: 1 });
        return { stdout: `${common.replaceAll("\\", "/")}${newline}${args[1].replaceAll("\\", "/")}${newline}` };
      },
    });
    const first = await resolveProject(main);
    const second = await resolveProject(linked);
    assert.equal(first.method, "git_observation");
    assert.equal(first.projectName, "main");
    assert.equal(first.worktreeName, "main");
    assert.equal(second.projectName, "main");
    assert.equal(second.worktreeName, "feature");
    assert.equal(second.project, first.project);
    assert.notEqual(second.worktree, first.worktree);
    assert.equal(calls.filter(args => args.includes("config")).length, 1);
  });

  test(`${platform} missing Git uses a saved origin while current Git failures preserve non-project status`, async () => {
    const { createWorkUsageProjectResolver } = await import("../src/platform/index.js");
    const location = paths.join(root, "main");
    const origin = "https://example.invalid/team/main.git";
    const missingGit = { code: "ENOENT", syscall: "spawn git" };
    const options = {
      digest: (kind, value) => `${kind}:${value}`,
      paths,
      repositoryOrigins: new Map([[location, origin]]),
      filesystem: {
        async realpath(path) { return path; },
        async stat() { return { isDirectory: () => true }; },
      },
    };
    const missingResolver = createWorkUsageProjectResolver({ ...options,
      async runCommand() { throw Object.assign(new Error("git_unavailable"), missingGit); },
    });
    const retained = await missingResolver(location);
    assert.equal(retained.method, "retained_git_origin");
    assert.equal(retained.projectName, "main");
    assert.equal(retained.project, "repository-origin:https://example.invalid/team/main");
    assert.equal(retained.worktreeName, "main");
    for (const failure of [
      { code: 128 }, // Current Git reports that this directory is not a repository.
      { code: "EACCES", syscall: "spawn git" },
      { code: "ENOENT", syscall: "realpath" },
      { code: "ETIMEDOUT" },
    ]) {
      const resolveProject = createWorkUsageProjectResolver({ ...options,
        async runCommand() { throw Object.assign(new Error("git_failed"), failure); },
      });
      assert.equal((await resolveProject(location)).method, "non_project");
    }
    for (const repositoryOrigins of [new Map(), new Map([[location, "file:///synthetic/main"]])]) {
      const resolveProject = createWorkUsageProjectResolver({ ...options, repositoryOrigins,
        async runCommand() { throw Object.assign(new Error("git_unavailable"), missingGit); },
      });
      assert.equal((await resolveProject(location)).method, "non_project");
    }
  });
}

test("canonical source groups explicitly projectless tasks and conserves unavailable-location usage", async () => {
  const absentRoot = await mkdtemp(join(tmpdir(), "work-usage-absent-"));
  const fixture = await makeFixture({ events: [
    { timestamp: "2026-08-24T00:01:00Z", total: 100, last: 100, cwd: join(absentRoot, "first") },
    { timestamp: "2026-08-24T00:02:00Z", total: 400, last: 300, cwd: join(absentRoot, "second") },
  ] });
  try {
    await writeFile(join(fixture.codexHome, ".codex-global-state.json"), JSON.stringify({
      "local-projects": {}, "thread-project-assignments": {}, "projectless-thread-ids": [THREAD_ID],
    }), { mode: 0o600 });
    const result = await readSnapshot({
      ...fixture,
      ...interval("2026-08-24T00:00:00Z", "2026-08-25T00:00:00Z"),
    });
    assert.equal(result.status, "available");
    const projects = query(result, "project");
    assert.equal(projects.rows.length, 1);
    assert.equal(projects.rows[0].id, "non-project");
    assert.equal(projects.rows[0].tokens, 400);
    assert.equal(projects.totals.tokens, 400);
    assert.equal(result.display.projects["non-project"].name, "Non-project tasks");
    assert.equal(result.display.projects["non-project"].method, "codex_projectless");
    assert.deepEqual(query(result, "worktree").rows.map(row => row.tokens).sort((a, b) => a - b), [100, 300]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(absentRoot, { recursive: true, force: true });
  }
});

test("verified repository origins recover deleted workspaces and group transport variants", async () => {
  const { createWorkUsageProjectResolver } = await import("../src/platform/index.js");
  const fixture = await makeFixture({ events: [] });
  try {
    await git(["remote", "add", "origin", "https://fixture-token@example.invalid/team/project.git"], fixture.repository);
    const clone = join(fixture.root, "clone");
    await git(["clone", "-q", fixture.repository, clone], fixture.root);
    await git(["remote", "set-url", "origin", "git@example.invalid:team/project.git"], clone);
    const removed = join(fixture.root, "removed");
    const replaced = join(fixture.root, "replaced");
    const malformed = join(fixture.root, "malformed");
    await mkdir(replaced);
    const resolveProject = createWorkUsageProjectResolver({
      digest: (kind, value) => `${kind}:${value}`,
      repositoryOrigins: new Map([
        [removed, "ssh://git@example.invalid:22/team/project.git?ignored=yes#fragment"],
        [replaced, "https://example.invalid/team/project"],
        [malformed, "file:///local/repository"],
      ]),
    });
    const [main, linked, copy, historical, currentFolder, invalid] = await Promise.all(
      [fixture.repository, fixture.worktree, clone, removed, replaced, malformed].map(resolveProject),
    );
    assert.equal(main.project, linked.project);
    assert.equal(main.project, copy.project);
    assert.equal(main.project, historical.project);
    assert.equal(main.projectName, "project");
    assert.equal(historical.method, "retained_git_origin");
    assert.equal(await resolveProject(`${removed}/`), historical, "trailing slash recovers and reuses the same retained workspace");
    assert.equal(await resolveProject(`${removed}//`), historical, "repeated trailing separators do not split workspace identity");
    assert.equal(new Set([main.worktree, linked.worktree, copy.worktree, historical.worktree]).size, 4);
    assert.equal(currentFolder.project, "non-project", "current non-Git directory overrides a stale saved origin");
    assert.equal(invalid.project, "non-project");
    assert.ok(!JSON.stringify([main, linked, copy, historical]).includes("fixture-token"));
    await git(["remote", "set-url", "origin", "https://example.invalid/other/project.git"], clone);
    const fresh = createWorkUsageProjectResolver({ digest: (kind, value) => `${kind}:${value}` });
    assert.notEqual((await fresh(clone)).project, (await fresh(fixture.repository)).project);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("repository origin normalization rejects unsupported and malformed identities", async () => {
  const { normalizeWorkUsageRepositoryOrigin } = await import("../src/platform/index.js");
  const expected = "https://example.invalid/team/project";
  for (const value of [
    "https://user:password@EXAMPLE.invalid/team/project.git/?query=yes#fragment",
    "ssh://git@example.invalid:22/team/project.git",
    "git://example.invalid:9418/team/project.git",
    "git@example.invalid:team/project.git",
    expected,
  ]) assert.equal(normalizeWorkUsageRepositoryOrigin(value), expected);
  for (const value of [null, "", "/local/project", "file:///local/project", "http://example.invalid/team/project",
    "https://example.invalid", "https://example.invalid/.git", "https://example.invalid/team/%2fproject",
    "https://example.invalid/team/%00project", "not a URL", "https://example.invalid/team/\\project"])
    assert.equal(normalizeWorkUsageRepositoryOrigin(value), null);
  assert.equal(normalizeWorkUsageRepositoryOrigin("ssh://git@example.invalid:2222/team/project.git"),
    "https://example.invalid:2222/team/project");
});
