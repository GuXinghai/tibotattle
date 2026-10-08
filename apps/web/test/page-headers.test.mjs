import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const render = source.slice(source.indexOf("function renderLocalOnboarding(value) {"), source.indexOf("\nfunction renderDashboard(data) {"));

function onboardingHarness(locale = "en-US") {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: true, open: true, dataset: {}, classList: { toggle() {} },
      children: [], removeAttribute() {}, setAttribute() {}, append(...children) { this.children.push(...children); },
    });
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
  return { context, get, card: get("#setup-card"), ready, setLocale(value) { locale = value; }, update: (value = ready) => context.renderLocalOnboarding(value) };
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

test("setup disclosure preserves manual expansion but opens when readiness needs attention", () => {
  const h = onboardingHarness();
  h.update();
  assert.equal(h.card.open, false);
  h.card.open = true;
  h.update();
  assert.equal(h.card.open, true, "a refresh preserves manual expansion");
  h.card.open = false;
  h.context.dashboard.collector.indexing = { status: "bounded_pause", filesProcessed: 1, filesSelected: 3 };
  h.update();
  assert.equal(h.card.open, true, "a bounded pass needs an accessible continuation action");
  h.context.dashboard.collector.indexing = null;
  h.update();
  assert.equal(h.card.open, false);
  h.update({ ...h.ready, stateWritable: false, stateStatus: "unwritable" });
  assert.equal(h.card.open, true, "an unwritable state must expose recovery guidance");
  h.context.dashboard.collector.indexing = { status: "recent_7d_indexing" };
  h.update();
  assert.equal(h.card.open, false, "ready setup stays compact while collection runs in the header");
  h.update({ state: "unavailable" });
  assert.equal(h.card.hidden, true, "unavailable onboarding is not a ready status");
});

test("setup stays expanded before any dashboard results exist", () => {
  const h = onboardingHarness();
  h.context.dashboard = null;
  h.update();
  assert.equal(h.card.open, true);
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
  assert.equal(keys.length, 10);
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
