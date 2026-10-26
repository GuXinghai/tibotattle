import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import electron from "electron";

// This deliberately loads the complete production HTML/module graph. A
// component-only pause fixture cannot catch its synchronous callback reading
// a page controller that the app module has not initialized yet.
async function rendererProbe() {
  const { app, BrowserWindow } = require("electron");
  const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
  const { pathToFileURL } = require("node:url");
  const [root, temporary] = process.argv.slice(2);
  app.setPath("userData", path.join(temporary, "profile"));
  app.on("window-all-closed", () => {});
  let server;
  try {
    await app.whenReady();
    const { LOCAL_COMPANION_STATIC_FILES: files } = await import(pathToFileURL(path.join(root, "apps/local/static-assets.js")).href);
    let failed = false;
    const requests = [], errors = [], results = [];
    server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        requests.push({ path: url.pathname, method: request.method });
        response.writeHead(failed ? 503 : 200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(failed ? { error: { code: "internal_error" } }
          : url.pathname === "/api/local/overview"
            ? { mode: "local", freshness: { status: "insufficient" }, quotaWindows: [], usage: [] } : {}));
        return;
      }
      const asset = files[url.pathname];
      if (!asset) { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", asset.type);
      response.end(fs.readFileSync(path.join(root, "apps/web/public", asset.file)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    for (const [language, readFailure] of [["en", false], ["zh-Hans", false], ["es", false], ["zh-Hans", true]]) {
      failed = readFailure;
      const before = requests.length;
      const preload = path.join(temporary, "preload.cjs");
      fs.writeFileSync(preload, `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('usageMonitorDesktop',Object.freeze({version:'v1',getSettings:async()=>({settings:{language:${JSON.stringify(language)},appearance:'light',refreshPaused:false,refreshIntervalSeconds:300}}),setRefreshPaused:async paused=>({settings:{refreshPaused:paused}}),onCommand:()=>()=>{}}));`);
      const window = new BrowserWindow({ show: false, width: 1280, height: 900,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      window.webContents.on("console-message", event => {
        const message = event.message;
        if (typeof message === "string" && /Uncaught|ReferenceError/u.test(message)) errors.push(message.slice(0, 800));
      });
      await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = await window.webContents.executeJavaScript("document.documentElement.dataset.localDashboardReady === 'true'");
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const state = await window.webContents.executeJavaScript(`({ready:document.documentElement.dataset.localDashboardReady==='true',pauseEnabled:!document.querySelector('#pause-refresh-button').disabled,footer:document.querySelector('footer')?.textContent??null})`);
      results.push({ language, readFailure, state, requests: requests.slice(before) });
      window.destroy();
    }
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify({ electron: process.versions.electron, errors, results }));
    server.close(); app.quit();
  } catch (error) {
    fs.writeFileSync(path.join(temporary, "failure.txt"), String(error));
    server?.close(); app.exit(1);
  }
}

test("complete desktop dashboard initializes pause after page controllers and terminates loading in every locale", {
  skip: process.platform !== "win32" || process.arch !== "x64",
  timeout: 30_000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "usagemonitor-dashboard-startup-"));
  try {
    const script = join(temporary, "probe.cjs");
    await writeFile(script, `(${rendererProbe.toString()})()`);
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(electron, [script, fileURLToPath(new URL("../../../", import.meta.url)), temporary],
      { env: environment, windowsHide: true, timeout: 25_000, maxBuffer: 64 * 1024 });
    const result = JSON.parse(await readFile(join(temporary, "result.json"), "utf8"));
    assert.deepEqual(result.errors, []);
    assert.equal(result.results.length, 4);
    for (const { state, requests } of result.results) {
      assert.equal(state.ready, true, "primary read reaches a terminal rendered state");
      assert.equal(state.pauseEnabled, true);
      assert.equal(state.footer, null, "removed disclaimer has no translated footer");
      assert.ok(requests.some(request => request.path === "/api/local/overview"));
      assert.ok(requests.every(request => request.method === "GET"));
    }
  } finally {
    // Only the fresh directory returned by mkdtemp is owned by this test.
    await rm(temporary, { recursive: true, force: true });
  }
});
