import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

// The v2 store is the one place private paths and working directories may
// rest (docs/decisions/2026-10-12-local-index-v2-and-local-paths.md). These
// guards keep every other surface unable to reach them.

const repository = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_EXTENSIONS = /(?<!\.test)\.(?:js|mjs|cjs|ts|tsx)$/u;
// The one composition root that selects the backend, and only its facade. It
// receives paths and rows from the facade, never the store modules behind it.
const FACADE_IMPORTERS = new Map([
  ["apps/local/server.js", new Set(["local-index-backend.js"])],
  // The snapshot builder's default projection reader.
  ["src/local-companion-data.js", new Set(["local-index-backend.js"])],
  // The two command-line composition roots, for the explainer's reader switch.
  ["src/cli.js", new Set(["local-index-usage-explainer.js"])],
  ["apps/local/agent-cli.js", new Set(["local-index-usage-explainer.js"])],
]);
const SKIPPED = new Set(["node_modules", ".git", "generated", ".release-build", "test", "tests"]);

function sourceFiles(directory, found = []) {
  for (const name of readdirSync(directory)) {
    if (SKIPPED.has(name)) continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) sourceFiles(path, found);
    else if (SOURCE_EXTENSIONS.test(name)) found.push(path);
  }
  return found;
}

const inspected = ["src", "apps", "packages", "plugins", "tools"]
  .flatMap((root) => {
    try {
      return sourceFiles(join(repository, root));
    } catch {
      return [];
    }
  });

const isIndexModule = (path) => /^local-index-[a-z-]+\.js$/u.test(basename(path));

test("only the v2 index modules reach the v2 store", () => {
  assert.ok(inspected.length > 300, "the scan must cover the product source");
  const importers = [];
  for (const path of inspected) {
    if (isIndexModule(path)) continue;
    const text = readFileSync(path, "utf8");
    const name = relative(repository, path).split(sep).join("/");
    const allowed = FACADE_IMPORTERS.get(name) ?? new Set();
    const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*\/(local-index-[a-z-]+\.js)["']/gu;
    for (const [, imported] of text.matchAll(pattern)) {
      if (!allowed.has(imported)) importers.push(`${name} -> ${imported}`);
    }
  }
  assert.deepEqual(importers, [], "no export, contribution, application or app code may import the store");
});

test("the allowance names a real importer of exactly its facade", () => {
  for (const [name, allowed] of FACADE_IMPORTERS) {
    const text = readFileSync(join(repository, name), "utf8");
    for (const imported of allowed) {
      assert.ok(text.includes(`/${imported}"`), `${name} must import ${imported}`);
    }
  }
});

test("only the v2 index modules name the work-directory table", () => {
  const holders = [];
  for (const path of inspected) {
    if (isIndexModule(path)) continue;
    if (readFileSync(path, "utf8").includes("work_directory")) {
      holders.push(relative(repository, path).split(sep).join("/"));
    }
  }
  assert.deepEqual(holders, []);
});

const SAFE_STRING = /^[a-z][a-z0-9_]*$/u;
function assertClosedValue(value, label) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    assert.match(value, SAFE_STRING, `${label} must be a fixed token`);
    return;
  }
  assert.equal(typeof value, "object", label);
  for (const [key, inner] of Object.entries(value)) {
    assert.match(key, /^[A-Za-z][A-Za-z0-9]*$/u, `${label}.${key}`);
    assertClosedValue(inner, `${label}.${key}`);
  }
}

test("a refresh result is closed and carries no path, directory or content", async () => {
  const workspace = createWorkspace({ files: 6, events: 120 });
  try {
    const result = await refreshLocalIndex({
      codexHome: workspace.codexHome,
      indexFile: join(workspace.state, "index.sqlite"),
      secretFile: workspace.secretFile,
      workerCount: 1,
    });
    assertClosedValue(result, "result");
    const text = JSON.stringify(result);
    for (const marker of [workspace.root, workspace.codexHome, workspace.state, basename(workspace.root)]) {
      assert.ok(!text.includes(marker.replaceAll("\\", "\\\\")) && !text.includes(marker),
        "the result must not echo a private path");
    }
  } finally {
    workspace.cleanup();
  }
});
