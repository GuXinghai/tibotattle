import { formatModelName } from "./ui-format.js";
import {
  normalizeReportingWindow,
  reportingRequestPeriod,
} from "./dashboard-ui.js";
export { normalizeReportingWindow } from "./dashboard-ui.js";

// Presentation-only: the companion owns reconstruction, eligibility and bins.
const DAY = 86_400_000;
const PERIODS = ["1", "7", "30", "all"];
const STANDALONE_PERIODS = ["7", "30", "all"];
// The shared dashboard can request the 24-hour backend period (`1`), while
// the standalone controls intentionally expose only the standard periods.
const PRELOAD_PERIODS = STANDALONE_PERIODS;
const MAX_READY_PERIODS = 12;
// Keep the in-memory period cache useful across quick switches while ensuring
// each entry is eventually revalidated. The cache holds at most the four
// shared periods in three speed modes; it never persists measurements in browser storage.
const PERIOD_CACHE_TTL_MS = 300_000;
// A first history pass can take minutes. Continue bounded background retries
// while the document is visible instead of giving up after ten seconds.
const PRELOAD_MAX_ATTEMPTS = 24;
const preloadRetryDelay = attempt => Math.min(30_000, 5_000 * 2 ** attempt);
// Source recovery has its own budget: it must not spend the cold-history
// polling budget or turn a persistent warning into endless foreground work.
// Span the worker's one-minute rediscovery cadence while keeping every gap
// below its one-minute idle lease. Reads do not force a history scan.
const SOURCE_RETRY_DELAYS = [5_000, 10_000, 20_000, 30_000];
const RETRYABLE_SOURCE_CHANGES = ['source_grew_during_read',
  'source_metadata_changed_during_read', 'source_changed_unknown'];
const SPEED_METHOD = "speed";
const SPEED_MODES = ["standard", "fast", "ultrafast"];
const MODEL_NAMES = Object.freeze({
  "gpt-6-astra": "Astra", "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6.1-terra": "GPT-6.1 Terra",
  "gpt-6-sol": "GPT-6 Sol", "gpt-6-luna": "GPT-6 Luna",
  "gpt-5.6-terra": "Terra", "gpt-5.6-sol": "Sol", "gpt-5.6-luna": "Luna",
  "gpt-5.5": "GPT-5.5", "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 mini", "gpt-5.3-codex-spark": "Spark",
  "gpt-5.3-codex": "GPT-5.3 Codex", "gpt-5.2-codex": "GPT-5.2 Codex", "gpt-5.2": "GPT-5.2",
});
const MODEL_ORDER = Object.freeze(Object.keys(MODEL_NAMES));
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export { reportingRequestPeriod } from "./dashboard-ui.js";

/** A closed, bounded display contract: never pass arbitrary source text to DOM. */
export function normalizeModelPerformance(value) {
  if (!exact(value, ["schemaVersion", "method", "status", "collecting", "stale", "updatedAt", "period", "interval", "start", "end", "historyProgress", "speedMode", "excludedUnknownTurns", "models"])
      || value.schemaVersion !== 6 || value.method !== 5
      || !SPEED_MODES.includes(value.speedMode) || !count(value.excludedUnknownTurns)
      || !["ready", "loading", "unavailable"].includes(value.status)
      || typeof value.collecting !== "boolean" || typeof value.stale !== "boolean" || !PERIODS.includes(value.period)
      || !["day", "week"].includes(value.interval) || !timestamp(value.end)
      || !(value.start === null || timestamp(value.start) && value.start <= value.end)
      || !(value.updatedAt === null || typeof value.updatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value.updatedAt) && Number.isFinite(Date.parse(value.updatedAt)))
      || !(value.historyProgress === null || exact(value.historyProgress, ["checked", "total"])
        && count(value.historyProgress.checked) && count(value.historyProgress.total)
        && value.historyProgress.checked <= value.historyProgress.total)
      || !Array.isArray(value.models) || value.models.length > 16) return null;
  const step = value.interval === "week" ? 7 * DAY : DAY;
  const seen = new Set();
  const validPoints = (points, maximum) => {
    if (!Array.isArray(points) || points.length > 2048) return false;
    let previous = -1, total = 0;
    for (const point of points) {
      if (!exact(point, ["at", "n", "mean", "p10", "p25", "median", "p75", "p90"]) || !timestamp(point.at)
          || point.at <= previous || point.at > value.end || (value.start !== null && point.at < value.start - step)
          || !count(point.n) || point.n < 1 || !Number.isFinite(point.median) || point.median < 0
          || point.median > 1e9 || !Number.isFinite(point.mean) || point.mean < 0 || point.mean > 1e9) return false;
      if (point.n < 5 ? [point.p10, point.p25, point.p75, point.p90].some(value => value !== null)
        : ![point.p10, point.p25, point.p75, point.p90].every(Number.isFinite)
          || point.p10 < 0 || point.p10 > point.p25 || point.p25 > point.median
          || point.p75 < point.median || point.p90 < point.p75 || point.p90 > 1e9) return false;
      previous = point.at;
      total += point.n;
    }
    return total <= maximum;
  };
  for (const model of value.models) {
    if (!exact(model, ["id", "label", "turns", "speedTurns", "ttftTurns", "timedResponses", "speed", "ttft", "toolFreeTurns", "toolFree"])
        || !Object.hasOwn(MODEL_NAMES, model.id) || model.label !== MODEL_NAMES[model.id] || seen.has(model.id)
        || ![model.turns, model.speedTurns, model.ttftTurns, model.timedResponses].every(count)
        || model.speedTurns > model.turns || model.ttftTurns > model.turns
        || !Array.isArray(model.speed) || model.speed.length > 1 || !validPoints(model.ttft, model.ttftTurns)) return null;
    if (!count(model.toolFreeTurns) || model.toolFreeTurns > model.turns
        || !validPoints(model.toolFree, model.toolFreeTurns)) return null;
    seen.add(model.id);
    let speedCount = 0;
    for (const series of model.speed) {
      if (!exact(series, ["method", "points"]) || series.method !== SPEED_METHOD
          || !validPoints(series.points, model.speedTurns)) return null;
      speedCount += series.points.reduce((sum, point) => sum + point.n, 0);
    }
    if (speedCount > model.speedTurns) return null;
    if (model.toolFreeTurns > model.speedTurns) return null;
    const speedBins = new Map(model.speed.flatMap(series => series.points).map(point => [point.at, point.n]));
    if (model.toolFree.some(point => point.n > (speedBins.get(point.at) ?? 0))) return null;
  }
  return value;
}

/** Segment metadata identifies gaps; renderers must not draw those intervals. */
export function performanceSegments(points, interval) {
  const step = interval === "week" ? 7 * DAY : DAY;
  return points.slice(1).flatMap((point, index) => {
    const previous = points[index], gap = point.at - previous.at;
    return [{ from: previous, to: point, dashed: gap > step }];
  });
}

/** All-time focuses this model's measured era; all metrics retain one domain. */
export function performanceDomain(payload, model) {
  let start = payload.start;
  if (payload.period === "all") {
    let first = Infinity;
    for (const series of model.speed) if (series.points.length) first = Math.min(first, series.points[0].at);
    if (model.ttft.length) first = Math.min(first, model.ttft[0].at);
    if (Number.isFinite(first)) start = first;
  }
  return { start: start ?? payload.end, end: payload.end };
}

/** Zero-based 1/2/5 scales keep ticks legible without clipping the spread. */
export function performanceYScale(values) {
  const peak = Math.max(0, ...values.filter(value => Number.isFinite(value) && value >= 0));
  const rough = (peak || 1) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find(n => n * power >= rough) ?? 10) * power;
  const maximum = Math.ceil((peak || 1) / step) * step;
  const ticks = Array.from({ length: Math.round(maximum / step) + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  return { maximum, ticks, digits: Math.max(0, -Math.floor(Math.log10(step))) };
}

/** UTC calendar ticks, never fractional positions formatted as random dates. */
export function performanceDateTicks({ start, end }) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days = (end - start) / DAY, ticks = [];
  if (days <= 40) {
    const step = days <= 8 ? DAY : days <= 16 ? 2 * DAY : 7 * DAY;
    const anchor = step === 7 * DAY ? 4 * DAY : 0; // Mondays.
    for (let at = Math.ceil((start - anchor) / step) * step + anchor; at <= end; at += step) ticks.push(at);
  } else {
    const date = new Date(start);
    let year = date.getUTCFullYear(), month = date.getUTCMonth();
    const monthStep = days <= 100 ? 0 : days <= 240 ? 1 : days <= 730 ? 3 : 12 * Math.ceil(days / (365 * 6));
    if (monthStep >= 12) { year = Math.floor(year / (monthStep / 12)) * (monthStep / 12); month = 0; }
    else if (monthStep) month = Math.floor(month / monthStep) * monthStep;
    for (let i = 0; i < 32; i++) {
      const at = Date.UTC(year, month, 1);
      if (at > end) break;
      if (at >= start) ticks.push(at);
      if (!monthStep) {
        const mid = Date.UTC(year, month, 15);
        if (mid >= start && mid <= end) ticks.push(mid);
      }
      month += monthStep || 1;
    }
  }
  return ticks;
}

/** Snap to the calendar bin, including missing bins; never borrow a distant point. */
export function performanceHoverBin(fraction, { start, end }, interval) {
  const step = interval === 'week' ? 7 * DAY : DAY;
  const anchor = interval === 'week' ? 4 * DAY : 0;
  const at = start + Math.max(0, Math.min(1, fraction)) * (end - start);
  const first = Math.floor((start - anchor) / step), last = Math.floor((end - anchor) / step);
  return Math.max(first, Math.min(last, Math.round((at - anchor) / step))) * step + anchor;
}

export function mountModelPerformance(options = {}) {
  const { root, client, t, locale = () => "en-US", windowRef = globalThis.window } = options;
  if (!root) return {
    render() {},
    refresh() {},
    preload: () => Promise.resolve(false),
    setReportingWindow() { return false; },
    cancel() {},
  };
  const documentRef = root.ownerDocument;
  let sharedReporting = options.sharedReporting === true || Object.hasOwn(options, "reportingWindow");
  const storageKey = "usagemonitor.performance.v1";
  let saved = {};
  try { saved = JSON.parse(windowRef.localStorage.getItem(storageKey)) ?? {}; } catch { /* Storage can be disabled. */ }
  let period = STANDALONE_PERIODS.includes(saved.period) ? saved.period : "all";
  let reportingWindow = sharedReporting ? normalizeReportingWindow(options.reportingWindow) : null;
  let modelId = Object.hasOwn(MODEL_NAMES, saved.model) ? saved.model : null;
  let speedMode = SPEED_MODES.includes(saved.speedMode) ? saved.speedMode : "standard";
  let diagnostics = [], sourceDiagnostics = [], failureCode = null, pendingAttempts = 0;
  let sourceRetryKey = null, sourceRetryAttempts = 0, retrying = false, retryExhausted = false;
  const pendingResult = () => (payload?.status === 'loading' || payload?.collecting)
    && !diagnostics.some(code => code === 'timing_worker_failed' || code === 'timing_projection_failed');
  const diagnosticsByKey = new Map();
  const sourceDiagnosticsByKey = new Map();
  const resetSourceRetry = () => {
    sourceRetryKey = null; sourceRetryAttempts = 0; retrying = false; retryExhausted = false;
  };
  const recoverableSourceWarning = () => diagnostics.includes('timing_source_recovery_failed')
    && diagnostics.every(code => code === 'timing_source_recovery_failed')
    && sourceDiagnostics.every(row => RETRYABLE_SOURCE_CHANGES.includes(row.code));
  let payload = null, loading = false, failed = false, cancelled = false, request = 0, timer = null;
  let retainedWindowKey = null;
  let retainedWindowUnavailable = false;
  let foregroundKey = null;
  // Retain only a bounded set of exact reporting windows for this mounted
  // local view. Shared end bounds can change as accounting snapshots advance.
  // No measurements or identity-bearing data enter browser storage.
  const readyPeriods = new Map();
  const rememberReady = (key, value) => {
    readyPeriods.delete(key);
    readyPeriods.set(key, { payload: value, cachedAt: Date.now() });
    while (readyPeriods.size > MAX_READY_PERIODS)
      readyPeriods.delete(readyPeriods.keys().next().value);
  };
  const pendingPeriods = new Map();
  let lifecycle = 0, scopeGeneration = 0, scopeUnavailable = false, destroyed = false;
  let preloadPromise = null, preloadComplete = false;
  const preloadWaiters = new Map();
  let chartCursors = [];
  let selectedInterval = null;
  const showInterval = (at) => { if (at === selectedInterval) return; selectedInterval = at; for (const update of chartCursors) update(at); };
  const translate = (key, values) => t(`performance.${key}`, values);
  const reportTranslate = (key, values) => t(`reporting.${key}`, values);
  const reportingKey = () => sharedReporting
    ? `${reportingWindow?.period ?? "waiting"}:${reportingWindow?.startAt ?? ""}:${reportingWindow?.endAt ?? ""}`
    : period;
  const selectedRequestPeriod = () => sharedReporting
    ? reportingRequestPeriod(reportingWindow?.period)
    : period;
  const requestEndAt = () => sharedReporting ? reportingWindow?.endAt ?? null : null;
  let formatterLocale, numberFormat, integerFormat, dateFormat, fullDateFormat;
  function formatters() {
    const selectedLocale = locale();
    if (formatterLocale !== selectedLocale) {
      formatterLocale = selectedLocale;
      numberFormat = new Intl.NumberFormat(selectedLocale, { maximumFractionDigits: 1 });
      integerFormat = new Intl.NumberFormat(selectedLocale, { maximumFractionDigits: 0 });
      dateFormat = new Intl.DateTimeFormat(selectedLocale, { month: "short", day: "numeric", timeZone: "UTC" });
      fullDateFormat = new Intl.DateTimeFormat(selectedLocale, { dateStyle: "medium", timeZone: "UTC" });
    }
  }
  const number = (value) => { formatters(); return numberFormat.format(value); };
  const metricNumber = (value, metric) => { formatters(); return (metric === "latency" ? numberFormat : integerFormat).format(value); };
  const date = (value) => { formatters(); return dateFormat.format(value); };
  const visible = () => !root.classList.contains("dashboard-page-inactive") && !documentRef.hidden;
  const remember = () => {
    try {
      const preference = sharedReporting ? { model: modelId, speedMode } : { period, model: modelId, speedMode };
      windowRef.localStorage.setItem(storageKey, JSON.stringify(preference));
    } catch { /* Nonessential preference. */ }
  };
  const element = (name, className, text) => {
    const node = documentRef.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const derivedReportingStart = (window) => {
    if (!window?.endAt || window.period === "all") return null;
    const duration = window.period === "24h" ? DAY : window.period === "7d" ? 7 * DAY : 30 * DAY;
    return new Date(Date.parse(window.endAt) - duration).toISOString();
  };
  const reportingRange = (window, fallback = null) => {
    formatters();
    const selected = window ?? fallback;
    if (!selected) return null;
    const period = selected.period;
    const endAt = selected.endAt ?? (Number.isFinite(selected.end) ? new Date(selected.end).toISOString() : null);
    if (!endAt) return null;
    const end = fullDateFormat.format(new Date(endAt));
    if (period === "all") return reportTranslate("allThrough", { end });
    const startAt = selected.startAt ?? derivedReportingStart(selected)
      ?? (Number.isFinite(selected.start) ? new Date(selected.start).toISOString() : null);
    if (!startAt) return end;
    return reportTranslate("range", { start: fullDateFormat.format(new Date(startAt)), end });
  };
  const svgElement = (name, attributes = {}, text) => {
    const node = documentRef.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function plot(series, metric, color, domain) {
    const holder = element("div", "performance-plot");
    const points = series.flatMap((item) => item.points);
    if (!points.length) { holder.append(element("p", "performance-empty", translate("noMeasurements"))); return holder; }
    const contentWidth = root.clientWidth || 800;
    const width = Math.max(240, contentWidth >= 760 ? (contentWidth - 28) / 2 : contentWidth);
    const svg = svgElement("svg", { viewBox: `0 0 ${width} 256`, role: "group", "aria-label": translate(metric) });
    formatters();
    const { start, end } = domain;
    const scale = performanceYScale(points.flatMap(point => [point.p90 ?? point.median, point.mean]));
    const axisNumber = new Intl.NumberFormat(locale(), { maximumFractionDigits: metric === "latency" ? Math.min(20, scale.digits) : 0 });
    const plotLeft = 50, plotRight = width - 14, plotWidth = plotRight - plotLeft;
    const x = value => plotLeft + Math.max(0, Math.min(1, (value - start) / Math.max(1, end - start))) * plotWidth;
    const y = value => 214 - value / scale.maximum * 190;
    const curve = (a, b, key, reverse = false) => {
      const ax = x(a.at), ay = y(a[key]), bx = x(b.at), by = y(b[key]), control = (bx - ax) / 3;
      return reverse
        ? `M${bx},${by} C${bx - control},${by} ${ax + control},${ay} ${ax},${ay}`
        : `M${ax},${ay} C${ax + control},${ay} ${bx - control},${by} ${bx},${by}`;
    };
    const band = (a, b, low, high) => `${curve(a, b, low)} L${x(b.at)},${y(b[high])} ${curve(a, b, high, true).slice(1)} Z`;
    for (const value of scale.ticks) {
      svg.append(svgElement("line", { x1: plotLeft, x2: plotRight, y1: y(value), y2: y(value), class: "performance-grid" }),
        svgElement("text", { x: 42, y: y(value) + 4, "text-anchor": "end", class: "performance-axis" }, axisNumber.format(value)));
    }
    const dateTicks = performanceDateTicks(domain);
    const tickDate = new Intl.DateTimeFormat(locale(), { month: "short", ...(end - start > 730 * DAY ? { year: "numeric" } : { day: "numeric" }), timeZone: "UTC" });
    const tickStride = Math.max(1, Math.ceil(dateTicks.length / (width < 360 ? 2 : 4)));
    for (const at of dateTicks.filter((_, index) => index % tickStride === 0)) {
      const px = x(at);
      svg.append(svgElement("line", { x1: px, x2: px, y1: 24, y2: 214, class: "performance-grid performance-date-grid" }),
        svgElement("text", { x: px, y: 244, "text-anchor": px < 80 ? "start" : px > plotRight - 30 ? "end" : "middle", class: "performance-axis" }, tickDate.format(at)));
    }
    svg.append(svgElement("path", { d: `M${plotLeft} 24V214H${plotRight}`, class: "performance-axis-line", fill: "none" }));
    const readout = element("p", "sr-only performance-readout", "");
    readout.setAttribute("aria-live", "polite");
    const tooltip = element("div", "performance-tooltip"); tooltip.hidden = true;
    tooltip.setAttribute("aria-hidden", "true");
    const percentileValues = point => point.p10 === null ? translate("percentilesUnavailable") : translate("percentileValues", {
      p10: metricNumber(point.p10, metric), p25: metricNumber(point.p25, metric), p75: metricNumber(point.p75, metric), p90: metricNumber(point.p90, metric),
    });
    const formatPoint = (point) => translate("point", { date: fullDateFormat.format(point.at), method: translate(metric), median: metricNumber(point.median, metric), mean: number(point.mean), percentiles: percentileValues(point), count: number(point.n) });
    const cursor = svgElement("line", { x1: 0, x2: 0, y1: 24, y2: 214, class: "performance-cursor", visibility: "hidden" });
    const markers = [];
    for (const item of series) {
      const gradientSuffix = `${metric}-${modelId}-${item.method}`;
      const defs = svgElement("defs");
      for (const [name, middleOpacity] of [["outer", .12], ["inner", .22]]) {
        const gradient = svgElement("linearGradient", { id: `performance-${name}-${gradientSuffix}`, x1: 0, y1: 0, x2: 0, y2: 1 });
        gradient.append(svgElement("stop", { offset: "0%", "stop-color": color, "stop-opacity": .035 }),
          svgElement("stop", { offset: "50%", "stop-color": color, "stop-opacity": middleOpacity }),
          svgElement("stop", { offset: "100%", "stop-color": color, "stop-opacity": .035 }));
        defs.append(gradient);
      }
      svg.append(defs);
      for (const segment of performanceSegments(item.points, payload.interval)) {
        const a = segment.from, b = segment.to;
        if (segment.dashed) continue;
        if (!segment.dashed && a.p10 !== null && b.p10 !== null) {
          if (layers.outer) svg.append(svgElement("path", { d: band(a, b, "p10", "p90"), fill: `url(#performance-outer-${gradientSuffix})`, class: "performance-percentile-band performance-percentile-band-outer" }));
          if (layers.inner) svg.append(svgElement("path", { d: band(a, b, "p25", "p75"), fill: `url(#performance-inner-${gradientSuffix})`, class: "performance-percentile-band performance-percentile-band-inner" }));
        }
        if (layers.median) svg.append(svgElement("path", { d: curve(a, b, "median"), fill: "none", stroke: color,
          class: `performance-median-line${segment.dashed ? " performance-median-line-gap" : ""}` }));
        if (layers.mean) svg.append(svgElement("path", {
          d: `M${x(a.at)},${y(a.mean)} L${x(b.at)},${y(b.mean)}`, fill: "none", stroke: color, class: "performance-mean-line",
        }));
      }
      for (const point of item.points) {
        const cx = x(point.at), cy = y(point.median);
        const marker = svgElement("g", { tabindex: -1, role: "img", "aria-label": formatPoint(point, item.method), class: "performance-point" });
        marker.dataset.performanceFocus = `point-${metric}-${item.method}-${point.at}`;
        // Pointer targets are independent of visible marker size; the whole plot
        // also accepts a horizontal sweep, including dates without evidence.
        marker.append(svgElement("circle", { cx, cy, r: 14, fill: "transparent", class: "performance-hit-target" }));
        marker.append(svgElement("circle", {
          cx, cy, r: 4,
          fill: point.n < 5 ? "var(--surface-raised)" : color, stroke: color, "stroke-width": 1.8, visibility: layers.median ? 'visible' : 'hidden',
        }));
        if (layers.mean) marker.append(svgElement("rect", {
          x: cx - 3, y: y(point.mean) - 3, width: 6, height: 6,
          fill: point.n < 5 ? "var(--surface-raised)" : color, stroke: color, "stroke-width": 1.5,
          class: "performance-mean-point",
        }));
        if (point.p10 !== null && layers.outer) svg.append(svgElement("line", { x1: cx, x2: cx, y1: y(point.p10), y2: y(point.p90), stroke: color, class: "performance-percentile-range" }));
        if (point.p10 !== null && layers.inner) svg.append(svgElement("line", { x1: cx, x2: cx, y1: y(point.p25), y2: y(point.p75), stroke: color, class: "performance-quartile-range" }));
        marker.addEventListener("focus", () => {
          for (const entry of markers) entry.node.setAttribute("tabindex", entry.node === marker ? "0" : "-1");
          showInterval(point.at);
        });
        marker.addEventListener("keydown", event => {
          if (event.key === "Escape") { showInterval(null); return; }
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const index = markers.findIndex(entry => entry.node === marker);
          const next = event.key === "Home" ? 0 : event.key === "End" ? markers.length - 1 : Math.max(0, Math.min(markers.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
          event.preventDefault(); markers[next]?.node.focus();
        });
        markers.push({ node: marker, at: point.at }); svg.append(marker);
      }
    }
    markers.sort((a, b) => a.at - b.at);
    markers[0]?.node.setAttribute("tabindex", "0");
    const highlights = series.map(() => svgElement("circle", { r: 8, fill: "none", stroke: color, "stroke-width": 2.5, visibility: "hidden", class: "performance-highlight" }));
    svg.append(cursor, ...highlights);
    const byDate = series.map(item => new Map(item.points.map(point => [point.at, point])));
    chartCursors.push(at => {
      tooltip.hidden = at === null;
      cursor.setAttribute("visibility", at === null ? "hidden" : "visible");
      for (const highlight of highlights) highlight.setAttribute("visibility", "hidden");
      if (at === null) { readout.textContent = ""; return; }
      cursor.setAttribute("x1", x(at)); cursor.setAttribute("x2", x(at));
      const matches = series.flatMap((item, i) => {
        const point = byDate[i].get(at);
        if (!point) return [];
        highlights[i].setAttribute("cx", x(at)); highlights[i].setAttribute("cy", y(layers.median ? point.median : point.mean));
        highlights[i].setAttribute("visibility", layers.median || layers.mean ? "visible" : "hidden");
        return [{ point, method: item.method }];
      });
      tooltip.replaceChildren(element("strong", "performance-tooltip-date", fullDateFormat.format(at)));
      readout.textContent = matches.map(({ point, method }) => formatPoint(point, method)).join(" · ") || `${fullDateFormat.format(at)} · ${translate("noBin")}`;
      if (!matches.length) tooltip.append(element("p", "", translate("noBin")));
      for (const { point, method } of matches) {
        const row = element("div", "performance-tooltip-row");
        const unit = translate(metric === "latency" ? "latencyShortUnit" : "speedShortUnit");
        row.append(element("span", "performance-tooltip-method", method === "ttft" ? translate("latency") : translate("medianP50")),
          element("strong", "performance-tooltip-value", `${metricNumber(point.median, metric)} ${unit}`));
        row.append(element("span", "", translate("mean")),
          element("strong", "performance-tooltip-value", `${number(point.mean)} ${unit}`));
        const distribution = element("div", "performance-tooltip-percentiles");
        if (point.p10 === null) distribution.append(element("span", "performance-tooltip-detail", 'P10 / P25 / P75 / P90 —'));
        else for (const [label, value] of [["P90", point.p90], ["P75", point.p75], ["P25", point.p25], ["P10", point.p10]]) {
          distribution.append(element("span", "", label), element("strong", "", `${metricNumber(value, metric)} ${unit}`));
        }
        row.append(distribution, element("span", "performance-tooltip-detail", `${translate("turns")}: ${number(point.n)}`));
        tooltip.append(row);
      }
      const anchorY = matches.length ? y(matches[0].point.median) : 24;
      const bounds = svg.getBoundingClientRect();
      const anchorXCss = x(at) / width * bounds.width;
      const anchorYCss = anchorY / 256 * bounds.height;
      const tooltipHeight = tooltip.offsetHeight || 180;
      const vertical = bounds.top + anchorYCss >= tooltipHeight + 12 ? "above" : "below";
      const horizontal = anchorXCss >= bounds.width / 2 ? "before" : "after";
      tooltip.className = `performance-tooltip performance-tooltip-${horizontal} performance-tooltip-${vertical}`;
      tooltip.style.setProperty("--performance-tooltip-x", `${anchorXCss}px`);
      tooltip.style.setProperty("--performance-tooltip-y", `${anchorYCss}px`);
    });
    const sweep = event => {
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const px = (event.clientX - bounds.left) * width / bounds.width;
      const py = (event.clientY - bounds.top) * 256 / bounds.height;
      if (px < plotLeft || px > plotRight || py < 24 || py > 214) { showInterval(null); return; }
      showInterval(performanceHoverBin((px - plotLeft) / plotWidth, domain, payload.interval));
    };
    svg.addEventListener("pointermove", sweep);
    svg.addEventListener("pointerdown", sweep);
    svg.addEventListener("pointerleave", () => { showInterval(null); });
    svg.addEventListener("focusout", event => { if (!svg.contains(event.relatedTarget)) showInterval(null); });
    holder.append(svg, tooltip, readout);
    return holder;
  }
  let dialog = null, dialogBody = null, dialogTitle = null, dialogView = null, dialogPage = 0, dialogOpener = null;
  let pageContent = null;
  const layers = { median: true, mean: true, inner: true, outer: true };
  const button = (label, key, action, className = 'performance-text-button') => {
    const node = element('button', className, label); node.type = 'button';
    node.dataset.performanceFocus = key; node.addEventListener('click', action); return node;
  };
  const closeDetails = () => { if (dialog?.open) dialog.close(); };
  const selectedModel = () => payload?.models.find(model => model.id === modelId);
  const pointsFor = (model, metric) => metric === 'speed' ? model.speed.flatMap(series => series.points)
    : metric === 'toolFree' ? model.toolFree : model.ttft;
  const instant = value => value ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
  const runtimeStage = code => code.includes('history') ? 'history' : code.includes('snapshot') ? 'snapshot' : code.includes('scan') ? 'scan'
    : code.includes('store') ? 'store' : code.includes('projection') ? 'projection' : code.includes('worker') ? 'worker' : 'request';
  function ensureView() {
    if (pageContent) return;
    pageContent = element('div', 'performance-content');
    dialog = element('dialog', 'performance-dialog'); dialog.id = 'performance-details-dialog';
    dialog.setAttribute('aria-labelledby', 'performance-details-title');
    const head = element('header', 'performance-dialog-heading');
    dialogTitle = element('h2', '', ''); dialogTitle.id = 'performance-details-title';
    head.append(dialogTitle, button(translate('close'), 'detail-close', closeDetails));
    dialogBody = element('div', 'performance-dialog-body'); dialog.append(head, dialogBody);
    dialog.addEventListener('close', () => {
      dialogView = null;
      const target = [...root.querySelectorAll('[data-performance-focus]')].find(node => node.dataset.performanceFocus === dialogOpener);
      target?.focus({ preventScroll: true });
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const b = dialog.getBoundingClientRect();
      if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) closeDetails();
    });
    root.replaceChildren(); root.append(pageContent, dialog);
  }
  function openDetails(view, opener) {
    dialogView = view; dialogPage = 0; dialogOpener = opener;
    renderDetails(); if (!dialog.open) dialog.showModal();
  }
  function renderDetails() {
    if (!dialogView || !payload && dialogView !== 'measurements') return;
    const model = selectedModel(), scroll = dialog.scrollTop, active = documentRef.activeElement?.dataset?.performanceFocus;
    dialogTitle.textContent = model ? formatModelName(model.id) : translate('measurements');
    dialogBody.replaceChildren();
    const tabs = element('nav', 'performance-dialog-tabs'); tabs.setAttribute('aria-label', translate('details'));
    for (const key of ['speed', 'latency', 'toolFree', 'measurements']) {
      const tab = button(translate(key), `detail-tab-${key}`, () => { dialogView = key; dialogPage = 0; renderDetails(); });
      tab.disabled = !model && key !== 'measurements';
      tab.setAttribute('aria-pressed', String(dialogView === key)); tabs.append(tab);
    }
    dialogBody.append(tabs);
    const kv = (label, value) => {
      const row = element('div', 'performance-detail-row');
      row.append(element('span', '', label), element('strong', '', value)); dialogBody.append(row);
    };
    if (dialogView === 'measurements') {
      kv(translate('models'), model ? formatModelName(model.id) : '—'); kv(translate('mode'), translate(speedMode));
      kv(reportTranslate('period'), (payload ? reportingRange(null, { period: payload.period, start: payload.start, end: payload.end }) : reportingRange(reportingWindow)) ?? '—');
      kv(translate('providerLabel'), 'Codex'); kv(translate('grain'), payload ? translate(payload.interval) : '—');
      kv(translate('updatedLabel'), instant(payload?.updatedAt));
      if (model) for (const [key, value] of [['totalTurns', model.turns], ['speedTurns', model.speedTurns],
        ['responseTurns', model.speedTurns - model.toolFreeTurns], ['toolFreeTurns', model.toolFreeTurns],
        ['ttftTurns', model.ttftTurns], ['timedResponses', model.timedResponses]]) kv(translate(key), number(value));
      kv(translate('unknownTurns'), payload?.status === 'ready' ? number(payload.excludedUnknownTurns) : '—');
      if (payload?.historyProgress) kv(translate('historyProgress'), `${number(payload.historyProgress.checked)} / ${number(payload.historyProgress.total)}`);
      for (const code of diagnostics) kv(translate(`error.${code}`), `${code} · ${runtimeStage(code)}`);
      for (const { code, count } of sourceDiagnostics) kv(translate(`source.${code}`), `${code} · ${number(count)}`);
      if (failed && failureCode && !diagnostics.includes(failureCode)) kv(translate(`error.${failureCode}`), `${failureCode} · ${runtimeStage(failureCode)}`);
    } else {
      const points = [...pointsFor(model, dialogView)].reverse(), pages = Math.max(1, Math.ceil(points.length / 10));
      dialogPage = Math.min(dialogPage, pages - 1);
      const context = element('div', 'performance-detail-context');
      context.append(element('span', '', translate(speedMode)), element('span', '', translate(dialogView === 'latency' ? 'latencyShortUnit' : 'speedShortUnit')), element('span', '', translate(payload.interval)));
      dialogBody.append(context);
      const wrap = element('div', 'performance-detail-table'), table = element('table');
      const thead = element('thead'), header = element('tr');
      for (const key of [translate('date'), translate('sampleTurns'), translate('mean'), 'P10', 'P25', 'P50', 'P75', 'P90']) header.append(element('th', '', key));
      thead.append(header); const tbody = element('tbody');
      for (const point of points.slice(dialogPage * 10, dialogPage * 10 + 10)) {
        const tr = element('tr');
        for (const value of [fullDateFormat.format(point.at), number(point.n), ...['mean', 'p10', 'p25', 'median', 'p75', 'p90'].map(key => point[key] === null ? '—' : number(point[key]))]) tr.append(element('td', '', value));
        tbody.append(tr);
      }
      table.append(thead, tbody); wrap.append(table); dialogBody.append(wrap);
      if (!points.length) dialogBody.append(element('p', 'performance-empty', translate('noMeasurements')));
      if (pages > 1) {
        const pager = element('div', 'performance-pager');
        const prev = button(translate('previous'), 'detail-prev', () => { dialogPage--; renderDetails(); }); prev.disabled = dialogPage === 0;
        const next = button(translate('next'), 'detail-next', () => { dialogPage++; renderDetails(); }); next.disabled = dialogPage === pages - 1;
        pager.append(prev, element('span', '', `${dialogPage + 1} / ${pages}`), next); dialogBody.append(pager);
      }
    }
    dialog.scrollTop = scroll;
    if (active) [...root.querySelectorAll('[data-performance-focus]')].find(node => node.dataset.performanceFocus === active)?.focus({ preventScroll: true });
  }
  function render() {
    ensureView(); formatters();
    const activeFocus = documentRef.activeElement?.dataset?.performanceFocus;
    chartCursors = [];
    pageContent.replaceChildren();
    const append = (...nodes) => pageContent.append(...nodes);
    if (!sharedReporting) {
      const periods = element('div', 'segmented-control performance-periods');
      for (const value of STANDALONE_PERIODS) {
        const b = button(translate(value === 'all' ? 'all' : `days${value}`), `period-${value}`, () => {
          if (period === value) return; closeDetails(); selectedInterval = null; pendingAttempts = 0; resetSourceRetry();
          period = value; payload = cachedPayload(value); remember(); render(); refresh();
        }); b.setAttribute('aria-pressed', String(period === value)); periods.append(b);
      }
      const heading = element('div', 'dashboard-page-header'), title = element('h2', '', translate('title'));
      title.id = 'performance-title'; title.tabIndex = -1; title.dataset.performanceFocus = 'heading'; heading.append(title, periods); append(heading);
    }
    const models = payload?.models ? [...payload.models].sort((a,b) => MODEL_ORDER.indexOf(a.id) - MODEL_ORDER.indexOf(b.id)) : [];
    if (models.length && !models.some(model => model.id === modelId)) {
      if (modelId) closeDetails(); modelId = models[0].id; selectedInterval = null;
    }
    const toolbar = element('div', 'performance-toolbar');
    const select = element('select', 'performance-model-select'); select.setAttribute('aria-label', translate('models')); select.dataset.performanceFocus = 'model-select';
    if (!models.length) { const option = element('option', '', translate('models')); option.value = ''; select.append(option); select.disabled = true; }
    for (const model of models) { const option = element('option', '', formatModelName(model.id)); option.value = model.id; select.append(option); }
    select.value = models.length ? modelId : '';
    select.addEventListener('change', () => { closeDetails(); selectedInterval = null; modelId = select.value; remember(); render(); });
    const modes = element('div', 'segmented-control performance-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', translate('mode'));
    for (const value of SPEED_MODES) {
      const b = button(translate(value), `mode-${value}`, () => {
        if (value === speedMode) return;
        closeDetails(); selectedInterval = null; speedMode = value; pendingAttempts = 0; resetSourceRetry();
        request++; scopeGeneration++; cancelPending(); cancelPreloadWaits();
        preloadPromise = null; preloadComplete = false; foregroundKey = null;
        windowRef.clearTimeout(timer); timer = null; retainedWindowKey = null; retainedWindowUnavailable = false;
        payload = cachedPayload(selectedRequestPeriod());
        loading = false; failed = false; cancelled = false; scopeUnavailable = false; remember(); render(); refresh();
      }); b.setAttribute('aria-pressed', String(value === speedMode)); modes.append(b);
    }
    const details = button(translate('measurements'), 'measurements', () => openDetails('measurements', 'measurements')); details.disabled = !payload && !failed && !diagnostics.length && !sourceDiagnostics.length;
    toolbar.append(select, modes, details); append(toolbar);
    const state = cancelled ? 'cancelled' : retrying ? 'retrying' : failed || diagnostics.length || sourceDiagnostics.length ? 'error' : retainedWindowUnavailable ? 'unavailable'
      : payload?.status === 'unavailable' ? 'unavailable' : payload?.stale ? 'stale' : loading && !payload ? 'loading'
      : payload?.collecting || payload?.status === 'loading' ? 'updating' : sharedReporting && !reportingWindow ? 'waiting' : '';
    if (state) {
      const actions = element('div', 'performance-actions'), status = element('p', 'performance-status'); status.setAttribute('role', 'status'); status.dataset.state = state;
      const code = failed ? failureCode : diagnostics.find(value => value !== 'timing_source_recovery_failed') ?? diagnostics[0];
      const sourceFailure = sourceDiagnostics.find(row => !RETRYABLE_SOURCE_CHANGES.includes(row.code));
      status.textContent = state === 'error' ? translate(`error.${code || 'timing_request_failed'}`)
        : state === 'waiting' ? reportTranslate('waiting') : translate(state === 'updating' ? 'collectingCompact' : `status.${state}`);
      if (state === 'error' && sourceFailure) status.textContent += ` · ${translate(`source.${sourceFailure.code}`)}`;
      if (retryExhausted && state === 'error') status.textContent += ` · ${translate('retryExhausted')}`;
      if (payload?.updatedAt && ['error','stale','unavailable'].includes(state)) status.textContent += ` · ${instant(payload.updatedAt)}`;
      actions.append(status);
      if (loading && !retrying) actions.append(button(translate('cancel'), 'cancel', cancelRefresh));
      else if (['error','unavailable','stale'].includes(state)) actions.append(button(translate('retry'), 'retry', () => { pendingAttempts = 0; resetSourceRetry(); refresh(); }));
      append(actions);
    }
    if (models.length) {
      const selected = selectedModel(), panel = element('div', 'performance-model-panel'); panel.id = 'performance-model-panel';
      panel.setAttribute('aria-label', formatModelName(selected.id));
      const domain = performanceDomain(payload, selected);
      for (const metric of ['speed', 'latency']) {
        const card = element('article', 'performance-card'); card.dataset.performanceMetric = metric;
        const heading = element('header', 'performance-card-heading');
        heading.append(element('h3', '', translate(metric)), button(translate('details'), `details-${metric}`, () => openDetails(metric, `details-${metric}`)));
        const headline = element('div', 'performance-headline'), value = element('strong', 'performance-headline-value'), when = element('span', 'performance-headline-date');
        headline.append(value, element('span', 'performance-headline-unit', translate(metric === 'speed' ? 'speedShortUnit' : 'latencyShortUnit')), when);
        const points = pointsFor(selected, metric);
        const update = at => { const point = at === null ? points.at(-1) : points.find(point => point.at === at); value.textContent = point ? number(point.median) : '—'; when.textContent = point ? `${date(point.at)} · P50` : at === null ? '' : `${date(at)} · P50`; };
        update(selectedInterval); chartCursors.push(update);
        card.append(heading, headline, plot(metric === 'speed' ? selected.speed : [{ method: 'ttft', points: selected.ttft }], metric, 'var(--ink)', domain)); panel.append(card);
      }
      append(panel);
      const legend = element('div', 'performance-legend');
      for (const [key, label] of [['median','P50'],['mean',translate('mean')],['inner','P25–P75'],['outer','P10–P90']]) {
        const b = button('', `layer-${key}`, () => { layers[key] = !layers[key]; render(); }); b.setAttribute('aria-pressed', String(layers[key]));
        b.append(element('i', `performance-key performance-key-${key}`), element('span', '', label)); legend.append(b);
      }
      append(legend);
      for (const update of chartCursors) update(selectedInterval);
    } else if (payload?.status === 'ready') append(element('p', 'performance-empty', translate('noMeasurements')));
    if (dialog.open && !selectedModel() && dialogView !== 'measurements') closeDetails(); else renderDetails();
    if (activeFocus) [...root.querySelectorAll('[data-performance-focus]')].find(node => node.dataset.performanceFocus === activeFocus)?.focus({ preventScroll: true });
  }
  const cacheKeyFor = (value, mode = speedMode, window = reportingWindow) => `${mode}::${sharedReporting
    ? `${window?.period ?? "waiting"}:${window?.startAt ?? ""}:${window?.endAt ?? ""}::${value}` : value}`;
  const cachedPayload = value => {
    const key = cacheKeyFor(value);
    diagnostics = diagnosticsByKey.get(key) ?? [];
    sourceDiagnostics = sourceDiagnosticsByKey.get(key) ?? [];
    return readyPeriods.get(key)?.payload ?? null;
  };
  const cacheFresh = entry => entry && Date.now() - entry.cachedAt < PERIOD_CACHE_TTL_MS;
  const preloadTargets = () => {
    if (!sharedReporting) return PRELOAD_PERIODS.map(value => ({ value, mode: speedMode, window: null }));
    if (!reportingWindow) return [];
    return [{ value: selectedRequestPeriod(), mode: speedMode, window: reportingWindow }];
  };
  const allPeriodsFresh = () => {
    const targets = preloadTargets();
    return targets.length > 0
      && targets.every(({ value, mode, window }) => cacheFresh(readyPeriods.get(cacheKeyFor(value, mode, window))));
  };
  const documentVisible = () => !documentRef.hidden && !destroyed;
  const canPreload = (runLifecycle, runScope) => documentVisible()
    && lifecycle === runLifecycle && scopeGeneration === runScope;
  const cancelPending = ({ includeSpeculative = true } = {}) => {
    for (const [key, entry] of pendingPeriods) {
      if (!includeSpeculative && entry.speculative) continue;
      entry.controller.abort();
      if (pendingPeriods.get(key) === entry) pendingPeriods.delete(key);
    }
  };
  const cancelPreloadWaits = () => {
    for (const finish of preloadWaiters.values()) finish(false);
  };
  const invalidateScope = (sourcePeriod, unavailable, sourceKey) => {
    if (retainedWindowKey !== reportingKey() || payload?.status !== "ready") retainedWindowKey = null;
    scopeGeneration++;
    windowRef.clearTimeout(timer); timer = null; resetSourceRetry();
    scopeUnavailable = true;
    preloadComplete = false;
    cancelPreloadWaits();
    readyPeriods.clear();
    // An unavailable response describes the complete local scope. Abort
    // requests from the prior scope so they cannot spend work or repopulate
    // the cache after invalidation. Keep the response that established the
    // invalidation alive for its caller.
    for (const [key, entry] of pendingPeriods) if (key !== sourceKey) {
      entry.controller.abort();
      if (pendingPeriods.get(key) === entry) pendingPeriods.delete(key);
    }
    // A sibling period can discover that the whole scope is unavailable while
    // the selected period is still displaying a previous ready value. Remove
    // that value immediately, including on an inactive page, so first visit
    // cannot resurrect stale evidence.
    const selected = selectedRequestPeriod();
    if (!destroyed && selected !== sourcePeriod) {
      payload = { ...unavailable, period: selected ?? unavailable.period };
      failed = false;
      render();
    }
  };
  const presentResult = (value, result) => {
    if (!result || value !== selectedRequestPeriod() || result.speedMode !== speedMode) return false;
    if (result.status === "unavailable") readyPeriods.clear();
    if (result.status === "unavailable" && retainedWindowKey === reportingKey() && payload?.status === "ready") {
      // An unavailable new window withdraws live caches, but the previous
      // window remains readable as dated historical evidence until retry.
      payload = { ...payload, collecting: false, stale: true };
      retainedWindowUnavailable = true;
      return true;
    }
    retainedWindowUnavailable = false;
    const retained = result.status === "loading" ? cachedPayload(value)
      ?? (retainedWindowKey === reportingKey() && payload?.status === "ready" ? payload : null) : null;
    if (result.status !== "loading") retainedWindowKey = null;
    const next = retained ? { ...retained, collecting: true, stale: true } : result;
    const changed = JSON.stringify({ ...next, updatedAt: null }) !== JSON.stringify(payload ? { ...payload, updatedAt: null } : null);
    payload = next;
    return changed;
  };
  function requestPeriod(value, { force = false, speculative = false,
    mode = speedMode, window = reportingWindow } = {}) {
    if (!PERIODS.includes(value) || !SPEED_MODES.includes(mode)
        || sharedReporting && (!window || value !== reportingRequestPeriod(window.period))) {
      return Promise.reject(new RangeError("Unsupported performance period"));
    }
    const cacheKey = cacheKeyFor(value, mode, window);
    const existing = pendingPeriods.get(cacheKey);
    if (existing) return existing.promise;
    const entry = readyPeriods.get(cacheKey);
    if (!force && cacheFresh(entry)) return Promise.resolve(entry.payload);
    const expectedMode = mode;
    const expectedWindow = sharedReporting ? window : null;
    const expectedEndAt = expectedWindow?.endAt ?? null;
    const expectedStartAt = expectedWindow?.startAt ?? null;
    const controller = new AbortController();
    const startedLifecycle = lifecycle;
    const startedScope = scopeGeneration;
    let timedOut = false;
    const deadline = windowRef.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    const record = { controller, promise: null, speculative };
    const promise = (async () => {
      try {
        let responseDiagnostics = [], responseSourceDiagnostics = [];
        const result = normalizeModelPerformance(await client.modelPerformance(value, {
          signal: controller.signal, speedMode: expectedMode,
          onDiagnostics: codes => { responseDiagnostics = codes; },
          onSourceDiagnostics: details => { responseSourceDiagnostics = details; },
          ...(expectedEndAt ? { endAt: expectedEndAt } : {}),
        }));
        if (!result || result.period !== value || result.speedMode !== expectedMode
            || (expectedEndAt && result.end !== Date.parse(expectedEndAt))
            || (expectedStartAt !== null && result.start !== Date.parse(expectedStartAt))) {
          throw Object.assign(new Error("Invalid timing contract"), { code: 'timing_contract_invalid' });
        }
        // Hidden/destroyed views and responses from an invalidated scope may
        // finish, but they must not affect the visible state or cache.
        if (destroyed || lifecycle !== startedLifecycle || scopeGeneration !== startedScope) return null;
        // Some clients may ignore AbortSignal and resolve after the deadline.
        // Treat that response as timed out so a late result cannot become a
        // fresh cache entry or replace the current period.
        if (controller.signal.aborted) {
          if (timedOut) throw Object.assign(new Error("Performance request timed out"), { code: 'timing_timeout' });
          return null;
        }
        diagnosticsByKey.set(cacheKey, responseDiagnostics);
        while (diagnosticsByKey.size > MAX_READY_PERIODS) diagnosticsByKey.delete(diagnosticsByKey.keys().next().value);
        sourceDiagnosticsByKey.set(cacheKey, responseSourceDiagnostics);
        while (sourceDiagnosticsByKey.size > MAX_READY_PERIODS) sourceDiagnosticsByKey.delete(sourceDiagnosticsByKey.keys().next().value);
        if (expectedMode === speedMode && value === selectedRequestPeriod()) {
          diagnostics = responseDiagnostics; sourceDiagnostics = responseSourceDiagnostics;
        }
        if (result.status === "unavailable") invalidateScope(value, result, cacheKey);
        else {
          scopeUnavailable = false;
          if (result.status === "ready") rememberReady(cacheKey, result);
        }
        return result;
      } catch (error) {
        if (controller.signal.aborted && !timedOut || destroyed || lifecycle !== startedLifecycle || scopeGeneration !== startedScope) return null;
        throw Object.assign(new Error('Performance request failed'), {
          code: timedOut ? 'timing_timeout' : error?.code === 'timing_contract_invalid' ? error.code
            : error instanceof SyntaxError ? 'timing_parse_failed' : 'timing_request_failed',
        });
      } finally {
        windowRef.clearTimeout(deadline);
        if (pendingPeriods.get(cacheKey) === record) pendingPeriods.delete(cacheKey);
      }
    })();
    record.promise = promise;
    pendingPeriods.set(cacheKey, record);
    return promise;
  }
  function waitForPreload(delay, runLifecycle, runScope) {
    return new Promise(resolve => {
      let timeout;
      const finish = value => {
        if (!preloadWaiters.delete(timeout)) return;
        windowRef.clearTimeout(timeout);
        resolve(value && canPreload(runLifecycle, runScope));
      };
      timeout = windowRef.setTimeout(() => finish(true), delay);
      preloadWaiters.set(timeout, finish);
    });
  }
  async function preloadPeriod({ value, mode, window }, runLifecycle, runScope) {
    for (let attempt = 0; attempt < PRELOAD_MAX_ATTEMPTS; attempt++) {
      if (!canPreload(runLifecycle, runScope)) return null;
      let result = null;
      try { result = await requestPeriod(value, { speculative: true, mode, window }); }
      catch (error) {
        if (canPreload(runLifecycle, runScope) && mode === speedMode && value === selectedRequestPeriod()) {
          failed = true; failureCode = error.code; render();
        }
        return null;
      }
      if (result?.status === "unavailable") {
        if (mode === speedMode && value === selectedRequestPeriod() && presentResult(value, result)) render();
        return result;
      }
      if (!canPreload(runLifecycle, runScope)) return null;
      if (result) {
        if (mode === speedMode && presentResult(value, result)) render();
        if (result.status === "ready" && !result.collecting) return result;
      }
      if (attempt + 1 < PRELOAD_MAX_ATTEMPTS
          && !await waitForPreload(preloadRetryDelay(attempt), runLifecycle, runScope)) return null;
    }
    return null;
  }
  async function runPreload(runLifecycle, runScope) {
    if (!sharedReporting) {
      const targets = preloadTargets().sort((left, right) =>
        Number(right.value === selectedRequestPeriod()) - Number(left.value === selectedRequestPeriod()));
      for (const target of targets) {
        const result = await preloadPeriod(target, runLifecycle, runScope);
        if (result?.status === "unavailable" || !canPreload(runLifecycle, runScope)) return;
      }
      return;
    }
    // Readers can have different exact cutoffs. Warm only the selected window;
    // two clients must not evict each other's active result with speculative work.
    await Promise.all(preloadTargets().map(target => preloadPeriod(target, runLifecycle, runScope)));
  }
  function preload() {
    if (destroyed || documentRef.hidden) return Promise.resolve();
    if (preloadPromise) return preloadPromise;
    if (!preloadTargets().length) return Promise.resolve(false);
    if (preloadComplete && allPeriodsFresh()) return Promise.resolve();
    preloadComplete = false;
    const runLifecycle = lifecycle, runScope = scopeGeneration;
    const operation = (async () => {
      try { await runPreload(runLifecycle, runScope); }
      catch { /* Speculative warming is best effort; foreground refresh remains authoritative. */ }
    })();
    preloadPromise = operation;
    void operation.finally(() => {
      if (preloadPromise !== operation) return;
      preloadPromise = null;
      preloadComplete = allPeriodsFresh();
    });
    return operation;
  }
  async function warmOtherPeriods() {
    if (sharedReporting || !visible() || destroyed || scopeUnavailable || payload?.status === "unavailable") return;
    const selectedPeriod = period;
    await Promise.all(PRELOAD_PERIODS.filter(value => value !== selectedPeriod).map(async value => {
      if (!visible() || destroyed) return;
      const entry = readyPeriods.get(cacheKeyFor(value));
      if (cacheFresh(entry)) return;
      try { await requestPeriod(value); } catch { /* Background warming is best effort. */ }
    }));
  }
  async function refresh() {
    if (!visible() || destroyed) return;
    if (sharedReporting && !reportingWindow) {
      cancelPending();
      foregroundKey = null;
      loading = false;
      failed = false;
      cancelled = false;
      payload = null;
      render();
      return;
    }
    const current = ++request;
    const startedLifecycle = lifecycle;
    const startedScope = scopeGeneration;
    const targetPeriod = selectedRequestPeriod();
    if (!targetPeriod) return;
    const targetKey = cacheKeyFor(targetPeriod);
    if (sourceRetryKey !== targetKey) { resetSourceRetry(); sourceRetryKey = targetKey; }
    foregroundKey = targetKey;
    const hadFailure = failed || retrying || retainedWindowUnavailable || diagnostics.length > 0 || sourceDiagnostics.length > 0;
    retainedWindowUnavailable = false;
    if (retainedWindowKey === reportingKey() && payload?.status === "ready")
      payload = { ...payload, collecting: true, stale: true };
    scopeUnavailable = false;
    loading = true; failed = false; cancelled = false; windowRef.clearTimeout(timer); timer = null;
    // A cached period remains visible while its replacement is fetched.
    if (!payload || hadFailure) render();
    let changed = false, shouldWarm = false;
    try {
      const result = await requestPeriod(targetPeriod, { force: true });
      if (request !== current || lifecycle !== startedLifecycle || destroyed || !result) return;
      shouldWarm = !sharedReporting && result.status !== "unavailable";
      changed = presentResult(targetPeriod, result);
    } catch (error) {
      if (request !== current || lifecycle !== startedLifecycle || destroyed) return;
      // Keep a good period visible through transient foreground failures. A
      // scope invalidation that aborted this request already rendered its
      // unavailable state, so do not replace it with a generic failure.
      failed = scopeGeneration === startedScope;
      if (failed) failureCode = error.code ?? 'timing_request_failed';
    } finally {
      if (foregroundKey === targetKey && request === current) foregroundKey = null;
      if (request === current && lifecycle === startedLifecycle && !destroyed) {
        const recoveryWarning = !failed && payload?.status !== 'unavailable' && recoverableSourceWarning();
        retrying = recoveryWarning && sourceRetryAttempts < SOURCE_RETRY_DELAYS.length;
        retryExhausted = recoveryWarning && !retrying;
        if (retryExhausted) { failed = true; failureCode = 'timing_source_recovery_failed'; }
        if (!failed && !diagnostics.length && !sourceDiagnostics.length) resetSourceRetry();
        if (!failed && !recoveryWarning && pendingResult() && pendingAttempts >= PRELOAD_MAX_ATTEMPTS - 1) {
          failed = true; failureCode = 'timing_timeout';
        }
        loading = false; if (changed || failed || diagnostics.length || sourceDiagnostics.length || hadFailure || !payload) render();
        if (visible()) {
          if (retrying) {
            const retryScope = scopeGeneration;
            timer = windowRef.setTimeout(() => {
              timer = null;
              if (!visible() || destroyed || lifecycle !== startedLifecycle
                  || scopeGeneration !== retryScope || sourceRetryKey !== targetKey) return;
              sourceRetryAttempts++;
              void refresh();
            }, SOURCE_RETRY_DELAYS[sourceRetryAttempts]);
          } else if (!failed && !sourceDiagnostics.length && !diagnostics.includes('timing_source_recovery_failed')
              && pendingResult() && pendingAttempts < PRELOAD_MAX_ATTEMPTS - 1) {
            timer = windowRef.setTimeout(refresh, preloadRetryDelay(pendingAttempts++));
          }
          if (shouldWarm && !scopeUnavailable) void warmOtherPeriods();
        }
      }
    }
  }
  function cancelRefresh() {
    if (!loading && !retrying) return;
    resetSourceRetry();
    request++;
    const key = foregroundKey;
    const entry = key ? pendingPeriods.get(key) : null;
    if (entry) {
      entry.controller.abort();
      if (pendingPeriods.get(key) === entry) pendingPeriods.delete(key);
    }
    foregroundKey = null;
    windowRef.clearTimeout(timer);
    timer = null;
    loading = false;
    failed = false;
    cancelled = true;
    render();
  }
  const rootVisibilityChanged = () => {
    if (visible()) { if (!loading) refresh(); }
    else {
      closeDetails();
      windowRef.clearTimeout(timer);
      timer = null;
      resetSourceRetry();
      request++;
      loading = false;
      foregroundKey = null;
      // A page transition should stop its foreground poll, while a
      // document-visible speculative preload is allowed to finish for the
      // first visit. Document hiding below cancels both kinds of work.
      cancelPending({ includeSpeculative: false });
    }
  };
  const documentVisibilityChanged = () => {
    if (documentRef.hidden) {
      windowRef.clearTimeout(timer);
      timer = null;
      resetSourceRetry();
      lifecycle++;
      cancelPending();
      cancelPreloadWaits();
      if (preloadPromise && !preloadComplete) preloadPromise = null;
      request++;
      loading = false;
      foregroundKey = null;
    } else if (visible() && !loading) refresh();
  };
  function setReportingWindow(value) {
    const next = normalizeReportingWindow(value);
    if (next?.period !== reportingWindow?.period) { closeDetails(); selectedInterval = null; }
    const retainPrevious = next && reportingWindow && next.period === reportingWindow.period
      && Date.parse(next.endAt) > Date.parse(reportingWindow.endAt) && payload?.status === "ready";
    const previousPayload = retainPrevious ? payload : null;
    const previousKey = reportingKey();
    sharedReporting = true;
    reportingWindow = next;
    const nextKey = reportingKey();
    if (previousKey === nextKey) {
      if (next === null) {
        loading = false;
        failed = false;
        cancelled = false;
        payload = null;
        render();
      }
      return next !== null;
    }
    request++;
    pendingAttempts = 0;
    resetSourceRetry();
    scopeGeneration++;
    cancelPending();
    cancelPreloadWaits();
    preloadPromise = null;
    preloadComplete = false;
    foregroundKey = null;
    windowRef.clearTimeout(timer);
    timer = null;
    loading = false;
    failed = false;
    cancelled = false;
    scopeUnavailable = false;
    payload = next === null ? null : cachedPayload(selectedRequestPeriod());
    if (next === null) { diagnostics = []; sourceDiagnostics = []; }
    retainedWindowKey = null;
    retainedWindowUnavailable = false;
    if (!payload && previousPayload) {
      // Show the prior report under its own bounds while the new exact
      // window loads. It must never become a cache entry for the new window.
      payload = { ...previousPayload, collecting: true, stale: true };
      retainedWindowKey = nextKey;
    }
    render();
    if (next !== null && visible()) refresh();
    return next !== null;
  }
  const observer = new windowRef.MutationObserver(rootVisibilityChanged);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  let lastWidth = root.clientWidth;
  const resizeObserver = windowRef.ResizeObserver ? new windowRef.ResizeObserver(() => {
    if (root.clientWidth > 0 && root.clientWidth !== lastWidth) { lastWidth = root.clientWidth; render(); }
  }) : null;
  resizeObserver?.observe(root);
  documentRef.addEventListener("visibilitychange", documentVisibilityChanged);
  render();
  if (visible()) refresh();
  return {
    render,
    refresh,
    preload,
    setReportingWindow,
    cancel: cancelRefresh,
    destroy() {
      closeDetails();
      destroyed = true;
      lifecycle++;
      readyPeriods.clear();
      diagnosticsByKey.clear(); sourceDiagnosticsByKey.clear(); resetSourceRetry();
      payload = null;
      observer.disconnect();
      resizeObserver?.disconnect();
      cancelPending();
      cancelPreloadWaits();
      preloadPromise = null;
      preloadComplete = false;
      foregroundKey = null;
      request++;
      windowRef.clearTimeout(timer);
      documentRef.removeEventListener("visibilitychange", documentVisibilityChanged);
    },
  };
}
