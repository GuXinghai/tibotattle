import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import identity from "../config/application-identity.cjs";
import brand from "../config/product-brand.cjs";
import { collectRuntimeGraph, RUNTIME_EXPECTED_EXTERNAL_SPECIFIERS } from "../scripts/lib/runtime-closure.mjs";

test("domain and version dependency closures cannot select a product brand", async () => {
  for (const [entrypoint, expectedExternalSpecifiers] of [["src/local-usage-explainer.js", RUNTIME_EXPECTED_EXTERNAL_SPECIFIERS], ["src/providers/codex/app-server.js", ["@app-usagemonitor/telemetry-contract"]]]) {
    const graph = await collectRuntimeGraph({ entrypoint: resolve(entrypoint), expectedExternalSpecifiers });
    for (const file of graph.files) {
      assert.doesNotMatch(file.replaceAll("\\", "/"), /\/product-brand\.(?:cjs|js)$/u);
    }
  }
  assert.equal(identity.APPLICATION_IDENTITY.stateDirectoryName, "UsageMonitor");
  assert.equal(identity.APPLICATION_PROFILES.stable.appId, "com.usagemonitor.local");
  for (const field of ["appId", "profile", "stateDirectoryName", "executableName", "metadataKey"]) {
    assert.equal(Object.hasOwn(brand, field), false, field);
  }
});

test("approved artwork remains editable and Windows icon frames cover small and high DPI sizes", async () => {
  const svg = await readFile(new URL(`../${brand.vector}`, import.meta.url), "utf8");
  assert.match(svg, /<path\b/u);
  assert.doesNotMatch(svg, /<image\b|data:image/u);
  const png = await readFile(new URL(`../${brand.icon}`, import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[25], 6, "RGBA transparency must survive raster export");
  const ico = await readFile(new URL(`../${brand.windowsIcon}`, import.meta.url));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  const sizes = [];
  for (let i = 0; i < 7; i += 1) {
    const row = 6 + 16 * i;
    sizes.push(ico[row] || 256);
    assert.equal(ico[row], ico[row + 1]);
    const bytes = ico.readUInt32LE(row + 8);
    const offset = ico.readUInt32LE(row + 12);
    assert.ok(offset >= 118 && bytes > 0 && offset + bytes <= ico.length);
    assert.equal(ico.subarray(offset + 1, offset + 4).toString(), "PNG");
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256]);
});
