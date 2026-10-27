import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelPerformance, performanceSegments, performanceDomain, performanceYScale, performanceDateTicks, performanceHoverBin, mountModelPerformance } from '../public/model-performance.js';
import { LocalCompanionClient } from '../public/data-client.js';
import { translate, SUPPORTED_LOCALES } from '../public/localization.js';
const DAY = 86400000;
const point = (at = 2 * DAY, n = 5) => ({ at, n, mean: n < 3 ? 50 : 55,
  p10: n < 5 ? null : 30, p25: n < 5 ? null : 40, median: 50,
  p75: n < 5 ? null : 60, p90: n < 5 ? null : 70 });
function payload() {
  return { schemaVersion: 6, method: 5, speedMode: 'standard', excludedUnknownTurns: 0, status: 'ready', collecting: false, stale: false, updatedAt: '2026-09-09T12:00:00.000Z', period: 'all', interval: 'day', start: DAY, end: 9 * DAY, historyProgress: null,
    models: [{ id: 'gpt-5.6-sol', label: 'Sol', turns: 20, speedTurns: 10, ttftTurns: 15, timedResponses: 45, toolFreeTurns: 0, toolFree: [],
      speed: [{ method: 'speed', points: [point(), point(3 * DAY)] }], ttft: [point(), point(3 * DAY), point(4 * DAY)] }] };
}
test('GPT-6.1 Sol and older Sol and Luna DTOs retain generation labels and refuse unreviewed suffixes', () => {
  const data = payload();
  data.models.push(...[['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6.1-terra', 'GPT-6.1 Terra'], ['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-5.6-luna', 'Luna']]
    .map(([id, label]) => ({ ...structuredClone(data.models[0]), id, label })));
  assert.equal(normalizeModelPerformance(data), data);
  for (const model of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna']) {
    const suffix = structuredClone(data);
    suffix.models.find(row => row.id === model).id += '-unreviewed';
    assert.equal(normalizeModelPerformance(suffix), null);
    const mislabeled = structuredClone(data);
    mislabeled.models.find(row => row.id === model).label = model.endsWith('sol') ? 'Sol' : 'Luna';
    assert.equal(normalizeModelPerformance(mislabeled), null);
  }
});
function legacyToolFreePayload() {
  const data = payload(); data.schemaVersion = 3; data.method = 4;
  Object.assign(data.models[0], { toolFreeTurns: 2, toolFree: [point(DAY, 2)] });
  return data;
}
function combinedPayload() {
  const data = payload();
  Object.assign(data.models[0], { toolFreeTurns: 2, toolFree: [point(DAY, 2)] });
  data.models[0].speedTurns = 12;
  data.models[0].speed[0].points.unshift(point(DAY, 2));
  return data;
}
test('combined DTO accepts fallback subsets and refuses impossible or cross-version populations', () => {
  const data = combinedPayload();
  assert.equal(normalizeModelPerformance(data), data);
  for (const mutate of [
    x => { x.method = 4; }, x => { x.schemaVersion = 3; }, x => { x.schemaVersion = 4; }, x => { x.schemaVersion = 5; },
    x => { x.models[0].toolFreeTurns = 13; },
    x => { x.models[0].toolFree[0].at = 5 * DAY; },
    x => { x.models[0].toolFree[0].n = 3; },
  ]) { const invalid = combinedPayload(); mutate(invalid); assert.equal(normalizeModelPerformance(invalid), null); }
  for (const period of ['1', '7', '30']) {
    const pinned = combinedPayload(); pinned.period = period;
    assert.equal(normalizeModelPerformance(pinned), pinned);
  }
});
test('mode-scoped tool-free DTO uses a closed contract and a subset of combined speed evidence', () => {
  const data = combinedPayload();
  assert.equal(normalizeModelPerformance(data), data);
  for (const mutate of [
    x => { x.schemaVersion = 2; }, x => { x.method = 3; },
    x => { delete x.models[0].toolFree; }, x => { delete x.models[0].toolFreeTurns; },
    x => { x.models[0].toolFreeTurns = 21; }, x => { x.models[0].toolFreeTurns = -1; },
    x => { x.models[0].toolFreeTurns = 1; },
    x => { x.models[0].toolFree[0].p90 = 1; },
    x => { x.models[0].toolFree[0].privatePath = '/synthetic/private'; },
    x => { x.models[0].toolFree.push(point(DAY, 1)); },
  ]) { const invalid = combinedPayload(); mutate(invalid); assert.equal(normalizeModelPerformance(invalid), null); }
  for (const [schemaVersion, method] of [[2, 3], [3, 4], [4, 5]]) {
    const legacy = legacyToolFreePayload(); Object.assign(legacy, { schemaVersion, method });
    delete legacy.speedMode; delete legacy.excludedUnknownTurns;
    if (schemaVersion === 2) { delete legacy.models[0].toolFree; delete legacy.models[0].toolFreeTurns; }
    assert.equal(normalizeModelPerformance(legacy), null, 'mixed-mode legacy contracts must never appear as Standard');
  }
  Object.assign(data.models[0], { speedTurns: 2, speed: [{ method: 'speed', points: [point(DAY, 2)] }], ttftTurns: 0, ttft: [] });
  assert.equal(normalizeModelPerformance(data), data, 'historical throughput needs no reconstructed response timing');
  assert.deepEqual(performanceDomain(data, data.models[0]), { start: DAY, end: data.end });
});
test('bounded contract preserves independent populations and one combined speed series', () => {
  const data = payload();
  assert.equal(normalizeModelPerformance(data), data);
  assert.equal(data.models[0].speedTurns, 10);
  assert.equal(data.models[0].ttftTurns, 15);
  data.models[0].speed = [];
  data.models[0].speedTurns = 0;
  assert.equal(normalizeModelPerformance(data), data, 'TTFT-only models remain usable');
});
test('malformed, private, unknown, duplicate and excessive evidence fails closed', () => {
  for (const mutate of [
    x => { x.privatePath = '/synthetic/private'; },
    x => { x.schemaVersion = 7; }, x => { x.method = 1; },
    x => { x.speedMode = 'unknown'; }, x => { x.speedMode = 'mixed'; },
    x => { delete x.speedMode; }, x => { x.excludedUnknownTurns = -1; },
    x => { x.excludedUnknownTurns = 1.5; }, x => { delete x.excludedUnknownTurns; },
    x => { x.historyProgress = { checked: 2, total: 1 }; },
    x => { x.historyProgress = { checked: -1, total: 1 }; },
    x => { x.historyProgress = { checked: 0, total: 1, privatePath: '/synthetic/private' }; },
    x => { x.period = '365'; }, x => { x.models[0].label = '<img>'; },
    x => { x.models[0].id = 'private-thread'; },
    x => { x.models.push(x.models[0]); },
    x => { x.models[0].speed.push(x.models[0].speed[0]); },
    x => { x.models[0].speedTurns = 2; },
    x => { x.models[0].ttftTurns = 30; },
    x => { x.models[0].speed[0].points[0].median = NaN; },
    x => { x.models[0].speed[0].points[0].mean = NaN; },
    x => { x.models[0].speed[0].points[0].mean = Infinity; },
    x => { x.models[0].speed[0].points[0].mean = -1; },
    x => { x.models[0].ttft[0].mean = 1e9 + 1; },
    x => { delete x.models[0].speed[0].points[0].mean; },
    x => { x.models[0].speed[0].points[0].p10 = 45; },
    x => { x.models[0].speed[0].points[0].p75 = 30; },
    x => { x.models[0].speed[0].points[0].p90 = 55; },
    x => { x.models[0].speed[0].points[0].n = 1; },
    x => { x.models[0].ttft[1].at = x.models[0].ttft[0].at; },
    x => { x.models[0].ttft[0].at = x.end + DAY; },
    x => { x.models[0].ttft = Array.from({length: 2049}, () => point()); },
  ]) { const data = payload(); mutate(data); assert.equal(normalizeModelPerformance(data), null); }
});
test('zero latency is real while missing speed remains absent; sparse bins have no band', () => {
  const data = payload(); data.models[0].ttft = [point(DAY, 1)]; data.models[0].ttft[0].median = 0;
  assert.equal(normalizeModelPerformance(data), data);
  data.models[0].ttft[0].p25 = 0;
  assert.equal(normalizeModelPerformance(data), null);
});
test('all observed medians stay connected while every missing interval is marked dashed', () => {
  const points = [point(DAY, 1), point(2 * DAY, 2), point(5 * DAY), point(20 * DAY)];
  assert.deepEqual(performanceSegments(points, 'day').map(x => x.dashed), [false, true, true]);
  assert.deepEqual(performanceSegments([point(DAY), point(8 * DAY), point(22 * DAY), point(43 * DAY)], 'week').map(x => x.dashed), [false, true, true]);
});
test('client requests only an enum period, is abortable, and reports endpoint failures', async () => {
  const calls = [], signal = new AbortController().signal;
  const client = new LocalCompanionClient({ fetchImpl: async (...args) => { calls.push(args); return {ok: true, status: 200, json: async () => payload()}; } });
  await client.modelPerformance('all', { signal });
  assert.equal(calls[0][0], '/api/local/model-performance?period=all&speedMode=standard');
  assert.equal(calls[0][1].signal, signal);
  assert.equal(calls[0][1].headers['X-Usage-Monitor-Local'], '1');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.throws(() => client.modelPerformance('bad&secret=x'), RangeError);
  const failed = new LocalCompanionClient({ fetchImpl: async () => ({ok: false, status: 404, json: async () => ({})}) });
  await assert.rejects(() => failed.modelPerformance('7'));
});
test('every supported locale preserves coverage and measurement meaning', () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ['title', 'speedEmpty', 'ttftEmpty', 'methodology', 'variance', 'speedSummary', 'latencySummary', 'combinedSpeedSummary', 'combinedSpeedMethodology', 'combinedSpeedEmpty', 'combinedMethodology', 'outerBand', 'innerBand', 'medianP50', 'mean', 'percentileValues', 'percentilesUnavailable', 'buildingHistory', 'unavailable', 'stale', 'mode', 'standard', 'fast', 'ultrafast', 'standardNote', 'fastNote', 'ultrafastNote', 'unknownMode', 'modeEmpty']) {
      const value = translate(`performance.${key}`, {}, locale);
      assert.notEqual(value, `performance.${key}`);
    }
    const coverage = translate('performance.coverageSpeed', { measured: 12, total: 99 }, locale);
    assert.match(coverage, /12/u); assert.match(coverage, /99/u);
    assert.doesNotMatch(coverage, /\{/u);
  }
});

test('all-time axes share the selected model earliest measured bin without borrowing another model history', () => {
  const data = payload(), selected = data.models[0];
  selected.speed[0].points = [point(6 * DAY), point(7 * DAY)];
  selected.ttft = [point(3 * DAY), point(8 * DAY)];
  assert.deepEqual(performanceDomain(data, selected), { start: 3 * DAY, end: data.end });
  selected.ttft = [];
  assert.deepEqual(performanceDomain(data, selected), { start: 6 * DAY, end: data.end });
  selected.speed = [];
  selected.ttft = [point(4 * DAY)];
  assert.deepEqual(performanceDomain(data, selected), { start: 4 * DAY, end: data.end });
});
test('bounded periods preserve the complete requested domain and empty all-time has no fabricated era', () => {
  const data = payload(), selected = data.models[0];
  for (const period of ['7', '30']) {
    data.period = period;
    assert.deepEqual(performanceDomain(data, selected), { start: DAY, end: data.end });
  }
  data.period = 'all'; selected.speed = []; selected.ttft = [];
  assert.deepEqual(performanceDomain(data, selected), { start: DAY, end: data.end });
  data.start = null;
  assert.deepEqual(performanceDomain(data, selected), { start: data.end, end: data.end });
});


// A small DOM harness models the important browser behavior here: replacing a
// focused descendant drops focus, so rendering must focus its new equivalent.
function focusHarness() {
  let inactive = true, visibilityObserver = null, documentVisibilityObserver = null, nextTimer = 0;
  const timers = new Map();
  const timerDelays = new Map();
  const documentRef = { activeElement: null, hidden: false,
    addEventListener: (type, listener) => { if (type === 'visibilitychange') documentVisibilityObserver = listener; },
    removeEventListener: (type, listener) => { if (type === 'visibilitychange' && documentVisibilityObserver === listener) documentVisibilityObserver = null; } };
  class Node {
    constructor(tagName) {
      this.tagName = tagName; this.ownerDocument = documentRef; this.children = [];
      this.dataset = {}; this.style = { setProperty() {} }; this.attributes = {};
      this.classList = { contains: () => inactive }; this.listeners = {};
    }
    append(...children) { this.children.push(...children); }
    all() { return this.children.flatMap(child => [child, ...child.all()]); }
    replaceChildren(...children) {
      if (this.all().includes(documentRef.activeElement)) documentRef.activeElement = null;
      this.children = children;
    }
    querySelectorAll(selector) {
      assert.equal(selector, '[data-performance-focus]');
      return this.all().filter(node => node.dataset.performanceFocus);
    }
    setAttribute(key, value) { this.attributes[key] = value; if (key === "class") this.className = value; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 256 }; }
    contains(node) { return node === this || this.all().includes(node); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    focus(options) { documentRef.activeElement = this; this.focusOptions = options; this.listeners.focus?.(); }
  }
  documentRef.createElement = tag => new Node(tag);
  documentRef.createElementNS = (namespace, tag) => new Node(tag);
  const root = new Node('section');
  const windowRef = { localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, callback); timerDelays.set(id, delay); return id; },
    clearTimeout: id => { timers.delete(id); timerDelays.delete(id); },
    MutationObserver: class { constructor(callback) { visibilityObserver = callback; } observe() {} disconnect() {} },
  };
  return { root, documentRef, windowRef, show: () => { inactive = false; },
    navigate: (shown) => { inactive = !shown; visibilityObserver?.(); },
    find: key => root.all().find(node => node.dataset.performanceFocus === key),
    timerIds: () => [...timers.keys()], timerDelay: id => timerDelays.get(id),
    runTimer: id => {
      const callback = timers.get(id);
      timers.delete(id); timerDelays.delete(id);
      return callback?.();
    },
    setDocumentHidden: hidden => { documentRef.hidden = hidden; documentVisibilityObserver?.(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const periodPayload = (period, overrides = {}) => ({ ...payload(), ...overrides, period });
const performanceClient = handler => {
  const calls = [];
  return {
    calls,
    client: { modelPerformance: async (period, options) => { calls.push({ period, options }); return handler(period, options); } },
  };
};



test('Terra 6.1 renders its reviewed name and measured chart from synthetic evidence', async () => {
  const dom = focusHarness(), data = payload();
  Object.assign(data.models[0], { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' });
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => data },
    t: (key, values) => translate(key, values, 'en-US') });
  try {
    dom.show(); await controller.refresh();
    assert.ok(dom.root.all().some(node => node.textContent === 'GPT-6.1 Terra'));
    assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  } finally { controller.destroy(); }
});

test('legacy independent distributions reject mixed-mode evidence without rendering charts', async () => {
  const dom = focusHarness(), data = legacyToolFreePayload();
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => data },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  assert.equal(dom.root.all().filter(node => node.tagName === 'h4').length, 0);
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false);
  assert.ok(dom.find('retry'));
  controller.destroy();
});








test('y axes use readable round steps, include the spread, and retain subsecond resolution', () => {
  assert.deepEqual(performanceYScale([53.9, 54.5, 30]), { maximum: 60, ticks: [0,20,40,60], digits: 0 });
  assert.deepEqual(performanceYScale([36.3]), { maximum: 40, ticks: [0,10,20,30,40], digits: 0 });
  assert.deepEqual(performanceYScale([.008]), { maximum: .008, ticks: [0,.002,.004,.006,.008], digits: 3 });
  assert.equal(performanceYScale([0, null, NaN]).maximum, 1);
  for (const peak of [.1, .9, 1, 12, 72, 100, 1e9]) {
    const scale = performanceYScale([peak]);
    assert.ok(scale.maximum >= peak); assert.ok(scale.ticks.length >= 3 && scale.ticks.length <= 6);
  }
});
test('calendar ticks use first/fifteenth, Monday weeks and bounded year intervals', () => {
  const stamp = value => Date.parse(`${value}T00:00:00Z`);
  const dates = (start,end) => performanceDateTicks({ start: stamp(start), end: stamp(end) }).map(at => new Date(at).toISOString().slice(0,10));
  assert.deepEqual(dates('2026-07-09','2026-09-09'), ['2026-07-15','2026-08-01','2026-08-15','2026-09-01']);
  assert.deepEqual(dates('2026-08-11','2026-09-09'), ['2026-08-17','2026-08-24','2026-08-31','2026-09-07']);
  assert.deepEqual(dates('2026-09-03','2026-09-09'), ['2026-09-03','2026-09-04','2026-09-05','2026-09-06','2026-09-07','2026-09-08','2026-09-09']);
  assert.ok(dates('2001-06-01','2049-09-09').length <= 7);
  assert.deepEqual(performanceDateTicks({ start: 2, end: 1 }), []);
});
test('horizontal hover bins are calendar-aligned including unobserved days and edges', () => {
  const domain = { start: 2*DAY, end: 9.5*DAY };
  assert.equal(performanceHoverBin(0, domain, 'day'), 2*DAY);
  assert.equal(performanceHoverBin(1, domain, 'day'), 9*DAY);
  assert.equal(performanceHoverBin(.5, domain, 'day'), 6*DAY);
  assert.equal((performanceHoverBin(.5, domain, 'week') - 4*DAY) % (7*DAY), 0);
});








test('revisits and background loading retain the ready period while replacements and invalidation stay authoritative', async () => {
  const dom = focusHarness();
  let response = payload();
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => response },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  const panel = () => dom.root.all().find(node => node.id === 'performance-model-panel');
  assert.ok(panel());
  const pending = Promise.withResolvers(); response = pending.promise;
  dom.navigate(false); dom.navigate(true);
  assert.ok(panel(), 'navigation does not blank the last valid chart');
  pending.resolve({ ...payload(), status: 'loading', models: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(panel(), 'background loading is not a replacement measurement');
  response = { ...payload(), status: 'ready', models: [] };
  await controller.refresh();
  assert.equal(panel(), undefined, 'an authoritative empty measurement replaces old values');
  response = payload(); await controller.refresh();
  response = { ...payload(), status: 'unavailable', models: [] };
  await controller.refresh();
  assert.equal(panel(), undefined);
  response = { ...payload(), status: 'loading', models: [] };
  await controller.refresh();
  assert.equal(panel(), undefined, 'unavailable invalidates cached measurements');
  controller.destroy();
});

test('first visible load prioritizes the selected period and warms the other two exactly once', async () => {
  const dom = focusHarness();
  const { calls, client } = performanceClient(period => periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  assert.deepEqual(calls.map(call => call.period), [], 'hidden mounts do not prewarm');
  dom.show(); await controller.refresh(); await settle(); await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30']);
  controller.destroy();
});

test('shared reporting waits for its bound, maps 24h to the rolling backend period, and hides local period controls', async () => {
  const dom = focusHarness();
  const end = 9 * DAY;
  const window = {
    period: '24h',
    startAt: new Date(end - DAY).toISOString(),
    endAt: new Date(end).toISOString(),
  };
  const exact = structuredClone(payload());
  exact.period = '1'; exact.start = end - DAY; exact.end = end;
  exact.models[0].speed[0].points = [point(end - DAY), point(end)];
  exact.models[0].ttft = [point(end - DAY), point(end)];
  const calls = [];
  const controller = mountModelPerformance({
    ...dom,
    sharedReporting: true,
    reportingWindow: null,
    client: { modelPerformance: async (period, options) => {
      calls.push({ period, options });
      return exact;
    } },
    t: (key, values) => translate(key, values, 'en-US'),
  });
  assert.equal(calls.length, 0);
  assert.equal(dom.root.all().some(node => node.dataset.performanceFocus?.startsWith('period-')), false);
  assert.match(dom.root.all().find(node => node.className === 'performance-status').textContent, /unavailable until local data loads/u);
  dom.show();
  assert.equal(controller.setReportingWindow(window), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].period, '1');
  assert.equal(calls[0].options.endAt, window.endAt);
  assert.equal(dom.root.all().some(node => node.dataset.performanceFocus?.startsWith('period-')), false);
  assert.equal(dom.root.all().some(node => node.dataset.evidence === 'period'), false, 'the shared header owns the reporting range');
  assert.equal(dom.root.all().filter(node => node.className === 'performance-headline').length, 2, 'both plots retain their own dated value');
  controller.destroy();
});

test('advancing a shared end bound retains dated charts under their original bounds and fences cancelled replacements', async () => {
  const dom = focusHarness();
  const end = 9 * DAY;
  const windowAt = value => ({ period: '24h', startAt: new Date(value - DAY).toISOString(), endAt: new Date(value).toISOString() });
  const exactAt = value => ({ ...combinedPayload(), period: '1', start: value - DAY, end: value,
    models: combinedPayload().models.map(model => ({ ...model, speedTurns: 5, ttftTurns: 5,
      speed: [{method: 'speed', points: [point(value - DAY)]}], ttft: [point(value - DAY)], toolFree: [point(value - DAY, 2)] })) });
  const calls = [];
  let response = exactAt(end);
  const controller = mountModelPerformance({ ...dom, reportingWindow: windowAt(end),
    client: { modelPerformance: async (period, options) => { calls.push({period, options}); return response; } },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  const panel = () => dom.root.all().find(node => node.id === 'performance-model-panel');
  const toolFreeVisible = () => { if (!panel()) return false; dom.find('measurements').listeners.click(); const found = dom.root.all().some(n => n.className === 'performance-detail-row' && n.children[0].textContent === 'Full-turn estimates' && n.children[1].textContent === '2'); dom.find('detail-close').listeners.click(); return found; };
  const status = () => dom.root.all().find(node => node.className === 'performance-status')?.textContent ?? '';
  const pending = Promise.withResolvers(); response = pending.promise;
  controller.setReportingWindow(windowAt(end + DAY));
  assert.ok(panel());
  assert.ok(toolFreeVisible());
  assert.match(status(), /Previous result/u);
  dom.find('measurements').listeners.click();
  assert.ok(dom.root.all().some(node => node.className === 'performance-detail-row' && node.children[0].textContent === 'Reporting period'));
  dom.find('detail-close').listeners.click();
  assert.equal(calls.at(-1).options.endAt, windowAt(end + DAY).endAt);
  pending.resolve(exactAt(end + DAY));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(panel());
  assert.ok(toolFreeVisible());
  assert.doesNotMatch(status(), /Updating/);
  assert.equal(dom.root.all().some(node => node.dataset.evidence === 'period'), false);

  const cancelled = Promise.withResolvers(); response = cancelled.promise;
  controller.setReportingWindow(windowAt(end + 2 * DAY));
  controller.cancel();
  assert.match(status(), /cancelled/i);
  cancelled.resolve({ ...exactAt(end + 2 * DAY), models: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(panel(), 'late cancelled result cannot remove the retained chart');
  assert.ok(toolFreeVisible(), 'tool-free evidence survives cancellation too');
  assert.match(status(), /cancelled/i);

  response = exactAt(end);
  await controller.refresh();
  assert.ok(panel());
  assert.ok(toolFreeVisible());
  assert.match(status(), /Measurement validation failed/, 'an old-window response cannot be accepted as the new window');
  assert.ok(dom.root.all().some(node => node.className === 'performance-headline-date' && node.textContent.includes('P50')));
  response = { ...exactAt(end + 2 * DAY), status: 'unavailable', models: [] };
  await controller.refresh();
  assert.ok(panel(), 'an unavailable replacement keeps the old explicitly dated window');
  assert.ok(toolFreeVisible(), 'unavailable does not drop recovered estimates from the retained speed chart');
  assert.match(status(), /Measurements unavailable/);
  assert.ok(dom.find('retry'));
  assert.ok(dom.root.all().some(node => node.className === 'performance-headline-date' && node.textContent.includes('P50')));
  response = { ...exactAt(end + 2 * DAY), models: [] };
  await controller.refresh();
  assert.equal(panel(), undefined, 'an authoritative empty replacement still clears the old chart');
  assert.equal(toolFreeVisible(), false);
  assert.equal(dom.root.all().some(node => node.dataset.evidence === 'period'), false);
  controller.destroy();
});





test('page preload warms all periods before first visit and remains idempotent', async () => {
  const dom = focusHarness();
  const { calls, client } = performanceClient(period => periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const first = controller.preload();
  assert.equal(controller.preload(), first, 'a concurrent preload joins the existing operation');
  await first; await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30']);
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'), 'selected data is ready before navigation');
  await controller.preload();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30'], 'fresh periods are not fetched again');
  controller.destroy();
});

test('page preload retries a cold loading response with a bounded retry', async () => {
  const dom = focusHarness();
  let attempts = 0;
  const { calls, client } = performanceClient(period => period === 'all' && attempts++ === 0
    ? periodPayload('all', { status: 'loading', models: [] }) : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const operation = controller.preload();
  await settle();
  assert.deepEqual(calls.map(call => call.period), ['all']);
  const retry = dom.timerIds()[0];
  assert.ok(retry, 'loading response schedules a retry');
  dom.runTimer(retry);
  await operation; await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', 'all', '7', '30']);
  controller.destroy();
});

test('background timing preload continues past the first ten seconds of a cold history pass', async () => {
  const dom = focusHarness();
  let attempts = 0;
  const { calls, client } = performanceClient(period => period === 'all' && attempts++ < 4
    ? periodPayload('all', { status: 'loading', models: [] }) : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client,
    t: (key, values) => translate(key, values, 'en-US') });
  try {
    const operation = controller.preload();
    for (const delay of [5_000, 10_000, 20_000, 30_000]) {
      await settle();
      const timer = dom.timerIds().find(id => dom.timerDelay(id) === delay);
      assert.ok(timer, `cold history schedules a ${delay}ms retry`);
      dom.runTimer(timer);
    }
    await operation;
    assert.equal(calls.filter(call => call.period === 'all').length, 5);
  } finally { controller.destroy(); }
});

test('active navigation joins an in-flight page preload without duplicating the request', async () => {
  const dom = focusHarness(), all = Promise.withResolvers();
  const { calls, client } = performanceClient(period => period === 'all' ? all.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const preparation = controller.preload(); await settle();
  dom.navigate(true);
  const navigation = controller.refresh(); await settle();
  assert.equal(calls.filter(call => call.period === 'all').length, 1, 'foreground refresh joins speculative work');
  all.resolve(periodPayload('all'));
  await Promise.all([preparation, navigation]); await settle();
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  controller.destroy();
});

test('document hiding fences preload and allows a later visible retry', async () => {
  const dom = focusHarness(), first = Promise.withResolvers();
  let attempts = 0;
  const { calls, client } = performanceClient(period => period === 'all' && attempts++ === 0
    ? first.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const canceled = controller.preload(); await settle();
  assert.equal(calls.length, 1);
  dom.setDocumentHidden(true);
  assert.equal(calls[0].options.signal.aborted, true, 'document hiding aborts speculative work');
  await controller.preload();
  assert.equal(calls.length, 1, 'a hidden document does not start speculative work');
  first.resolve(periodPayload('all')); await canceled; await settle();
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'late hidden data is fenced');
  dom.setDocumentHidden(false);
  await controller.preload(); await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', 'all', '7', '30']);
  controller.destroy();
});

test('a warmed period switches synchronously while its replacement revalidates in the background', async () => {
  const dom = focusHarness(), replacement = Promise.withResolvers();
  let blockReplacement = false;
  const { calls, client } = performanceClient((period) => period === '7' && blockReplacement
    ? replacement.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  blockReplacement = true;
  dom.find('period-7').listeners.click();
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'), 'cached chart stays visible before revalidation');
  assert.equal(calls.filter(call => call.period === '7').length, 2, 'switch reuses the warm result and makes one revalidation request');
  replacement.resolve(periodPayload('7'));
  await settle();
  controller.destroy();
});

test('switching during prefetch coalesces with the in-flight period request', async () => {
  const dom = focusHarness(), seven = Promise.withResolvers(), thirty = Promise.withResolvers();
  const { calls, client } = performanceClient(period => period === '7' ? seven.promise : period === '30' ? thirty.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30']);
  dom.find('period-7').listeners.click();
  assert.equal(calls.filter(call => call.period === '7').length, 1, 'the selected refresh joins prefetch');
  seven.resolve(periodPayload('7')); thirty.resolve(periodPayload('30'));
  await settle(); await settle();
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  controller.destroy();
});

test('out-of-order period responses cannot replace the currently selected period', async () => {
  const dom = focusHarness(), all = Promise.withResolvers(), seven = Promise.withResolvers();
  const { client } = performanceClient(period => period === 'all' ? all.promise : period === '7' ? seven.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show();
  const first = controller.refresh();
  dom.find('period-7').listeners.click();
  seven.resolve(periodPayload('7', { models: [] }));
  await settle(); await settle();
  assert.equal(dom.find('period-7').attributes['aria-pressed'], 'true');
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'the selected empty period is rendered');
  all.resolve(periodPayload('all'));
  await first; await settle();
  assert.equal(dom.find('period-7').attributes['aria-pressed'], 'true', 'late all-time data is fenced');
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'late all-time data cannot replace the selected empty period');
  controller.destroy();
});

test('a sibling unavailable response fences a selected refresh already in flight', async () => {
  const dom = focusHarness(), sibling = Promise.withResolvers(), selected = Promise.withResolvers();
  let allAttempts = 0;
  const { calls, client } = performanceClient((period) => {
    if (period === 'all') return ++allAttempts === 1 ? periodPayload('all') : selected.promise;
    if (period === '7') return sibling.promise;
    return periodPayload(period);
  });
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  const selectedRefresh = controller.refresh(); await settle();
  const selectedCall = calls.find((call, index) => call.period === 'all' && index > 0);
  assert.ok(selectedCall, 'a second selected request is in flight');
  sibling.resolve(periodPayload('7', { status: 'unavailable', models: [] }));
  await settle();
  assert.equal(selectedCall.options.signal.aborted, true, 'global unavailability aborts the selected request');
  selected.resolve(periodPayload('all'));
  await selectedRefresh; await settle();
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'the selected view stays unavailable after the late response');
  controller.destroy();
});

test('repeated polling coalesces while the selected period request is in flight', async () => {
  const dom = focusHarness(), poll = Promise.withResolvers();
  let allAttempts = 0;
  const { calls, client } = performanceClient(period => period === 'all'
    ? ++allAttempts === 1 ? periodPayload('all') : poll.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  const first = controller.refresh(), second = controller.refresh(); await settle();
  assert.equal(calls.filter(call => call.period === 'all').length, 2, 'two polls share one network request');
  poll.resolve(periodPayload('all')); await Promise.all([first, second]);
  controller.destroy();
});

test('fresh period entries avoid warm requests until the bounded TTL expires', async () => {
  const dom = focusHarness();
  const { calls, client } = performanceClient(period => periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  await controller.refresh(); await settle();
  assert.deepEqual(calls.map(call => call.period), ['all', '7', '30', 'all'], 'fresh siblings are not re-fetched');
  const originalNow = Date.now, expiredAt = originalNow() + 301_000;
  Date.now = () => expiredAt;
  try {
    await controller.refresh(); await settle(); await settle();
    assert.deepEqual(calls.map(call => call.period), ['all', '7', '30', 'all', 'all', '7', '30'], 'expired siblings are warmed again');
  } finally { Date.now = originalNow; }
  controller.destroy();
});

test('scope unavailability invalidates every period cache', async () => {
  const dom = focusHarness();
  let unavailable = false, pendingThirty = null;
  const { calls, client } = performanceClient(period => {
    if (period === '7' && unavailable) return periodPayload('7', { status: 'unavailable', models: [] });
    if (period === '30' && pendingThirty) return pendingThirty.promise;
    return periodPayload(period);
  });
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  const originalNow = Date.now, expiredAt = originalNow() + 301_000;
  Date.now = () => expiredAt;
  try {
    unavailable = true; pendingThirty = Promise.withResolvers();
    await controller.refresh(); await settle(); await settle();
    assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'background scope invalidation withdraws the visible chart');
    dom.find('period-30').listeners.click();
    assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'invalidated periods are not rendered from stale cache');
    pendingThirty.resolve(periodPayload('30'));
    await settle();
  } finally { Date.now = originalNow; }
  assert.ok(calls.some(call => call.period === '7'));
  controller.destroy();
});

test('scope unavailability withdraws the selected chart while the page is inactive', async () => {
  const dom = focusHarness();
  let unavailable = false;
  const { client } = performanceClient(period => period === '7' && unavailable
    ? periodPayload('7', { status: 'unavailable', models: [] })
    : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'));
  dom.navigate(false);
  const originalNow = Date.now, expiredAt = originalNow() + 301_000;
  Date.now = () => expiredAt;
  try {
    unavailable = true;
    await controller.preload();
    await settle();
    assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false,
      'an unavailable sibling cannot leave a stale chart for the first visit');
  } finally { Date.now = originalNow; }
  controller.destroy();
});

test('a selected unavailable result does not fan out sibling requests', async () => {
  const dom = focusHarness();
  const unavailableClient = performanceClient(() => periodPayload('all', { status: 'unavailable', models: [] }));
  const controller = mountModelPerformance({ ...dom, client: unavailableClient.client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  assert.deepEqual(unavailableClient.calls.map(call => call.period), ['all']);
  controller.destroy();
});

test('an empty ready result replaces the warmed period authoritatively', async () => {
  const dom = focusHarness();
  let empty = false;
  const { client } = performanceClient(period => periodPayload(period, empty && period === '7' ? { models: [] } : {}));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  const originalNow = Date.now, expiredAt = originalNow() + 301_000;
  Date.now = () => expiredAt;
  try {
    empty = true; await controller.refresh(); await settle(); await settle();
    dom.find('period-7').listeners.click();
    assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false);
    assert.ok(dom.root.all().some(node => node.className === 'performance-empty'), 'empty ready remains authoritative after a switch');
  } finally { Date.now = originalNow; }
  controller.destroy();
});

test('background failures retain the last good period value', async () => {
  const dom = focusHarness();
  let fail = false;
  const { client } = performanceClient(period => {
    if (fail && period === '7') throw new Error('temporary connection failure');
    return periodPayload(period);
  });
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle(); await settle();
  const originalNow = Date.now, expiredAt = originalNow() + 301_000;
  Date.now = () => expiredAt;
  try {
    fail = true; await controller.refresh(); await settle(); await settle();
    dom.find('period-7').listeners.click();
    await settle();
    assert.ok(dom.root.all().some(node => node.id === 'performance-model-panel'), 'failed revalidation does not blank a good chart');
  } finally { Date.now = originalNow; }
  controller.destroy();
});

test('a client that ignores the timeout abort cannot publish its late response', async () => {
  const dom = focusHarness(), late = Promise.withResolvers();
  let attempt = 0;
  const { calls, client } = performanceClient(() => ++attempt === 1 ? late.promise : periodPayload('all'));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show();
  const first = controller.refresh();
  const deadline = dom.timerIds()[0];
  dom.runTimer(deadline);
  assert.equal(calls[0].options.signal.aborted, true);
  late.resolve(periodPayload('all'));
  await first; await settle();
  assert.equal(dom.root.all().some(node => node.id === 'performance-model-panel'), false, 'late timed-out data is not rendered');
  await controller.refresh();
  assert.equal(calls.filter(call => call.period === 'all').length, 2, 'timeout permits a later retry');
  controller.destroy();
});

test('hidden and destroyed views cancel selected and prefetch requests', async () => {
  const dom = focusHarness(), first = Promise.withResolvers();
  // The first selected request is held so the view can be hidden before any
  // prefetch begins.
  const held = performanceClient((period, options) => period === 'all' ? first.promise : periodPayload(period));
  const controller = mountModelPerformance({ ...dom, client: held.client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); const refresh = controller.refresh();
  assert.equal(held.calls.length, 1);
  dom.navigate(false);
  assert.equal(held.calls[0].options.signal.aborted, true);
  first.resolve(periodPayload('all'));
  await refresh; await settle();
  assert.equal(held.calls.length, 1, 'hidden cancellation prevents prewarming');
  controller.destroy();

  const secondDom = focusHarness(), prefetch = Promise.withResolvers();
  const warmed = performanceClient(period => period === '7' ? prefetch.promise : periodPayload(period));
  const secondController = mountModelPerformance({ ...secondDom, client: warmed.client, t: (key, values) => translate(key, values, 'en-US') });
  secondDom.show(); await secondController.refresh(); await settle();
  const prefetchCall = warmed.calls.find(call => call.period === '7');
  assert.ok(prefetchCall, 'visible ready data starts the bounded prefetch');
  secondController.destroy();
  assert.equal(prefetchCall.options.signal.aborted, true, 'destroy cancels a running prefetch');
});

const modePayload = (period, speedMode, overrides = {}) => periodPayload(period, { speedMode, ...overrides });
const hasPanel = dom => dom.root.all().some(node => node.id === 'performance-model-panel');

test('Standard is the initial mode and Fast empty results show unknown exclusions without borrowing cached Standard', async () => {
  const dom = focusHarness(), fast = Promise.withResolvers();
  const { calls, client } = performanceClient((period, { speedMode }) => speedMode === 'fast'
    ? period === 'all' ? fast.promise : modePayload(period, speedMode, { models: [] })
    : modePayload(period, speedMode));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  assert.ok(calls.every(call => call.options.speedMode === 'standard'), 'prewarming also stays in Standard');
  assert.equal(dom.find('mode-standard').attributes['aria-pressed'], 'true');
  assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'false');
  dom.find('mode-fast').focus(); dom.find('mode-fast').listeners.click();
  assert.equal(hasPanel(dom), false, 'an uncached Fast view clears all Standard charts immediately');
  assert.equal(dom.documentRef.activeElement, dom.find('mode-fast'), 'toggle focus survives render');
  assert.equal(calls.at(-1).options.speedMode, 'fast');
  fast.resolve(modePayload('all', 'fast', { models: [], excludedUnknownTurns: 17 }));
  await settle(); await settle();
  assert.equal(hasPanel(dom), false);
  assert.ok(dom.root.all().some(node => node.className === 'performance-empty' && node.textContent === 'No measurements'));
  dom.find('measurements').listeners.click();
  assert.ok(dom.root.all().some(node => node.className === 'performance-detail-row' && node.children[0].textContent === 'Unknown speed mode' && node.children[1].textContent === '17'));
  dom.find('detail-close').listeners.click();
  assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'true');
  controller.destroy();
});

test('Ultrafast clears other modes while pending and retains its own empty result and exclusions', async () => {
  const dom = focusHarness(), ultrafast = Promise.withResolvers();
  const { calls, client } = performanceClient((period, { speedMode }) => speedMode === 'ultrafast'
    ? period === 'all' ? ultrafast.promise : modePayload(period, speedMode, { models: [] })
    : modePayload(period, speedMode));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  dom.find('mode-fast').listeners.click(); await settle();
  assert.equal(hasPanel(dom), true);
  assert.equal(dom.find('mode-ultrafast').attributes['aria-pressed'], 'false');
  dom.find('mode-ultrafast').focus(); dom.find('mode-ultrafast').listeners.click();
  assert.equal(hasPanel(dom), false);
  assert.equal(dom.documentRef.activeElement, dom.find('mode-ultrafast'));
  assert.equal(calls.at(-1).options.speedMode, 'ultrafast');
  ultrafast.resolve(modePayload('all', 'ultrafast', { models: [], excludedUnknownTurns: 17 }));
  await settle(); await settle();
  assert.equal(hasPanel(dom), false);
  assert.ok(dom.root.all().some(node => node.className === 'performance-empty' && node.textContent === 'No measurements'));
  assert.equal(dom.find('mode-ultrafast').attributes['aria-pressed'], 'true');
  dom.find('measurements').listeners.click();
  assert.ok(dom.root.all().some(node => node.className === 'performance-detail-row' && node.children[0].textContent === 'Unknown speed mode' && node.children[1].textContent === '17'));
  dom.find('detail-close').listeners.click();
  dom.find('mode-standard').listeners.click();
  assert.equal(hasPanel(dom), true);
  dom.find('mode-ultrafast').listeners.click();
  assert.equal(hasPanel(dom), false);
  assert.equal(dom.find('mode-ultrafast').attributes['aria-pressed'], 'true');
  controller.destroy();
});

test('one Fast observation shows its own coverage, hollow points and no percentile bands', async () => {
  const dom = focusHarness();
  const { client } = performanceClient((period, { speedMode }) => {
    const data = modePayload(period, speedMode);
    if (speedMode === 'fast') Object.assign(data.models[0], { turns: 1, speedTurns: 1, ttftTurns: 1, timedResponses: 1,
      speed: [{ method: 'speed', points: [point(2 * DAY, 1)] }], ttft: [point(2 * DAY, 1)] });
    return data;
  });
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); dom.find('mode-fast').listeners.click(); await settle();
  const nodes = dom.root.all();
  assert.equal(nodes.filter(node => node.className === 'performance-point').length, 2);
  assert.equal(nodes.filter(node => node.tagName === 'circle' && node.attributes.fill === 'var(--surface-raised)').length, 2);
  assert.equal(nodes.filter(node => node.className === 'performance-mean-point' && node.attributes.fill === 'var(--surface-raised)').length, 2);
  assert.equal(nodes.some(node => node.className?.startsWith('performance-percentile-band ')), false);
  assert.equal(nodes.some(node => node.className === 'performance-median-line'), false);
  dom.find('measurements').listeners.click();
  assert.ok(dom.root.all().some(node => node.className === 'performance-detail-row' && node.children[0].textContent === 'Speed measurements' && node.children[1].textContent === '1'));
  controller.destroy();
});

test('mode and period caches stay independent while revisits retain only their own measurements', async () => {
  const dom = focusHarness(); let loading = false;
  const { calls, client } = performanceClient((period, { speedMode }) => modePayload(period, speedMode,
    loading ? { status: 'loading', models: [] } : speedMode === 'fast' ? { models: [] } : {}));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh(); await settle();
  dom.find('mode-fast').listeners.click(); await settle(); await settle();
  assert.deepEqual(calls.filter(call => call.options.speedMode === 'fast').map(call => call.period), ['all', '7', '30']);
  loading = true;
  dom.find('mode-standard').listeners.click();
  assert.ok(hasPanel(dom), 'Standard synchronously recovers its own cached all-time result');
  await settle();
  dom.find('period-7').listeners.click();
  assert.ok(hasPanel(dom), 'Standard recovers only its own warmed seven-day result');
  await settle();
  dom.find('mode-fast').listeners.click();
  assert.equal(hasPanel(dom), false, 'Fast seven-day empty result is not replaced by Standard seven-day charts');
  await settle();
  assert.equal(calls.at(-1).period, '7');
  assert.equal(calls.at(-1).options.speedMode, 'fast');
  assert.equal(dom.find('period-7').attributes['aria-pressed'], 'true');
  controller.destroy();
});

test('late responses and failures from the previous mode cannot change the selected mode or its cache', async () => {
  for (const outcome of ['response', 'failure']) {
    const dom = focusHarness(), late = Promise.withResolvers();
    let standardAttempts = 0;
    const { calls, client } = performanceClient((period, { speedMode }) => {
      if (speedMode === 'standard' && period === 'all') {
        if (++standardAttempts === 1) return late.promise;
        return modePayload(period, speedMode, { status: 'loading', models: [] });
      }
      return modePayload(period, speedMode, { models: [] });
    });
    const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
    dom.show(); const first = controller.refresh();
    dom.find('mode-fast').listeners.click(); await settle();
    assert.equal(calls[0].options.signal.aborted, true);
    if (outcome === 'response') late.resolve(modePayload('all', 'standard'));
    else late.reject(new Error('late Standard failure'));
    await first; await settle();
    assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'true');
    assert.equal(hasPanel(dom), false);
    assert.equal(dom.find('retry'), undefined, 'an obsolete failure never becomes a Fast error');
    dom.find('mode-standard').listeners.click(); await settle();
    assert.equal(hasPanel(dom), false, 'late Standard responses never warm the Standard cache');
    controller.destroy();
  }
});

test('a mode switch fences an in-flight page preload and starts an independent Fast request', async () => {
  const dom = focusHarness(), late = Promise.withResolvers();
  const { calls, client } = performanceClient((period, { speedMode }) => speedMode === 'standard'
    ? late.promise : modePayload(period, speedMode, { models: [] }));
  const controller = mountModelPerformance({ ...dom, client, t: (key, values) => translate(key, values, 'en-US') });
  const preload = controller.preload(); await settle();
  dom.show(); dom.find('mode-fast').listeners.click(); await settle();
  assert.equal(calls[0].options.signal.aborted, true);
  late.resolve(modePayload('all', 'standard')); await preload; await settle();
  assert.equal(calls.filter(call => call.options.speedMode === 'standard').length, 1, 'cancelled preload does not fan out Standard periods');
  assert.equal(hasPanel(dom), false);
  assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'true');
  await controller.preload(); await settle();
  assert.equal(calls.filter(call => call.options.speedMode === 'fast' && call.period === 'all').length, 1, 'new-mode preload reuses only Fast cache');
  controller.destroy();
});

test('shared reporting keeps its exact bound and selected speed mode through mode and period changes', async () => {
  const dom = focusHarness(), end = 9 * DAY;
  const windowAt = period => ({ period, startAt: new Date(end - (period === '24h' ? 1 : 7) * DAY).toISOString(), endAt: new Date(end).toISOString() });
  const { calls, client } = performanceClient((period, { speedMode }) => modePayload(period, speedMode, {
    start: end - Number(period) * DAY, end, models: [],
  }));
  const controller = mountModelPerformance({ ...dom, client, reportingWindow: windowAt('24h'),
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  dom.find('mode-fast').listeners.click(); await settle();
  assert.equal(calls.at(-1).period, '1');
  assert.equal(calls.at(-1).options.speedMode, 'fast');
  assert.equal(calls.at(-1).options.endAt, windowAt('24h').endAt);
  controller.setReportingWindow(windowAt('7d')); await settle();
  assert.equal(calls.at(-1).period, '7');
  assert.equal(calls.at(-1).options.speedMode, 'fast');
  assert.equal(calls.at(-1).options.endAt, windowAt('7d').endAt);
  assert.equal(dom.root.all().some(node => node.dataset.performanceFocus?.startsWith('period-')), false);
  assert.equal(dom.find('mode-fast').attributes['aria-pressed'], 'true');
  controller.destroy();
});

test('shared preload warms only the exact selected period and mode without evicting another reader', async () => {
  const end=60*DAY, calls=[];
  const make=(period,delta)=>{const dom=focusHarness(),endAt=new Date(end+delta).toISOString(),window={period,startAt:period==='all'?null:new Date(end+delta-7*DAY).toISOString(),endAt};
    const controller=mountModelPerformance({...dom,reportingWindow:window,client:{modelPerformance:async(value,options)=>{calls.push({value,...options});return modePayload(value,options.speedMode,{start:period==='all'?null:end+delta-7*DAY,end:end+delta,models:[]});}},t:(k,v)=>translate(k,v,'en-US')});
    return {controller,dom,endAt};};
  const left=make('7d',0),right=make('all',-2000);
  try{
    await Promise.all([left.controller.preload(),right.controller.preload()]);
    assert.equal(calls.length,2);assert.deepEqual(new Set(calls.map(c=>c.endAt)),new Set([left.endAt,right.endAt]));
    assert.deepEqual(calls.map(c=>c.value),['7','all']);assert.ok(calls.every(c=>c.speedMode==='standard'));
    await Promise.all([left.controller.preload(),right.controller.preload()]);assert.equal(calls.length,2,'repeat preparation reuses each exact result');
    left.dom.navigate(true);left.dom.find('mode-fast').listeners.click();await settle();
    assert.equal(calls.at(-1).speedMode,'fast');assert.equal(calls.at(-1).endAt,left.endAt);
    assert.equal(calls.filter(c=>c.speedMode==='ultrafast').length,0,'unselected modes never consume shared cache slots');
  }finally{left.controller.destroy();right.controller.destroy();}
});

test('client rejects unsupported modes, preserves endAt, and page rejects a wrong-mode response', async () => {
  const calls = [], endAt = '2026-09-22T12:00:00.000Z';
  const client = new LocalCompanionClient({ fetchImpl: async (...args) => {
    calls.push(args); return { ok: true, status: 200, json: async () => payload() };
  } });
  await client.modelPerformance('7', { speedMode: 'fast', endAt });
  const url = new URL(calls[0][0], 'http://localhost');
  assert.equal(url.searchParams.get('period'), '7');
  assert.equal(url.searchParams.get('speedMode'), 'fast');
  assert.equal(url.searchParams.get('endAt'), endAt);
  await client.modelPerformance('7', { speedMode: 'ultrafast', endAt });
  const ultrafastUrl = new URL(calls[1][0], 'http://localhost');
  assert.equal(ultrafastUrl.searchParams.get('speedMode'), 'ultrafast');
  assert.equal(ultrafastUrl.searchParams.get('endAt'), endAt);
  for (const speedMode of ['unknown', 'mixed', 'all', 'fast&path=x', null]) assert.throws(() => client.modelPerformance('7', { speedMode }), RangeError);
  const dom = focusHarness();
  const controller = mountModelPerformance({ ...dom, client: { modelPerformance: async () => modePayload('all', 'fast') },
    t: (key, values) => translate(key, values, 'en-US') });
  dom.show(); await controller.refresh();
  assert.equal(hasPanel(dom), false);
  assert.ok(dom.find('retry'));
  controller.destroy();
});

test('compact controls preserve complete statistics in one dialog including fallback and unknown modes', async () => {
  const dom = focusHarness(), data = {...combinedPayload(), excludedUnknownTurns: 17};
  const c = mountModelPerformance({...dom, client:{modelPerformance:async()=>data}, t:(key,v)=>translate(key,v,'en-US')});
  dom.show(); await c.refresh();
  assert.equal(dom.root.all().filter(n=>n.className==='performance-card').length,2);
  assert.equal(dom.root.all().some(n=>['performance-provider','performance-mode-note','performance-method-note'].includes(n.className)),false);
  dom.find('measurements').focus(); dom.find('measurements').listeners.click();
  const rows = () => Object.fromEntries(dom.root.all().filter(n=>n.className==='performance-detail-row').map(n=>[n.children[0].textContent,n.children[1].textContent]));
  assert.equal(rows()['Speed measurements'],'12'); assert.equal(rows()['Response-timed turns'],'10');
  assert.equal(rows()['Full-turn estimates'],'2'); assert.equal(rows()['Unknown speed mode'],'17');
  dom.find('detail-tab-toolFree').listeners.click();
  const cells = dom.root.all().filter(n=>n.tagName==='td').map(n=>n.textContent);
  assert.deepEqual(cells.slice(1),['2','50','—','—','50','—','—']);
  dom.find('detail-close').listeners.click(); assert.equal(dom.documentRef.activeElement,dom.find('measurements'));
  c.destroy();
});

test('all measurement rows paginate without changing values and a refresh preserves dialog state', async () => {
  const dom=focusHarness(), data=payload(); data.end=60*DAY;
  const rows=Array.from({length:35},(_,i)=>point((i+1)*DAY));
  Object.assign(data.models[0],{turns:175,speedTurns:175,ttftTurns:175,speed:[{method:'speed',points:rows}],ttft:rows});
  const c=mountModelPerformance({...dom,client:{modelPerformance:async()=>data},t:(k,v)=>translate(k,v,'en-US')});
  dom.show();await c.refresh();dom.find('details-speed').listeners.click();
  let count=0;
  for(let i=0;i<4;i++){count+=dom.root.all().filter(n=>n.tagName==='tbody')[0].children.length;if(i<3)dom.find('detail-next').listeners.click();}
  assert.equal(count,35);assert.equal(dom.find('detail-next').disabled,true);
  const dialog=dom.root.all().find(n=>n.tagName==='dialog');dialog.scrollTop=120;
  await c.refresh();assert.equal(dialog.open,true);assert.equal(dialog.scrollTop,120);
  assert.equal(dom.root.all().find(n=>n.className==='performance-pager').children[1].textContent,'4 / 4');
  dom.find('period-7').listeners.click();assert.equal(dialog.open,false);c.destroy();
});

test('shared layer toggles leave data intact and a missing date never borrows another metric', async()=>{
  const dom=focusHarness(), data=payload(); data.models[0].speed[0].points=[point(DAY),point(3*DAY)];
  const original=JSON.stringify(data),c=mountModelPerformance({...dom,client:{modelPerformance:async()=>data},t:(k,v)=>translate(k,v,'en-US')});
  dom.show();await c.refresh();
  assert.equal(dom.root.all().filter(n=>n.className==='performance-median-line').length,2,'only adjacent latency bins connect');
  const marker=dom.root.all().find(n=>n.dataset.performanceFocus==='point-speed-speed-86400000');marker.focus();
  assert.deepEqual(dom.root.all().filter(n=>n.className==='performance-headline-value').map(n=>n.textContent),['50','—']);
  dom.find('layer-inner').listeners.click();
  assert.equal(dom.root.all().some(n=>n.className==='performance-percentile-band performance-percentile-band-inner'),false);
  dom.find('layer-median').listeners.click();assert.equal(dom.root.all().some(n=>n.className==='performance-median-line'),false);
  assert.equal(JSON.stringify(data),original);c.destroy();
});

test('mean uses straight segments, breaks missing bins, fits the axis and toggles independently', async () => {
  const dom = focusHarness(), data = payload();
  data.models[0].speed[0].points = [point(DAY), { ...point(3 * DAY), mean: 300 }];
  const original = JSON.stringify(data);
  const c = mountModelPerformance({ ...dom, client: { modelPerformance: async () => data }, t: (k,v) => translate(k,v,'en-US') });
  dom.show(); await c.refresh();
  const meanLines = () => dom.root.all().filter(n => n.className === 'performance-mean-line');
  assert.equal(meanLines().length, 2, 'only adjacent latency dates connect');
  assert.ok(meanLines().every(n => / L/u.test(n.attributes.d) && !/ C/u.test(n.attributes.d)));
  const meanPoints = dom.root.all().filter(n => n.className === 'performance-mean-point');
  assert.equal(meanPoints.length, 5);
  assert.ok(meanPoints.every(n => Number(n.attributes.y) >= 21 && Number(n.attributes.y) <= 214), 'mean above P90 stays inside the plot');
  dom.find('point-speed-speed-259200000').focus();
  assert.ok(dom.root.all().some(n => n.className === 'sr-only performance-readout' && n.textContent?.includes('Mean 300')));
  assert.ok(dom.root.all().some(n => n.className === 'performance-tooltip-value' && n.textContent === `300 ${translate('performance.speedShortUnit', {}, 'en-US')}`));
  dom.find('layer-mean').focus(); dom.find('layer-mean').listeners.click();
  assert.equal(meanLines().length, 0);
  assert.equal(dom.root.all().some(n => n.className === 'performance-mean-point'), false);
  assert.equal(dom.root.all().filter(n => n.className === 'performance-median-line').length, 2);
  assert.equal(dom.documentRef.activeElement, dom.find('layer-mean'));
  dom.find('layer-mean').listeners.click();
  assert.equal(meanLines().length, 2);
  assert.equal(JSON.stringify(data), original);
  c.destroy();
});

test('ready reports have no recurring timer and loading requests stop at the bounded budget',async()=>{
  const dom=focusHarness();let data=payload(),calls=0;
  const c=mountModelPerformance({...dom,sharedReporting:true,reportingWindow:{period:'all',startAt:null,endAt:new Date(data.end).toISOString()},client:{modelPerformance:async()=>{calls++;return data;}},t:(k,v)=>translate(k,v,'en-US')});
  dom.show();await c.refresh();assert.equal(dom.timerIds().length,0);
  data={...data,status:'loading',models:[]};await c.refresh();
  for(let i=0;i<30;i++){const timers=dom.timerIds().filter(id=>dom.timerDelay(id)!==15000);if(!timers.length)break;dom.runTimer(timers.at(-1));await settle();}
  assert.equal(calls,25,'one completed report plus at most 24 pending reads');c.destroy();
});

test('request diagnostics are closed and separate from the v6 DTO',async()=>{
  const run=async raw=>{const seen=[];const client=new LocalCompanionClient({fetchImpl:async()=>({ok:true,status:200,headers:{get:name=>name==='X-Usage-Monitor-Performance-Diagnostics'?raw:null},json:async()=>payload()})});const value=await client.modelPerformance('all',{onDiagnostics:codes=>seen.push(codes)});assert.deepEqual(Object.keys(value),Object.keys(payload()));return seen;};
  assert.deepEqual(await run('timing_scan_failed,timing_snapshot_write_failed'),[['timing_scan_failed','timing_snapshot_write_failed']]);
  assert.deepEqual(await run('timing_history_unavailable'),[['timing_history_unavailable']]);
  const sourceCodes=['timing_source_decode_failed','timing_source_read_failed','timing_source_limit','timing_source_unsupported'];
  for(const code of sourceCodes)assert.deepEqual(await run(code),[[code]]);
  const allCodes=['timing_worker_failed','timing_scan_failed','timing_store_failed','timing_projection_failed',
    'timing_snapshot_read_failed','timing_snapshot_invalid','timing_snapshot_write_failed','timing_snapshot_scope_mismatch',
    'timing_history_unavailable','timing_source_recovery_failed',...sourceCodes];
  assert.deepEqual(await run(allCodes.join(',')),[allCodes]);
  for(const raw of ['private/path','timing_scan_failed,timing_scan_failed','x'.repeat(513)])await assert.rejects(run(raw),{code:'timing_contract_invalid'});
});

test('background diagnostics remain visible with a good result and clear after successful recovery',async()=>{
  const dom=focusHarness();let codes=['timing_snapshot_write_failed'];
  const c=mountModelPerformance({...dom,client:{modelPerformance:async(_,options)=>{options.onDiagnostics(codes);return payload();}},t:(k,v)=>translate(k,v,'en-US')});
  dom.show();await c.refresh();assert.equal(hasPanel(dom),true);assert.ok(dom.find('retry'));
  assert.match(dom.root.all().find(n=>n.className==='performance-status').textContent,/could not be saved/);
  dom.find('measurements').listeners.click();assert.ok(dom.root.all().some(n=>n.textContent==='timing_snapshot_write_failed · snapshot'));
  codes=[];await c.refresh();assert.equal(dom.root.all().some(n=>n.className==='performance-status'),false);c.destroy();
});

test('parse failure, timeout and contract failure remain distinct from cancellation',async()=>{
  for(const [error,code] of [[new SyntaxError('synthetic'),'timing_parse_failed'],[new Error('network'),'timing_request_failed']]){
    const dom=focusHarness(),c=mountModelPerformance({...dom,client:{modelPerformance:async()=>{throw error;}},t:(k,v)=>translate(k,v,'en-US')});dom.show();await c.refresh();
    assert.equal(dom.root.all().find(n=>n.className==='performance-status').textContent,translate('performance.error.'+code,{},'en-US'));
    assert.ok(dom.find('retry'));c.destroy();
  }
});
test('saved-source warnings never block bounded reads of a cold live reporting window',async()=>{
  const dom=focusHarness();let pending=true;
  const c=mountModelPerformance({...dom,sharedReporting:true,reportingWindow:{period:'all',startAt:null,endAt:new Date(payload().end).toISOString()},
    client:{modelPerformance:async(_,options)=>{options.onDiagnostics(['timing_snapshot_scope_mismatch']);return pending?{...payload(),status:'loading',models:[]}:payload();}},t:(k,v)=>translate(k,v,'en-US')});
  dom.show();await c.refresh();const retry=dom.timerIds().find(id=>dom.timerDelay(id)===5000);assert.ok(retry);
  pending=false;dom.runTimer(retry);await settle();assert.equal(hasPanel(dom),true);
  assert.match(dom.root.all().find(n=>n.className==='performance-status').textContent,/source mismatch/);
  c.destroy();
});
test('unavailable historical sources remain visible with their history stage while current measurements stay readable',async()=>{
  const dom=focusHarness(),c=mountModelPerformance({...dom,
    client:{modelPerformance:async(_,options)=>{options.onDiagnostics(['timing_history_unavailable']);return {...payload(),stale:true};}},
    t:(k,v)=>translate(k,v,'en-US')});
  dom.show();await c.refresh();assert.equal(hasPanel(dom),true);
  assert.match(dom.root.all().find(n=>n.className==='performance-status').textContent,/historical sources/);
  dom.find('measurements').listeners.click();
  assert.ok(dom.root.all().some(n=>n.textContent==='timing_history_unavailable · history'));c.destroy();
});

test('pending metadata does not present placeholder counts as measured zero',async()=>{
  const dom=focusHarness(),c=mountModelPerformance({...dom,client:{modelPerformance:async()=>({...payload(),status:'loading',models:[]})},t:(k,v)=>translate(k,v,'en-US')});
  dom.show();await c.refresh();dom.find('measurements').listeners.click();
  const row=dom.root.all().find(n=>n.className==='performance-detail-row'&&n.children[0].textContent==='Unknown speed mode');
  assert.equal(row.children[1].textContent,'—');c.destroy();
});
test('a failed first request still exposes its bounded diagnostic code without invented measurements',async()=>{
  const dom=focusHarness(),c=mountModelPerformance({...dom,client:{modelPerformance:async()=>{throw new SyntaxError('synthetic');}},t:(k,v)=>translate(k,v,'en-US')});
  dom.show();await c.refresh();assert.equal(dom.find('measurements').disabled,false);dom.find('measurements').listeners.click();
  assert.ok(dom.root.all().some(n=>n.textContent==='timing_parse_failed · request'));
  assert.equal(dom.root.all().some(n=>n.className==='performance-detail-row'&&n.children[0].textContent==='Speed measurements'),false);
  c.destroy();
});

test('source diagnostic headers are closed, bounded and separate from the measurement body', async () => {
  const codes = ['recovery_source_missing', 'recovery_source_read_failed', 'recovery_source_not_discovered',
    'source_identity_changed', 'source_truncated_during_read', 'source_grew_during_read',
    'source_metadata_changed_during_read', 'source_changed_unknown'];
  const run = async raw => {
    const seen = [];
    const client = new LocalCompanionClient({ fetchImpl: async () => ({ ok: true, status: 200,
      headers: { get: name => name === 'X-Usage-Monitor-Performance-Source-Diagnostics' ? raw : '' },
      json: async () => payload() }) });
    const data = await client.modelPerformance('all', { onSourceDiagnostics: rows => seen.push(rows) });
    assert.deepEqual(data, payload());
    return seen;
  };
  assert.deepEqual(await run(null), [[]], 'old companions remain compatible');
  const rows = codes.map((code, i) => ({ code, count: i + 1 }));
  assert.deepEqual(await run(JSON.stringify(rows)), [rows]);
  const valid = { code: 'source_grew_during_read', count: 1 };
  for (const raw of ['{', 'null', '{}', ' '.repeat(1025),
    ...[[valid, valid], [{ ...valid, path: 'synthetic-private-path' }], [{ count: 1 }],
      [{ code: 'unknown', count: 1 }], ...[0, -1, 1.5, 1_000_000_001, '1', null].map(count => [{ ...valid, count }])]
      .map(value => JSON.stringify(value))]) {
    await assert.rejects(run(raw), { code: 'timing_contract_invalid' });
  }
});

function sourceRecoveryHarness({ codes = ['timing_source_recovery_failed'],
  details = [{ code: 'source_grew_during_read', count: 1 }], locale = 'zh-CN' } = {}) {
  const dom = focusHarness(), state = { codes, details, data: payload(), error: null, calls: 0 };
  const controller = mountModelPerformance({ ...dom, sharedReporting: true,
    reportingWindow: { period: 'all', startAt: null, endAt: new Date(state.data.end).toISOString() },
    client: { modelPerformance: async (_, options) => {
      state.calls++;
      if (state.error) throw state.error;
      options.onDiagnostics(state.codes); options.onSourceDiagnostics(state.details);
      return { ...state.data, speedMode: options.speedMode };
    } }, t: (key, values) => translate(key, values, locale) });
  const status = () => dom.root.all().find(node => node.dataset.state);
  const text = () => dom.root.all().map(node => node.textContent ?? '').join('\n');
  return { ...dom, controller, state, status, text };
}

test('growth warnings retain charts, back off and clear unchanged measurements and old warnings on recovery', async () => {
  const h = sourceRecoveryHarness(); h.show(); await h.controller.refresh();
  assert.equal(h.status().dataset.state, 'retrying'); assert.equal(h.status().textContent, '正在重试');
  assert.equal(h.root.all().find(node => node.className === 'performance-actions').children.length, 1);
  assert.equal(h.find('cancel'), undefined); assert.equal(hasPanel(h), true);
  h.find('measurements').listeners.click(); assert.match(h.text(), /source_grew_during_read · 1/);
  for (const delay of [5000, 10000]) {
    const timers = h.timerIds(); assert.equal(timers.length, 1); assert.equal(h.timerDelay(timers[0]), delay);
    h.runTimer(timers[0]); await settle(); assert.equal(hasPanel(h), true);
  }
  h.state.codes = []; h.state.details = [];
  h.runTimer(h.timerIds()[0]); await settle();
  assert.equal(h.status(), undefined); assert.equal(h.timerIds().length, 0);
  assert.doesNotMatch(h.text(), /source_grew_during_read|timing_source_recovery_failed/);
  // A later independent incident gets a fresh budget.
  h.state.codes = ['timing_source_recovery_failed'];
  h.state.details = [{ code: 'source_grew_during_read', count: 1 }];
  await h.controller.refresh(); assert.equal(h.timerDelay(h.timerIds()[0]), 5000);
  h.controller.destroy();
});

test('persistent source changes exhaust four retries and expose the original error and source reason', async () => {
  const h = sourceRecoveryHarness(); h.show(); await h.controller.refresh();
  for (const delay of [5000, 10000, 20000, 30000]) {
    assert.equal(h.timerIds().length, 1); assert.equal(h.timerDelay(h.timerIds()[0]), delay);
    h.runTimer(h.timerIds()[0]); await settle();
  }
  assert.equal(h.state.calls, 5); assert.equal(h.timerIds().length, 0);
  assert.equal(h.status().dataset.state, 'error'); assert.match(h.text(), /计时源恢复失败.*已达自动重试次数上限/);
  assert.doesNotMatch(h.text(), /正在重试|等待日志稳定/); assert.equal(hasPanel(h), true);
  h.find('measurements').listeners.click(); assert.match(h.text(), /source_grew_during_read · 1/);
  h.find('retry').listeners.click(); await settle();
  assert.equal(h.status().dataset.state, 'retrying'); assert.equal(h.timerDelay(h.timerIds()[0]), 5000);
  h.controller.destroy();
});

test('missing, unreadable, replaced and truncated sources stay explicit and mixed errors never hide behind retrying', async () => {
  for (const code of ['recovery_source_missing', 'recovery_source_read_failed', 'recovery_source_not_discovered',
    'source_identity_changed', 'source_truncated_during_read']) {
    const h = sourceRecoveryHarness({ details: [{ code: 'source_grew_during_read', count: 1 }, { code, count: 2 }] });
    h.state.data = { ...h.state.data, collecting: true, stale: true };
    h.show(); await h.controller.refresh();
    assert.equal(h.status().dataset.state, 'error'); assert.equal(h.timerIds().length, 0);
    assert.ok(h.text().includes(translate(`performance.source.${code}`, {}, 'zh-CN')));
    assert.doesNotMatch(h.text(), /正在重试|等待日志稳定/); assert.equal(hasPanel(h), true);
    h.controller.destroy();
  }
  const h = sourceRecoveryHarness({ codes: ['timing_source_recovery_failed', 'timing_source_decode_failed'] });
  h.show(); await h.controller.refresh(); assert.equal(h.status().dataset.state, 'error');
  assert.match(h.status().textContent, /压缩计时来源格式错误/);
  assert.equal(h.timerIds().length, 0); h.controller.destroy();
});

test('an old companion recovery warning retries without inventing growth evidence or old measurements', async () => {
  const h = sourceRecoveryHarness({ details: [] }); h.show(); await h.controller.refresh();
  assert.equal(h.status().dataset.state, 'retrying'); assert.doesNotMatch(h.text(), /等待日志稳定/);
  h.controller.destroy();
  const cold = sourceRecoveryHarness(); cold.state.data = { ...cold.state.data, status: 'loading', models: [] };
  cold.show(); await cold.controller.refresh(); assert.equal(hasPanel(cold), false);
  assert.equal(cold.status().textContent, '正在重试'); assert.equal(cold.find('cancel'), undefined);
  assert.doesNotMatch(cold.text(), /保留旧测量/);
  cold.controller.destroy();
});

test('request and contract failures interrupt retries, remain explicit and keep the prior graphs', async () => {
  for (const error of [new Error('synthetic network failure'), new SyntaxError('synthetic invalid JSON')]) {
    const h = sourceRecoveryHarness(); h.show(); await h.controller.refresh(); h.state.error = error;
    h.runTimer(h.timerIds()[0]); await settle();
    assert.equal(h.status().dataset.state, 'error'); assert.equal(h.timerIds().length, 0);
    assert.match(h.text(), error instanceof SyntaxError ? /响应解析失败/ : /请求失败/);
    assert.doesNotMatch(h.text(), /正在重试/); assert.equal(hasPanel(h), true);
    h.controller.destroy();
  }
});

test('cancel, navigation, document hiding and destroy clear queued retries', async () => {
  for (const stop of [h => h.controller.cancel(), h => h.navigate(false),
    h => h.setDocumentHidden(true), h => h.controller.destroy()]) {
    const h = sourceRecoveryHarness(); h.show(); await h.controller.refresh();
    stop(h); assert.equal(h.timerIds().length, 0); await settle(); assert.equal(h.state.calls, 1);
    h.controller.destroy();
  }
});

test('a speed or exact-window change fences retry causes and starts a new budget', async () => {
  for (const change of [h => h.find('mode-fast').listeners.click(), h => {
    h.state.data = { ...h.state.data, end: h.state.data.end + 1000 };
    h.controller.setReportingWindow({ period: 'all', startAt: null, endAt: new Date(h.state.data.end).toISOString() });
  }]) {
    const h = sourceRecoveryHarness(); h.show(); await h.controller.refresh();
    const oldTimer = h.timerIds()[0]; h.state.codes = []; h.state.details = [];
    change(h); await settle();
    assert.equal(h.status(), undefined); assert.equal(h.timerIds().length, 0);
    h.runTimer(oldTimer); await settle(); assert.equal(h.state.calls, 2);
    assert.doesNotMatch(h.text(), /source_grew_during_read|正在重试/); h.controller.destroy();
  }
});

test('revalidating before a queued retry runs does not consume its attempt budget', async () => {
  const h = sourceRecoveryHarness(); h.show(); await h.controller.refresh();
  for (let i = 0; i < 5; i++) {
    await h.controller.refresh(); assert.equal(h.status().dataset.state, 'retrying');
    assert.equal(h.timerIds().length, 1); assert.equal(h.timerDelay(h.timerIds()[0]), 5000);
  }
  h.controller.destroy();
});

test('cancelling an in-flight retry fences a client that ignores its abort signal', async () => {
  const dom = focusHarness(), late = Promise.withResolvers(); let calls = 0;
  const c = mountModelPerformance({ ...dom, sharedReporting: true,
    reportingWindow: { period: 'all', startAt: null, endAt: new Date(payload().end).toISOString() },
    client: { modelPerformance: async (_, options) => {
      options.onDiagnostics(['timing_source_recovery_failed']);
      options.onSourceDiagnostics([{ code: 'source_grew_during_read', count: 1 }]);
      return ++calls === 1 ? payload() : late.promise;
    } }, t: (key, values) => translate(key, values, 'zh-CN') });
  dom.show(); await c.refresh(); dom.runTimer(dom.timerIds()[0]); await settle();
  assert.equal(dom.root.all().find(node => node.dataset.state).textContent, '正在重试');
  assert.equal(dom.find('cancel'), undefined);
  c.cancel(); late.resolve(payload()); await settle();
  assert.equal(dom.timerIds().length, 0); assert.equal(hasPanel(dom), true);
  assert.equal(dom.root.all().find(node => node.dataset.state).dataset.state, 'cancelled'); c.destroy();
});

test('malformed source diagnostics reject a retry rather than silently accepting fresh-looking measurements', async () => {
  const dom = focusHarness(); let bad = false;
  const c = mountModelPerformance({ ...dom, sharedReporting: true,
    reportingWindow: { period: 'all', startAt: null, endAt: new Date(payload().end).toISOString() },
    client: new LocalCompanionClient({ fetchImpl: async () => ({ ok: true, status: 200,
      headers: { get: name => name === 'X-Usage-Monitor-Performance-Diagnostics' ? 'timing_source_recovery_failed'
        : bad ? '[{"code":"source_grew_during_read","count":1,"private":"omitted"}]'
          : '[{"code":"source_grew_during_read","count":1}]' }, json: async () => payload() }) }),
    t: (key, values) => translate(key, values, 'zh-CN') });
  dom.show(); await c.refresh(); bad = true; dom.runTimer(dom.timerIds()[0]); await settle();
  assert.equal(dom.timerIds().length, 0); assert.equal(hasPanel(dom), true);
  assert.match(dom.root.all().find(node => node.dataset.state).textContent, /测量校验失败/); c.destroy();
});
