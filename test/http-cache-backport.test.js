import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKPORT_VERSION, CONFIG, INSTALLED_SHA256, PATCH_PATH, PATCH_SHA256,
  checkLocal, verifyReviewedInputs } from "../scripts/check-http-cache-backport.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("actual builder consumer verifies patched bytes and policy without a dated exception", async () => {
  assert.deepEqual(await checkLocal(root), { version: BACKPORT_VERSION, sourceSha256: INSTALLED_SHA256, patchSha256: PATCH_SHA256 });
});

test("reviewed input guard refuses suppression, lock, patch and workspace drift", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "http-cache-backport-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(fixture, "config", "patches"), { recursive: true });
  const inputs = {
    "osv-scanner.toml": CONFIG,
    "pnpm-lock.yaml": `  http-cache-semantics@4.3.0:\n  http-cache-semantics@4.3.0: ${PATCH_SHA256}\n      http-cache-semantics: 4.3.0(patch_hash=${PATCH_SHA256})\n`,
    "pnpm-workspace.yaml": `  http-cache-semantics@4.2.0: 4.3.0\n  http-cache-semantics@4.3.0: ${PATCH_PATH}\n`,
    [PATCH_PATH]: await readFile(join(root, PATCH_PATH)),
  };
  const restore = async () => { for (const [path, bytes] of Object.entries(inputs)) await writeFile(join(fixture, path), bytes); };
  await restore();
  await verifyReviewedInputs(fixture);
  for (const [path, changed] of [
    ["osv-scanner.toml", CONFIG + "[[IgnoredVulns]]\nid='GHSA-ch52-4w7c-c8xp'\n"],
    ["pnpm-lock.yaml", inputs["pnpm-lock.yaml"].replaceAll(PATCH_SHA256, "0".repeat(64))],
    ["pnpm-lock.yaml", inputs["pnpm-lock.yaml"] + "  http-cache-semantics@4.2.0:\n"],
    ["pnpm-workspace.yaml", "patchedDependencies: {}\n"],
    [PATCH_PATH, Buffer.from("unreviewed synthetic patch\n")],
  ]) {
    await restore();
    await writeFile(join(fixture, path), changed);
    await assert.rejects(verifyReviewedInputs(fixture), undefined, path);
  }
  await restore();
  await writeFile(join(fixture, "package-lock.json"), "{}");
  await assert.rejects(verifyReviewedInputs(fixture), /lock ownership drift/u);
});

test("OSV retains direct checksum-pinned scanner failure semantics without suppression", async () => {
  assert.doesNotMatch(CONFIG, /IgnoredVulns|PackageOverrides|ignoreUntil/u);
  const workflow = await readFile(join(root, ".github/workflows/osv-scanner.yml"), "utf8");
  assert.match(workflow, /node scripts\/check-http-cache-backport\.mjs/u);
  assert.match(workflow, /node scripts\/run-isolated-tests\.mjs -- test\/http-cache-semantics-security/u);
  assert.doesNotMatch(workflow, /--config|fail-on-vuln=false|continue-on-error|google\/osv-scanner-action/u);
  assert.match(workflow, /"\$scanner" scan source --all-vulns --recursive \.\//u);
  assert.ok(workflow.indexOf("node scripts/check-http-cache-backport.mjs") < workflow.indexOf("name: Run scanner"));
});
