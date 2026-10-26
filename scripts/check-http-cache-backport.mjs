import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BACKPORT_VERSION = "4.3.0";
export const PATCH_PATH = "config/patches/http-cache-semantics@4.3.0.patch";
export const PATCH_SHA256 = "94ecd9492e12512d8de3feef07eb3f98fbf82d55c6c0332612f2f1b919bec2ae";
export const INSTALLED_SHA256 = "59d8952163820dc7ed24a1839eae7ee372ecb1a85d909fdad67b7cdac95f8a67";
export const CONFIG = "# No local advisory suppressions. The reviewed downstream backport is verified separately.\n";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export async function verifyReviewedInputs(root) {
  const locks = (await readdir(root)).filter(name => /^(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/u.test(name));
  assert.deepEqual(locks.sort(), ["pnpm-lock.yaml"], "Root lock ownership drift");
  assert.ok(await readFile(resolve(root, "osv-scanner.toml"), "utf8") === CONFIG, "Scanner suppression/config drift");
  const patch = await readFile(resolve(root, PATCH_PATH));
  assert.equal(digest(patch), PATCH_SHA256, "Reviewed backport patch drift (LF bytes required)");
  const lock = await readFile(resolve(root, "pnpm-lock.yaml"), "utf8");
  assert.ok(/^  http-cache-semantics@4\.3\.0:$/mu.test(lock), "Reviewed package resolution missing");
  assert.ok(new RegExp(`http-cache-semantics: 4\\.3\\.0\\(patch_hash=${PATCH_SHA256}\\)`, "u").test(lock), "Consumer patch binding drift");
  assert.ok(!/^  http-cache-semantics@4\.2\.0(?:\(patch_hash=[a-f0-9]+\))?: *(?:\{\})?$/mu.test(lock), "Retired package resolution remains");
  assert.ok(new RegExp(`http-cache-semantics@4\\.3\\.0: ${PATCH_SHA256}`, "u").test(lock), "Lock patch hash drift");
  const workspace = await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8");
  assert.ok(/http-cache-semantics@4\.2\.0: 4\.3\.0/u.test(workspace), "Reviewed override missing");
  assert.ok(workspace.includes(`http-cache-semantics@4.3.0: ${PATCH_PATH}`), "Reviewed patch binding missing");
}

export function resolveBuilderCacheConsumer(root) {
  let require = createRequire(resolve(root, "package.json"));
  const expected = [["electron-builder", "26.15.7"], ["app-builder-lib", "26.15.7"],
    ["@electron/get", "3.1.0"], ["got", "11.8.6"], ["cacheable-request", "7.0.4"],
    ["http-cache-semantics", BACKPORT_VERSION]];
  let downloaderRequire;
  for (const [name, version] of expected) {
    const manifest = require.resolve(`${name}/package.json`);
    const dependencyRequire = createRequire(manifest);
    assert.equal(dependencyRequire(manifest).version, version, `Installed consumer version drift: ${name}`);
    if (name === "@electron/get") downloaderRequire = dependencyRequire;
    require = dependencyRequire;
  }
  assert.equal(downloaderRequire("got").defaults.options.cache, undefined, "Downloader cache default changed");
  return { CachePolicy: require("http-cache-semantics"), sourcePath: require.resolve("http-cache-semantics") };
}

export function verifyPolicyBehavior(CachePolicy) {
  const request = (cacheControl, language = "en") => ({ url: "https://cache.invalid/example", method: "GET",
    headers: { host: "cache.invalid", "accept-language": language, ...(cacheControl ? { "cache-control": cacheControl } : {}) } });
  const response = headers => ({ status: 200, headers: { date: new Date().toUTCString(), ...headers } });
  for (const headers of [
    { "cache-control": "max-age=3600", "set-cookie": "session=synthetic" },
    ...["proxy-revalidate", "no-cache", "no-store", "private", "must-revalidate"].map(value => ({ "cache-control": `max-age=3600, ${value}` })),
  ]) {
    const policy = new CachePolicy(request(), response(headers));
    assert.equal(policy.satisfiesWithoutRevalidation(request("max-stale=999999")), false);
    assert.equal(policy.evaluateRequest(request("max-stale=999999")).response, undefined);
  }
  const varying = new CachePolicy(request(), response({ "cache-control": "max-age=60", vary: "Accept-Language" }));
  assert.equal(varying.satisfiesWithoutRevalidation(request(null, "en")), true);
  assert.equal(varying.satisfiesWithoutRevalidation(request(null, "fr")), false);
  const star = new CachePolicy(request(), response({ "cache-control": "max-age=60", vary: " * " }));
  assert.equal(star.satisfiesWithoutRevalidation(request()), false);
}

export async function checkLocal(root) {
  await verifyReviewedInputs(root);
  const consumer = resolveBuilderCacheConsumer(root);
  assert.equal(digest(await readFile(consumer.sourcePath)), INSTALLED_SHA256, "Installed backport source drift");
  verifyPolicyBehavior(consumer.CachePolicy);
  return { version: BACKPORT_VERSION, sourceSha256: INSTALLED_SHA256, patchSha256: PATCH_SHA256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkLocal(resolve(fileURLToPath(new URL("../", import.meta.url))));
  console.log("Reviewed HTTP cache downstream backport: PASS (no advisory suppression)");
}
