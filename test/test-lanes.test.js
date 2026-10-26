import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  mergeChangedPaths,
  parseTestLaneArguments,
  selectTestLanes,
  ELECTRON_TEST_ARGUMENTS,
} from "../scripts/test-lanes.mjs";
import {
  PORTABLE_TEST_FILES,
  PORTABLE_TEST_GROUPS,
} from "../scripts/portable-test-manifest.mjs";

test("Electron gate discovers every focused suite serially and joins the integrated product gate", async () => {
  assert.deepEqual(ELECTRON_TEST_ARGUMENTS, ["--test-concurrency=1", "apps/electron/test/*.test.mjs"]);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts["product:electron:test"], `node --test ${ELECTRON_TEST_ARGUMENTS.join(" ")}`);
  assert.ok(manifest.scripts["product:check"].split(" && ").includes("pnpm run product:electron:test"));
  assert.equal(parseTestLaneArguments(["electron"]).command, "electron");
  assert.deepEqual(selectTestLanes(["apps/electron/test/desktop-runtime.test.mjs"]).lanes, ["electron"]);
  assert.deepEqual(selectTestLanes(["apps/electron/desktop-runtime.js"]).lanes, ["full"]);
});

test("portable manifest is explicit, unique, and excludes native release gates", () => {
  assert.equal(PORTABLE_TEST_FILES.length, new Set(PORTABLE_TEST_FILES).size);
  assert.deepEqual(
    PORTABLE_TEST_FILES,
    Object.values(PORTABLE_TEST_GROUPS).flat(),
  );
  assert.equal(PORTABLE_TEST_FILES.includes("apps/local/server.test.mjs"), true);
  assert.equal(PORTABLE_TEST_FILES.includes("apps/web/test/lib.test.mjs"), true);
  assert.equal(PORTABLE_TEST_FILES.includes("test/accounting-package-parity.test.js"), true);
  for (const path of PORTABLE_TEST_FILES) {
    assert.doesNotMatch(path, /(?:^|\/)macos-|sparkle|release-site/u);
  }
});

test("test-lane arguments retain explicit paths and reject ambiguous input", () => {
  assert.deepEqual(
    parseTestLaneArguments([
      "changed",
      "--base",
      "origin/main",
      "--full",
      "--path",
      "scripts/electron-sparkle-transition.js",
      "--path",
      "apps/web/public/app.js",
    ]),
    {
      command: "changed",
      base: "origin/main",
      full: true,
      paths: [
        "scripts/electron-sparkle-transition.js",
        "apps/web/public/app.js",
      ],
    },
  );
  assert.deepEqual(
    parseTestLaneArguments(["--help"]),
    { command: "help", base: null, full: false, paths: [] },
  );
  assert.deepEqual(
    parseTestLaneArguments(["i18n"]),
    { command: "i18n", base: null, full: false, paths: [] },
  );
  for (const argv of [
    ["changed", "--unexpected"],
    ["unknown"],
    ["changed", "--path", "--full"],
    ["changed", "--path", ""],
    ["changed", "--path", "../outside.md"],
    ["changed", "--path", "/outside.md"],
    ["changed", "--base", ""],
    ["macos-transition", "--path", "scripts/electron-sparkle-transition.js"],
    ["portable", "--path", "apps/local/server.js"],
  ]) {
    assert.throws(() => parseTestLaneArguments(argv));
  }
});

test("changed-path merger retains branch, active-worktree, and untracked entries", () => {
  assert.deepEqual(
    mergeChangedPaths([
      "scripts/electron-sparkle-transition.js\0README.md\0",
      "README.md\0scripts/test-lanes.mjs\0",
      "test/new-untracked.test.js\0",
    ]),
    [
      "README.md",
      "scripts/electron-sparkle-transition.js",
      "scripts/test-lanes.mjs",
      "test/new-untracked.test.js",
    ],
  );
});

test("test-lane selection narrows only paths with complete executable coverage", () => {
  for (const path of [
    "scripts/electron-sparkle-transition.js",
    "scripts/prepare-sparkle-framework.js",
    "scripts/macos-release-core.js",
    "test/macos-keychain-migration-artifact.test.js",
    "test/macos-updater.test.js",
  ]) {
    assert.deepEqual(selectTestLanes([path]).lanes, ["full"], path);
  }
  assert.deepEqual(
    selectTestLanes(["scripts/electron-sparkle-transition.js"], { full: true }).lanes,
    ["full"],
  );
  assert.deepEqual(selectTestLanes(["packages/i18n/index.js"]).lanes, ["i18n"]);
  for (const path of [
    "scripts/generate-i18n-browser-mirror.js",
    "scripts/generate-i18n-electron-copy.js",
    "apps/electron/desktop-copy-source.js",
    "apps/electron/desktop-copy.js",
  ]) {
    assert.deepEqual(selectTestLanes([path]).lanes, ["i18n"], path);
  }
  for (const path of [
    "apps/web/public/app.js",
    "apps/local/server.js",
    "config/product-brand.js",
    "scripts/lib/sparkle-remote-inspection.mjs",
    "scripts/test-lanes.mjs",
    "scripts/unknown-new-tool.mjs",
    "src/unmapped-product-path.js",
    "../critical.md",
  ]) {
    assert.deepEqual(selectTestLanes([path]).lanes, ["full"], path);
  }
  assert.deepEqual(selectTestLanes(["docs/decisions/example.md"]).lanes, []);
});

test("retired hosted paths cannot select a runnable hosted lane", () => {
  for (const path of ["apps/worker/src/index.ts", "scripts/build-public-release-site.js"])
    assert.deepEqual(selectTestLanes([path]).lanes, ["full"]);
  for (const lane of ["worker", "public-site"]) assert.throws(() => parseTestLaneArguments([lane]));
  assert.deepEqual(selectTestLanes(["docs/example.md"], { full: true }).lanes, ["full"]);
});
