import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalCompanionServer } from "./server.js";
import {
  RUNTIME_WEB_MODULE_ENTRYPOINTS,
} from "../../scripts/lib/runtime-closure.mjs";
import { surfaceFiles } from "../../scripts/lib/surface-manifest.mjs";

const ASSETS = ["weekly-api-intervals.js", "weekly-api-chart.js", "allowance-page.js", "usage-simple.css", "cache-reuse-matrix.js", "cache-reuse-matrix.css", "cache-reuse-metrics.js", "overview-workload.js", "allowance-trends.js", "codex-color.svg", "desktop-appearance.js", "desktop-shell.js", "electron-tray-popup.html", "electron-tray-popup.js",
  "window-background.js", "window-background.css", "electron-tray-popup.css", "electron-settings.html", "electron-settings.js",
  "electron-tray-settings.js", "electron-tray-preferences.js", "electron-settings.css", "icon-panel-left.svg", "icon-refresh-cw.svg", "icon-settings.svg"];

test("Electron settings and bridge have a real loopback route and retained client/native asset closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-assets-"));
  const sourceStaticRoot = fileURLToPath(new URL("../web/public/", import.meta.url));
  const resourceRoot = join(root, "resources");
  const staticRoot = join(resourceRoot, "public");
  await mkdir(staticRoot, { recursive: true });
  for (const file of ASSETS) await copyFile(join(sourceStaticRoot, file), join(staticRoot, file));
  const websiteOnly = ["allowance-tanks.js", "allowance-tank-renderer.js"];
  // Existing files must still be refused by the desktop route allowlist.
  for (const file of websiteOnly) await copyFile(join(sourceStaticRoot, file), join(staticRoot, file));
  const codexHome = join(root, "synthetic-codex");
  await mkdir(codexHome, { mode: 0o700 });
  let app;
  try {
    app = await startLocalCompanionServer({ resourceRoot,
      stateRoot: join(root, "state"), codexHome, staticRoot, port: 0,
      dataStore: { initialize: async () => {}, reload: async () => {}, getOverview: () => ({}) },
      refreshRunner: async () => ({}),
    });
    const origin = `http://127.0.0.1:${app.port}`;
    for (const file of ASSETS) {
      const response = await fetch(`${origin}/${file}`);
      assert.equal(response.status, 200, file);
      assert.equal(await response.text(), await readFile(join(staticRoot, file), "utf8"), file);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.ok(surfaceFiles("history-free-export").includes(`apps/web/public/${file}`),
        `history-free export: ${file}`);
      assert.ok([...RUNTIME_WEB_MODULE_ENTRYPOINTS, ...surfaceFiles("electron-runtime")]
        .includes(`apps/web/public/${file}`), `Electron closure: ${file}`);
    }
    const health = await (await fetch(`${origin}/api/local/health`)).json();
    assert.deepEqual(health.capabilities, {
      localDashboard: true, explicitRefresh: true,
      arbitraryPathAccess: false, remoteProxy: false,
    });
    assert.equal((await fetch(`${origin}/unexpected-electron-file.js`)).status, 404);
    for (const file of websiteOnly) {
      assert.equal((await fetch(`${origin}/${file}`)).status, 404, file);
      assert.equal(surfaceFiles("electron-runtime").includes(`apps/web/public/${file}`), false);
      assert.equal(surfaceFiles("history-free-export").includes(`apps/web/public/${file}`), false);
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
