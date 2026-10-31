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

test("maintained guidance enforces Codex-only provider scope without touching legacy state", async () => {
  const [readme, guide, index, decision] = await Promise.all([
    text("README.md"), text("docs/user-guide.md"), text("docs/README.md"),
    text("docs/decisions/2026-10-27-codex-only-product.md"),
  ]);
  for (const source of [readme, guide, decision]) {
    assert.match(source, /Codex is the only supported usage provider/u);
  }
  assert.ok(index.includes("2026-10-27-codex-only-product.md"));
  assert.match(decision, /Do not run an uninstall or cleanup operation/u);
  assert.match(decision, /Existing versioned generic telemetry\/export and provider-accounting snapshot\s+formats/u);
  assert.match(decision, /does not change their original contract-status fields/u);
  assert.doesNotMatch(decision, /Frozen generic telemetry\/export/u);
  assert.match(decision, /resume fails closed/u);
});

test("R7 evidence stays frozen historical readback with generation retired", async () => {
  const [decision, index, runbook, schemas] = await Promise.all([
    text("docs/decisions/2026-10-27-codex-only-product.md"), text("docs/README.md"),
    text("docs/runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md"),
    text("docs/reference/schema-contracts.md"),
  ]);
  assert.match(decision, /R7 release-evidence v0\.1 schema requires Claude operation values and\s+fields/u);
  assert.match(decision, /do not create a v0\.2 schema/u);
  assert.match(decision, /must reject before it creates or reads a\s+fixture, reads or writes repository state, or reads a provider source/u);
  assert.match(index, /R7 evidence preservation and readback[\s\S]+generation is retired/u);
  assert.match(runbook, /There is no supported freshness, regeneration, recovery, or replacement\s+procedure/u);
  assert.match(runbook, /must fail closed\s+before creating or reading fixtures/u);
  assert.doesNotMatch(runbook, /scripts\/regenerate-r7-release-evidence\.js|chmod 600 generated/u);
  assert.match(schemas, /frozen historical readback[\s\S]+no new receipt\/evidence generation or v0\.2 schema/u);
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
  assert.match(status, /owner-authorized one-time conversion of the active stable\s+usage state was activated after cold backup, copy conversion and readback/u);
  assert.match(status, /Do not\s+repeat the migration against accumulated new history, replay the old brand activation or alter\s+its existing startup policy implicitly/u);
  assert.match(status, /original usage directory, complete cold backup, previous program\s+and private operation receipts are retained/u);
  assert.match(status, /X, background and generic Chromium\s+state remain outside this upgrade/u);
  assert.match(status, /Native synthetic\s+tests cover its source preservation, exact known DDL/u);
  assert.match(status, /Passing a source gate never proves physical Windows, packaged, installed,\s+signed-release, updater or public deployment behavior/u);
  assert.match(status, /\[usage-only scope\]\(\.\/decisions\/2026-10-25-usage-only-state-cutover\.md\)/u);
  assert.match(status, /copy-only conversion, semantic continuity/u);
  assert.match(status, /Operational readback is\s+not a real-data test, and no installed, signed-release or publication gate is\s+claimed/u);
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
