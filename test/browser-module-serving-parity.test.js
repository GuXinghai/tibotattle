import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  LOCAL_COMPANION_STATIC_FILES,
} from "../apps/local/static-assets.js";
import {
  collectWebModuleGraph,
} from "../scripts/lib/runtime-closure.mjs";

const CLASSIC_RUNTIME_ASSETS = Object.freeze({
  "vendor/hls.light.min.js": "/vendor/hls.light.min.js",
});

test("every transitive browser module is served by loopback and every served module is in the closure", async () => {
  const discovered = await collectWebModuleGraph({
    surface: "local companion",
  });
  const classicFiles = new Set(Object.keys(CLASSIC_RUNTIME_ASSETS));
  const servedModules = Object.entries(LOCAL_COMPANION_STATIC_FILES)
    .filter(([, { file }]) => /\.(?:m?js)$/u.test(file) && !classicFiles.has(file))
    .map(([route, { file, type }]) => ({
      file: `apps/web/public/${file}`,
      route,
      type,
    }))
    .sort((left, right) => left.file.localeCompare(right.file));

  assert.deepEqual(
    servedModules.map(({ file }) => file),
    discovered.relativeFiles,
  );
  for (const { file, route, type } of servedModules) {
    assert.equal(
      route,
      `/${file.slice("apps/web/public/".length)}`,
      `${file} must be served at its relative module URL`,
    );
    assert.equal(type, "text/javascript; charset=utf-8");
  }

  const classicLoader = await readFile(
    new URL("../apps/web/public/x-reader-integration.js", import.meta.url),
    "utf8",
  );
  assert.match(classicLoader, /script\.src\s*=\s*["']\.\/vendor\/hls\.light\.min\.js["']/u);
  assert.doesNotMatch(classicLoader, /https?:\/\//u, "the lazy script stays local");
  for (const [file, route] of Object.entries(CLASSIC_RUNTIME_ASSETS)) {
    const asset = LOCAL_COMPANION_STATIC_FILES[route];
    assert.ok(asset, `${route} is served by the local companion`);
    assert.equal(asset.file, file);
    assert.equal(asset.type, "text/javascript; charset=utf-8");
  }
});
