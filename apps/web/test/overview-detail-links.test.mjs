import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDashboardHash } from "../public/navigation.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const layout = source.slice(source.indexOf("function mountDashboardLayout("));

// A link is real only when its page exists and that page's level-1 switch
// lists the view; an unknown view would silently fall back to the default.
function assertReachable(href) {
  const { page, view } = parseDashboardHash(href);
  assert.ok(page, href);
  if (page === "usage" && view === "composition") {
    assert.match(layout, /composition: "#usage-composition-details"/u);
    assert.match(layout, /usageDetailRoutes\[event\.detail\.view\][\s\S]*?summary[\s\S]*?click/u);
    assert.match(html, /id="usage-composition-details"/u);
    return;
  }
  const config = layout.slice(layout.indexOf(`{ id: "${page}", page: "${page}", level: 1`));
  const views = config.slice(0, config.indexOf("] },"));
  assert.match(views, new RegExp(`view\\("${view}"`, "u"), href);
}

test("Overview price and comparison cards open the views that explain them", () => {
  const links = [...html.matchAll(/<a class="overview-card-link" href="([^"]+)" data-i18n="([^"]+)"/gu)];
  assert.deepEqual(links.map((match) => match[1]), ["#usage/composition", "#allowance/differences"]);
  for (const [, href] of links) assertReachable(href);
});

test("only the primary seven-day allowance card links to Allowance changes", () => {
  const block = source.slice(source.indexOf("function renderQuotaCards("),
    source.indexOf("function providerReportedPlanEvidence("));
  assert.match(block, /if \(isPrimaryCodexWeeklyQuotaWindow\(window\)\) \{\s*const link = node\("a", "overview-card-link"\);\s*link\.href = "#allowance\/changes";/u);
  assertReachable("#allowance/changes");
});
