import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("function focusTrendsPeriod(period) {");
const end = source.indexOf("\n// One id per rendered divergence period", start);
assert.ok(start >= 0 && end > start);

test("View period frames the divergence on Allowance changes and selects its end", () => {
  const viewports = [];
  const selections = [];
  const events = [];
  const focused = [];
  const timeControl = { focus: (options) => focused.push(options) };
  const documentRef = { dispatchEvent: (event) => events.push(event) };
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init.detail; }
  }
  const focusTrendsPeriod = Function(
    "dashboard", "updateTimelineViewport", "selectedUsagePoints",
    "requestAnimationFrame", "trendsHorizonView", "document", "CustomEvent", "$",
    `${source.slice(start, end)}\nreturn focusTrendsPeriod;`,
  )(
    { usage: [] },
    (points, update) => viewports.push(update()),
    () => [],
    (callback) => callback(),
    { select: (at, user) => selections.push([at, user]) },
    documentRef,
    CustomEvent,
    (selector) => (selector === "#trends-time" ? timeControl : null),
  );

  const hour = 3_600_000;
  focusTrendsPeriod({ startMs: 100 * hour, endMs: 110 * hour, durationMs: 10 * hour });

  // The shared viewport pads the period on both sides (12% of ten hours).
  assert.deepEqual(viewports, [{ startMs: 100 * hour - 1.2 * hour, endMs: 110 * hour + 1.2 * hour }]);
  assert.deepEqual(selections, [[110 * hour, true]]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "usagemonitor:page-view");
  assert.deepEqual(events[0].detail, { page: "allowance", view: "changes" });
  assert.deepEqual(focused, [{ preventScroll: true }]);

  // A short period still gets at least thirty minutes of context.
  viewports.length = 0;
  focusTrendsPeriod({ startMs: 100 * hour, endMs: 100 * hour + 60_000, durationMs: 60_000 });
  assert.deepEqual(viewports, [{ startMs: 100 * hour - 30 * 60_000, endMs: 100 * hour + 31 * 60_000 }]);
});

test("the calibration and dual-track charts share one viewport", () => {
  for (const name of ["CALIBRATION_CHART_VIEWPORT", "USAGE_CHART_VIEWPORT"]) {
    const block = source.slice(source.indexOf(`const ${name} = Object.freeze({`));
    const write = block.slice(0, block.indexOf("});"));
    assert.match(write, /timelineViewport = value/u, name);
    assert.match(write, /usageTimelineViewport = value/u, name);
  }
});
