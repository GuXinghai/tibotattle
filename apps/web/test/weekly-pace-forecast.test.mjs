import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const paceSource = appSource.match(
  /function weeklyPaceReading[\s\S]*?\n\}\n\nfunction renderWeekly\(data\)/u,
)?.[0] ?? "";

function sliceDeclaration(name) {
  const source = appSource.match(
    new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\n`, "u"),
  )?.[0];
  assert.ok(source, `${name} is declared at the top level of app.js`);
  return source;
}

function sliceConstant(name) {
  const source = appSource.match(new RegExp(`\\nconst ${name} = [^;]+;`, "u"))?.[0];
  assert.ok(source, `${name} is declared at the top level of app.js`);
  return source;
}

// The classification is pure arithmetic over numbers the payload already
// carries, so it is exercised directly rather than asserted about as text. The
// slice keeps the test bound to the shipped source: app.js is a boot script
// with no exports, and a copy of the maths here could drift from it silently.
const pace = new Function(
  "finite",
  "formatDecimal",
  `
  ${sliceConstant("PACE_ON_TRACK_LOWER_RATIO")}
  ${sliceConstant("PACE_ON_TRACK_UPPER_RATIO")}
  ${sliceConstant("PACE_CRITICAL_RATIO")}
  ${sliceConstant("PACE_AVERAGE_MINIMUM_HOURS")}
  ${sliceDeclaration("firstFiniteForecastNumber")}
  ${sliceDeclaration("weeklyPaceRates")}
  ${sliceDeclaration("weeklyPaceStanding")}
  ${sliceDeclaration("formatPaceRatio")}
  return {
    weeklyPaceRates,
    weeklyPaceStanding,
    formatPaceRatio,
    PACE_ON_TRACK_LOWER_RATIO,
    PACE_ON_TRACK_UPPER_RATIO,
    PACE_CRITICAL_RATIO,
  };
`,
)(
  (value) => (typeof value === "number" && Number.isFinite(value) ? value : null),
  (value, digits) => value.toFixed(digits),
);

test("pace standing is measured against what the window can still sustain", () => {
  // 50% left with 84 hours to run sustains 0.595pp/hour. The three readings
  // below sit either side of that rate, not either side of a fixed
  // 100%-per-seven-days rate, which is the whole point of the change.
  const under = pace.weeklyPaceStanding({
    remainingPercent: 50,
    hoursToReset: 84,
    pacePpPerHour: .3,
  });
  const on = pace.weeklyPaceStanding({
    remainingPercent: 50,
    hoursToReset: 84,
    pacePpPerHour: .6,
  });
  const over = pace.weeklyPaceStanding({
    remainingPercent: 50,
    hoursToReset: 84,
    pacePpPerHour: .9,
  });
  assert.equal(under.state, "under");
  assert.equal(on.state, "on");
  assert.equal(over.state, "over");
  assert.equal(over.critical, false);

  // The reading that prompted the change: 3% left, a day and five hours to
  // run, and a pace that empties it inside the hour. The old card called this
  // "ahead of a steady weekly pace" and rendered green.
  const emergency = pace.weeklyPaceStanding({
    remainingPercent: 3,
    hoursToReset: 29,
    pacePpPerHour: 11.3,
  });
  assert.equal(emergency.state, "over");
  assert.equal(emergency.critical, true);
  assert.ok(emergency.coveredHours < .3);
  assert.ok(emergency.dryHours > 28);
  assert.equal(emergency.sparePercent, 0);
});

test("the critical step is exactly the point where dry time exceeds covered time", () => {
  const atThreshold = pace.weeklyPaceStanding({
    remainingPercent: 40,
    hoursToReset: 100,
    // Twice the sustainable 0.4pp/hour.
    pacePpPerHour: .8,
  });
  assert.equal(atThreshold.ratio, pace.PACE_CRITICAL_RATIO);
  assert.equal(atThreshold.critical, true);
  assert.equal(atThreshold.coveredHours, 50);
  assert.equal(atThreshold.dryHours, 50);
});

test("an under-pace standing reports the allowance left over at the reset", () => {
  const standing = pace.weeklyPaceStanding({
    remainingPercent: 60,
    hoursToReset: 100,
    pacePpPerHour: .4,
  });
  assert.equal(standing.state, "under");
  // 0.4pp/hour for 100 hours spends 40 of the 60 points that are left.
  assert.equal(Math.round(standing.sparePercent), 20);
  assert.equal(standing.dryHours, 0);
  assert.equal(standing.coveredHours, 100);
});

test("pace standing refuses readings it cannot classify", () => {
  const cases = [
    { remainingPercent: null, hoursToReset: 84, pacePpPerHour: .6 },
    { remainingPercent: 50, hoursToReset: null, pacePpPerHour: .6 },
    { remainingPercent: 50, hoursToReset: 0, pacePpPerHour: .6 },
    { remainingPercent: 0, hoursToReset: 84, pacePpPerHour: .6 },
    { remainingPercent: 50, hoursToReset: 84, pacePpPerHour: 0 },
    { remainingPercent: 50, hoursToReset: 84, pacePpPerHour: null },
  ];
  for (const input of cases) {
    assert.equal(pace.weeklyPaceStanding(input), null, JSON.stringify(input));
  }
});

test("the headline rate counts idle time and the active rate stays separate", () => {
  // Since quota-pace-forecast-v0.2 the engine names both rates, and the
  // wall-clock one is what its own ETA is built from. The card follows it.
  const rates = pace.weeklyPaceRates(
    {
      activePercentagePointsPerHour: 11.3,
      overallPercentagePointsPerHour: .97,
      elapsedHours: 100,
      movementPp: 97,
    },
    {},
  );
  assert.equal(rates.active, 11.3);
  assert.equal(rates.average, .97);
  assert.equal(rates.headline, .97);
});

test("a payload without the named wall-clock rate derives one", () => {
  // Pre-v0.2 shape: the rate has to come from movement over elapsed time, and
  // carries a minimum-span guard because a derived average over a few minutes
  // is whatever the reader happened to be doing.
  const rates = pace.weeklyPaceRates(
    { activePercentagePointsPerHour: 11.3, elapsedHours: 100, movementPp: 97 },
    {},
  );
  assert.equal(rates.active, 11.3);
  assert.equal(Math.round(rates.average * 100) / 100, .97);
  assert.equal(rates.headline, rates.average);
});

test("too short an observation span falls back to the active rate", () => {
  const rates = pace.weeklyPaceRates(
    { activePercentagePointsPerHour: 4, elapsedHours: .5, movementPp: 2 },
    {},
  );
  assert.equal(rates.average, null);
  assert.equal(rates.headline, 4);

  const noMovement = pace.weeklyPaceRates(
    { activePercentagePointsPerHour: 4, elapsedHours: 12, movementPp: 0 },
    {},
  );
  assert.equal(noMovement.average, null);
  assert.equal(noMovement.headline, 4);
});

test("weekly pace forecast is an optional, allowance-scoped dashboard surface", () => {
  assert.match(paceSource, /data\?\.weekly\?\.paceForecast/u);
  assert.match(paceSource, /weekly-pace-forecast/u);
  assert.match(paceSource, /status === "available"/u);
  assert.match(paceSource, /will_reach_reset_first/u);
  assert.match(
    paceSource,
    /status === "insufficient_observations"[\s\S]*?observations === 1/u,
  );
  assert.match(paceSource, /allowance\.headline/u);
  assert.match(paceSource, /allowance\.spareTitle/u);
  assert.match(paceSource, /allowance\.collectingTitle/u);
  assert.match(paceSource, /allowance\.early/u);
  assert.match(
    paceSource,
    /if \(!available && !reachesResetFirst && !collectingEvidence\) return/u,
  );
  assert.match(
    paceSource,
    /forecast\.observationCount[\s\S]*?paceIntervals === null \? null : paceIntervals \+ 1/u,
  );
  assert.doesNotMatch(paceSource, /probability|tokens/iu);
});

test("the standing drives the card's class and is also stated in words", () => {
  // Colour alone must never carry the reading: the chip names the state, so a
  // monochrome screen, a colour-vision difference and a screen reader all get
  // the same answer the border does.
  assert.match(paceSource, /is-over-pace/u);
  assert.match(paceSource, /is-on-pace/u);
  assert.match(paceSource, /is-under-pace/u);
  assert.match(paceSource, /is-critical/u);
  assert.match(paceSource, /weekly-pace-forecast-state-chip/u);
  assert.match(appSource, /over: "allowance\.over"/u);
  assert.match(appSource, /on: "allowance\.on"/u);
  assert.match(appSource, /under: "allowance\.under"/u);
  // The engine's own split is no longer what colours the card, but it stays
  // readable from the DOM.
  assert.match(paceSource, /reachesResetFirst \? "is-reset-first" : ""/u);
});

test("weekly pace forecast styles map each standing to its own accent", () => {
  assert.match(styles, /\.weekly-pace-forecast\[hidden\]\s*\{\s*display:\s*none;/u);
  assert.match(styles, /\.weekly-pace-forecast-metrics/u);
  assert.match(styles, /\.weekly-pace-forecast-metric/u);
  assert.match(styles, /\.weekly-pace-forecast\.is-insufficient/u);
  assert.match(styles, /\.weekly-pace-forecast-early-chip/u);
  assert.match(styles, /\.weekly-pace-forecast\.is-on-pace/u);
  assert.match(styles, /\.weekly-pace-forecast\.is-over-pace/u);
  assert.match(styles, /\.weekly-pace-forecast\.is-over-pace\.is-critical/u);
  // Under pace keeps the calm accent; every other standing overrides it.
  assert.match(
    styles,
    /\.weekly-pace-forecast \{[\s\S]*?--pace-accent: var\(--green\);/u,
  );
  assert.match(
    styles,
    /\.weekly-pace-forecast\.is-over-pace \{[\s\S]*?--pace-accent: var\(--amber\);/u,
  );
  assert.match(
    styles,
    /\.weekly-pace-forecast\.is-over-pace\.is-critical \{[\s\S]*?--pace-accent: var\(--rust\);/u,
  );
  assert.match(styles, /\.weekly-pace-track-bar/u);
  assert.match(styles, /\.weekly-pace-track-covered/u);
  assert.match(styles, /\.weekly-pace-track-mark/u);
  // The dry remainder is hatched, not merely a paler colour.
  assert.match(styles, /repeating-linear-gradient/u);
});

// ---------------------------------------------------------------------------
// Overview summary
//
// The Overview states the same reading as the Forecast card, so these cases run
// the shipped renderOverviewPace, weeklyPaceReading and their helpers against
// a minimal DOM. Only presentation primitives are stubbed; every number on the
// page comes from the shipped arithmetic.
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tag, className = "", text = "") {
    this.tag = tag;
    this.className = className;
    this.textContent = text;
    this.children = [];
    this.attributes = new Map();
    this.hidden = false;
    this.classList = { add: (name) => { this.className = `${this.className} ${name}`.trim(); } };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  get childElementCount() { return this.children.length; }
  text() {
    return [this.textContent, ...this.children.map((child) => (
      typeof child === "string" ? child : child.text()
    ))].filter(Boolean).join(" | ");
  }
}

function overviewHarness() {
  const target = new FakeElement("aside", "overview-pace");
  target.hidden = true;
  const render = new Function(
    "finite", "formatDecimal", "formatPercent", "formatAllowanceDuration", "t",
    "node", "clear", "$", "allowanceTimestamp", "document",
    "isPrimaryCodexWeeklyQuotaWindow", "PACE_STATE_LABELS",
    `
    ${sliceConstant("PACE_ON_TRACK_LOWER_RATIO")}
    ${sliceConstant("PACE_ON_TRACK_UPPER_RATIO")}
    ${sliceConstant("PACE_CRITICAL_RATIO")}
    ${sliceConstant("PACE_AVERAGE_MINIMUM_HOURS")}
    ${sliceDeclaration("firstFiniteForecastNumber")}
    ${sliceDeclaration("forecastTimestamp")}
    ${sliceDeclaration("weeklyPaceRates")}
    ${sliceDeclaration("weeklyPaceStanding")}
    ${sliceDeclaration("formatPaceRatio")}
    ${sliceDeclaration("weeklyPaceReading")}
    ${sliceDeclaration("weeklyPaceHeadlineText")}
    ${sliceDeclaration("weeklyPaceCopyText")}
    ${sliceDeclaration("weeklyPaceWaitingText")}
    ${sliceDeclaration("renderOverviewPace")}
    return renderOverviewPace;
  `,
  )(
    (value) => (typeof value === "number" && Number.isFinite(value) ? value : null),
    (value, digits) => value.toFixed(digits),
    (value) => `${value}%`,
    (hours) => `${Math.round(hours)}h`,
    (key, values = {}) => `${key}${Object.keys(values).length ? JSON.stringify(values) : ""}`,
    (tag, className = "", text = "") => new FakeElement(tag, className, text),
    (element) => { element.children = []; },
    () => target,
    (label) => new FakeElement("button", "allowance-timestamp", label),
    { createTextNode: (text) => text },
    (window) => window?.limitId === "codex" && window?.durationMinutes === 10_080,
    { over: "allowance.over", on: "allowance.on", under: "allowance.under" },
  );
  return { target, render };
}

const HOUR = 3_600_000;
const weeklyWindow = (extra = {}) => ({ limitId: "codex", durationMinutes: 10_080, ...extra });
const resetIn = (hours) => new Date(Date.now() + hours * HOUR).toISOString();

test("the overview names the run-out when the pace exhausts the window", () => {
  const { target, render } = overviewHarness();
  render({
    quotaWindows: [weeklyWindow()],
    weekly: { paceForecast: {
      status: "available",
      resetsAt: resetIn(40),
      remainingPercent: 20,
      etaAt: resetIn(20),
      observationCount: 12,
      pace: { overallPercentagePointsPerHour: 1.2, elapsedHours: 48, sampleCount: 11 },
    } },
  });
  assert.equal(target.hidden, false);
  assert.match(target.className, /is-over-pace/u);
  assert.match(target.className, /is-critical/u);
  const text = target.text();
  assert.match(text, /allowance\.headline/u);
  assert.match(text, /allowance\.runout/u);
  assert.match(text, /allowance\.recentPace/u);
  assert.match(text, /allowance\.rate\{"rate":"1\.2"\}/u);
  assert.match(text, /allowance\.wayOver/u);
  assert.doesNotMatch(text, /allowance\.spare\b/u);
  assert.match(target.children.at(-1).attributes.get("href"), /^#allowance\/forecast$/u);
});

test("the overview reports spare allowance when the window outlasts the pace", () => {
  const { target, render } = overviewHarness();
  render({
    quotaWindows: [weeklyWindow()],
    weekly: { paceForecast: {
      status: "will_reach_reset_first",
      resetsAt: resetIn(40),
      remainingPercent: 80,
      observationCount: 12,
      pace: { overallPercentagePointsPerHour: .5, elapsedHours: 48, sampleCount: 11 },
    } },
  });
  assert.equal(target.hidden, false);
  assert.match(target.className, /is-under-pace/u);
  const text = target.text();
  assert.match(text, /allowance\.spareTitle/u);
  assert.match(text, /allowance\.spare\b/u);
  assert.doesNotMatch(text, /allowance\.runout/u);
});

test("the overview reports only observed exhaustion and the time until reset", () => {
  const { target, render } = overviewHarness();
  const resetAt = resetIn(20);
  const forecast = {
    status: "exhausted",
    currentUsedPercent: 100,
    remainingPercent: 0,
    resetsAt: resetAt,
    etaAt: null,
    hoursToExhaustion: 0,
    observationCount: 3,
    pace: { method: "median_adjacent_quota_slope" },
  };
  const payload = {
    quotaWindows: [weeklyWindow()],
    weekly: { paceForecast: forecast },
  };

  render(payload);
  assert.equal(target.hidden, false);
  assert.match(target.text(), /trends\.evidenceExhausted/u);
  assert.match(target.text(), /trends\.evidenceExhaustedWhy/u);
  assert.match(target.text(), /0%/u);
  assert.match(target.text(), /allowance\.resetsIn/u);
  assert.doesNotMatch(target.text(), /allowance\.rate|allowance\.runout|allowance\.spare\b/u);

  for (const changes of [
    { remainingPercent: 0.001 },
    { etaAt: resetIn(1) },
    { hoursToExhaustion: null },
    { observationCount: 0 },
    { pace: { method: "unreviewed_method" } },
  ]) {
    render({ ...payload, weekly: { paceForecast: { ...forecast, ...changes } } });
    assert.match(target.text(), /allowance\.waitingTitle/u);
    assert.doesNotMatch(target.text(), /trends\.evidenceExhausted/u);
  }
});

test("the overview says it is waiting instead of inventing a rate", () => {
  const waiting = overviewHarness();
  waiting.render({ quotaWindows: [weeklyWindow()], weekly: {} });
  assert.equal(waiting.target.hidden, false);
  assert.match(waiting.target.className, /is-waiting/u);
  assert.match(waiting.target.text(), /allowance\.waitingTitle/u);
  assert.doesNotMatch(waiting.target.text(), /allowance\.rate|allowance\.runout/u);

  const stale = overviewHarness();
  stale.render({
    quotaWindows: [weeklyWindow({ status: "stale" })],
    weekly: { paceForecast: { status: "available", resetsAt: resetIn(40), remainingPercent: 20 } },
  });
  assert.match(stale.target.text(), /allowance\.waitingStaleTitle/u);
  assert.doesNotMatch(stale.target.text(), /allowance\.runout/u);
});

test("the overview stays out of the page when no weekly window was observed", () => {
  const { target, render } = overviewHarness();
  render({ quotaWindows: [], weekly: {} });
  assert.equal(target.hidden, true);
  assert.equal(target.childElementCount, 0);
});

test("unattributed live allowance explains why forecast evidence is unavailable", () => {
  const { target, render } = overviewHarness();
  render({ quotaWindows: [weeklyWindow({ status: "live", accountAttribution: "unattributed" })],
    weekly: { paceForecast: { status: "unavailable", observationCount: 0 } } });
  assert.equal(target.hidden, false);
  assert.match(target.text(), /allowance\.waitingAccountTitle/u);
  assert.match(target.text(), /allowance\.waitingAccountCopy/u);
  assert.doesNotMatch(target.text(), /allowance\.rate|allowance\.runout/u);
  render({ quotaWindows: [weeklyWindow({ status: "stale", accountAttribution: "unattributed" })] });
  assert.match(target.text(), /allowance\.waitingStaleCopy/u);
  assert.doesNotMatch(target.text(), /allowance\.waitingAccountTitle/u);
});

test("the overview and the Forecast card share one reading", () => {
  const overview = sliceDeclaration("renderOverviewPace");
  const card = sliceDeclaration("renderWeeklyPaceForecast");
  assert.match(overview, /weeklyPaceReading\(data\)/u);
  assert.match(card, /weeklyPaceReading\(data\)/u);
  // No second forecast parser: the Overview never reads the payload itself.
  assert.doesNotMatch(overview, /paceForecast|hoursToExhaustion|etaAt/u);
  assert.match(appSource, /renderWeeklyPaceForecast\(presentation\);\s*renderOverviewPace\(presentation\);/u);
});
