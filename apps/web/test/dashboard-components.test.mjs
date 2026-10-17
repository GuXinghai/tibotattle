import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const performanceStyles = await readFile(new URL("../public/model-performance.css", import.meta.url), "utf8");
const reference = await readFile(new URL("../../../docs/reference/2026-09-13-dashboard-component-reference.md", import.meta.url), "utf8");

test("dashboard component styles keep shared visual rules scoped", () => {
  for (const selector of [
    ".dashboard-tabs",
    ".chart-card",
    ".dashboard-state",
    ".evidence-meta",
    ".technical-disclosure",
  ]) {
    assert.match(styles, new RegExp(`\\.dashboard-shell[^{]*${selector.replaceAll(".", "\\.")}`), selector);
  }
  const header = styles.slice(styles.indexOf("/* Report context belongs"), styles.indexOf(".dashboard-shell :is(.dashboard-control-group"));
  assert.match(header, /body:not\(\.community-site\) > \.topbar/u);
  assert.match(header, /\.reporting-period-toolbar/u);
  assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*dashboard-state-indicator/u);
  assert.match(styles, /aria-pressed="true"/u);
  assert.match(styles, /aria-selected="true"/u);
});

test("compact model performance keeps complete evidence in dialogs and visible failure states", () => {
  for (const selector of [
    ".performance-detail-row",
    ".performance-detail-table",
    ".performance-card",
    ".performance-empty",
    ".performance-dialog",
    ".performance-headline-date",
  ]) assert.match(performanceStyles, new RegExp(selector.replaceAll(".", "\\.")), selector);
  assert.match(performanceStyles, /data-state="error"/u);
  assert.match(performanceStyles, /data-state="unavailable"/u);
  assert.match(performanceStyles, /grid-template-columns:\s*minmax\(0,1fr\) minmax\(0,1fr\)/u);
  assert.match(performanceStyles, /var\(--surface-raised\)/u);
});

test("dashboard component reference documents the integration contract", () => {
  for (const token of [
    ".reporting-period-toolbar",
    ".segmented-control",
    ".dashboard-tabs",
    ".chart-card",
    ".dashboard-state",
    ".evidence-meta",
    ".technical-disclosure",
  ]) assert.match(reference, new RegExp(token.replaceAll(".", "\\.")), token);
  assert.match(reference, /aria-pressed="true"/u);
  assert.match(reference, /aria-selected="true"/u);
});
