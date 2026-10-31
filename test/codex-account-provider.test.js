import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import * as accountFacade from "../src/providers/codex/account.js";
import * as accountScope from "../src/providers/codex/account-scope.js";
import * as appServer from "../src/providers/codex/app-server.js";
import {
  sanitizeProviderQuotaLimitDisplayName,
  sanitizeProviderQuotaLimitId,
} from "../src/providers/codex/quota-metadata.js";
import {
  sanitizeQuotaLimitDisplayName,
  sanitizeQuotaLimitId,
} from "@app-usagemonitor/quota-analysis";

const EXPECTED_PUBLIC_EXPORTS = [
  "CodexAppServerClient",
  "CodexAppServerError",
  "OPENAI_ACCOUNT_SCOPE_VERSION",
  "codexAppServerChildEnv",
  "deriveOpenAIAccountScope",
  "deriveOpenAIAccountScopeWithSecretLoader",
  "findCodexBinary",
  "inspectCodexBinary",
  "readCodexAccountSnapshot",
  "sanitizeAccountScope",
  "sanitizeBracketedCodexAccountSnapshotWithSecretLoader",
  "sanitizeCodexAccountSnapshot",
  "sanitizeCodexAccountSnapshotWithSecretLoader",
  "sanitizePlanType",
  "sanitizeRateLimit",
  "volatileResetCreditInventory",
];

test("Codex account facade exposes only reviewed exports with exact identities", () => {
  assert.deepEqual(Object.keys(accountFacade).sort(), EXPECTED_PUBLIC_EXPORTS);
  for (const name of EXPECTED_PUBLIC_EXPORTS) {
    assert.equal(
      accountFacade[name],
      accountScope[name] ?? appServer[name],
      name,
    );
  }
  assert.equal(accountFacade.OPENAI_ACCOUNT_SCOPE_PREFIX, undefined);
});

test("account-change protocol notifications expose only an invalidation signal", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString("utf8"));
      if (request.method === "initialize") {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
      }
      done();
    },
  });
  child.kill = () => true;
  const client = new accountFacade.CodexAppServerClient({ spawnProcess: () => child });
  const notifications = [];
  client.on("accountChanged", (...args) => notifications.push(args));
  try {
    await client.start();
    for (const method of ["account/updated", "account/login/completed"]) {
      child.stdout.write(`${JSON.stringify({ method, params: { accountId: "DO-NOT-LEAK", email: "synthetic@example.test", loginId: "DO-NOT-LEAK" } })}\n`);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notifications, [[], []]);
  } finally {
    client.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

test("Codex binary diagnostics preserve selection precedence without exposing paths", async () => {
  const privateOverride = "/private/codex-builds/review/codex";
  const diagnostic = await accountFacade.inspectCodexBinary({
    environment: { CODEX_BIN: privateOverride },
    statFile: async (candidate) => {
      assert.equal(candidate, privateOverride);
      return { isFile: () => true };
    },
    accessFile: async (candidate, mode) => {
      assert.equal(candidate, privateOverride);
      assert.equal(mode, fsConstants.X_OK);
    },
    readVersion: async (candidate) => {
      assert.equal(candidate, privateOverride);
      return "codex-cli 0.149.1\n";
    },
  });

  assert.deepEqual(diagnostic, {
    schemaVersion: "codex-binary-diagnostic-v0.2",
    source: "environment_override",
    location: "explicit_override",
    versionStatus: "available",
    version: "0.149.1",
  });
  assert.equal(JSON.stringify(diagnostic).includes(privateOverride), false);
});

test("Codex binary diagnostics fail closed on malformed or unavailable versions", async () => {
  const diagnostic = await accountFacade.inspectCodexBinary({
    environment: {},
    statFile: async () => ({ isFile: () => false }),
    readVersion: async (candidate) => {
      assert.equal(candidate, "codex");
      return "private warning with /Users/someone/project";
    },
  });

  assert.deepEqual(diagnostic, {
    schemaVersion: "codex-binary-diagnostic-v0.2",
    source: "path",
    location: "path",
    versionStatus: "unavailable",
    version: null,
  });
});



function windowsDiscoveryFixture() {
  const local = join(tmpdir(), "synthetic-codex-local");
  const root = join(local, "OpenAI", "Codex", "bin");
  const path = join(local, "cli");
  const entries = ["old", "middle", "newest", "older"];
  const probes = [];
  const files = new Set(entries.map(name => join(root, name, "codex.exe")));
  const versions = new Map([...files].map(file => [file, "codex-cli 0.162.0\n"]));
  const options = {
    platform: "win32", environment: { LOCALAPPDATA: local, Path: path },
    statFile: async candidate => ({ isFile: () => files.has(candidate) }),
    accessFile: async () => {},
    readDirectory: async () => entries.map(name => ({ name, isDirectory: () => true, isSymbolicLink: () => false })),
    lstatFile: async candidate => ({
      isDirectory: () => !candidate.endsWith(".exe"), isFile: () => files.has(candidate),
      isSymbolicLink: () => false,
      mtimeMs: { old: 2, middle: 3, newest: 4, older: 1 }[candidate.split(/[\\/]/u).at(-1)] ?? 0,
    }),
    resolvePath: async candidate => candidate,
    readVersion: async candidate => { probes.push(candidate); return versions.get(candidate) ?? "invalid"; },
  };
  return { root, path, options, files, versions, probes };
}

test("Windows Codex discovery prioritizes override and working PATH before recent desktop candidates", async () => {
  const fixture = windowsDiscoveryFixture();
  const override = join(fixture.path, "override.exe");
  fixture.files.add(override);
  assert.equal(await accountFacade.findCodexBinary({ ...fixture.options,
    environment: { ...fixture.options.environment, CODEX_BIN: override } }), override);
  assert.deepEqual(fixture.probes, []);
  const pathBinary = join(fixture.path, "codex.exe");
  fixture.files.add(pathBinary);
  fixture.versions.set(pathBinary, "codex-cli 0.162.0");
  assert.equal(await accountFacade.findCodexBinary(fixture.options), pathBinary);
  fixture.files.delete(pathBinary);
  assert.equal(await accountFacade.findCodexBinary(fixture.options), join(fixture.root, "newest", "codex.exe"));
});

test("Windows Codex desktop discovery is limited to three recent candidates and rejects escaped paths", async () => {
  const fixture = windowsDiscoveryFixture();
  fixture.versions.clear();
  assert.equal(await accountFacade.findCodexBinary(fixture.options), "codex");
  assert.deepEqual(fixture.probes, ["newest", "middle", "old"].map(name => join(fixture.root, name, "codex.exe")));
  fixture.probes.length = 0;
  fixture.options.resolvePath = async candidate => candidate.endsWith(".exe") ? join(tmpdir(), "outside", "codex.exe") : candidate;
  assert.equal(await accountFacade.findCodexBinary(fixture.options), "codex");
  assert.deepEqual(fixture.probes, []);
  fixture.options.resolvePath = async candidate => candidate;
  fixture.options.lstatFile = async () => ({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => true });
  assert.equal(await accountFacade.findCodexBinary(fixture.options), "codex");
  assert.deepEqual(fixture.probes, []);
});

test("Windows discovery enforces one shared probe budget", async () => {
  const fixture = windowsDiscoveryFixture();
  let time = 0;
  fixture.options.now = () => time;
  fixture.options.readVersion = async (candidate, { timeoutMs }) => {
    assert.equal(timeoutMs, 5_000);
    fixture.probes.push(candidate); time += 5_000;
    throw new Error("timeout");
  };
  assert.equal(await accountFacade.findCodexBinary(fixture.options), "codex");
  assert.equal(fixture.probes.length, 1);
});

test("Windows discovery returns the PATH fallback when the desktop install directory is absent", async () => {
  const fixture = windowsDiscoveryFixture();
  let directoryReads = 0;
  fixture.options.readDirectory = async () => {
    directoryReads += 1;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  assert.equal(await accountFacade.findCodexBinary(fixture.options), "codex");
  assert.equal(directoryReads, 1);
});

test("Windows discovery rejects symlinked version directories and executable files", async () => {
  for (const target of ["version-directory", "executable-file"]) {
    const fixture = windowsDiscoveryFixture();
    const newestDirectory = join(fixture.root, "newest");
    const newestBinary = join(newestDirectory, "codex.exe");
    const originalLstat = fixture.options.lstatFile;
    fixture.options.lstatFile = async candidate => {
      if ((target === "version-directory" && candidate === newestDirectory)
          || (target === "executable-file" && candidate === newestBinary)) {
        return {
          isDirectory: () => target === "version-directory",
          isFile: () => target === "executable-file",
          isSymbolicLink: () => true,
          mtimeMs: 4,
        };
      }
      return originalLstat(candidate);
    };
    const middleBinary = join(fixture.root, "middle", "codex.exe");
    assert.equal(await accountFacade.findCodexBinary(fixture.options), middleBinary, target);
    assert.deepEqual(fixture.probes, [middleBinary], target);
  }
});

test("Windows discovery reuses a valid cache, invalidates removed files, and honors forced rediscovery", async () => {
  const fixture = windowsDiscoveryFixture();
  fixture.options.binaryCache = {};
  const newest = join(fixture.root, "newest", "codex.exe");
  const middle = join(fixture.root, "middle", "codex.exe");
  assert.equal(await accountFacade.findCodexBinary(fixture.options), newest);
  assert.equal(await accountFacade.findCodexBinary(fixture.options), newest);
  assert.deepEqual(fixture.probes, [newest]);
  fixture.files.delete(newest);
  assert.equal(await accountFacade.findCodexBinary(fixture.options), middle);
  fixture.files.add(newest);
  assert.equal(await accountFacade.findCodexBinary({ ...fixture.options, forceRefresh: true }), newest);
  assert.deepEqual(fixture.probes, [newest, middle, newest]);
});

test("Windows discovery skips malformed versions, missing candidates, and redirected installation roots", async () => {
  const fixture = windowsDiscoveryFixture();
  const newest = join(fixture.root, "newest", "codex.exe");
  fixture.versions.set(newest, "private malformed output");
  fixture.files.delete(join(fixture.root, "middle", "codex.exe"));
  assert.equal(await accountFacade.findCodexBinary(fixture.options), join(fixture.root, "old", "codex.exe"));
  fixture.probes.length = 0;
  fixture.options.resolvePath = async candidate => candidate === fixture.root ? join(tmpdir(), "redirected") : candidate;
  assert.equal(await accountFacade.findCodexBinary(fixture.options), "codex");
  assert.deepEqual(fixture.probes, []);
});

test("Codex startup rediscovers exactly once on synchronous ENOENT and not on other spawn errors", async () => {
  for (const errorCode of ["ENOENT", "EACCES"]) {
    const selections = [];
    let starts = 0;
    const client = new accountFacade.CodexAppServerClient({
      findBinary: async options => { selections.push(options.forceRefresh); return "synthetic-codex"; },
      spawnProcess: () => { starts += 1; throw Object.assign(new Error("startup failed"), { code: errorCode }); },
    });
    await assert.rejects(client.start(), { code: errorCode === "ENOENT" ? "app_server_unavailable" : "temporary_disconnect" });
    assert.equal(starts, errorCode === "ENOENT" ? 2 : 1);
    assert.deepEqual(selections, errorCode === "ENOENT" ? [false, true] : [false]);
    client.close();
  }
});

test("Codex startup does not rediscover after authentication or protocol initialization errors", async () => {
  for (const { label, response } of [
    { label: "authentication", response: { error: { code: -32000, message: "authentication required" } } },
    { label: "protocol", response: { error: { code: -32600, message: "invalid initialize request" } } },
  ]) {
    const selections = [];
    let starts = 0;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString("utf8"));
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`));
        done();
      },
    });
    child.kill = () => true;
    const client = new accountFacade.CodexAppServerClient({
      findBinary: async options => { selections.push(options.forceRefresh); return "synthetic-codex"; },
      spawnProcess: () => { starts += 1; return child; },
    });
    try {
      const failure = await client.start().then(() => null, error => error);
      assert.ok(failure, label);
      assert.notEqual(failure.code, "app_server_unavailable", label);
      assert.equal(starts, 1, label);
      assert.deepEqual(selections, [false], label);
    } finally {
      client.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("Codex startup recovers asynchronous ENOENT without admitting a stale child exit", async () => {
  const selections = [];
  let starts = 0;
  let firstChild;
  let secondChild;
  const disconnects = [];
  const client = new accountFacade.CodexAppServerClient({
    findBinary: async options => { selections.push(options.forceRefresh); return "synthetic-codex"; },
    spawnProcess: () => {
      starts += 1;
      const fails = starts === 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true;
      if (fails) firstChild = child;
      else secondChild = child;
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString());
        queueMicrotask(() => fails
          ? child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }))
          : child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
        done();
      } });
      return child;
    },
  });
  client.on("disconnect", event => disconnects.push(event));
  try {
    await client.start();
    assert.equal(starts, 2);
    assert.deepEqual(selections, [false, true]);
    assert.equal(client.child, secondChild);
    const disconnectCountAfterRetry = disconnects.length;
    firstChild.emit("exit", 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disconnects.length, disconnectCountAfterRetry);
    assert.deepEqual(await client.readAccount(), {});
  } finally {
    client.close();
    for (const child of [firstChild, secondChild]) {
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
    }
  }
});

test("rate-limit sanitation retains provider duration and fails closed on plan evidence", () => {
  const sanitized = accountFacade.sanitizeRateLimit({
    limitId: "codex",
    limitName: "Codex allowance",
    planType: "pro-20x",
    primary: {
      usedPercent: 12,
      windowDurationMins: 43_200,
      resetsAt: 1_788_048_360,
    },
    secondary: {
      usedPercent: 20,
      windowDurationMins: 10_080,
      resetsAt: 1_786_061_160,
    },
  });

  assert.equal(sanitized.planType, "unknown");
  assert.equal(accountFacade.sanitizeRateLimit({
    limitId: "codex",
    planType: "promax",
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_788_048_360 },
    secondary: { usedPercent: 21, windowDurationMins: 10_080, resetsAt: 1_788_048_360 },
  }).planType, "promax");
  assert.equal(sanitized.limitName, "Codex allowance");
  assert.equal(sanitized.primary.windowDurationMins, 43_200);
  assert.equal(sanitized.secondary.windowDurationMins, 10_080);
  assert.equal(
    accountFacade.sanitizeRateLimit({
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 10, windowDurationMins: 525_601, resetsAt: 1_788_048_360 },
    }).primary,
    null,
  );
  assert.equal(
    accountFacade.sanitizeRateLimit({
      limitId: "future_pool",
      limitName: "Account alice@example.com",
      planType: "pro",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_788_048_360 },
    }).limitName,
    null,
  );
  assert.equal(
    accountFacade.sanitizeRateLimit({
      limitName: "Future Pool",
      planType: "pro",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_788_048_360 },
    }, "future_pool").limitId,
    "future_pool",
  );
  assert.equal(
    accountFacade.sanitizeRateLimit({
      limitId: "future/pool",
      limitName: "Future Pool",
      planType: "pro",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_788_048_360 },
    }).limitId,
    "unknown",
  );
});

test("provider quota metadata validation stays in parity with canonical analysis rules", () => {
  for (const value of [
    undefined,
    null,
    "",
    "codex",
    "codex_bengalfox",
    "future.pool:v2",
    "future/pool",
    `x${"y".repeat(63)}`,
    `x${"y".repeat(64)}`,
  ]) {
    assert.equal(
      sanitizeProviderQuotaLimitId(value),
      sanitizeQuotaLimitId(value),
      String(value),
    );
  }

  for (const value of [
    undefined,
    null,
    "",
    " Future Pool ",
    "Cuota futura",
    "未来プール 2",
    "Account alice@example.com",
    "https://example.com/pool",
    "<Future Pool>",
    `P${"o".repeat(79)}`,
    `P${"o".repeat(80)}`,
  ]) {
    assert.equal(
      sanitizeProviderQuotaLimitDisplayName(value),
      sanitizeQuotaLimitDisplayName(value),
      String(value),
    );
  }
});

async function withRateLimitServer(respond, run, { timeoutMs = undefined } = {}) {
  const requests = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(chunk.toString("utf8"));
      if (request.id !== undefined) {
        const response = request.method === "initialize" ? { result: {} } : respond(request, requests.length);
        if (request.method !== "initialize") requests.push(request);
        if (response !== null) {
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`));
        }
      }
      done();
    },
  });
  child.kill = () => true;
  const client = new accountFacade.CodexAppServerClient({ timeoutMs, spawnProcess: () => child });
  try {
    await client.start();
    await run(client, requests, child);
  } finally {
    client.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

test("concurrent quota reads are serialized per app-server client", async () => {
  await withRateLimitServer((_request, index) => index === 0 ? null : { result: { read: index + 1 } }, async (client, requests, child) => {
    const first = client.readRateLimits();
    await new Promise((resolve) => setImmediate(resolve));
    const second = client.readRateLimits();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(client.pending.size, 1);

    child.stdout.write(`${JSON.stringify({ id: requests[0].id, result: { read: 1 } })}\n`);
    assert.deepEqual(await first, { read: 1 });
    assert.deepEqual(await second, { read: 2 });
    assert.equal(requests.length, 2);
    assert.equal(client.listenerCount("closed"), 0);
  });
});

test("quota serialization spans clients and releases a closed waiter after the active read", async () => {
  function createUnansweredClient() {
    const requests = [];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString("utf8"));
        if (request.id !== undefined) {
          if (request.method !== "initialize") requests.push(request);
          else queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
        }
        done();
      },
    });
    child.kill = () => true;
    return {
      child,
      requests,
      client: new accountFacade.CodexAppServerClient({
        timeoutMs: 1_000,
        spawnProcess: () => child,
      }),
    };
  }

  const first = createUnansweredClient();
  const closedWaiter = createUnansweredClient();
  const last = createUnansweredClient();
  const clients = [first, closedWaiter, last];
  try {
    await Promise.all(clients.map(({ client }) => client.start()));
    const firstRead = first.client.readRateLimits();
    await new Promise((resolve) => setImmediate(resolve));
    const closedRead = closedWaiter.client.request("account/rateLimits/read", {});
    const lastRead = last.client.readRateLimits();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first.requests.length, 1);
    assert.equal(closedWaiter.requests.length, 0);
    assert.equal(last.requests.length, 0);

    closedWaiter.client.close();
    await assert.rejects(closedRead, { code: "temporary_disconnect" });
    first.child.stdout.write(`${JSON.stringify({ id: first.requests[0].id, result: { source: "first" } })}\n`);
    assert.deepEqual(await firstRead, { source: "first" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(last.requests.length, 1);
    last.child.stdout.write(`${JSON.stringify({ id: last.requests[0].id, result: { source: "last" } })}\n`);
    assert.deepEqual(await lastRead, { source: "last" });
  } finally {
    for (const { client, child } of clients) {
      client.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("a global timeout releases the next client's quota request without accepting the late reply", async () => {
  function createClient() {
    const requests = [];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString("utf8"));
        if (request.id !== undefined) {
          if (request.method !== "initialize") requests.push(request);
          else queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
        }
        done();
      },
    });
    child.kill = () => true;
    return {
      child,
      requests,
      client: new accountFacade.CodexAppServerClient({ timeoutMs: 20, spawnProcess: () => child }),
    };
  }

  const first = createClient();
  const second = createClient();
  try {
    await Promise.all([first.client.start(), second.client.start()]);
    const timedOut = first.client.readRateLimits();
    const retry = second.client.readRateLimits();
    await assert.rejects(timedOut, { code: "request_timeout" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first.client.pending.size, 0);
    assert.equal(second.requests.length, 1);
    assert.equal(second.client.pending.size, 1);

    first.child.stdout.write(`${JSON.stringify({ id: first.requests[0].id, result: { stale: true } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second.client.pending.size, 1);
    second.child.stdout.write(`${JSON.stringify({ id: second.requests[0].id, result: { fresh: true } })}\n`);
    assert.deepEqual(await retry, { fresh: true });
  } finally {
    for (const { client, child } of [first, second]) {
      client.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("a timed-out quota request ignores its late reply and permits retry", async () => {
  await withRateLimitServer(() => null, async (client, requests, child) => {
    const timedOut = client.readRateLimits();
    await assert.rejects(timedOut, { code: "request_timeout" });
    assert.equal(client.pending.size, 0);

    const retry = client.readRateLimits();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].id, requests[1].id);
    assert.equal(client.pending.size, 1);
    child.stdout.write(`${JSON.stringify({ id: requests[0].id, result: { stale: true } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.pending.size, 1);
    child.stdout.write(`${JSON.stringify({ id: requests[1].id, result: { fresh: true } })}\n`);
    assert.deepEqual(await retry, { fresh: true });
  }, { timeoutMs: 10 });
});

test("snapshot reads bracket the quota RPC with account reads", async () => {
  const calls = [];
  const client = {
    binary: "synthetic-codex",
    async start() { calls.push("start"); },
    async readAccount() { calls.push("account"); return { account: { email: "fixture@example.test" } }; },
    async readRateLimits() { calls.push("quota"); return { rateLimits: {} }; },
    async readAccountUsage() { calls.push("usage"); return { dailyUsageBuckets: [] }; },
    close() { calls.push("close"); },
  };
  const snapshot = await appServer.readCodexAccountSnapshot({ createClient: () => client });
  assert.deepEqual(calls, ["start", "account", "quota", "usage", "account", "close"]);
  assert.deepEqual(snapshot.account, snapshot.accountAfter);
  assert.deepEqual(snapshot.accountBefore, snapshot.accountAfter);
});

test("bracketed snapshot sanitization rejects known changes and keeps unknown identity unattributed", () => {
  const rateLimits = {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    },
  };
  const accountBefore = { account: { email: "before@example.test", planType: "pro" } };
  const accountAfter = { account: { email: "after@example.test", planType: "pro" } };
  const options = { accountHmacKey: Buffer.alloc(32, 7) };
  const capturedAt = "2026-10-31T00:00:00.000Z";

  assert.throws(() => appServer.sanitizeCodexAccountSnapshot({
    account: accountAfter, accountBefore, accountAfter, rateLimits,
  }, capturedAt, options), {
    code: "request_failed",
    message: "Codex account or plan changed during quota observation",
  });

  const incomplete = appServer.sanitizeCodexAccountSnapshot({
    account: accountAfter, accountBefore: null, accountAfter, rateLimits,
  }, capturedAt, options);
  assert.equal(incomplete.accountScope.status, "unavailable");
  assert.equal(incomplete.ordinaryUsageAllowed, null);

  const stable = appServer.sanitizeCodexAccountSnapshot({
    account: accountAfter, accountBefore: accountAfter, accountAfter, rateLimits,
  }, capturedAt, options);
  assert.equal(stable.accountScope.status, "available");
  assert.equal(stable.ordinaryUsageAllowed, true);
});

test("rate-limit reads use lightweight capabilities only when explicitly requested and never opt into Reserve", async () => {
  await withRateLimitServer(() => ({ result: { ordinaryUsageAllowed: false } }), async (client, requests) => {
    assert.deepEqual(await client.readRateLimits(), { ordinaryUsageAllowed: false });
    await client.readRateLimits({ excludeResetCreditDetails: true, supportsLunaReserve: true });
    await client.readRateLimits({ excludeResetCreditDetails: false });
    await client.readRateLimits({ excludeResetCreditDetails: "true" });
    assert.deepEqual(requests.map(({ params }) => params), [undefined, { excludeResetCreditDetails: true }, undefined, undefined]);
    assert.equal(requests.every((request) => request.method === "account/rateLimits/read"), true);
    assert.equal(JSON.stringify(requests).includes("supportsLunaReserve"), false);
    assert.equal(Object.hasOwn(requests[0], "params"), false);
  });
});

test("older servers get one parameter-free retry and subsequent polls stay compatible", async () => {
  for (const code of [-32600, -32602]) {
    await withRateLimitServer((request) => Object.hasOwn(request, "params")
      ? { error: { code, message: "Unsupported params" } }
      : { result: { ordinaryUsageAllowed: null } }, async (client, requests) => {
      assert.deepEqual(await client.readRateLimits({ excludeResetCreditDetails: true }), { ordinaryUsageAllowed: null });
      await client.readRateLimits({ excludeResetCreditDetails: true });
      assert.deepEqual(requests.map(({ params }) => params), [{ excludeResetCreditDetails: true }, undefined, undefined]);
    });
  }
});

test("rate-limit fallback never retries unrelated errors or loops after a legacy rejection", async () => {
  for (const code of [-32000, -32603, "-32602", undefined]) {
    await withRateLimitServer(() => ({ error: { code, message: "Synthetic failure" } }), async (client, requests) => {
      await assert.rejects(client.readRateLimits({ excludeResetCreditDetails: true }), { code: "request_failed" });
      assert.equal(requests.length, 1);
    });
  }
  await withRateLimitServer(() => ({ error: { code: -32602, message: "Unsupported params" } }), async (client, requests) => {
    await assert.rejects(client.readRateLimits({ excludeResetCreditDetails: true }), { code: "request_failed" });
    assert.equal(requests.length, 2);
  });
});

test("ordinary usage permission stays tri-state, account-scoped and independent of percentages", () => {
  for (const value of [true, false, null, undefined, 0, 1, "true", {}, []]) {
    for (const usedPercent of [0, 100]) {
      const snapshot = {
        account: { account: { email: "permission.fixture@example.test", planType: "pro" } },
        rateLimits: { ordinaryUsageAllowed: value, rateLimits: {
          limitId: "codex", planType: "pro", primary: { usedPercent, windowDurationMins: 300, resetsAt: 123 },
        } },
      };
      const result = accountFacade.sanitizeCodexAccountSnapshot(snapshot, "2026-09-10T12:00:00.000Z", { accountHmacKey: "synthetic-key" });
      assert.equal(result.ordinaryUsageAllowed, typeof value === "boolean" ? value : null);
      assert.equal(result.capturedAt, "2026-09-10T12:00:00.000Z");
      assert.equal(accountFacade.sanitizeCodexAccountSnapshot(snapshot, result.capturedAt).ordinaryUsageAllowed, null);
      snapshot.account = null;
      assert.equal(accountFacade.sanitizeCodexAccountSnapshot(snapshot, result.capturedAt, { accountHmacKey: "synthetic-key" }).ordinaryUsageAllowed, null);
    }
  }
});
