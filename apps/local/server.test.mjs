import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  createProtectedFixtureDirectory, writeInitialProtectedFixtureFile,
} from "../../test/helpers/windows-owner-only-fixture.js";
import { tmpdir } from "node:os";
import { acquireCompanionInstanceLock } from "../../src/platform/index.js";
import { join, resolve } from "node:path";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
} from "../../src/local-companion-data.js";
import { readLocalIndexProjection } from "../../src/local-index-backend.js";
import {
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
} from "../../src/desktop-shell-status.js";
import {
  PREVIEW_PRODUCT_BRAND,
  PRODUCT_BRAND,
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../config/product-brand.js";
import {
  configuredSemanticOpenTarget,
  createCachedLocalUnifiedProjectionReader,
  createLocalCompanionServer,
  LOCAL_STARTUP_DIAGNOSTIC_DETAILS,
  LOCAL_STARTUP_DIAGNOSTIC_STEPS,
  startLocalCompanionServer,
} from "./server.js";

test("unchanged unified projections reuse only within exact generation, time, and baseline bounds", async () => {
  const generationA = `generation-v2-${"a".repeat(64)}`;
  const generationB = `generation-v2-${"b".repeat(64)}`;
  let selectedGeneration = generationA;
  let reads = 0;
  const validityChecks = [];
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async (options) => {
      reads += 1;
      if (options.mode === "deferred") {
        return { status: "deferred", generation: null };
      }
      return {
        status: "available",
        generation: { fingerprint: selectedGeneration },
        usage: [{ marker: reads }],
      };
    },
    validUntil: async (options) => {
      validityChecks.push(options);
      return options.nowMs + 100;
    },
    readGeneration: async () => selectedGeneration,
  });
  const options = (nowMs, baselines, mode = "full") => ({
    indexFile: "/private/index.sqlite",
    nowMs,
    declaredSpeedBaselines: baselines,
    mode,
  });
  const reuse = (generationFingerprint) => ({
    reuse: { generationFingerprint },
  });

  const cold = await reader(options(100, [{ startAt: 1, mode: "standard" }]));
  assert.equal(reads, 1);
  assert.equal(cold.usage[0].marker, 1);

  const unchanged = await reader(
    options(150, [{ startAt: 1, mode: "standard" }]),
    reuse(generationA),
  );
  assert.equal(reads, 1);
  assert.equal(unchanged.usage[0].marker, 1);
  // A caller cannot mutate the retained cache through a returned clone.
  unchanged.usage[0].marker = 999;

  const clockMovedBack = await reader(
    options(99, [{ startAt: 1, mode: "standard" }]),
    reuse(generationA),
  );
  assert.equal(reads, 2);
  assert.equal(clockMovedBack.usage[0].marker, 2);

  const baselineChanged = await reader(
    options(151, [{ startAt: 1, mode: "fast" }]),
    reuse(generationA),
  );
  assert.equal(reads, 3);
  assert.equal(baselineChanged.usage[0].marker, 3);

  const timeBoundaryReached = await reader(
    options(251, [{ startAt: 1, mode: "fast" }]),
    reuse(generationA),
  );
  assert.equal(reads, 4);
  assert.equal(timeBoundaryReached.usage[0].marker, 4);

  selectedGeneration = generationB;
  const changedGeneration = await reader(
    options(252, [{ startAt: 1, mode: "fast" }]),
    reuse(generationB),
  );
  assert.equal(reads, 5);
  assert.equal(changedGeneration.generation.fingerprint, generationB);

  const deferred = await reader(
    options(253, [{ startAt: 1, mode: "fast" }], "deferred"),
    reuse(generationB),
  );
  assert.equal(reads, 6);
  assert.equal(deferred.status, "deferred");
  assert.equal(validityChecks.length, 5);

  const afterDeferred = await reader(
    options(254, [{ startAt: 1, mode: "fast" }]),
    reuse(generationB),
  );
  assert.equal(reads, 6);
  assert.equal(afterDeferred.usage[0].marker, 5);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reader(
      options(255, [{ startAt: 1, mode: "fast" }]),
      { ...reuse(generationB), signal: controller.signal },
    ),
    (error) => error?.code === "local_unified_companion_projection_aborted",
  );
  assert.equal(reads, 6);
});

test("semantic open target is stable by default and accepts only reviewed identities", () => {
  assert.equal(configuredSemanticOpenTarget({}), PRODUCT_BRAND.appOpenURL);
  assert.equal(
    configuredSemanticOpenTarget({
      USAGE_MONITOR_APP_OPEN_URL: PREVIEW_PRODUCT_BRAND.appOpenURL,
    }),
    PREVIEW_PRODUCT_BRAND.appOpenURL,
  );
  for (const value of [
    "",
    "https://attacker.example/open",
    "usagemonitor-preview://other",
  ]) {
    assert.throws(
      () => configuredSemanticOpenTarget({
        USAGE_MONITOR_APP_OPEN_URL: value,
      }),
      /must match a reviewed product identity/u,
    );
  }
});

function fakeStore() {
  let reloads = 0;
  const paceOutlook = {
    schemaVersion: "local-weekly-pace-outlook-v0.1",
    status: "unavailable",
    standing: null,
    critical: false,
    earlyEstimate: false,
    remainingPercent: null,
    resetsAt: null,
    observationCount: 0,
    elapsedHours: null,
    rates: {
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
      headlinePercentagePointsPerHour: null,
      sustainablePercentagePointsPerHour: null,
      ratio: null,
    },
    projection: {
      hoursToReset: null,
      coveredHours: null,
      dryHours: null,
      sparePercent: null,
      projectedExhaustionAt: null,
    },
    track: {
      coveredFraction: null,
      activeExhaustionFraction: null,
    },
  };
  return {
    async initialize() {},
    async reload() {
      reloads += 1;
    },
    getOverview() {
      return {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        mode: "real_local_evidence",
        evidenceStatus: "available",
      };
    },
    getDesktopShellDisplayEvidence() {
      return null;
    },
    getGradient() {
      return { status: "available", datasets: { rolling: [{ quota_change_pp: 3 }] } };
    },
    getWeekly() {
      return {
        status: "available",
        datasets: { summary: [{ median_weekly_value_usd: 100 }] },
        allowanceHistoryByWindow: {
          300: {
            status: "available",
            datasets: {
              summary: [{ median_weekly_value_usd: 10 }],
              weekly_values: [{ sequence: 1, value_usd: 10 }],
            },
          },
        },
      };
    },
    getWeeklyPaceOutlook() {
      return structuredClone(paceOutlook);
    },
    getQuality() {
      return { status: "available", datasets: { summary: [{ known_speed_fraction: 0.8 }] } };
    },
    getReports() {
      return { schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION, reports: [] };
    },
    get reloads() {
      return reloads;
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-companion-server-"));
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  const codexHome = join(root, "home", ".codex");
  const staticRoot = join(resourceRoot, "public");
  createProtectedFixtureDirectory(stateRoot);
  await mkdir(staticRoot, { recursive: true });
  await mkdir(join(codexHome, "sessions"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(codexHome, "archived_sessions"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(codexHome, "sessions", "rollout-fixture.jsonl"),
    `${JSON.stringify({ type: "session_meta" })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(staticRoot, "index.html"),
    `<!doctype html><meta name="usage-monitor-semantic-open-target" content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}"><title>TiboTattle</title>`,
  );
  await writeFile(join(staticRoot, "app.js"), "export const app = true;");
  await writeFile(join(staticRoot, "data-client.js"), "export const client = true;");
  await writeFile(join(staticRoot, "lib.js"), "export const lib = true;");
  await writeFile(join(staticRoot, "model-performance.js"), "export const performance = true;");
  await writeFile(join(staticRoot, "dashboard-report-preload.js"), "export const preload = true;");
  await writeFile(join(staticRoot, "model-performance.css"), ".model-performance { color: black; }");
  await writeFile(
    join(staticRoot, "localization.js"),
    "export const localization = true;",
  );
  await writeFile(
    join(staticRoot, "telemetry-shared.generated.js"),
    "export const telemetry = true;",
  );
  await writeFile(
    join(staticRoot, "telemetry-envelope.js"),
    "export const envelope = true;",
  );
  await writeFile(join(staticRoot, "styles.css"), "body { color: black; }");
  await writeFile(
    join(staticRoot, "tibotattle-icon.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  for (const [fileName, title] of [
    ["2026-07-24-simple-quota-gradient-report.html", "Gradient detail"],
    ["2026-07-24-weekly-7-day-calibration-report.html", "Weekly detail"],
    ["2026-07-24-monitoring-quality-report.html", "Quality detail"],
    ["2026-07-24-codex-work-account-usage-report.html", "Multi-surface detail"],
  ]) {
    await writeFile(
      join(resourceRoot, fileName),
      `<!doctype html><title>${title}</title>`,
    );
  }
  return { root, resourceRoot, stateRoot, codexHome, staticRoot };
}


function rawRequest({ port, path, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", rejectRequest);
    request.end(body);
  });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("condition was not reached");
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function processIsRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

const WATCHDOG_PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeSync } = require("node:fs");
const child = spawn(
  process.execPath,
  [process.env.WATCHDOG_SERVER_PATH],
  {
    cwd: process.env.USAGE_MONITOR_RESOURCE_ROOT,
    env: {
      ...process.env,
      USAGE_MONITOR_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
writeSync(1, \`WATCHDOG_CHILD_PID=\${child.pid}\\n\`);
let pending = "";
let ready = false;
child.stdout.on("data", (chunk) => {
  writeSync(1, chunk);
  pending += chunk.toString("utf8");
  if (!ready && pending.includes("USAGE_MONITOR_READY")) {
    ready = true;
    setTimeout(() => process.exit(0), 25);
  }
});
child.stderr.on("data", (chunk) => writeSync(2, chunk));
child.once("exit", () => {
  if (!ready) process.exit(2);
});
setTimeout(() => process.exit(3), 15_000);
`;

test("loopback server exposes only fixed API, static, and report routes", async () => {
  const files = await fixture();
  const store = fakeStore();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const health = await fetch(`${base}/api/local/health`);
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).capabilities, {
      localDashboard: true,
      explicitRefresh: true,
      arbitraryPathAccess: false,
      remoteProxy: false,
    });
    assert.equal(health.headers.get("access-control-allow-origin"), null);
    assert.match(health.headers.get("content-security-policy"), /default-src 'none'/);

    await app.snapshotReady;
    const desktopStatus = await fetch(`${base}/api/local/desktop-status`);
    assert.equal(desktopStatus.status, 200);
    assert.deepEqual(await desktopStatus.json(), {
      schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
      state: "unavailable",
      allowance: null,
      notificationEvidence: null,
    });
    assert.equal((await fetch(`${base}/api/local/desktop-status`, {
      method: "POST",
    })).status, 405);

    // The removed contribution feature leaves no tombstone or settings file
    // behind: startup creates the single-instance lock and nothing else.
    assert.deepEqual(await readdir(join(files.stateRoot, "private")), [
      "automatic-contribution-v0.1.lock",
    ]);

    const onboarding = await fetch(`${base}/api/local/onboarding`);
    assert.equal(onboarding.status, 200);
    assert.deepEqual(await onboarding.json(), {
      schemaVersion: "local-onboarding-v0.2",
      status: "ready",
      source: {
        status: "ready",
        sessionsReadable: true,
        archivedSessionsReadable: true,
        rolloutFilesPresent: true,
        rolloutFilesObserved: 1,
        rolloutFilesObservedCapped: false,
      },
      state: {
        status: "ready",
        writable: true,
      },
      capabilities: {
        explicitRefresh: true,
        customCodexHomeConfigured: false,
        rawContentExposed: false,
        arbitraryPathAccess: false,
      },
    });
    assert.equal((await fetch(`${base}/api/local/onboarding`, {
      method: "POST",
    })).status, 405);

    const overview = await fetch(`${base}/api/local/overview`);
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).mode, "real_local_evidence");

    const weekly = await fetch(`${base}/api/local/weekly`);
    assert.equal(weekly.status, 200);
    assert.equal(
      (await weekly.json()).weekly.allowanceHistoryByWindow[300]
        .datasets.weekly_values.length,
      1,
    );

    const paceOutlook = await fetch(`${base}/api/local/weekly-pace-outlook`);
    assert.equal(paceOutlook.status, 200);
    assert.equal(
      (await paceOutlook.json()).weekly.paceOutlook.schemaVersion,
      "local-weekly-pace-outlook-v0.1",
    );
    assert.equal((await fetch(`${base}/api/local/weekly-pace-outlook`, {
      method: "POST",
    })).status, 405);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const pageBody = await page.text();
    assert.match(pageBody, /TiboTattle/);
    assert.match(
      pageBody,
      new RegExp(
        `content="${PRODUCT_BRAND.appOpenURL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`,
        "u",
      ),
    );
    assert.doesNotMatch(pageBody, new RegExp(SEMANTIC_OPEN_TARGET_PLACEHOLDER, "u"));
    assert.equal((await fetch(`${base}/data-client.js`)).status, 200);
    assert.equal((await fetch(`${base}/localization.js`)).status, 200);
    for (const [path, type] of [
      ["model-performance.js", "text/javascript; charset=utf-8"],
      ["dashboard-report-preload.js", "text/javascript; charset=utf-8"],
      ["model-performance.css", "text/css; charset=utf-8"],
    ]) {
      const asset = await fetch(`${base}/${path}`);
      assert.equal(asset.status, 200, path);
      assert.equal(asset.headers.get("content-type"), type, path);
    }
    assert.equal(
      (await fetch(`${base}/telemetry-shared.generated.js`)).status,
      200,
    );
    const brandIcon = await fetch(`${base}/tibotattle-icon.png`);
    assert.equal(brandIcon.status, 200);
    assert.equal(brandIcon.headers.get("content-type"), "image/png");

    for (const [route, title] of [
      ["gradient", "Gradient detail"],
      ["weekly", "Weekly detail"],
      ["quality", "Quality detail"],
      ["multi-surface", "Multi-surface detail"],
    ]) {
      const report = await fetch(`${base}/reports/${route}`);
      assert.equal(report.status, 200, route);
      assert.match(await report.text(), new RegExp(title, "u"), route);
    }
    const privateReportDirectory = join(
      files.resourceRoot,
      ".usage-monitor",
      "legacy-reports",
    );
    await mkdir(privateReportDirectory, { recursive: true });
    await writeFile(
      join(privateReportDirectory, "2026-07-24-simple-quota-gradient-report.html"),
      "<!doctype html><title>Canonical gradient detail</title>",
      { mode: 0o600 },
    );
    const canonicalReport = await fetch(`${base}/reports/gradient`);
    assert.equal(canonicalReport.status, 200);
    assert.match(await canonicalReport.text(), /Canonical gradient detail/);

    for (const retiredPath of [
      "/api/local/claude/quota",
      "/api/local/reports",
      "/api/local/contribution/preview",
      "/api/local/contribution/sync-once",
      "/api/local/contribution/sync-pause",
      "/api/local/contribution/sync-resume",
      "/api/local/contribution/automatic-settings",
      "/api/local/contribution/automatic-enable",
      "/api/local/contribution/automatic-disable",
      "/api/local/contribution/prepare",
      "/api/local/contribution/sync-status",
      "/api/local/contribution/sync-next",
      "/api/local/contribution/device-pair",
      "/api/local/contribution/device-disconnect",
      "/api/local/contribution/device-credential-reset",
      "/api/local/contribution/sync-inspect-exact",
      "/api/local/contribution/incremental-status",
      "/api/local/contribution/incremental-review-v11",
      "/api/local/contribution/incremental-review-v12",
      "/api/local/contribution/incremental-approve",
      "/api/local/contribution/incremental-run",
      "/api/local/performance/status",
      "/api/local/performance/review",
      "/api/local/performance/approve",
      "/api/local/diagnostics/contribution",
      "/api/local/identity/hosted-signin-handoff",
    ]) {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`${base}${retiredPath}`, {
          method,
          ...(method === "POST"
            ? {
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }
            : {}),
        });
        assert.equal(response.status, 404, `${method} ${retiredPath}`);
        assert.equal(
          (await response.json()).error.code,
          "not_found",
          `${method} ${retiredPath}`,
        );
      }
    }

    assert.equal((await fetch(`${base}/reports/gradient`, {
      method: "POST",
    })).status, 405);

    assert.equal((await fetch(`${base}/reports/not-allowed`)).status, 404);
    assert.equal((await fetch(`${base}/api/local/not-allowed`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/local/overview?path=/Users/private`)).status, 400);

    await writeFile(
      join(files.staticRoot, "index.html"),
      "<!doctype html><title>Unstamped</title>",
    );
    assert.equal((await fetch(`${base}/index.html`)).status, 404);
    await writeFile(
      join(files.staticRoot, "index.html"),
      `<meta content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}"><meta content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}">`,
    );
    assert.equal((await fetch(`${base}/index.html`)).status, 404);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("preview companion stamps only the preview semantic-open route", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    environment: {
      ...process.env,
      USAGE_MONITOR_APP_OPEN_URL: PREVIEW_PRODUCT_BRAND.appOpenURL,
    },
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const page = await fetch(`http://127.0.0.1:${app.port}/`);
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.match(body, new RegExp(PREVIEW_PRODUCT_BRAND.appOpenURL, "u"));
    assert.doesNotMatch(body, new RegExp(PRODUCT_BRAND.appOpenURL, "u"));
    assert.doesNotMatch(
      body,
      new RegExp(SEMANTIC_OPEN_TARGET_PLACEHOLDER, "u"),
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("window-breakdown route bounds its range and returns a per-model/speed shape", async () => {
  const files = await fixture();
  const requests = [];
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    // Injected so the route's validation and shaping are exercised without a
    // real unified index on disk. A caller asking for an inverted range is
    // rejected by the reader with a typed code the route maps to 400.
    windowBreakdownProvider: async ({ fromMs, toMs }) => {
      requests.push({ fromMs, toMs });
      if (toMs <= fromMs) {
        const error = new Error("window range is invalid");
        error.code = "window_range_invalid";
        throw error;
      }
      return {
        status: "available",
        errorCode: null,
        schemaVersion: "local-window-breakdown-v0.1",
        from: fromMs,
        to: toMs,
        events: 12,
        unpricedEvents: 0,
        unpricedShare: 0,
        costUsd: 34.5,
        tokens: 6_000,
        fastCostUsd: 0,
        fastEvents: 0,
        byModel: [
          { model: "gpt-5.6-sol", costUsd: 34.5, tokens: 6_000, events: 12, unpricedEvents: 0, unpricedShare: 0, fastModeFamily: "gpt-5.6", fastModeMultiplier: 2.5 },
        ],
        bySpeed: { standard: { speed: "standard", costUsd: 34.5, tokens: 6_000, events: 12, unpricedEvents: 0, unpricedShare: 0 } },
        spark: { events: 0, costUsd: 0 },
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const route = `${base}/api/local/timeline/window-breakdown`;

    // A well-formed bounded window returns the breakdown, and the exact integer
    // parameters reach the provider.
    const ok = await fetch(`${route}?from=1000&to=2000`);
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.schemaVersion, LOCAL_COMPANION_SCHEMA_VERSION);
    assert.equal(payload.breakdown.status, "available");
    assert.equal(payload.breakdown.byModel[0].model, "gpt-5.6-sol");
    assert.deepEqual(requests.at(-1), { fromMs: 1000, toMs: 2000 });

    // Missing, non-integer, and float parameters never reach the provider.
    const before = requests.length;
    assert.equal((await fetch(route)).status, 400);
    assert.equal((await fetch(`${route}?from=1000`)).status, 400);
    assert.equal((await fetch(`${route}?from=1.5&to=2000`)).status, 400);
    assert.equal((await fetch(`${route}?from=abc&to=2000`)).status, 400);
    // An unexpected extra parameter is refused rather than ignored.
    assert.equal((await fetch(`${route}?from=1000&to=2000&path=/x`)).status, 400);
    assert.equal(requests.length, before);

    // A provider that rejects an inverted range maps to a 400 with its code.
    const bad = await fetch(`${route}?from=2000&to=1000`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "window_range_invalid");

    // The route is GET-only.
    assert.equal((await fetch(route, { method: "POST" })).status, 405);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("cache-drop thread links are private, transient, query-free local reads", async () => {
  const files = await fixture();
  const store = fakeStore();
  const requests = [];
  const privateName = "Synthetic local thread name";
  const threadId = "11111111-1111-4111-8111-111111111111";
  let fail = false;
  const overviewBefore = structuredClone(store.getOverview());
  const payload = {
    schemaVersion: "local-cache-drop-thread-links-v1",
    status: "available",
    generation: "7",
    entries: [{ kind: "switch", key: "synthetic-anonymous-pair", thread: {
      id: threadId, name: privateName, nickname: null, parent: null,
    } }],
  };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => ({}),
    cacheDropThreadLinksProvider: async (options) => {
      requests.push(options);
      if (fail) throw new Error(privateName);
      return payload;
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const route = `${base}/api/local/cache-drop-thread-links`;
    const headers = { "X-Usage-Monitor-Local": "1" };
    // Missing header, foreign origin, arbitrary identifiers/paths and methods
    // are refused before the metadata provider is called.
    assert.equal((await fetch(route)).status, 403);
    assert.equal((await fetch(route, { headers: {
      ...headers, Origin: "https://example.invalid",
    } })).status, 403);
    assert.equal((await fetch(`${route}?id=${threadId}`, { headers })).status, 400);
    assert.equal((await fetch(`${route}?path=elsewhere`, { headers })).status, 400);
    for (const method of ["POST", "DELETE", "OPTIONS"]) {
      const response = await fetch(route, { method, headers });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    const rebind = await rawRequest({
      port: app.port, path: "/api/local/cache-drop-thread-links",
      headers: { ...headers, Host: `example.invalid:${app.port}` },
    });
    assert.equal(rebind.status, 403);
    assert.equal(requests.length, 0);

    // Same-origin browser GETs normally omit Origin; explicit matching Origin
    // is allowed too. Both reads get an independent current snapshot input.
    for (const admitted of [headers, { ...headers, Origin: base }]) {
      const response = await fetch(route, { headers: admitted });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.deepEqual(await response.json(), payload);
    }
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], { overview: overviewBefore });
    assert.deepEqual(store.getOverview(), overviewBefore);
    assert.equal(store.reloads, 0);
    for (const publicRoute of [
      "/api/local/overview", "/api/local/gradient", "/api/local/weekly",
      "/api/local/quality", "/reports/gradient", "/reports/weekly",
    ]) {
      const response = await fetch(`${base}${publicRoute}`);
      assert.equal(response.status, 200, publicRoute);
      const body = await response.text();
      assert.equal(body.includes(privateName), false, publicRoute);
      assert.equal(body.includes(threadId), false, publicRoute);
    }

    // Metadata failures are optional unavailability, not refresh failure or
    // filesystem diagnostics. In particular, do not echo provider errors.
    fail = true;
    const unavailable = await fetch(route, { headers });
    assert.equal(unavailable.status, 200);
    assert.deepEqual(await unavailable.json(), {
      schemaVersion: "local-cache-drop-thread-links-v1",
      status: "unavailable", generation: null, entries: [],
    });
    assert.equal(store.reloads, 0);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("local companion remains usable before Codex is installed", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: join(files.root, "no-codex-home-yet"),
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const onboarding = await fetch(
      `http://127.0.0.1:${app.port}/api/local/onboarding`,
    );
    assert.equal(onboarding.status, 200);
    assert.deepEqual(await onboarding.json(), {
      schemaVersion: "local-onboarding-v0.2",
      status: "needs_attention",
      source: {
        status: "codex_home_missing",
        sessionsReadable: false,
        archivedSessionsReadable: false,
        rolloutFilesPresent: false,
        rolloutFilesObserved: 0,
        rolloutFilesObservedCapped: false,
      },
      state: {
        status: "ready",
        writable: true,
      },
      capabilities: {
        explicitRefresh: true,
        customCodexHomeConfigured: false,
        rawContentExposed: false,
        arbitraryPathAccess: false,
      },
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("startup and shutdown never read, rewrite or delete preserved contribution-era state", async () => {
  const files = await fixture();
  const privateRoot = join(files.stateRoot, "private");
  const preserved = {
    "automatic-contribution-v0.1.json": JSON.stringify({
      schemaVersion: "automatic-contribution-settings-v0.4",
      enabled: true,
      consent: "synthetic-consent",
      destinationOrigin: "https://legacy.invalid",
    }),
    "incremental-contribution-sync-v1.json": "{\"synthetic\":true}",
    "contribution-sync-v0.1.sqlite3": "synthetic queue bytes",
  };
  createProtectedFixtureDirectory(privateRoot);
  for (const [name, text] of Object.entries(preserved)) {
    writeInitialProtectedFixtureFile(join(privateRoot, name), text);
  }
  const before = await Promise.all(Object.keys(preserved).map(async (name) => {
    const file = join(privateRoot, name);
    const info = await lstat(file);
    return [name, await readFile(file, "utf8"), info.mtimeMs, info.size];
  }));
  let first;
  let restarted;
  const options = {
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  };
  try {
    first = await startLocalCompanionServer(options);
    await first.snapshotReady;
    await first.close();
    first = null;
    restarted = await startLocalCompanionServer({ ...options, dataStore: fakeStore() });
    await restarted.snapshotReady;
    await restarted.close();
    restarted = null;
    for (const [name, text, mtimeMs, size] of before) {
      const file = join(privateRoot, name);
      const info = await lstat(file);
      assert.equal(await readFile(file, "utf8"), text, name);
      assert.equal(info.mtimeMs, mtimeMs, name);
      assert.equal(info.size, size, name);
    }
    assert.deepEqual((await readdir(privateRoot)).sort(), Object.keys(preserved).sort());
  } finally {
    await restarted?.close();
    await first?.close();
    await rm(files.root, { recursive: true });
  }
});

test("one state root cannot run concurrently while the instance lock is held", async () => {
  const files = await fixture();
  let first;
  let restarted;
  const options = {
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  };
  const lockFile = join(
    files.stateRoot,
    "private",
    "automatic-contribution-v0.1.lock",
  );
  try {
    first = await startLocalCompanionServer(options);
    let snapshotSettled = false;
    first.snapshotReady.then(() => {
      snapshotSettled = true;
    });
    await waitFor(() => snapshotSettled);
    await assert.rejects(
      startLocalCompanionServer({
        ...options,
        dataStore: fakeStore(),
      }),
      (error) =>
        error?.code === "companion_instance_active",
    );
    assert.equal((await lstat(lockFile)).isFile(), true);

    await first.close();
    first = null;
    await assert.rejects(
      lstat(lockFile),
      (error) => error?.code === "ENOENT",
    );

    restarted = await startLocalCompanionServer({
      ...options,
      dataStore: fakeStore(),
    });
    await restarted.snapshotReady;
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${restarted.port}/api/local/health`,
      )).status,
      200,
    );
  } finally {
    await restarted?.close();
    await first?.close();
    await rm(files.root, { recursive: true });
  }
});

test("a startup snapshot failure files one content-free server diagnostic note", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  const privateMessage = "private startup detail /Users/example/session.jsonl";
  const initializationError = new Error(privateMessage);
  initializationError.code = "private_startup_detail";
  let app;
  try {
    app = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: {
        ...fakeStore(),
        async initialize() {
          throw initializationError;
        },
      },
      refreshRunner: async () => ({}),
      diagnosticsLogFile,
      diagnosticReferenceFactory: () => "TT-4HJ7M2",
      clock: () => Date.parse("2026-09-08T14:30:00.000Z"),
      port: 0,
    });

    await assert.rejects(
      app.snapshotReady,
      (error) => error === initializationError,
    );
    const recorded = await readFile(diagnosticsLogFile, "utf8");
    assert.equal(recorded.includes(privateMessage), false);
    assert.equal(recorded.includes(initializationError.code), false);
    assert.deepEqual(
      recorded.trimEnd().split("\n").map((line) => JSON.parse(line)),
      [{
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-09-08T14:30:00.000Z",
        reference: "TT-4HJ7M2",
        surface: "local_startup",
        code: "snapshot_unavailable",
        requestId: "",
        step: "data_store",
        detail: "unexpected_error",
      }],
    );
    assert.deepEqual(LOCAL_STARTUP_DIAGNOSTIC_STEPS, [
      "data_store",
    ]);
    assert.equal(
      LOCAL_STARTUP_DIAGNOSTIC_DETAILS.includes(
        "local_collector_state_migration_busy",
      ),
      true,
    );
    assert.equal(
      LOCAL_STARTUP_DIAGNOSTIC_DETAILS.includes("unexpected_error"),
      true,
    );
  } finally {
    await app?.close();
    await rm(files.root, { recursive: true });
  }
});

test("a failed startup diagnostic recorder preserves the original error and shutdown", async () => {
  const files = await fixture();
  const initializationError = new Error("private source startup failure");
  initializationError.code = "collector_invalid_size";
  let recorderCalls = 0;
  let stopCalls = 0;
  let app;
  const instanceLockAcquirer = async (options) => {
    const lock = await acquireCompanionInstanceLock(options);
    return {
      async release() {
        stopCalls += 1;
        await lock.release();
      },
    };
  };
  try {
    app = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: {
        ...fakeStore(),
        async initialize() {
          throw initializationError;
        },
      },
      refreshRunner: async () => ({}),
      diagnosticReferenceFactory: () => "TT-4HJ7M2",
      diagnosticNoteRecorder: async (note) => {
        recorderCalls += 1;
        assert.deepEqual(note, {
          reference: "TT-4HJ7M2",
          surface: "local_startup",
          code: "snapshot_unavailable",
          requestId: "",
          step: "data_store",
          detail: "collector_invalid_size",
        });
        throw new Error("private recorder failure");
      },
      instanceLockAcquirer,
      port: 0,
    });

    await assert.rejects(
      app.snapshotReady,
      (error) => error === initializationError,
    );
    assert.equal(recorderCalls, 1);
    assert.equal(stopCalls, 1);
    assert.deepEqual(app.snapshotStatus(), {
      status: "failed",
      errorCode: "collector_invalid_size",
    });
  } finally {
    await app?.close();
    await rm(files.root, { recursive: true });
  }
});

test("a successful startup does not mint or file a startup diagnostic note", async () => {
  const files = await fixture();
  let app;
  try {
    app = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: fakeStore(),
      refreshRunner: async () => ({}),
      diagnosticReferenceFactory: () => {
        throw new Error("startup diagnostic reference must not be minted");
      },
      diagnosticNoteRecorder: async () => {
        throw new Error("startup diagnostic note must not be recorded");
      },
      port: 0,
    });

    await app.snapshotReady;
    assert.deepEqual(app.snapshotStatus(), { status: "ready", errorCode: null });
  } finally {
    await app?.close();
    await rm(files.root, { recursive: true });
  }
});

test("close drains workers before releasing the listener and remains idempotent after failure", async () => {
  for (const failClose of [false, true]) {
    const files = await fixture();
    const closeStarted = deferred();
    const closeBarrier = deferred();
    const closeError = new Error("synthetic worker shutdown failure");
    let closeCalls = 0;
    let refreshCalls = 0;
    let app;
    const sharedProjectionReader = async () => {};
    sharedProjectionReader.close = async () => {
      closeCalls += 1;
      closeStarted.resolve();
      await closeBarrier.promise;
      if (failClose) throw closeError;
    };
    try {
      app = await startLocalCompanionServer({
        resourceRoot: files.resourceRoot,
        stateRoot: files.stateRoot,
        codexHome: files.codexHome,
        staticRoot: files.staticRoot,
        dataStore: fakeStore(),
        refreshRunner: async () => { refreshCalls += 1; return {}; },
        sharedProjectionReader,
        port: 0,
      });
      await app.snapshotReady;
      const closing = app.close();
      assert.equal(app.close(), closing);
      await closeStarted.promise;
      assert.equal(app.server.listening, true);
      assert.equal(closeCalls, 1);
      const base = `http://127.0.0.1:${app.port}`;
      for (const [path, options] of [
        ["/api/local/overview", {}],
        ["/api/local/refresh", {
          method: "POST",
          headers: { Origin: base, "Content-Type": "application/json", "X-Usage-Monitor-Local": "1" },
          body: "{}",
        }],
      ]) {
        const response = await fetch(`${base}${path}`, options);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error.code, "server_shutting_down");
      }
      assert.equal((await fetch(`${base}/api/local/refresh`, {
        method: "POST", headers: { Origin: "https://invalid.example" }, body: "{}",
      })).status, 403);
      assert.equal(refreshCalls, 0);
      closeBarrier.resolve();
      if (failClose) await assert.rejects(closing, (error) => error === closeError);
      else await closing;
      assert.equal(app.server.listening, false);
      assert.equal(app.close(), closing);
      assert.equal(closeCalls, 1);
    } finally {
      closeBarrier.resolve();
      await app?.close().catch(() => {});
      await rm(files.root, { recursive: true });
    }
  }
});

test("initialization failure retains the instance lock until idempotent runtime shutdown finishes", async () => {
  const files = await fixture();
  const releaseStarted = deferred();
  const cleanupBarrier = deferred();
  const initializationError = new Error("simulated initialization failure");
  let releaseCalls = 0;
  let restarted;
  let failedStart;
  let observedFailure;
  const instanceLockAcquirer = async (options) => {
    const lock = await acquireCompanionInstanceLock(options);
    return {
      async release() {
        releaseCalls += 1;
        releaseStarted.resolve();
        await cleanupBarrier.promise;
        await lock.release();
      },
    };
  };
  const lockFile = join(files.stateRoot, "private", "automatic-contribution-v0.1.lock");
  const baseOptions = {
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    refreshRunner: async () => ({}),
    port: 0,
  };
  try {
    failedStart = await startLocalCompanionServer({
      ...baseOptions,
      dataStore: {
        ...fakeStore(),
        async initialize() {
          throw initializationError;
        },
      },
      instanceLockAcquirer,
    });
    observedFailure = assert.rejects(
      failedStart.snapshotReady,
      (error) => error === initializationError,
    );
    await releaseStarted.promise;
    assert.equal(releaseCalls, 1);

    const failedHealth = await fetch(
      `http://127.0.0.1:${failedStart.port}/api/local/health`,
    ).then((response) => response.json());
    assert.equal(failedHealth.status, "ready");
    assert.equal(failedHealth.snapshot.status, "failed");
    const failedOverview = await fetch(
      `http://127.0.0.1:${failedStart.port}/api/local/overview`,
    );
    assert.equal(failedOverview.status, 503);
    assert.equal((await failedOverview.json()).error.code, "snapshot_unavailable");

    await assert.rejects(
      startLocalCompanionServer({
        ...baseOptions,
        dataStore: fakeStore(),
      }),
      (error) => error?.code === "companion_instance_active",
    );
    assert.equal(releaseCalls, 1);

    cleanupBarrier.resolve();
    await observedFailure;
    observedFailure = null;
    await failedStart.close();
    failedStart = null;
    assert.equal(releaseCalls, 1);
    await assert.rejects(lstat(lockFile), (error) => error?.code === "ENOENT");

    restarted = await startLocalCompanionServer({
      ...baseOptions,
      dataStore: fakeStore(),
    });
    await restarted.snapshotReady;
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${restarted.port}/api/local/health`,
      )).status,
      200,
    );
  } finally {
    cleanupBarrier.resolve();
    await Promise.allSettled([
      observedFailure,
      failedStart?.close(),
      restarted?.close(),
    ].filter(Boolean));
    await rm(files.root, { recursive: true });
  }
});

test("the port and readiness answer before the first snapshot is built", async () => {
  const files = await fixture();
  const buildStarted = deferred();
  const buildBarrier = deferred();
  const store = fakeStore();
  let initializationOptions;
  let app;
  try {
    const startedAt = Date.now();
    app = await startLocalCompanionServer({
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: {
        ...store,
        async initialize(options) {
          initializationOptions = options;
          buildStarted.resolve();
          await buildBarrier.promise;
        },
      },
      refreshRunner: async () => ({}),
      port: 0,
    });
    const base = `http://127.0.0.1:${app.port}`;
    await buildStarted.promise;
    assert.deepEqual(initializationOptions, { purpose: "startup" });

    // Listening, and honest about what is not ready yet. Before the port moved
    // ahead of the build this request could not even be sent: a real install
    // spends seconds here, and a rejected accounting cache spends long enough
    // to exceed the launcher's own startup budget and have the companion
    // killed before it could finish.
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.equal(health.status, "ready");
    assert.deepEqual(health.snapshot, { status: "building", errorCode: null });
    assert.ok(
      Date.now() - startedAt < 5_000,
      "readiness must answer without waiting for the snapshot build",
    );
    assert.equal((await fetch(`${base}/`)).status, 200);

    // A route that reads the snapshot waits for the build rather than
    // projecting a half-built one.
    let overviewSettled = false;
    const overview = fetch(`${base}/api/local/overview`)
      .then((response) => {
        overviewSettled = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(overviewSettled, false);

    buildBarrier.resolve();
    assert.equal((await overview).status, 200);
    await app.snapshotReady;
    assert.deepEqual(
      (await fetch(`${base}/api/local/health`)
        .then((response) => response.json())).snapshot,
      { status: "ready", errorCode: null },
    );
  } finally {
    buildBarrier.resolve();
    await app?.close();
    await rm(files.root, { recursive: true });
  }
});

test("startup snapshot defers unified history until an explicit full refresh", async () => {
  const files = await fixture();
  const projectionModes = [];
  let fullRefreshRequested = false;
  let app;
  try {
    app = await startLocalCompanionServer({
      environment: {},
      resourceRoot: files.resourceRoot,
      stateRoot: files.stateRoot,
      homeDirectory: join(files.root, "home"),
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      accountingSourceMode: "unified",
      codexSpeedBaseline: { readWindows: async () => [] },
      unifiedProjectionReader: async (options) => {
        projectionModes.push(options.mode);
        if (options.mode === "full" && !fullRefreshRequested) {
          throw new Error("startup_must_not_build_full_projection");
        }
        return readLocalIndexProjection(options);
      },
      refreshRunner: async () => ({}),
      port: 0,
    });
    await app.snapshotReady;
    const base = `http://127.0.0.1:${app.port}`;
    assert.deepEqual(projectionModes, ["deferred"]);
    const health = await fetch(`${base}/api/local/health`)
      .then((response) => response.json());
    assert.deepEqual(health.snapshot, { status: "ready", errorCode: null });
    const response = await fetch(`${base}/api/local/overview`);
    assert.equal(response.status, 200);
    const overview = await response.json();
    assert.equal(overview.accounting.generationMatched, false);
    assert.equal(overview.accounting.projection.status, "unavailable");
    assert.equal(
      overview.accounting.projection.reason,
      "local_unified_index_deferred",
    );
    assert.deepEqual(overview.timeline.usage, []);
    assert.equal(overview.timeline.history.status, "loading");

    fullRefreshRequested = true;
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: "{}",
    });
    assert.equal(started.status, 202);
    await waitFor(async () => {
      const payload = await fetch(`${base}/api/local/refresh`)
        .then((result) => result.json());
      return payload.refresh.status === "succeeded";
    });
    assert.deepEqual(projectionModes, ["deferred", "full"]);
  } finally {
    await app?.close();
    await rm(files.root, { recursive: true });
  }
});

test("server rejects forged hosts and requires same-origin refresh authorization", async () => {
  const files = await fixture();
  const store = fakeStore();
  let resolveRefresh;
  const refreshGate = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => {
      await refreshGate;
      return {
        rolloutRecordsWritten: 2,
        filesDiscovered: 3,
        privatePath: "/Users/private",
        quotaRefresh: { attempted: true, recordWritten: true },
      };
    },
    port: 0,
  });
  try {
    const forgedHost = await rawRequest({
      port: app.port,
      path: "/api/local/health",
      headers: { Host: "attacker.example" },
    });
    assert.equal(forgedHost.status, 403);
    assert.equal(JSON.parse(forgedHost.body).error.code, "host_not_allowed");

    const base = `http://127.0.0.1:${app.port}`;
    const unauthorized = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 403);

    const authorizedHeaders = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: JSON.stringify({ reason: "user_request" }),
    });
    assert.equal(started.status, 202);
    const startedPayload = await started.json();
    assert.equal(startedPayload.refresh.status, "running");
    assert.match(
      startedPayload.refresh.refreshId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const duplicate = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(duplicate.status, 409);
    const duplicatePayload = await duplicate.json();
    assert.equal(
      duplicatePayload.refresh.refreshId,
      startedPayload.refresh.refreshId,
    );
    resolveRefresh();
    await waitFor(async () => {
      const status = await fetch(`${base}/api/local/refresh`).then((response) => response.json());
      return status.refresh.status === "succeeded";
    });
    const completed = await fetch(`${base}/api/local/refresh`).then((response) => response.json());
    assert.equal(completed.refresh.refreshId, startedPayload.refresh.refreshId);
    assert.deepEqual(completed.refresh.result, {
      rolloutRecordsWritten: 2,
      filesDiscovered: 3,
      quotaRefresh: { attempted: true, recordWritten: true, errorCode: null },
    });
    assert.equal(JSON.stringify(completed).includes("/Users/private"), false);
    assert.equal(store.reloads, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("desktop status route projects refresh lifecycle without dashboard payloads", async () => {
  const files = await fixture();
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  const notificationEvidence = {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt: new Date(now).toISOString(),
    continuityKey: "a".repeat(43),
    windows: [{
      lane: "primary",
      usedPercent: 26,
      durationMinutes: 300,
      resetAt: "2026-08-25T15:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
    }],
  };
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => {
      await refreshGate;
      return {
        notificationEvidence,
        privatePath: "/Users/private",
      };
    },
    clock: () => now,
    port: 0,
  });
  try {
    await app.snapshotReady;
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(started.status, 202);

    const analyzing = await fetch(`${base}/api/local/desktop-status`);
    assert.equal(analyzing.status, 200);
    assert.deepEqual(await analyzing.json(), {
      schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
      state: "analyzing",
      allowance: null,
      notificationEvidence: null,
    });

    releaseRefresh();
    await waitFor(async () => {
      const response = await fetch(`${base}/api/local/refresh`);
      return (await response.json()).refresh.status === "succeeded";
    });
    const completed = await fetch(`${base}/api/local/refresh`)
      .then((response) => response.json());
    assert.deepEqual(completed.refresh.result?.notificationEvidence, notificationEvidence);
    const fresh = await fetch(`${base}/api/local/desktop-status`);
    assert.equal(fresh.status, 200);
    const freshPayload = await fresh.json();
    assert.deepEqual(freshPayload, {
      schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
      state: "fresh",
      allowance: {
        source: "direct",
        window: "five_hour",
        remainingPercent: 74,
      },
      notificationEvidence,
    });
    assert.equal(JSON.stringify(freshPayload).includes("rollout"), false);
    assert.equal(JSON.stringify(freshPayload).includes("/Users/private"), false);
    assert.equal((await fetch(`${base}/api/local/desktop-status`, {
      method: "POST",
    })).status, 405);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("desktop status route serves cached current overview evidence without a completed refresh or notification evidence", async () => {
  const files = await fixture();
  const now = Date.parse("2026-09-05T12:00:00.000Z");
  const store = fakeStore();
  let overviewReads = 0;
  let displayReads = 0;
  store.getOverview = () => {
    overviewReads += 1;
    throw new Error("desktop status must not clone the full overview");
  };
  store.getDesktopShellDisplayEvidence = () => {
    displayReads += 1;
    return Object.freeze({
      evidenceStatus: "available",
      freshness: Object.freeze({ status: "live", staleAfterSeconds: 1_800 }),
      windows: Object.freeze([Object.freeze({
        durationMinutes: 10_080,
        slot: "primary",
        usedPercent: 100,
        remainingPercent: 0,
        observedAt: "2026-09-05T11:59:00.000Z",
        resetAt: "2026-09-05T15:00:00.000Z",
      })]),
    });
  };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async () => ({}),
    clock: () => now,
    port: 0,
  });
  try {
    await app.snapshotReady;
    const response = await fetch(
      `http://127.0.0.1:${app.port}/api/local/desktop-status`,
    );
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.deepEqual(status, {
      schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
      state: "fresh",
      allowance: {
        source: "direct",
        window: "seven_day",
        remainingPercent: 0,
      },
      notificationEvidence: null,
      displayEvidence: {
        schemaVersion: "tibotattle-display-evidence-v1", scopeKey: null, staleAfterSeconds: 1800,
        windows: [{ durationMinutes: 10080, remainingPercent: 0,
          observedAt: "2026-09-05T11:59:00.000Z", resetAt: "2026-09-05T15:00:00.000Z" }],
      },
    });
    assert.equal(displayReads, 1);
    assert.equal(overviewReads, 0);
    assert.equal(JSON.stringify(status).includes("continuity"), false);
    assert.equal(JSON.stringify(status).includes("openai_codex"), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("loopback quick refresh is separately authorized and selects the quick controller mode", async () => {
  const files = await fixture();
  const store = fakeStore();
  const modes = [];
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: async ({ mode }) => {
      modes.push(mode);
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 0,
        quotaRefresh: {
          attempted: true,
          recordWritten: false,
          errorCode: null,
        },
      };
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const unauthorized = await fetch(`${base}/api/local/refresh/quick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 403);

    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const started = await fetch(`${base}/api/local/refresh/quick`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "user_request" }),
    });
    assert.equal(started.status, 202);
    await waitFor(async () => {
      const status = await fetch(`${base}/api/local/refresh`)
        .then((response) => response.json());
      return status.refresh.status === "succeeded";
    });
    assert.deepEqual(modes, ["quick"]);
    assert.equal(store.reloads, 1);
    assert.equal(
      (await fetch(`${base}/api/local/refresh/quick`)).status,
      405,
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("loopback refresh publishes a rollout quarantine as degraded verified coverage", async () => {
  const files = await fixture();
  const generation = {
    id: 9,
    fingerprint: "d".repeat(64),
    status: "partial",
    blockReason: "codex_rollout_sources_quarantined",
    discoveredSourceCount: 3,
    discoveredSourceBytes: 3_000,
    indexedSourceCount: 1,
    indexedSourceBytes: 1_000,
    skippedSourceCount: 2,
    skippedSourceBytes: 2_000,
    skippedThreadCount: 1,
    issueCounts: {
      codex_rollout_generation_ambiguous: {
        threadCount: 1,
        sourceCount: 2,
        sourceBytes: 2_000,
      },
    },
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({
      unifiedIndex: {
        status: "ingested",
        generation,
      },
    }),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: "{}",
    });
    assert.equal(started.status, 202);
    await waitFor(async () => {
      const payload = await fetch(`${base}/api/local/refresh`)
        .then((response) => response.json());
      return payload.refresh.status === "degraded";
    });
    const payload = await fetch(`${base}/api/local/refresh`)
      .then((response) => response.json());
    assert.equal(payload.refresh.status, "degraded");
    assert.equal(payload.refresh.errorCode, "refresh_degraded");
    assert.equal(payload.refresh.failedStep, "unified_index");
    assert.equal(
      payload.refresh.failureCode,
      "codex_rollout_generation_ambiguous",
    );
    assert.deepEqual(payload.refresh.result.unifiedIndex.generation, {
      id: 9,
      fingerprint: "d".repeat(64),
      status: "partial",
      blockReason: "codex_rollout_sources_quarantined",
      schemaVersion: null,
      parserVersion: null,
      contractVersion: null,
      coveredAt: { startAt: null, endAt: null },
      sourceCount: 1,
      sourceBytes: 1_000,
      discoveredSourceCount: 3,
      discoveredSourceBytes: 3_000,
      indexedSourceCount: 1,
      indexedSourceBytes: 1_000,
      skippedSourceCount: 2,
      skippedSourceBytes: 2_000,
      skippedThreadCount: 1,
      reasonCounts: {
        codex_rollout_generation_ambiguous: 1,
      },
      usageEvents: 0,
      quotaOccurrences: 0,
      toolFacts: 0,
      toolFactFingerprint: null,
      discoveryComplete: true,
      diagnosticsComplete: true,
      usageProvenanceComplete: true,
      sourceOrderComplete: true,
      quotaProvenanceComplete: true,
      toolProvenanceComplete: true,
    });
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("server exposes an authorized cancellation without reloading deep state", async () => {
  const files = await fixture();
  const store = fakeStore();
  let observedAbort = false;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: store,
    refreshRunner: ({ signal, onProgress }) => new Promise((resolve) => {
      onProgress({
        mode: "recent_7d",
        status: "recent_7d_indexing",
        phase: "rollout_index",
        boundedBy: "modified_at_and_collection_start",
        filesDiscovered: 3,
        filesSelected: 3,
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: {
          startAt: "2026-07-16T12:00:00.000Z",
          endAt: null,
        },
      });
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({
          rolloutRecordsWritten: 2,
          filesDiscovered: 3,
          indexing: {
            mode: "recent_7d",
            status: "bounded_pause",
            phase: "paused",
            boundedBy: "modified_at_and_collection_start",
            filesDiscovered: 3,
            filesSelected: 3,
            filesProcessed: 1,
            recordsWritten: 2,
            coveredAt: {
              startAt: "2026-07-16T12:00:00.000Z",
              endAt: null,
            },
          },
        });
      }, { once: true });
    }),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const authorizedHeaders = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const started = await fetch(`${base}/api/local/refresh`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(started.status, 202);

    const unauthorizedCancel = await fetch(
      `${base}/api/local/refresh/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unauthorizedCancel.status, 403);

    const cancelled = await fetch(`${base}/api/local/refresh/cancel`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(cancelled.status, 202);
    assert.equal((await cancelled.json()).refresh.status, "cancelling");

    await waitFor(async () => {
      const status = await fetch(`${base}/api/local/refresh`)
        .then((response) => response.json());
      return status.refresh.status === "cancelled";
    });
    const status = await fetch(`${base}/api/local/refresh`)
      .then((response) => response.json());
    assert.equal(observedAbort, true);
    assert.equal(status.refresh.errorCode, "refresh_cancelled");
    assert.equal(status.refresh.progress.status, "bounded_pause");
    assert.equal(store.reloads, 0);

    const duplicateCancel = await fetch(`${base}/api/local/refresh/cancel`, {
      method: "POST",
      headers: authorizedHeaders,
      body: "{}",
    });
    assert.equal(duplicateCancel.status, 409);
    assert.equal(
      (await duplicateCancel.json()).error.code,
      "refresh_not_running",
    );
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});


test("production root environment keeps writable state outside resources", async () => {
  const files = await fixture();
  const environment = {
    HOME: join(files.root, "home"),
    USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
  };
  const resourceEntriesBefore = await readdir(files.resourceRoot);
  const app = await startLocalCompanionServer({
    environment,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    assert.equal(
      (await fetch(`${base}/api/local/health`)).status,
      200,
    );
    assert.deepEqual(
      await readdir(files.resourceRoot),
      resourceEntriesBefore,
    );
    assert.deepEqual(
      await readdir(join(files.stateRoot, "private")),
      ["automatic-contribution-v0.1.lock"],
    );
    if (process.platform !== "win32") {
      assert.equal((await lstat(files.stateRoot)).mode & 0o777, 0o700);
    }
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("retired Claude Desktop configuration cannot activate collection", async () => {
  const files = await fixture();
  let invoked = false;
  try {
    const app = createLocalCompanionServer({
      environment: { USERPROFILE: files.root, CLAUDE_CONFIG_DIR: "relative-config", CLAUDE_PROJECT_DIR: "relative-project" },
      resourceRoot: files.resourceRoot, stateRoot: files.stateRoot, codexHome: files.codexHome,
      staticRoot: files.staticRoot, dataStore: fakeStore(), refreshRunner: async () => ({}),
      claudeShadowEnabled: true,
      claudeShadowControllerFactory() { invoked = true; throw new Error("Retired collection must not run"); },
    });
    assert.equal(app.server.listening, false);
    assert.equal(invoked, false);
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("production root environment rejects unsafe roots before listen", async () => {
  const files = await fixture();
  const resourceLink = join(files.root, "resource-link");
  const stateTarget = join(files.root, "state-target");
  const stateLink = join(files.root, "state-link");
  await symlink(files.resourceRoot, resourceLink);
  await mkdir(stateTarget, { mode: 0o700 });
  await symlink(stateTarget, stateLink);
  const assertInvalid = async (environment) => {
    await assert.rejects(
      startLocalCompanionServer({
        environment,
        dataStore: fakeStore(),
        refreshRunner: async () => ({}),
        port: 0,
      }),
      (error) => error?.code
          === "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID"
        && error.message
          === "Local installation configuration is invalid"
        && !error.message.includes(files.root)
        && !JSON.stringify(error).includes(files.root),
    );
  };
  try {
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: "relative-resource",
      USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    });
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
      USAGE_MONITOR_STATE_ROOT: "relative-state",
    });
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: resourceLink,
      USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    });
    await assertInvalid({
      HOME: join(files.root, "home"),
      USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
      USAGE_MONITOR_STATE_ROOT: stateLink,
    });
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("parent watchdog accepts only the exact live parent PID", async () => {
  const files = await fixture();
  const invalidValues = [
    "",
    "0",
    "1",
    "01",
    "+2",
    ` ${process.ppid}`,
    `${process.ppid} `,
    "2147483648",
    String(process.pid),
    null,
    123,
  ];
  try {
    for (const [index, value] of invalidValues.entries()) {
      const stateRoot = join(files.root, `invalid-parent-${index}`);
      await assert.rejects(
        startLocalCompanionServer({
          environment: {
            HOME: join(files.root, "home"),
            USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
            USAGE_MONITOR_STATE_ROOT: stateRoot,
            USAGE_MONITOR_PARENT_PID: value,
          },
          codexHome: files.codexHome,
          staticRoot: files.staticRoot,
          dataStore: fakeStore(),
          refreshRunner: async () => ({}),
          port: 0,
        }),
        (error) => error?.code === "USAGE_MONITOR_PARENT_PID_INVALID"
          && error.message === "Parent watchdog configuration is invalid"
          && (String(value).length === 0
            || (!error.message.includes(String(value))
              && !JSON.stringify(error).includes(String(value)))),
      );
      await assert.rejects(lstat(stateRoot));
    }

    const app = await startLocalCompanionServer({
      environment: {
        HOME: join(files.root, "home"),
        USAGE_MONITOR_RESOURCE_ROOT: files.resourceRoot,
        USAGE_MONITOR_STATE_ROOT: files.stateRoot,
        USAGE_MONITOR_PARENT_PID: String(process.ppid),
      },
      codexHome: files.codexHome,
      staticRoot: files.staticRoot,
      dataStore: fakeStore(),
      refreshRunner: async () => ({}),
      port: 0,
    });
    try {
      const healthUrl =
        `http://127.0.0.1:${app.port}/api/local/health`;
      assert.equal((await fetch(healthUrl)).status, 200);
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      assert.equal((await fetch(healthUrl)).status, 200);
    } finally {
      await app.close();
    }
  } finally {
    await rm(files.root, { recursive: true });
  }
});

test("configured CLI exits after its declared parent disappears", async () => {
  const files = await fixture();
  const parentEnvironment = {
    ...process.env,
    WATCHDOG_SERVER_PATH: resolve("apps/local/server.js"),
    USAGE_MONITOR_PORT: "0",
    USAGE_MONITOR_RESOURCE_ROOT: process.cwd(),
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    HOME: join(files.root, "home"),
    CODEX_HOME: files.codexHome,
  };
  delete parentEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN;
  delete parentEnvironment.USAGE_MONITOR_PARENT_PID;
  const parent = spawn(
    process.execPath,
    ["--input-type=commonjs", "-e", WATCHDOG_PARENT_SCRIPT],
    {
      cwd: files.root,
      env: parentEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  let childPid = null;
  parent.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
    const observed = Number(
      output.match(/WATCHDOG_CHILD_PID=([1-9][0-9]*)/u)?.[1],
    );
    if (Number.isSafeInteger(observed)) childPid = observed;
  });
  parent.stderr.on("data", (chunk) => {
    errors += chunk.toString("utf8");
  });
  try {
    const [code, signal] = await once(parent, "exit");
    assert.equal(signal, null);
    assert.equal(code, 0, errors);
    assert.equal(Number.isSafeInteger(childPid), true);
    const url = output.match(
      /USAGE_MONITOR_READY (http:\/\/127\.0\.0\.1:\d+\/)/u,
    )?.[1];
    assert.ok(url);
    await waitFor(() => !processIsRunning(childPid), 5_000);
    await assert.rejects(fetch(url, {
      signal: AbortSignal.timeout(1_000),
    }));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGKILL");
      await once(parent, "exit");
    }
    if (Number.isSafeInteger(childPid) && processIsRunning(childPid)) {
      process.kill(childPid, "SIGKILL");
    }
    await rm(files.root, { recursive: true });
  }
});

// Hosted sign-in used to redirect back to a loopback callback served here,
// which handed the one-time code to the dashboard through localStorage. Both
// providers now redirect to the contribution service's own callback, so this
// origin must receive no provider redirect at all: the route is gone, and the
// blanket refusal of query strings — which that route was the sole exception
// to — covers every path again.
test("no provider redirect can land on the loopback companion", async () => {
  const files = await fixture();
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const carrying = await fetch(
      `${base}/oauth/google/callback?code=CANARY-code&state=CANARY-state`,
    );
    assert.equal(carrying.status, 400);
    assert.equal((await carrying.text()).includes("CANARY"), false);
    assert.equal(
      (await fetch(`${base}/oauth/google/callback`)).status,
      404,
    );
    assert.equal((await fetch(`${base}/oauth/google/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })).status, 404);
    assert.equal(
      (await fetch(`${base}/oauth/google/callback/extra`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/api/v1/identity/google/callback?code=CANARY-code`))
        .status,
      400,
    );
    assert.equal((await fetch(`${base}/?code=CANARY-code`)).status, 400);
    assert.equal(
      (await fetch(`${base}/api/local/health?code=CANARY-code`)).status,
      400,
    );

    // Nothing served by this companion mentions the retired localStorage relay
    // key, so no page here can complete a sign-in out of browser storage.
    const source = await readFile(
      new URL("./server.js", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("tibotattle-google-oauth-result"), false);
    assert.equal(source.includes("/oauth/google/callback"), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("CLI port zero prints its actual ready URL and honors explicit roots", async () => {
  const files = await fixture();
  const childEnvironment = {
    ...process.env,
    USAGE_MONITOR_PORT: "0",
    USAGE_MONITOR_RESOURCE_ROOT: process.cwd(),
    USAGE_MONITOR_STATE_ROOT: files.stateRoot,
    HOME: join(files.root, "home"),
    CODEX_HOME: files.codexHome,
  };
  delete childEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN;
  delete childEnvironment.USAGE_MONITOR_PARENT_PID;
  const child = spawn(process.execPath, [resolve("apps/local/server.js")], {
    cwd: files.root,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  try {
    await waitFor(() => output.includes("USAGE_MONITOR_READY"), 15_000);
    const url = output.match(
      /USAGE_MONITOR_READY (http:\/\/127\.0\.0\.1:\d+\/)/u,
    )?.[1];
    assert.ok(url);
    assert.notEqual(new URL(url).port, "0");
    const health = await fetch(new URL("/api/local/health", url));
    assert.equal(health.status, 200);
    const onboarding = await fetch(
      new URL("/api/local/onboarding", url),
    ).then((response) => response.json());
    assert.equal(onboarding.status, "ready");
    assert.equal(JSON.stringify(onboarding).includes(files.root), false);
    child.kill("SIGINT");
    const [code, signal] = await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("local companion did not exit after SIGINT")),
          2_000,
        );
      }),
    ]);
    assert.ok(code === 0 || signal === "SIGINT");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(files.root, { recursive: true });
  }
});

test("diagnostic notes are bounded, fixed-vocabulary, and land in a local log", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  let now = Date.parse("2026-08-01T09:00:00.000Z");
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile,
    clock: () => now,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const note = {
      reference: "TT-7QF3K2",
      surface: "local_refresh",
      code: "snapshot_unavailable",
      requestId: "",
    };

    // Loopback alone is not authority: the dashboard header and same origin
    // are both required before anything is written.
    const unauthorized = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(note),
    });
    assert.equal(unauthorized.status, 403);
    assert.deepEqual(await unauthorized.json(), {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "diagnostic_note_not_authorized" },
    });
    assert.equal((await fetch(`${base}/api/local/diagnostics/note`)).status, 405);

    const recorded = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify(note),
    });
    assert.equal(recorded.status, 200);
    assert.deepEqual(await recorded.json(), {
      schemaVersion: "local-diagnostic-note-v0.1",
      status: "recorded",
      reference: "TT-7QF3K2",
    });

    now = Date.parse("2026-08-01T09:05:00.000Z");
    await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        reference: "TT-ZZ0011",
        surface: "local_refresh",
        code: "INTERNAL_ERROR",
        requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      }),
    });

    const lines = (await readFile(diagnosticsLogFile, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-01T09:00:00.000Z",
        reference: "TT-7QF3K2",
        surface: "local_refresh",
        code: "snapshot_unavailable",
        requestId: "",
      },
      {
        schemaVersion: "local-diagnostic-note-v0.1",
        recordedAt: "2026-08-01T09:05:00.000Z",
        reference: "TT-ZZ0011",
        surface: "local_refresh",
        code: "INTERNAL_ERROR",
        requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      },
    ]);
    if (process.platform !== "win32") {
      assert.equal((await lstat(diagnosticsLogFile)).mode & 0o777, 0o600);
    }

    // Only the fixed vocabulary is accepted, so a free-form label, a sentence
    // masquerading as a code, or an extra member can never be logged.
    for (const invalid of [
      { ...note, surface: "arbitrary_journey" },
      // Surfaces of the removed contribution journeys are no longer accepted.
      { ...note, surface: "contribution_connect" },
      { ...note, surface: "hosted_identity" },
      // Server-minted startup evidence is never a dashboard-selectable route.
      { ...note, surface: "local_startup" },
      { ...note, reference: "TT-ILLEGAL" },
      { ...note, reference: "not-a-reference" },
      { ...note, code: "Failed reading /Users/private/state.json" },
      { ...note, requestId: "not-a-uuid" },
      { ...note, extra: "unexpected" },
    ]) {
      const rejected = await fetch(`${base}/api/local/diagnostics/note`, {
        method: "POST",
        headers,
        body: JSON.stringify(invalid),
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, "invalid_request");
    }
    const oversized = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...note, code: "a".repeat(4_096) }),
    });
    assert.equal(oversized.status, 413);
    const recordedText = await readFile(diagnosticsLogFile, "utf8");
    assert.equal(recordedText.includes("/Users/private"), false);
    assert.equal(recordedText.includes("arbitrary_journey"), false);
    assert.equal(recordedText.split("\n").filter(Boolean).length, 2);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("a terminal refresh failure files one bounded, rate-limited diagnostics note", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  const now = Date.parse("2026-08-11T09:00:00.000Z");
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => {
      // The incident shape: a typed accounting resource stop escaping the
      // accounting step with content in its message that must never land in
      // the log.
      const error = new Error("private failure detail /Users/private");
      error.code = "accounting_transition_rss_limit_exceeded";
      error.refreshStep = "accounting";
      throw error;
    },
    diagnosticsLogFile,
    clock: () => now,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Usage-Monitor-Local": "1",
      Origin: base,
    };
    const runOnce = async () => {
      const started = await fetch(`${base}/api/local/refresh`, {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(started.status, 202);
      const { refresh } = await started.json();
      await waitFor(async () => {
        const status = await fetch(`${base}/api/local/refresh`)
          .then((response) => response.json());
        return status.refresh.refreshId === refresh.refreshId
          && status.refresh.status === "failed";
      });
    };

    await runOnce();
    await waitFor(async () => {
      try {
        return (await readFile(diagnosticsLogFile, "utf8")).includes("\n");
      } catch {
        return false;
      }
    });
    const status = await fetch(`${base}/api/local/refresh`)
      .then((response) => response.json());
    assert.equal(status.refresh.errorCode, "refresh_resource_limited");

    const lines = (await readFile(diagnosticsLogFile, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0].reference, /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u);
    assert.deepEqual({ ...lines[0], reference: null }, {
      schemaVersion: "local-diagnostic-note-v0.1",
      recordedAt: "2026-08-11T09:00:00.000Z",
      reference: null,
      surface: "local_refresh",
      code: "refresh_resource_limited",
      requestId: "",
      step: "accounting",
      detail: "accounting_transition_rss_limit_exceeded",
    });

    // The identical failure again inside the hour: the terminal state is
    // fully reported, but the log gains no second line — a failure loop can
    // never grow it unboundedly.
    await runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const repeated = await readFile(diagnosticsLogFile, "utf8");
    assert.equal(repeated.trimEnd().split("\n").length, 1);
    assert.equal(repeated.includes("private failure detail"), false);
    assert.equal(repeated.includes("/Users/private"), false);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("failed diagnostic note writes return a fixed error without leaking recorder details", async () => {
  const files = await fixture();
  let calls = 0;
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile: join(files.stateRoot, "diagnostics-v0.1.log"),
    diagnosticNoteRecorder: async () => {
      calls += 1;
      throw new Error("private diagnostic recorder detail");
    },
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({
        reference: "TT-7QF3K2",
        surface: "local_refresh",
        code: "snapshot_unavailable",
        requestId: "",
      }),
    });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.deepEqual(payload, {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      error: { code: "diagnostic_note_not_recorded" },
    });
    assert.equal(JSON.stringify(payload).includes("private diagnostic recorder detail"), false);
    assert.equal(calls, 1);
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});

test("the diagnostics log is bounded and keeps one previous generation", async () => {
  const files = await fixture();
  const diagnosticsLogFile = join(files.stateRoot, "diagnostics-v0.1.log");
  await mkdir(files.stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(diagnosticsLogFile, "x".repeat(256 * 1024), { mode: 0o600 });
  const app = await startLocalCompanionServer({
    resourceRoot: files.resourceRoot,
    stateRoot: files.stateRoot,
    codexHome: files.codexHome,
    staticRoot: files.staticRoot,
    dataStore: fakeStore(),
    refreshRunner: async () => ({}),
    diagnosticsLogFile,
    port: 0,
  });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const recorded = await fetch(`${base}/api/local/diagnostics/note`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1",
        Origin: base,
      },
      body: JSON.stringify({
        reference: "TT-ABCDEF",
        surface: "local_refresh",
        code: "refresh_in_progress",
        requestId: "",
      }),
    });
    assert.equal(recorded.status, 200);
    const rotated = await lstat(`${diagnosticsLogFile}.previous`);
    assert.equal(rotated.size, 256 * 1024);
    const current = await readFile(diagnosticsLogFile, "utf8");
    assert.equal(current.split("\n").filter(Boolean).length, 1);
    assert.equal(JSON.parse(current).reference, "TT-ABCDEF");
  } finally {
    await app.close();
    await rm(files.root, { recursive: true });
  }
});
