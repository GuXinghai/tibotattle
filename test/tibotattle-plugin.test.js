import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_AGENT_RELEASE_VERSION,
  PLUGIN_STATUS_SCHEMA_VERSION,
  TiboTattlePluginError,
  createInstalledAgentClient,
  locateInstalledTiboTattle,
  readMacOSBundleVersion,
} from "../plugins/tibotattle/lib/installed-agent.mjs";
import {
  TIBOTATTLE_TOOLS,
  createMcpRequestHandler,
  createToolRouter,
} from "../plugins/tibotattle/mcp/server.mjs";

test("plugin installation discovery selects the latest exact app candidate", async () => {
  const inspected = [];
  const result = await locateInstalledTiboTattle({
    candidates: [
      { sourceKind: "first", appPath: "/synthetic/one.app" },
      { sourceKind: "second", appPath: "/synthetic/two.app" },
    ],
    exists: async (path) => {
      inspected.push(path);
      return true;
    },
    readVersion: async (path) => path.includes("two.app") ? "0.1.24" : "0.1.23",
  });
  assert.equal(result.sourceKind, "second");
  assert.equal(result.releaseVersion, "0.1.24");
  assert.equal(result.detectedInstallations, 2);
  assert.match(result.executable, /two\.app\/Contents\/MacOS\/TiboTattle$/u);
  assert.match(result.agentScript, /app\.asar\/apps\/local\/server\.js$/u);
  assert.equal(inspected.some((path) => path.includes("one.app")), true);
});

test("equal installation versions keep system-before-user precedence", async () => {
  const result = await locateInstalledTiboTattle({
    candidates: [
      { sourceKind: "macos_system", appPath: "/synthetic/system.app" },
      { sourceKind: "macos_user", appPath: "/synthetic/user.app" },
    ],
    exists: async () => true,
    readVersion: async () => "0.1.24",
  });
  assert.equal(result.sourceKind, "macos_system");
  assert.equal(result.detectedInstallations, 2);
});

test("macOS bundle version discovery accepts strict versions and sanitizes failures", async () => {
  assert.equal(await readMacOSBundleVersion("/synthetic/TiboTattle.app", {
    execute: async () => ({ stdout: "0.1.24\n" }),
  }), "0.1.24");
  await assert.rejects(
    readMacOSBundleVersion("/Users/private/TiboTattle.app", {
      execute: async () => ({ stdout: "not-a-version\n" }),
    }),
    (error) => (
      error.code === "tibotattle_installation_version_unavailable"
      && !error.message.includes("/Users/private")
    ),
  );
});

test("newest installation wins even when its agent interface is unavailable", async () => {
  const installation = await locateInstalledTiboTattle({
    candidates: [
      { sourceKind: "macos_system", appPath: "/synthetic/system.app" },
      { sourceKind: "macos_user", appPath: "/synthetic/user.app" },
    ],
    exists: async (path) => !path.includes("user.app/Contents/Resources/app.asar"),
    readVersion: async (path) => path.includes("user.app") ? "0.1.24" : "0.1.23",
  });
  assert.equal(installation.releaseVersion, "0.1.24");
  assert.equal(installation.sourceKind, "macos_user");
  assert.equal(installation.agentScript, null);
  assert.equal(installation.detectedInstallations, 2);

  let executed = false;
  const client = createInstalledAgentClient({
    platform: "darwin",
    locate: async () => installation,
    execute: async () => {
      executed = true;
      return { stdout: "{}\n" };
    },
  });
  const status = await client.status();
  assert.equal(status.compatibility, "incompatible");
  assert.equal(status.releaseVersion, "0.1.24");
  assert.equal(status.detectedInstallations, 2);
  assert.equal(status.errorCode, "tibotattle_agent_unavailable");
  assert.equal(executed, false);
});

test("plugin status distinguishes absent, compatible, and incompatible apps", async () => {
  const absent = createInstalledAgentClient({ platform: "darwin", locate: async () => null });
  assert.deepEqual(await absent.status(), {
    schemaVersion: PLUGIN_STATUS_SCHEMA_VERSION,
    installation: "absent",
    compatibility: "unavailable",
    requiredProtocolVersion: 1,
    minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
  });

  const installation = {
    sourceKind: "synthetic",
    executable: "/synthetic/TiboTattle",
    agentScript: "/synthetic/app.asar/apps/local/server.js",
    releaseVersion: "0.1.23",
    detectedInstallations: 2,
  };
  const compatible = createInstalledAgentClient({
    platform: "darwin",
    locate: async () => installation,
    execute: async (_selected, args) => ({
      stdout: `${JSON.stringify({
        schemaVersion: "tibotattle-installed-agent-status-v1",
        protocolVersion: 1,
        releaseVersion: "0.1.23",
        dataHealth: { status: "available" },
        args,
      })}\n`,
    }),
  });
  const compatibleStatus = await compatible.status();
  assert.equal(compatibleStatus.compatibility, "compatible");
  assert.equal(compatibleStatus.dataHealth.status, "available");
  assert.equal(compatibleStatus.detectedInstallations, 2);
  assert.doesNotMatch(JSON.stringify(compatibleStatus), /synthetic\/TiboTattle/u);

  const incompatible = createInstalledAgentClient({
    platform: "darwin",
    locate: async () => installation,
    execute: async () => ({ stdout: "not-json\n" }),
  });
  assert.equal((await incompatible.status()).compatibility, "incompatible");
  assert.equal((await incompatible.status()).releaseVersion, "0.1.23");
});

test("plugin reports unsupported platforms before installation discovery", async () => {
  let located = false;
  const client = createInstalledAgentClient({
    platform: "linux",
    locate: async () => {
      located = true;
      return null;
    },
  });
  assert.deepEqual(await client.status(), {
    schemaVersion: PLUGIN_STATUS_SCHEMA_VERSION,
    installation: "unsupported",
    compatibility: "unsupported",
    requiredProtocolVersion: 1,
    minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
    errorCode: "tibotattle_platform_unsupported",
  });
  await assert.rejects(
    client.invoke("status"),
    (error) => error.code === "tibotattle_platform_unsupported",
  );
  assert.equal(located, false);
});

test("plugin forwards opaque paging and evidence values without decoding them", async () => {
  const calls = [];
  const client = createInstalledAgentClient({
    platform: "darwin",
    locate: async () => ({ sourceKind: "synthetic" }),
    execute: async (_installation, args) => {
      calls.push(args);
      return { stdout: `${JSON.stringify({ status: "available" })}\n` };
    },
  });
  await client.invoke("explain-usage", {
    plan: "top_work",
    period: "7d",
    limit: 5,
    cursor: "opaque-cursor",
  });
  await client.invoke("explain-usage-evidence", { selector: "opaque-selector" });
  assert.deepEqual(calls, [
    ["explain-usage", "--plan", "top_work", "--period", "7d", "--limit", "5", "--cursor", "opaque-cursor"],
    ["explain-usage-evidence", "--selector", "opaque-selector"],
  ]);
});

test("MCP exposes exactly four read-only tools and rejects retired installation calls", async () => {
  const toolNames = [
    "tibotattle_status",
    "tibotattle_list_plans",
    "tibotattle_explain_usage",
    "tibotattle_get_evidence",
  ];
  assert.deepEqual(TIBOTATTLE_TOOLS.map((tool) => tool.name), toolNames);
  for (const tool of TIBOTATTLE_TOOLS) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
  }

  const calls = [];
  const router = createToolRouter({
    client: {
      status: async () => ({ status: "ok" }),
      invoke: async (command, input) => {
        calls.push([command, input]);
        return { status: "available", nextCursor: "opaque-next" };
      },
    },
  });
  const result = await router("tibotattle_explain_usage", {
    plan: "top_work",
    period: "30d",
    limit: 3,
    cursor: "opaque-current",
  });
  assert.equal(result.structuredContent.nextCursor, "opaque-next");
  assert.deepEqual(calls[0], ["explain-usage", {
    plan: "top_work",
    period: "30d",
    limit: 3,
    cursor: "opaque-current",
  }]);
  const rejected = await router("tibotattle_explain_usage", {
    plan: "top_work",
    hiddenPath: "/private/value",
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.errorCode, "tibotattle_tool_input_invalid");
  assert.doesNotMatch(JSON.stringify(rejected), /private\/value/u);
  const retired = await router("tibotattle_install", { confirmationToken: "synthetic-token" });
  assert.equal(retired.isError, true);
  assert.equal(retired.structuredContent.errorCode, "tibotattle_tool_unsupported");
});

test("MCP request handler lists tools and returns structured tool results", async () => {
  const handler = createMcpRequestHandler({
    callTool: async () => ({
      content: [{ type: "text", text: "{}" }],
      structuredContent: { ok: true },
    }),
  });
  const listed = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(listed.result.tools.length, 4);
  const called = await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "tibotattle_status", arguments: {} },
  });
  assert.equal(called.result.structuredContent.ok, true);
  assert.equal(await handler({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("unexpected plugin errors never echo sensitive error contents", async () => {
  const router = createToolRouter({
    client: { status: async () => { throw new Error("/Users/private/secret.sqlite"); } },
  });
  const result = await router("tibotattle_status", {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "tibotattle_plugin_internal_error");
  assert.doesNotMatch(JSON.stringify(result), /secret\.sqlite/u);
  assert.equal(new TiboTattlePluginError("code", "safe").code, "code");
});
