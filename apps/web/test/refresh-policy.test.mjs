import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { SUPPORTED_LOCALES, translate, translatePlural } from "../public/localization.js";
import { historyCoverageNoticeKind, refreshAccountingStatus, refreshQuickResultStatus } from "../public/lib.js";
import { observationRecency } from "../public/dashboard-ui.js";
import { createDomHelpers } from "../public/ui-format.js";
import { createElectronRefreshLease } from "../public/electron-refresh-lifecycle.js";
import { DESKTOP_AUTOMATIC_REFRESH_CADENCE_INTERVAL_MS } from "../../electron/desktop-automatic-refresh-cadence.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function productionFunction(name) {
  const match = source.match(new RegExp(
    `^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "mu",
  ));
  assert.ok(match, `${name} is exercised from production source`);
  return match[0];
}

function refreshElement(tagName = "button") {
  const attributes = new Map();
  const classes = new Set();
  return {
    tagName,
    children: [],
    style: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    },
    get textContent() { return this.children.map((child) => child.textContent).join(""); },
    set textContent(value) { this.children = [{ textContent: String(value) }]; },
    get title() { return attributes.get("title") ?? ""; },
    set title(value) { attributes.set("title", String(value)); },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, handler) { this[name] = handler; },
  };
}

function refreshHarness({
  rejection = null,
  native = false,
  electron = false,
  bridge = undefined,
  detailedSnapshot = false,
  now = Date.parse("2026-09-22T12:00:00.000Z"),
  refreshStates = [],
} = {}) {
  const calls = [];
  const routes = [];
  const notices = [];
  const timers = [];
  const buttons = new Map();
  const pendingRefreshStates = [...refreshStates];
  const progressFrames = [];
  const globalStates = [];
  const document = {
    createElement: refreshElement,
    createTextNode: (textContent) => ({ textContent }),
  };
  const priorDashboard = {
    mode: "local",
    state: "stale",
    activity: { lastScanAt: "2026-09-02T00:00:00.000Z" },
    accounting: {
      generationMatched: detailedSnapshot,
      projection: detailedSnapshot
        ? { status: "available", reason: null, terminal: false }
        : { status: "unavailable", reason: "local_unified_index_deferred", terminal: true },
    },
    timeline: {
      history: {
        status: "complete",
        source: "unified_local_index",
        generatedAt: new Date(now).toISOString(),
      },
    },
  };
  const context = createContext({
    Date: class extends Date { static now() { return now; } },
    dashboard: priorDashboard,
    localActionBusy: false,
    localRefreshInProgress: false,
    localRefreshCancelRequested: false,
    archiveHistoryScanActive: false,
    reindexAutoContinuations: 0,
    lastReindexProgressReceipt: null,
    returnRefreshScheduled: false,
    returnRefreshDeferrals: 0,
    electronStartupRefreshTriggered: false,
    electronStartupRefreshDeferred: false,
    activeLocalDashboardLoad: null,
    globalState: { state: "stale", companionReachable: true },
    refreshResultNotice: null,
    lastRefreshResultReceipt: null,
    PUBLIC_QUOTA_REFRESH_ERROR_CODES: new Set([
      "app_server_unavailable",
      "malformed_output",
      "temporary_disconnect",
      "collection_failed",
    ]),
    electronRefreshLifecycleState: null,
    tibotattleDesktop: bridge,
    createElectronRefreshLease: (options) => createElectronRefreshLease({
      ...options,
      heartbeatIntervalMs: 60_000,
      signalTimeoutMs: 1,
    }),
    document,
    ...createDomHelpers(document),
    $: (selector) => {
      if (!buttons.has(selector)) {
        const button = refreshElement();
        const replaceChildren = button.replaceChildren;
        button.replaceChildren = function (...children) {
          replaceChildren.call(this, ...children);
          if (selector === "#refresh-button") progressFrames.push({
            slots: children.map((child) => child.textContent),
            description: this.getAttribute("aria-label"),
          });
        };
        buttons.set(selector, button);
      }
      return buttons.get(selector);
    },
    localClient: {
      async refresh() {
        calls.push("quick");
        routes.push("/api/local/refresh/quick");
        if (rejection) throw rejection;
      },
      async recalculateDetailedAccounting() {
        calls.push("detailed");
        routes.push("/api/local/refresh");
        if (rejection) throw rejection;
      },
      async refreshStatus() {
        calls.push("status");
        return { refresh: pendingRefreshStates.shift() ?? { status: "succeeded" } };
      },
    },
    createRefreshPollingBudget: () => ({ hasTime: () => true }),
    historyProgressReceipt: () => "prior-generation",
    currentHistoryContinuationDecision: () => ({ terminalGap: false }),
    localAnalysisAllowed: () => true,
    runsInsideNativeDashboard: () => native,
    runsInsideElectronDashboard: () => electron,
    refreshAccountingStatus,
    refreshQuickResultStatus,
    observationRecency,
    historyCoverageNoticeKind,
    finite: (value, fallback = 0) => Number.isFinite(value) ? value : fallback,
    formatNumber: (value) => String(value),
    tPlural: (key, count, values = {}) => translatePlural(key, count, values, "en-US"),
    setGlobalState(state, options = {}) {
      globalStates.push({ state, ...options });
      context.globalState = { state, ...options };
    },
    setTimeout: (resolve) => resolve(),
    clearTimeout() {},
    window: {
      setTimeout: (callback) => timers.push(callback),
      clearTimeout() {},
    },
    showConnectionNotice: (notice) => notices.push(notice),
    refreshNeedsContinuation: () => false,
    scheduleReindexAutoContinuation: () => calls.push("continuation-check"),
    loadLocalDashboard: async () => calls.push("reload"),
    describeFailure: async () => { calls.push("diagnostic"); return { text: "An update could not be started." }; },
    setLocalizedText(element, key) {
      element.textContent = translate(key, {}, "en-US");
    },
    t: (key, values = {}) => translate(key, values, "en-US"),
  });
  for (const name of [
    "localAnalysisMessageKey",
    "renderRefreshProgress",
    "startRefreshProgressClock",
    "updateLocalActionButtons",
  ]) {
    runInContext(productionFunction(name), context);
  }
  runInContext(productionFunction("refreshElectronCadenceHealth"), context);
  runInContext(productionFunction("dashboardObservationPresentation"), context);
  runInContext(productionFunction("renderObservationConnectionState"), context);
  runInContext(productionFunction("quotaRefreshDisposition"), context);
  runInContext(productionFunction("quotaRefreshFailureMessage"), context);
  runInContext(productionFunction("historyRefreshFailureMessage"), context);
  runInContext(productionFunction("refreshResultReceipt"), context);
  runInContext(productionFunction("renderCurrentObservationConnectionState"), context);
  runInContext(productionFunction("publishRefreshResultNotice"), context);
  runInContext(productionFunction("loadLocalDashboardSecondaryState"), context);
  runInContext(productionFunction("requestRefresh"), context);
  runInContext(productionFunction("scheduleReturningUserRefresh"), context);
  return { context, calls, routes, notices, timers, buttons, priorDashboard, progressFrames, globalStates };
}

test("dynamic progress and idle actions follow the selected language", () => {
  const { context } = refreshHarness();
  let locale = "zh-Hans";
  context.setLocalizedText = (element, key, values = {}) => {
    element.textContent = translate(key, values, locale);
  };
  context.t = (key, values = {}) => translate(key, values, locale);
  const button = context.$("#refresh-button");
  context.localActionBusy = true;
  context.localRefreshInProgress = true;
  for (const nextLocale of ["zh-Hans", "en-US", "es", "zh-Hans"]) {
    locale = nextLocale;
    context.renderRefreshProgress(button, "Analyzing files…", {
      processed: 9, selected: 100, elapsedSeconds: 60,
    });
    const phase = translate("refresh.progress.files", {}, locale);
    assert.deepEqual(button.children.map(child => child.textContent), [phase, "9/100", "1:00"]);
    assert.equal(button.getAttribute("aria-label"), `${phase} · 9/100 · 1:00`);
  }
  context.localActionBusy = false;
  context.localRefreshInProgress = false;
  context.updateLocalActionButtons();
  assert.match(button.textContent, /[\u4e00-\u9fff]/u);
  assert.equal(button.getAttribute("aria-label"), null);
});

test("refresh progress reserves distinct count and timer slots and clears them when idle", () => {
  const harness = refreshHarness();
  const button = harness.context.$("#refresh-button");
  harness.context.localActionBusy = true;
  harness.context.localRefreshInProgress = true;
  harness.context.renderRefreshProgress(button, "Starting detailed accounting…");
  assert.deepEqual(button.children.map((child) => child.textContent), [
    "Starting detailed accounting…", "", "",
  ]);
  for (const [processed, seconds, expectedTime] of [[9, 59, "0:59"], [10, 60, "1:00"]]) {
    harness.context.renderRefreshProgress(button, "Analyzing files…", {
      processed, selected: 100, elapsedSeconds: seconds,
    });
    assert.deepEqual(button.children.map((child) => child.className), [
      "refresh-progress-phase", "refresh-progress-count", "refresh-progress-time",
    ]);
    assert.deepEqual(button.children.map((child) => child.textContent), [
      "Analyzing files…", `${processed}/100`, expectedTime,
    ]);
    assert.equal(button.children[1].children[0].style.minWidth, "3ch");
    assert.equal(button.getAttribute("aria-label"), `Analyzing files… · ${processed}/100 · ${expectedTime}`);
    assert.equal(button.title, button.getAttribute("aria-label"));
  }
  assert.equal(button.classList.contains("refresh-progress"), true);
  harness.context.localActionBusy = false;
  harness.context.localRefreshInProgress = false;
  harness.context.updateLocalActionButtons();
  assert.equal(button.classList.contains("refresh-progress"), false);
  assert.equal(button.getAttribute("aria-label"), null);
  assert.equal(button.getAttribute("title"), null);
  assert.equal(button.textContent, "Update local usage");
  assert.equal(harness.context.$("#cancel-refresh").hidden, true);
});

test("refresh elapsed clock follows wall-second boundaries independently of status polling", () => {
  const harness = refreshHarness();
  const button = harness.context.$("#refresh-button");
  const scheduled = [];
  const cancelled = [];
  let nowMs = 0;
  let nextTimer = 0;
  const clock = harness.context.startRefreshProgressClock(button, "Analyzing files…", {
    processed: 1,
    selected: 100,
    startedAtMs: 0,
    now: () => nowMs,
    schedule(callback, delayMs) {
      const timer = ++nextTimer;
      scheduled.push({ timer, callback, delayMs });
      return timer;
    },
    cancel: (timer) => cancelled.push(timer),
  });

  assert.deepEqual(button.children.map((child) => child.textContent), [
    "Analyzing files…", "1/100", "0:00",
  ]);
  assert.equal(scheduled[0].delayMs, 1_000);

  // A companion poll at 750 ms may change the count, but it cannot advance or
  // stall the elapsed clock; the timer still targets the one-second boundary.
  nowMs = 750;
  clock.update("Analyzing files…", { processed: 2, selected: 100 });
  assert.equal(button.children[2].textContent, "0:00");
  assert.equal(scheduled.length, 1);

  nowMs = 1_000;
  scheduled.shift().callback();
  assert.equal(button.children[2].textContent, "0:01");
  assert.equal(scheduled[0].delayMs, 1_000);

  // If the renderer is busy, use real elapsed time and shorten the following
  // delay so that callback latency is not accumulated into a repeating beat.
  nowMs = 3_750;
  scheduled.shift().callback();
  assert.equal(button.children[2].textContent, "0:03");
  assert.equal(scheduled[0].delayMs, 250);
  nowMs = 4_000;
  scheduled.shift().callback();
  assert.equal(button.children[2].textContent, "0:04");

  clock.reset("Continuing local analysis…");
  assert.equal(button.children[2].textContent, "0:00");
  assert.equal(cancelled.length, 1);
  clock.stop();
  assert.equal(cancelled.length, 2);
});

test("an active refresh keeps its progress affordance and cancellation action after a load lock is released", () => {
  const harness = refreshHarness();
  const button = harness.context.$("#refresh-button");
  button.textContent = "Update local usage";
  harness.context.localActionBusy = false;
  harness.context.localRefreshInProgress = true;

  harness.context.updateLocalActionButtons();

  assert.equal(button.disabled, true, "the refresh action remains locked while active");
  assert.equal(button.classList.contains("refresh-progress"), true);
  assert.equal(button.textContent, "Update running…");
  const cancel = harness.context.$("#cancel-refresh");
  assert.equal(cancel.hidden, false, "Cancel remains available for the active refresh");
  assert.equal(cancel.disabled, false);
  assert.equal(cancel.textContent, "Cancel");
});

test("a terminal refresh restores the last dashboard status after showing Running", async () => {
  const harness = refreshHarness();

  await harness.context.requestRefresh({ detailed: true });

  assert.deepEqual(harness.globalStates, [
    { state: "updating" },
    { state: "stale", companionReachable: true },
  ]);
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.context.localRefreshInProgress, false);
  assert.equal(harness.context.$("#refresh-button").textContent, "Update local usage");
});

test("a terminal refresh recovers the prior stable state when the dashboard still says updating", async () => {
  const harness = refreshHarness();
  harness.context.dashboard = { ...harness.priorDashboard, state: "updating" };

  await harness.context.requestRefresh();

  assert.deepEqual(harness.globalStates.at(-1), {
    state: "stale",
    companionReachable: true,
  });
});

test("refresh polling preserves counted indexing and count-free accounting phases", async () => {
  const harness = refreshHarness({ refreshStates: [
    { status: "running", progress: {
      kind: "unified_index", status: "scanning", phase: "rollout_index",
      filesProcessed: 9, filesSelected: 100,
    } },
    { status: "running", progress: { kind: "accounting", status: "calculating" } },
  ] });
  await harness.context.requestRefresh({ detailed: true });
  const indexed = harness.progressFrames.find((frame) => frame.slots[0] === "Analyzing files…");
  const accounting = harness.progressFrames.find((frame) => frame.slots[0] === "Calculating accounting…");
  assert.ok(indexed, "the indexed-file progress reaches the production renderer");
  assert.equal(indexed.slots[1], "9/100");
  assert.match(indexed.slots[2], /^\d+:\d{2}$/u);
  assert.ok(accounting, "accounting remains a distinct work phase");
  assert.equal(accounting.slots[1], "", "accounting cannot inherit an earlier source count");
  assert.match(accounting.slots[2], /^\d+:\d{2}$/u);
  assert.equal(accounting.description, `Calculating accounting… · ${accounting.slots[2]}`);
  assert.deepEqual(harness.calls, ["detailed", "status", "status", "status", "reload", "continuation-check"]);
  assert.deepEqual(harness.notices, []);
});

test("quota refresh failures and no-new observations remain explicit over stale observation ticks", () => {
  const harness = refreshHarness();
  const checked = {
    refreshId: "refresh-checked",
    status: "succeeded",
    result: { quotaRefresh: { attempted: true, recordWritten: false, errorCode: null } },
  };

  harness.context.publishRefreshResultNotice(checked);
  assert.equal(harness.context.refreshResultNotice.titleKey, "refresh.quota.checkedTitle");
  assert.equal(harness.notices.at(-1).copyKey, "refresh.quota.noNewCopy");
  const noticeCount = harness.notices.length;

  harness.context.renderObservationConnectionState(
    { mode: "local", state: "stale" },
    { status: "stale" },
  );
  assert.equal(harness.notices.length, noticeCount + 1);
  assert.equal(harness.notices.at(-1).titleKey, "refresh.quota.checkedTitle",
    "the generic stale timer restores the completed quota result");

  harness.context.publishRefreshResultNotice({
    refreshId: "refresh-failed",
    status: "succeeded",
    result: { quotaRefresh: { attempted: true, recordWritten: false, errorCode: "app_server_unavailable" } },
  });
  assert.equal(harness.context.refreshResultNotice.titleKey, "refresh.quota.failureTitle");
  assert.equal(harness.notices.at(-1).kind, "warning");
  assert.equal(harness.notices.at(-1).copyKey, "refresh.quota.appServerUnavailableCopy");

  harness.context.publishRefreshResultNotice({
    refreshId: "refresh-recovered",
    status: "succeeded",
    result: { quotaRefresh: { attempted: true, recordWritten: true, errorCode: null } },
  });
  assert.equal(harness.context.refreshResultNotice, null,
    "a written quota observation clears the prior quota failure");
});

test("degraded history and quota failures are combined in one persistent notice", async () => {
  const harness = refreshHarness({ refreshStates: [{
    refreshId: "refresh-degraded-quota",
    status: "degraded",
    errorCode: "refresh_degraded",
    failureCode: "unified_index",
    result: {
      unifiedIndex: { generation: { skippedSourceCount: 1, skippedThreadCount: 1 } },
      quotaRefresh: { attempted: true, recordWritten: false, errorCode: "app_server_unavailable" },
    },
  }] });

  await harness.context.requestRefresh();

  const notice = harness.notices.at(-1);
  assert.equal(notice.titleKey, "refresh.degradedQuotaFailureTitle");
  assert.match(notice.copy, /left out 1 rollout source across 1 affected thread/u);
  assert.match(notice.copy, /could not start the Codex CLI/u);
  assert.equal(harness.context.refreshResultNotice, notice,
    "a later generic stale render cannot replace the combined result");
});

test("dashboard reload reads the latest quota result from refresh status", async () => {
  const harness = refreshHarness();
  harness.context.localClient.health = async () => ({ status: "ready" });
  harness.context.localClient.onboarding = async () => ({ ready: true });
  harness.context.localClient.refreshStatus = async () => ({ refresh: {
    refreshId: "native-refresh",
    status: "succeeded",
    result: { quotaRefresh: { attempted: true, recordWritten: false, errorCode: "temporary_disconnect" } },
  } });
  for (const name of [
    "renderLocalOnboarding",
    "renderAccounting",
    "startElectronStartupRefresh",
    "scheduleReturningUserRefresh",
    "scheduleLocalReadinessPoll",
  ]) harness.context[name] = () => {};

  await harness.context.loadLocalDashboardSecondaryState({ isCurrent: () => true });

  assert.equal(harness.context.refreshResultNotice.titleKey, "refresh.quota.failureTitle");
  assert.equal(harness.notices.at(-1).copyKey, "refresh.quota.failureCodeCopy");
  assert.equal(harness.notices.at(-1).copyValues.code, "temporary_disconnect");
});

test("history publication failures explain the fixed cause in every language and keep quota failures visible", () => {
  const codes = [
    ["local_unified_index_publication_busy", "refresh.history.publicationBusyCopy"],
    ["local_unified_index_publication_timed_out", "refresh.history.publicationTimedOutCopy"],
    ["local_unified_index_publication_failed", "refresh.history.publicationFailedCopy"],
  ];
  for (const locale of SUPPORTED_LOCALES) {
    for (const [code, copyKey] of codes) {
      const harness = refreshHarness();
      harness.context.t = (key, values = {}) => translate(key, values, locale);
      harness.context.publishRefreshResultNotice({
        refreshId: "refresh-publication-failure",
        status: "degraded",
        failedStep: "unified_index",
        failureCode: code,
        result: {
          unifiedIndex: { status: "failed", errorCode: code },
          quotaRefresh: { attempted: true, recordWritten: false, errorCode: "app_server_unavailable" },
        },
      });
      const notice = harness.notices.at(-1);
      assert.equal(notice.titleKey, "refresh.degradedQuotaFailureTitle");
      assert.equal(notice.kind, "error");
      assert.equal(notice.copy, `${translate(copyKey, { code }, locale)} ${translate("refresh.quota.appServerUnavailableCopy", {}, locale)}`);
      assert.ok(notice.copy.includes(code), locale);
      assert.equal(harness.calls.includes("continuation-check"), false,
        "presenting a failure does not change the retry policy");
      harness.context.renderObservationConnectionState({ mode: "local", state: "stale" }, { status: "stale" });
      assert.equal(harness.notices.at(-1), notice, "a stale tick preserves the specific history error");
    }
  }
});

test("source changes explain that no new history index was published", () => {
  const code = "codex_rollout_source_changed";
  for (const locale of SUPPORTED_LOCALES) {
    const harness = refreshHarness();
    harness.context.t = (key, values = {}) => translate(key, values, locale);
    harness.context.publishRefreshResultNotice({
      refreshId: "refresh-source-changed",
      status: "degraded",
      result: { unifiedIndex: { status: "failed", errorCode: code } },
    });
    const notice = harness.notices.at(-1);
    assert.equal(notice.titleKey, "refresh.degradedTitle");
    assert.equal(notice.copy, translate("refresh.history.sourceChangedCopy", { code }, locale));
    assert.match(notice.copy, /not published|未发布|no se publicó/u);
  }
});

test("partial source coverage is unchanged and cannot be mislabeled as a publication failure", () => {
  const harness = refreshHarness();
  harness.context.publishRefreshResultNotice({
    refreshId: "refresh-partial-source",
    status: "degraded",
    failureCode: "local_unified_index_publication_timed_out",
    result: { unifiedIndex: { status: "partial", generation: { skippedSourceCount: 1, skippedThreadCount: 1 } } },
  });
  const notice = harness.notices.at(-1);
  assert.match(notice.copy, /left out 1 rollout source across 1 affected thread/u);
  assert.equal(notice.copy.includes("within the time limit"), false);
});

test("quota failure messages explain a missing Codex CLI and expose only fixed error codes", () => {
  const harness = refreshHarness();
  harness.context.publishRefreshResultNotice({
    refreshId: "refresh-cli-unavailable",
    status: "succeeded",
    result: { quotaRefresh: { attempted: true, recordWritten: false, errorCode: "app_server_unavailable" } },
  });
  const unavailable = harness.notices.at(-1);
  assert.equal(unavailable.titleKey, "refresh.quota.failureTitle");
  assert.equal(unavailable.copyKey, "refresh.quota.appServerUnavailableCopy");
  for (const locale of SUPPORTED_LOCALES) {
    const title = translate(unavailable.titleKey, {}, locale);
    const copy = translate(unavailable.copyKey, {}, locale);
    assert.match(title, /quota|额度|cuota/iu, locale);
    assert.match(copy, /CODEX_BIN/u, locale);
    assert.match(copy, /TiboTattle/u, locale);
    assert.match(copy, /Codex CLI/u, locale);
    assert.match(copy, /restart|重启|reinicia/iu, locale);
  }

  harness.context.publishRefreshResultNotice({
    refreshId: "refresh-malformed-output",
    status: "succeeded",
    result: { quotaRefresh: { attempted: true, recordWritten: false, errorCode: "malformed_output" } },
  });
  const fixedCode = harness.notices.at(-1);
  assert.equal(fixedCode.copyKey, "refresh.quota.failureCodeCopy");
  assert.equal(fixedCode.copyValues.code, "malformed_output");
  for (const locale of SUPPORTED_LOCALES) {
    const copy = translate(fixedCode.copyKey, fixedCode.copyValues, locale);
    assert.ok(copy.includes("malformed_output"), locale);
    assert.equal(copy.includes("private_detail_untrusted"), false, locale);
  }

  harness.context.publishRefreshResultNotice({
    refreshId: "refresh-untrusted-code",
    status: "succeeded",
    result: { quotaRefresh: { attempted: true, recordWritten: false, errorCode: "private_detail_untrusted" } },
  });
  const untrusted = harness.notices.at(-1);
  assert.equal(untrusted.copyKey, "refresh.quota.failureCopy");
  assert.equal(JSON.stringify(untrusted).includes("private_detail_untrusted"), false);
});

test("both visible manual refresh controls request detailed accounting once", async (t) => {
  for (const selector of ["#refresh-button", "#setup-refresh"]) {
    await t.test(selector, async () => {
      const harness = refreshHarness();
      const binding = source.match(new RegExp(
        `\\$\\("${selector}"\\)\\.addEventListener\\("click", \\(\\) => \\{[\\s\\S]*?\\n\\}\\);`, "u",
      ));
      assert.ok(binding, `${selector} binds explicit manual intent`);
      runInContext(binding[0], harness.context);
      // A DOM event cannot accidentally supply the quick/default options.
      harness.buttons.get(selector).click({ type: "click", detailed: false });
      await new Promise(setImmediate);
      assert.deepEqual(harness.calls, ["detailed", "status", "reload", "continuation-check"]);
      assert.deepEqual(harness.routes, ["/api/local/refresh"]);
      assert.equal(harness.context.localActionBusy, false);
      assert.equal(harness.context.localRefreshInProgress, false);
      assert.equal(harness.context.dashboard, harness.priorDashboard,
        "refresh does not clear the last-good result while replacing evidence");
    });
  }
});

test("the shared default and automatic browser return refresh stay quick", async () => {
  const direct = refreshHarness();
  await direct.context.requestRefresh();
  assert.deepEqual(direct.calls, ["quick", "status", "reload"]);
  assert.deepEqual(direct.routes, ["/api/local/refresh/quick"]);

  const returning = refreshHarness();
  returning.context.scheduleReturningUserRefresh();
  assert.equal(returning.timers.length, 1);
  returning.timers[0]();
  await new Promise(setImmediate);
  assert.deepEqual(returning.calls, ["quick", "status", "reload"]);
  assert.deepEqual(returning.routes, ["/api/local/refresh/quick"]);

  const native = refreshHarness({ native: true });
  native.context.scheduleReturningUserRefresh();
  assert.deepEqual(native.timers, [], "the native host retains sole cadence ownership");
  assert.deepEqual(native.calls, []);
});

test("Electron automatic refresh events honor the host-selected mode", async () => {
  const quick = refreshHarness({ electron: true });
  runInContext(productionFunction("handleElectronAutomaticRefresh"), quick.context);
  runInContext(
    "handleElectronAutomaticRefresh({ detail: { mode: 'quick' } });",
    quick.context,
  );
  await new Promise(setImmediate);
  assert.deepEqual(quick.routes, ["/api/local/refresh/quick"]);

  const detailed = refreshHarness({ electron: true });
  runInContext(productionFunction("handleElectronAutomaticRefresh"), detailed.context);
  runInContext(
    "handleElectronAutomaticRefresh({ detail: { mode: 'detailed' } });",
    detailed.context,
  );
  await new Promise(setImmediate);
  assert.deepEqual(detailed.routes, ["/api/local/refresh"]);

  const ignored = refreshHarness({ electron: true });
  runInContext(productionFunction("handleElectronAutomaticRefresh"), ignored.context);
  for (const expression of [
    "handleElectronAutomaticRefresh({ detail: { mode: 'quick', extra: true } });",
    "handleElectronAutomaticRefresh({ detail: { mode: 'background' } });",
    "handleElectronAutomaticRefresh({ detail: ['quick'] });",
  ]) {
    runInContext(expression, ignored.context);
  }
  await new Promise(setImmediate);
  assert.deepEqual(ignored.calls, []);
});

test("Electron startup performs one guarded detailed refresh without a trusted projection", async () => {
  const harness = refreshHarness({ electron: true });
  runInContext(productionFunction("startElectronStartupRefresh"), harness.context);

  assert.equal(harness.context.startElectronStartupRefresh(), true);
  assert.equal(harness.context.electronStartupRefreshTriggered, true);
  assert.equal(harness.context.startElectronStartupRefresh(), false);
  await new Promise(setImmediate);

  assert.deepEqual(harness.calls, ["detailed", "status", "reload", "continuation-check"]);
  assert.deepEqual(harness.routes, ["/api/local/refresh"]);
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.context.localRefreshInProgress, false);
});

test("Electron startup stays quick when a trusted detailed projection is present", async () => {
  const harness = refreshHarness({ electron: true, detailedSnapshot: true });
  runInContext(productionFunction("startElectronStartupRefresh"), harness.context);

  assert.equal(harness.context.startElectronStartupRefresh(), true);
  await new Promise(setImmediate);

  assert.deepEqual(harness.calls, ["quick", "status", "reload"]);
  assert.deepEqual(harness.routes, ["/api/local/refresh/quick"]);
});

test("Electron startup only trusts recent unified publication evidence", async (t) => {
  const now = Date.parse("2026-09-22T12:00:00.000Z");
  const interval = DESKTOP_AUTOMATIC_REFRESH_CADENCE_INTERVAL_MS;
  for (const [name, edit, expected] of [
    ["just under hourly cadence", (data) => {
      data.timeline.history.generatedAt = new Date(now - interval + 1).toISOString();
    }, "quick"],
    ["at hourly cadence", (data) => {
      data.timeline.history.generatedAt = new Date(now - interval).toISOString();
    }, "detailed"],
    ["stale despite fresh quota and accounting", (data) => {
      data.timeline.history.generatedAt = new Date(now - 3 * interval).toISOString();
      data.generatedAt = data.accounting.generatedAt = data.activity.lastScanAt = new Date(now).toISOString();
    }, "detailed"],
    ["missing publication", (data) => { delete data.timeline.history.generatedAt; }, "detailed"],
    ["null publication", (data) => { data.timeline.history.generatedAt = null; }, "detailed"],
    ["malformed publication", (data) => { data.timeline.history.generatedAt = "invalid"; }, "detailed"],
    ["noncanonical publication", (data) => { data.timeline.history.generatedAt = "2026-09-22"; }, "detailed"],
    ["future publication", (data) => {
      data.timeline.history.generatedAt = new Date(now + 1).toISOString();
    }, "detailed"],
    ["unavailable projection", (data) => { data.accounting.projection.status = "unavailable"; }, "detailed"],
    ["mismatched generation", (data) => { data.accounting.generationMatched = false; }, "detailed"],
    ["collector timeline", (data) => { data.timeline.history.source = "recent_collector_window"; }, "detailed"],
    ["loading history", (data) => { data.timeline.history.status = "loading"; }, "detailed"],
    ["available partial history", (data) => { data.timeline.history.status = "partial"; }, "quick"],
  ]) {
    await t.test(name, async () => {
      const harness = refreshHarness({ electron: true, detailedSnapshot: true, now });
      edit(harness.priorDashboard);
      runInContext(productionFunction("startElectronStartupRefresh"), harness.context);
      assert.equal(harness.context.startElectronStartupRefresh(), true);
      assert.equal(harness.context.startElectronStartupRefresh(), false);
      await new Promise(setImmediate);
      assert.equal(harness.calls[0], expected);
      assert.equal(harness.routes.length, 1);
    });
  }
});

test("short Electron relaunches eventually ingest old history without resetting its freshness", async () => {
  const publishedMs = Date.parse("2026-09-22T12:00:00.000Z");
  const interval = DESKTOP_AUTOMATIC_REFRESH_CADENCE_INTERVAL_MS;
  for (const [age, expected] of [
    [interval / 2, "quick"],
    [interval - 1, "quick"],
    [interval, "detailed"],
    [interval + 1, "detailed"],
  ]) {
    const harness = refreshHarness({ electron: true, detailedSnapshot: true, now: publishedMs + age });
    harness.priorDashboard.timeline.history.generatedAt = new Date(publishedMs).toISOString();
    runInContext(productionFunction("startElectronStartupRefresh"), harness.context);
    harness.context.startElectronStartupRefresh();
    await new Promise(setImmediate);
    assert.equal(harness.calls[0], expected);
    assert.equal(harness.priorDashboard.timeline.history.generatedAt, new Date(publishedMs).toISOString(),
      "starting or completing a renderer refresh cannot manufacture a publication timestamp");
  }
});

test("Electron startup evaluates publication evidence after its barrier clears", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = refreshHarness({ electron: true, detailedSnapshot: true });
  harness.context.__TIBOTATTLE_ELECTRON_MACOS_SMOKE__ = {
    version: "v1",
    waitForStartupRefresh: () => gate,
  };
  runInContext(productionFunction("startElectronStartupRefresh"), harness.context);
  harness.context.startElectronStartupRefresh();
  await new Promise(setImmediate);
  assert.deepEqual(harness.calls, []);
  harness.priorDashboard.timeline.history.generatedAt = null;
  release();
  await new Promise(setImmediate);
  assert.equal(harness.calls[0], "detailed");
  assert.equal(harness.routes.length, 1);
});

test("qualified Electron startup waits for the preload smoke barrier", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = refreshHarness({ electron: true });
  harness.context.__TIBOTATTLE_ELECTRON_MACOS_SMOKE__ = {
    version: "v1",
    waitForStartupRefresh: () => gate,
  };
  runInContext(productionFunction("startElectronStartupRefresh"), harness.context);

  assert.equal(harness.context.startElectronStartupRefresh(), true);
  await new Promise(setImmediate);
  assert.deepEqual(harness.calls, [], "the renderer waits for qualified observation");

  release();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(harness.calls, ["detailed", "status", "reload", "continuation-check"]);
  assert.deepEqual(harness.routes, ["/api/local/refresh"]);
});

test("qualified Electron startup deferred by the initial dashboard lock runs once it clears", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = refreshHarness({ electron: true });
  harness.context.__TIBOTATTLE_ELECTRON_MACOS_SMOKE__ = {
    version: "v1",
    waitForStartupRefresh: () => gate,
  };
  runInContext(productionFunction("startElectronStartupRefresh"), harness.context);

  harness.context.localActionBusy = true;
  harness.context.activeLocalDashboardLoad = { pending: true };
  assert.equal(harness.context.startElectronStartupRefresh(), true);
  release();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(harness.calls, [], "the lock cannot consume the one startup pass");
  assert.equal(harness.context.electronStartupRefreshTriggered, false);
  assert.equal(harness.context.electronStartupRefreshDeferred, true);

  harness.context.localActionBusy = false;
  harness.context.electronStartupRefreshDeferred = false;
  assert.equal(harness.context.startElectronStartupRefresh(), true);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(harness.routes, ["/api/local/refresh"]);
  assert.equal(harness.context.electronStartupRefreshTriggered, true);

  const startupFinalizer = source.match(/localActionBusy = load\.previousBusy;\n\s*updateLocalActionButtons\(\);\n\s*if \(electronStartupRefreshDeferred\) \{\n\s*electronStartupRefreshDeferred = false;\n\s*startElectronStartupRefresh\(\);/u);
  assert.ok(startupFinalizer,
    "the real dashboard owner retries the deferred launch pass after releasing its lock");
});

test("a non-bootstrap busy owner keeps Electron's existing one-shot suppression", async () => {
  const harness = refreshHarness({ electron: true });
  harness.context.localActionBusy = true;
  runInContext(productionFunction("startElectronStartupRefresh"), harness.context);

  assert.equal(harness.context.startElectronStartupRefresh(), true);
  await new Promise(setImmediate);
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.context.electronStartupRefreshTriggered, true);
  assert.equal(harness.context.electronStartupRefreshDeferred, false);
});

test("a deferred Electron startup pass suppresses the browser return timer", () => {
  const harness = refreshHarness({ electron: true });
  harness.context.electronStartupRefreshDeferred = true;
  harness.context.scheduleReturningUserRefresh();
  assert.deepEqual(harness.timers, []);
});

test("accepted Electron refreshes acquire and settle the main-process lease", async () => {
  const lifecycle = [];
  const harness = refreshHarness({
    electron: true,
    bridge: {
      refreshStarted(mode) {
        lifecycle.push(["started", mode]);
        return 41;
      },
      refreshHeartbeat() {
        lifecycle.push("heartbeat");
        return true;
      },
      refreshSettled(lease) {
        assert.equal(Number.isSafeInteger(lease), true,
          "the renderer must pass the numeric lease accepted by the preload bridge");
        lifecycle.push(["settled", lease]);
        return true;
      },
    },
  });

  await harness.context.requestRefresh();
  await new Promise(setImmediate);

  assert.deepEqual(harness.calls, ["quick", "status", "reload"]);
  assert.deepEqual(lifecycle, [["started", "quick"], ["settled", 41]]);
});

test("a stranded main-process lease is visible until cadence recovery is armed", async () => {
  let status = {
    schemaVersion: "tibotattle-desktop-refresh-status-v1",
    activeLease: true,
    cadenceTimerArmed: false,
  };
  const harness = refreshHarness({
    electron: true,
    bridge: {
      getRefreshStatus: async () => status,
    },
  });
  await harness.context.refreshElectronCadenceHealth();
  const health = harness.context.$("#automatic-refresh-health");
  assert.equal(health.hidden, false);
  assert.match(health.textContent, /waiting for safety recovery/u);

  status = { ...status, activeLease: false, cadenceTimerArmed: true };
  await harness.context.refreshElectronCadenceHealth();
  assert.equal(health.hidden, true);
});

test("a late Electron lease is settled with the preload's numeric contract", async () => {
  let releaseLease;
  const started = new Promise((resolve) => { releaseLease = resolve; });
  const settled = [];
  const harness = refreshHarness({
    electron: true,
    bridge: {
      refreshStarted: (mode) => {
        assert.equal(mode, "quick");
        return started;
      },
      refreshHeartbeat: () => true,
      refreshSettled(lease) {
        assert.equal(Number.isSafeInteger(lease), true);
        settled.push(lease);
        return true;
      },
    },
  });

  await harness.context.requestRefresh();
  assert.deepEqual(settled, []);
  releaseLease(73);
  await new Promise(setImmediate);

  assert.deepEqual(settled, [73]);
});

test("an initial controller conflict is informational and cannot queue detailed work", async () => {
  const harness = refreshHarness({ rejection: { status: 409 } });
  await harness.context.requestRefresh({ detailed: true });
  assert.deepEqual(harness.calls, ["detailed"],
    "the rejected request does not post again, escalate, or claim a detailed completion");
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].kind, "info");
  assert.match(harness.notices[0].copy, /did not start another update/u);
  assert.match(harness.notices[0].copy, /choose Refresh again if detailed accounting still needs updating/u);
  assert.equal(harness.context.dashboard, harness.priorDashboard);
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.context.localRefreshInProgress, false);
});

test("a non-conflict request failure remains a failure and a busy page makes no request", async () => {
  const failed = refreshHarness({ rejection: { status: 503 } });
  await failed.context.requestRefresh({ detailed: true });
  assert.deepEqual(failed.calls, ["detailed", "diagnostic"]);
  assert.equal(failed.notices[0].kind, "error");
  assert.equal(failed.context.localActionBusy, false);

  const busy = refreshHarness();
  busy.context.localActionBusy = true;
  await busy.context.requestRefresh({ detailed: true });
  assert.deepEqual(busy.calls, []);
  assert.equal(busy.context.localActionBusy, true, "another action's busy state is preserved");
});

test("already-running guidance is translated and the duplicate action copy is retired", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ["refresh.alreadyRunningTitle", "refresh.alreadyRunningCopy"]) {
      const copy = translate(key, {}, locale);
      assert.ok(copy.length > 0 && copy !== key, `${locale}: ${key}`);
    }
  }
  assert.doesNotMatch(source, /recalculate-detailed-accounting|refresh\.recalculateDetailed/u);
});

test("quota refresh outcome copy is localized in every shipped locale", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of [
      "refresh.quota.failureTitle",
      "refresh.quota.failureCopy",
      "refresh.quota.appServerUnavailableCopy",
      "refresh.quota.failureCodeCopy",
      "refresh.quota.checkedTitle",
      "refresh.quota.noNewCopy",
      "refresh.degradedQuotaFailureTitle",
    ]) {
      const values = key === "refresh.quota.failureCodeCopy" ? { code: "malformed_output" } : {};
      const copy = translate(key, values, locale);
      assert.ok(copy.length > 0 && copy !== key, `${locale}: ${key}`);
    }
  }
});
