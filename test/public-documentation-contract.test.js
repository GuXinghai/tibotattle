import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import distribution from "../config/electron-production-distribution.cjs";
import identity from "../config/application-identity.cjs";

const text = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("maintained product guidance identifies an unpublished local Windows product", async () => {
  const [readme, contribution, status, support] = await Promise.all([
    text("README.md"), text("CONTRIBUTING.md"), text("docs/current-status.md"), text("SUPPORT.md"),
  ]);
  for (const source of [readme, contribution, status, support]) assert.match(source, /Windows x64/u);
  assert.match(readme, /has not been published/u);
  assert.match(status, /unpublished/u);
  assert.match(support, /No external support, download or private reporting/u);
  assert.equal(distribution.PRODUCTION_ELECTRON_UPDATE_ORIGIN, null);
  assert.equal(distribution.PRODUCTION_ELECTRON_TARGETS["win32-x64"].feedURL, null);
});

test("documented machine identity stays separate from presentation and migration", async () => {
  const [readme, architecture, plan] = await Promise.all([
    text("README.md"), text("docs/reference/system-architecture.md"),
    text("docs/plans/2026-10-23-rhetrion-brand-identity-and-local-state-cutover.md"),
  ]);
  assert.ok(readme.includes(identity.APPLICATION_IDENTITY.executableName + ".exe"));
  assert.ok(readme.includes(identity.APPLICATION_PROFILES.stable.appId));
  assert.match(architecture, /display names\s+never select a credential, profile or production permission/u);
  assert.match(architecture, /before Electron readiness/u);
  assert.match(plan, /prepared → backed_up → converted → verified → activated → accepted/u);
  assert.match(plan, /不得直接覆盖新增历史/u);
});

test("source collection and content-free boundaries stay disclosed", async () => {
  const readme = await text("README.md");
  for (const marker of ["sessions", "archived_sessions", "state_5.sqlite", "config.toml",
    "account/read", "account/rateLimits/read", "account/usage/read"]) assert.ok(readme.includes(marker), marker);
  const security = await text("SECURITY.md");
  assert.match(security, /local usage data/u);
  assert.match(security, /private paths|source paths/u);
  assert.match(security, /prompts, responses/u);
  assert.match(readme, /Display windows do not delete retained history/u);
});

test("recovery guidance preserves original state and separates evidence gates", async () => {
  const [support, status, security] = await Promise.all([
    text("SUPPORT.md"), text("docs/current-status.md"), text("SECURITY.md"),
  ]);
  assert.match(support, /Do not delete the only database, wipe AppData, downgrade a schema/u);
  assert.match(status, /Real application data has not been moved or converted/u);
  assert.match(status, /usage-only cutover/u);
  assert.match(status, /timing conversion, semantic continuity checks/u);
  assert.match(status, /not a usage-cutover gate/u);
  assert.match(status, /Unexpected credential prompts remain a release blocker/u);
  assert.match(security, /never.*|Never wipe/u);
  assert.match(security, /Source tests, sidecar hashes, staging and\s+unsigned local candidates cannot substitute/u);
});

test("usage-only cutover excludes X and browser migration without authorizing source deletion", async () => {
  const decision = "docs/decisions/2026-10-25-usage-only-state-cutover.md";
  const [scope, index, plan, recovery, architecture] = await Promise.all([
    text(decision), text("docs/README.md"),
    text("docs/plans/2026-10-23-rhetrion-brand-identity-and-local-state-cutover.md"),
    text("docs/runbooks/local-index-recovery.md"), text("docs/reference/system-architecture.md"),
  ]);
  assert.ok(index.includes("2026-10-25-usage-only-state-cutover.md"));
  assert.match(scope, /usage computation and history continuity/u);
  assert.match(scope, /not whole-profile migration/u);
  for (const marker of ["original device salt", "collector state", "timing measurement state", "speed-mode baseline ledger",
    "source-root selections", "No automatic replay, deletion or duplicate counting", "No whole-profile rename, overlay or restore"]) {
    assert.ok(scope.includes(marker), marker);
  }
  assert.match(scope, /X posts, cache,[\s\S]+not\s+migration inputs or acceptance dependencies/u);
  assert.match(scope, /no deletion, cleanup, logout, registry update or\s+credential change/u);
  assert.match(scope, /not import the entire\s+desktop-settings file/u);
  assert.match(scope, /unknown|Unknown/u);
  assert.match(scope, /protected\s+cold backup\/readback/u);
  assert.match(plan, /尚未实现 scoped bundle 选择器/u);
  assert.match(recovery, /not a required selector or readiness gate/u);
  assert.match(architecture, /their migration or restart is not a usage-cutover prerequisite/u);
});
