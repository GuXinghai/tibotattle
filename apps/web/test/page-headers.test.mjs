import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const render = source.slice(source.indexOf("function renderLocalOnboarding(value) {"), source.indexOf("\nfunction renderDashboard(data) {"));

function onboardingHarness(locale = "en-US") {
  const nodes = new Map();
  const element = (tagName = "DIV") => ({
    tagName, hidden: true, open: false, dataset: {}, isConnected: true,
    classList: { toggle() {} }, children: [], removeAttribute() {}, setAttribute() {},
    get childNodes() { return this.children; },
    append(...children) {
      for (const child of children) {
        if (child.parentElement) {
          const siblings = child.parentElement.children;
          siblings.splice(siblings.indexOf(child), 1);
        }
        child.parentElement = this;
        this.children.push(child);
      }
    },
    replaceChildren() { this.children = []; },
    closest(selector) { return selector === "summary" && this.tagName === "SUMMARY" ? this : null; },
    focus() { this.focused = true; },
  });
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const context = vm.createContext({
    $: get, localOnboarding: null, dashboard: { collector: {} },
    runsInsideNativeDashboard: () => false,
    setJourneyState() {}, updateLocalActionButtons() {}, setGlobalState() {},
    localAnalysisAllowed: (value) => value.sourceStatus === "ready" && value.stateWritable,
    clear(element) { element.children = []; }, node: (tag, className) => ({ tag, className, children: [], append(...children) { this.children.push(...children); } }), compact: String,
    t: (key, values = {}) => translate(key, values, locale),
    setLocalizedText(element, key, values = {}) { element.textContent = translate(key, values, locale); },
    localizedNode(_tag, _className, key, values = {}) { return { textContent: translate(key, values, locale) }; },
  });
  vm.runInContext(source.slice(source.indexOf("function onboardingSourceGuidance(value) {"), source.indexOf("\nlet reportingWindow")), context);
  vm.runInContext(render, context);
  const ready = { state: "ready", sourceStatus: "ready", stateWritable: true, rolloutFilesPresent: true, rolloutFilesObserved: 3 };
  const card = get("#setup-card");
  card.tagName = "DETAILS";
  const summary = element("SUMMARY");
  summary.textContent = "Local setup";
  const body = element();
  body.append(get("#setup-summary"), get("#setup-checks"), get("#setup-note"));
  card.append(summary, body);
  const dialog = element("DIALOG"), content = element(), title = element();
  const listeners = new Map(), windowListeners = new Map(), dialogListeners = new Map();
  const frames = [];
  const documentRef = {
    body: { dataset: { dashboardPage: "overview" } },
    querySelector: selector => ({ "#overview-details-dialog": dialog,
      "#overview-details-content": content, "#overview-details-title": title,
      "#main": { contains: target => target === card } })[selector] ?? null,
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
  };
  const windowRef = {
    addEventListener(name, handler) { windowListeners.set(name, handler); },
    requestAnimationFrame(handler) { frames.push(handler); return frames.length; },
  };
  dialog.addEventListener = (name, handler) => dialogListeners.set(name, handler);
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialogListeners.get("close")(); };
  const layoutStart = source.indexOf("function mountDashboardLayout(");
  const layoutEnd = source.indexOf("\n// Mount the view switches first:", layoutStart);
  assert.ok(layoutStart >= 0 && layoutEnd > layoutStart);
  vm.runInContext(source.slice(layoutStart, layoutEnd), context);
  context.mountDashboardLayout({ documentRef, windowRef });
  const settleLayout = () => {
    windowListeners.get("usagemonitor:locale-change")();
    while (frames.length) frames.shift()();
  };
  settleLayout();
  return { context, get, card, ready, dialog, content, body, summary, settleLayout,
    setLocale(value) { locale = value; },
    open() {
      const event = { target: summary, preventDefault() { this.defaultPrevented = true; } };
      for (const handler of listeners.get("click")) handler(event);
      assert.equal(event.defaultPrevented, true, "the summary opens a modal instead of expanding Overview");
    },
    update: (value = ready) => context.renderLocalOnboarding(value),
  };
}

test("setup failures render in the selected language and update after language changes", () => {
  const h = onboardingHarness("zh-Hans");
  const missing = { ...h.ready, state: "needs_setup", sourceStatus: "codex_home_missing", customCodexHomeConfigured: true };
  h.update(missing);
  assert.equal(h.get("#setup-title").textContent, "找不到你的 Codex 文件夹");
  assert.match(h.get("#setup-summary").textContent, /设置中选择现有的 Codex 文件夹/u);
  assert.doesNotMatch(h.get("#setup-summary").textContent, /Mac|System Settings/u);
  assert.match(h.get("#setup-note").textContent, /不会分析日志，也不会上传/u);
  h.setLocale("en-US");
  h.update(missing);
  assert.equal(h.get("#setup-title").textContent, "Can't find your Codex folder");
  h.setLocale("es");
  h.update(missing);
  assert.equal(h.get("#setup-title").textContent, "No se encuentra tu carpeta de Codex");
  for (const sourceStatus of ["codex_home_unreadable", "session_directories_missing", "session_directories_unreadable", "no_rollout_files", "unknown"]) {
    h.setLocale("zh-Hans");
    h.update({ ...missing, sourceStatus });
    assert.match(h.get("#setup-title").textContent, /[\u4e00-\u9fff]/u, sourceStatus);
    assert.match(h.get("#setup-summary").textContent, /[\u4e00-\u9fff]/u, sourceStatus);
  }
});

test("setup dialog keeps live details across readiness refreshes and restores content and focus on close", () => {
  const h = onboardingHarness();
  h.update();
  assert.equal(h.card.open, false);
  assert.equal(h.card.dataset.setupMode, "ready");
  assert.equal(h.card.hidden, true, "a ready setup does not occupy Overview");
  h.context.dashboard.collector.indexing = { status: "bounded_pause", filesProcessed: 1, filesSelected: 3 };
  h.update();
  assert.equal(h.card.hidden, false, "an actionable setup remains reachable");
  h.open();
  assert.equal(h.dialog.open, true);
  assert.deepEqual(h.content.children, [h.body], "move the actual detail nodes, not a stale copy");
  assert.deepEqual(h.card.children, [h.summary]);
  h.context.dashboard.collector.indexing = { status: "bounded_pause", filesProcessed: 1, filesSelected: 3 };
  h.update();
  h.settleLayout();
  assert.equal(h.dialog.open, true, "background readiness updates preserve an open dialog");
  assert.equal(h.card.open, false, "attention never expands the primary page");
  assert.equal(h.card.dataset.setupMode, "attention");
  assert.equal(h.get("#setup-summary").textContent, translate("setup.state.boundedCopy", {
    processed: "1", selected: "3",
  }, "en-US"));
  assert.equal(h.content.children[0], h.body);
  h.context.dashboard.collector.indexing = null;
  h.update();
  h.settleLayout();
  assert.equal(h.card.hidden, true);
  assert.equal(h.dialog.open, false, "resolved setup closes its no-longer-visible disclosure");
  assert.equal(h.card.open, false);
  h.update({ ...h.ready, stateWritable: false, stateStatus: "unwritable" });
  assert.equal(h.card.hidden, false);
  assert.equal(h.card.open, false);
  assert.equal(h.card.dataset.setupMode, "attention");
  assert.equal(h.get("#setup-title").textContent, translate("setup.state.unwritableTitle", {}, "en-US"));
  assert.equal(h.get("#setup-summary").textContent, translate("setup.state.unwritableCopy", {}, "en-US"));
  h.context.dashboard.collector.indexing = { status: "recent_7d_indexing" };
  h.update();
  assert.equal(h.card.open, false, "ready setup stays compact while collection runs in the header");
  assert.deepEqual(h.card.children, [h.summary, h.body]);
  assert.equal(h.content.children.length, 0);
  assert.equal(h.summary.focused, true);
  h.context.dashboard.collector.indexing = { status: "bounded_pause", filesProcessed: 1, filesSelected: 3 };
  h.update();
  h.open();
  h.update({ state: "unavailable" });
  h.settleLayout();
  assert.equal(h.card.hidden, true, "unavailable onboarding is not a ready status");
  assert.equal(h.dialog.open, false, "an unavailable disclosure cannot leave a stale dialog open");
});

test("setup remains reachable in a dialog before dashboard results exist without expanding Overview", () => {
  const h = onboardingHarness();
  h.context.dashboard = null;
  h.update();
  assert.equal(h.card.hidden, false);
  assert.equal(h.card.open, false);
  assert.equal(h.card.dataset.setupMode, "attention");
  assert.equal(h.get("#setup-checks").children.length, 3);
  h.open();
  assert.equal(h.dialog.open, true);
  assert.equal(h.content.children[0], h.body);
  h.dialog.close();
  assert.equal(h.card.children[1], h.body);
  assert.equal(h.summary.focused, true);
});

test("translated setup checks preserve list semantics and capped observation counts", () => {
  const h = onboardingHarness("zh-Hans");
  h.update({ ...h.ready, rolloutFilesObserved: 3, rolloutFilesObservedCapped: true });
  const checks = h.get("#setup-checks").children;
  assert.equal(checks.length, 3);
  assert.ok(checks.every(row => row.tag === "li"));
  assert.equal(checks[2].children[0].textContent, "找到 3+ 个 Codex 会话文件");
});

test("every static page header is available through the browser locale entrypoint", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const keys = [...html.matchAll(/data-i18n="(page\.[^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(keys)].sort(), ["page.allowance.title", "page.overview.description", "page.overview.title", "page.performance.title", "page.usage.title"],
    "the four destinations and the Overview description are the only static page headers");
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) {
      const value = translate(key, {}, locale);
      assert.ok(value && value !== key, `${locale} resolves ${key} instead of displaying its key`);
    }
  }
});

test("setup status labels resolve through the browser catalog", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ["setup.title", "setup.ready"]) {
      assert.notEqual(translate(key, {}, locale), key);
    }
  }
});
