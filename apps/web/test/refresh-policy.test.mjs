import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { SUPPORTED_LOCALES, translate, translatePlural } from "../public/localization.js";
import { createRefreshPollingBudget, historyCoverageNoticeKind, refreshAccountingStatus, refreshNeedsContinuation, refreshQuickResultStatus } from "../public/lib.js";
import { observationRecency } from "../public/dashboard-ui.js";
import { LocalCompanionClient } from "../public/data-client.js";
import { LocalCompanionRefreshController } from "../../../src/local-companion-refresh.js";
import { createDomHelpers } from "../public/ui-format.js";
import { createElectronRefreshLease } from "../public/electron-refresh-lifecycle.js";
import { createLocalProgressEvents } from "../public/local-progress-events.js";

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
      remove: (...names) => names.forEach(name => classes.delete(name)),
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
  sidebar = false,
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
  let lastStreamRefresh = null;
  const document = {
    createElement: refreshElement,
    createTextNode: (textContent) => ({ textContent }),
  };
  const priorDashboard = {
    workload: detailedSnapshot ? {schemaVersion:"overview-workload-v4",status:"available"} : null,
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
    AbortController,
    Date: class extends Date { static now() { return now; } },
    dashboard: priorDashboard,
    localActionBusy: false,
    accountingRebuildDeferral: null,
    localRefreshInProgress: false,
    localRefreshPaused: false,
    localRefreshPauseReady: true,
    localRefreshSubmissionPending: false,
    localRefreshObserverActive: false,
    localRefreshStatusVersion: 0,
    lastObservedRefreshPublication: null, lastOverviewScheduleError: null,
    overviewPublicationReadPending: false,
    overviewPublicationPollingStarted: false,
    localRefreshCancelRequested: false,
    localRefreshObservationWait: null,
    sidebarRefreshSummaryTimer: null,
    sidebarRefreshSummaryVersion: 0,
    reindexAutoContinuations: 0,
    lastReindexProgressReceipt: null,
    activeLocalDashboardLoad: null,
    nativeEvidenceReloadPending: false,
    dashboardReadFailed: false,
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
    usageMonitorDesktop: bridge,
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
        if (sidebar && selector === "#refresh-button") button.setAttribute("data-sidebar-refresh", "true");
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
        calls.push("overview");
        routes.push("/api/local/refresh/overview");
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
    localProgressEvents: {
      cursor: () => 0,
      connection: () => "connected",
      current: () => lastStreamRefresh ? { refresh: lastStreamRefresh } : null,
      wait: async () => {},
    },
    createRefreshPollingBudget: () => ({ hasTime: () => true, remainingMs: () => 60_000 }),
    historyProgressReceipt: () => "prior-generation",
    currentHistoryContinuationDecision: () => ({ terminalGap: false }),
    localAnalysisAllowed: () => true,
    allowancePage: {setLoadState() {}},
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
    loadQuickResultDashboard: async () => calls.push("quick-reload"),
    describeFailure: async () => { calls.push("diagnostic"); return { text: "An update could not be started." }; },
    setLocalizedText(element, key) {
      element.textContent = translate(key, {}, "en-US");
    },
    setRawText(element, value) { element.textContent = value; },
    t: (key, values = {}) => translate(key, values, "en-US"),
  });
  let statusReader = context.localClient.refreshStatus;
  Object.defineProperty(context.localClient, "refreshStatus", {
    get() { return async (...args) => {
      const value = await statusReader(...args);
      lastStreamRefresh = value?.refresh ?? null;
      return value;
    }; },
    set(value) { statusReader = value; },
  });
  for (const name of [
    "localAnalysisMessageKey",
    "setSidebarRefreshSummary",
    "renderRefreshProgress",
    "startRefreshProgressClock",
    "updateLocalActionButtons",
  ]) {
    runInContext(productionFunction(name), context);
  }
  runInContext(productionFunction("refreshElectronCadenceHealth"), context);
  runInContext(productionFunction("quotaObservationRecency"), context);
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
  runInContext(productionFunction("observeOverviewPublication"), context);
  runInContext(productionFunction("handleElectronAutomaticRefresh"), context);
  return { context, calls, routes, notices, timers, buttons, priorDashboard, progressFrames, globalStates };
}

test("allowance loading follows the existing primary-read and refresh owners through failure and retry", () => {
  const { context } = refreshHarness({ sidebar: true });
  const states=[];context.allowancePage.setLoadState=state=>states.push(state);
  context.localRefreshInProgress=true;context.updateLocalActionButtons();
  context.localRefreshInProgress=false;context.dashboardReadFailed=true;context.updateLocalActionButtons();
  context.activeLocalDashboardLoad={pending:true};context.updateLocalActionButtons();
  context.activeLocalDashboardLoad=null;context.dashboardReadFailed=false;context.updateLocalActionButtons();
  assert.deepEqual(states,['loading','error','loading','ready']);
});

test("paused local refresh rejects submissions and disables refresh without blocking read-only reports", async () => {
  const { context, calls } = refreshHarness({ sidebar: true });
  context.localRefreshPaused = true;
  context.updateLocalActionButtons();
  assert.equal(context.$("#refresh-button").disabled, true);
  await context.requestRefresh();
  assert.deepEqual(calls, []);
  context.localRefreshPaused = false;
  context.updateLocalActionButtons();
  assert.equal(context.$("#refresh-button").disabled, false);
});

test("sidebar refresh keeps its icon and cancellability while showing only the phase", () => {
  const { context } = refreshHarness({ sidebar: true });
  const button = context.$("#refresh-button");
  const icon = refreshElement("svg");
  button.append(icon);
  context.localRefreshInProgress = true;
  context.localActionBusy = true;
  context.renderRefreshProgress(button, "Scanning local history…", { processed: 9, selected: 100, elapsedSeconds: 12 });
  context.updateLocalActionButtons();
  assert.equal(button.children[0], icon);
  assert.equal(button.classList.contains("is-refreshing"), true);
  assert.equal(button.disabled, false, "the same icon must remain available for safe cancellation");
  assert.equal(context.$("#sidebar-refresh-summary").textContent, "Scanning local history…");
  assert.equal(context.$("#cancel-refresh").hidden, true, "there is no duplicate cancel button");
  context.localRefreshCancelRequested = true;
  context.updateLocalActionButtons();
  assert.equal(button.disabled, true, "only one cancellation request is sent");
});

test("sidebar success clears after 3000ms and stale timers cannot clear a later refresh", async () => {
  const { context } = refreshHarness({ sidebar: true });
  const scheduled = [];
  context.window.setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; };
  await context.requestRefresh();
  const summary = context.$("#sidebar-refresh-summary");
  assert.equal(summary.textContent, "Update complete");
  assert.equal(summary.hidden, false);
  assert.equal(context.$("#refresh-button").classList.contains("is-refreshing"), false);
  const successTimer = scheduled.at(-1);
  assert.equal(successTimer.delay, 3_000);
  context.renderRefreshProgress(context.$("#refresh-button"), "Scanning local history…");
  successTimer.callback();
  assert.equal(summary.textContent, "Scanning local history…");
  assert.equal(summary.hidden, false);
  context.setSidebarRefreshSummary("refresh.sidebar.succeeded", { success: true });
  scheduled.at(-1).callback();
  assert.equal(summary.textContent, "");
  assert.equal(summary.hidden, true);
});

test("sidebar refresh never claims success after failure, cancellation, degradation or a failed reload", async () => {
  for (const [refreshState, expected] of [
    [{ status: "failed" }, "Refresh failed"],
    [{ status: "cancelled" }, "Refresh cancelled"],
    [{ status: "degraded" }, "Refresh incomplete"],
  ]) {
    const { context } = refreshHarness({ sidebar: true, refreshStates: [refreshState] });
    await context.requestRefresh();
    assert.equal(context.$("#sidebar-refresh-summary").textContent, expected);
    assert.equal(context.$("#sidebar-refresh-summary").hidden, false);
  }
  const { context } = refreshHarness({ sidebar: true });
  context.loadLocalDashboard = async () => false;
  await context.requestRefresh();
  assert.equal(context.$("#sidebar-refresh-summary").textContent, "Refresh failed");
});

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
  harness.context.renderRefreshProgress(button, "Starting detailed analysis…");
  assert.deepEqual(button.children.map((child) => child.textContent), [
    "Starting detailed analysis…", "", "",
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
  assert.equal(button.textContent, "Reading local data");
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

test("refresh events preserve counted indexing and count-free accounting phases", async () => {
  const harness = refreshHarness({ refreshStates: [
    { status: "running", progress: {
      kind: "unified_index", status: "scanning", phase: "rollout_index",
      filesProcessed: 9, filesSelected: 100,
    } },
    { status: "running", progress: { kind: "accounting", status: "calculating" } },
  ] });
  await harness.context.requestRefresh({ detailed: true });
  const indexed = harness.progressFrames.find((frame) => frame.slots[0] === "Reading local data" && frame.slots[1] === "9/100");
  const accounting = harness.progressFrames.find((frame) => frame.slots[0] === "Preparing usage statistics");
  assert.ok(indexed, "the indexed-file progress reaches the production renderer");
  assert.equal(indexed.slots[1], "9/100");
  assert.match(indexed.slots[2], /^\d+:\d{2}$/u);
  assert.ok(accounting, "accounting remains a distinct work phase");
  assert.equal(accounting.slots[1], "", "accounting cannot inherit an earlier source count");
  assert.match(accounting.slots[2], /^\d+:\d{2}$/u);
  assert.equal(accounting.description, `Preparing usage statistics · ${accounting.slots[2]}`);
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
  assert.match(noticeCopy(harness, notice), /left out 1 rollout source across 1 affected thread/u);
  assert.match(noticeCopy(harness, notice), /couldn't start the Codex CLI/u);
  assert.equal(harness.context.refreshResultNotice, notice,
    "a later generic stale render cannot replace the combined result");
});

test("dashboard reload reads the latest quota result from refresh status", async () => {
  const harness = refreshHarness();
  harness.context.localProgressEvents.connection = () => "unavailable";
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
      assert.equal(notice.titleKey, "refresh.usageQuotaFailureTitle");
      assert.equal(notice.kind, "error");
      assert.equal(noticeCopy(harness, notice), `${translate(copyKey, { code }, locale)} ${translate("refresh.quota.appServerUnavailableCopy", {}, locale)}`);
      assert.ok(noticeCopy(harness, notice).includes(code), locale);
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
    assert.equal(notice.titleKey, "refresh.usageFailureTitle");
    assert.equal(noticeCopy(harness, notice), translate("refresh.history.sourceChangedCopy", { code }, locale));
    assert.match(noticeCopy(harness, notice), /not published|未发布|no se publicó/u);
  }
});

test("usage failures cannot claim completion, mask accounting failure or claim retries stopped", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const [failedStep, result, copyKey] of [
      ['unified_index', { unifiedIndex: { status: 'failed', errorCode: 'codex_response_usage_legacy_conflict' } }, 'refresh.history.usageEvidenceCopy'],
      ['unified_index', { unifiedIndex: { status: 'failed' } }, 'refresh.degradedGenericCopy'],
      ['unified_index', { unifiedIndex: { status: 'failed', generation: { skippedSourceCount: 2 } } }, 'refresh.degradedGenericCopy'],
      ['accounting', { accounting: { status: 'unavailable' } }, 'refresh.accounting.failureCopy'],
    ]) {
      const harness = refreshHarness();
      harness.context.t = (key, values = {}) => translate(key, values, locale);
      const failureCode = result.unifiedIndex?.errorCode ?? 'accounting_unified_read_failed';
      harness.context.publishRefreshResultNotice({ status: 'degraded', failedStep, failureCode, result });
      const notice = harness.notices.at(-1);
      assert.equal(notice.titleKey, 'refresh.usageFailureTitle');
      assert.equal(notice.kind, 'error');
      assert.equal(noticeCopy(harness, notice), translate(copyKey, { code: failureCode }, locale));
      assert.doesNotMatch(noticeCopy(harness, notice), /retries have stopped|停止自动重试|se han detenido/u);
      assert.match(noticeCopy(harness, notice), /refresh settings|刷新设置|ajustes/u);
    }
  }
});

test("quota-only degradation cannot invent a history failure or limited coverage", () => {
  const harness = refreshHarness();
  harness.context.publishRefreshResultNotice({ status: 'degraded', failedStep: 'collector', result: {
    quotaRefresh: { attempted: true, recordWritten: false, errorCode: 'app_server_unavailable' },
  } });
  const notice = harness.notices.at(-1);
  assert.equal(notice.titleKey, 'refresh.quota.failureTitle');
  assert.equal(noticeCopy(harness, notice), translate('refresh.quota.appServerUnavailableCopy'));
});

test("partial source coverage is unchanged and cannot be mislabeled as a publication failure", () => {
  const harness = refreshHarness();
  harness.context.publishRefreshResultNotice({
    refreshId: "refresh-partial-source",
    status: "degraded",
    failureCode: "local_unified_index_publication_timed_out",
    failedStep: "unified_index",
    result: { unifiedIndex: { status: "ingested", generation: { status: "partial", skippedSourceCount: 1, skippedThreadCount: 1 } } },
  });
  const notice = harness.notices.at(-1);
  assert.equal(notice.titleKey, 'refresh.degradedTitle');
  assert.match(noticeCopy(harness, notice), /left out 1 rollout source across 1 affected thread/u);
  assert.equal(noticeCopy(harness, notice).includes("within the time limit"), false);
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
    assert.ok(copy.includes(translate("app.name", {}, locale)), locale);
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

test("global refresh uses the bounded overview path while setup retains explicit detailed accounting", async (t) => {
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
      assert.deepEqual(harness.calls, selector==="#refresh-button" ? ["overview","status","reload"] : ["detailed", "status", "reload", "continuation-check"]);
      assert.deepEqual(harness.routes, [selector==="#refresh-button" ? "/api/local/refresh/overview" : "/api/local/refresh"]);
      assert.equal(harness.context.localActionBusy, false);
      assert.equal(harness.context.localRefreshInProgress, false);
      assert.equal(harness.context.dashboard, harness.priorDashboard,
        "refresh does not clear the last-good result while replacing evidence");
    });
  }
});

test("ordinary refresh requests overview while the companion owns startup and return scheduling", async () => {
  const direct = refreshHarness();
  await direct.context.requestRefresh();
  assert.deepEqual(direct.calls, ["overview", "status", "reload"]);
  assert.deepEqual(direct.routes, ["/api/local/refresh/overview"]);
  assert.equal(source.includes("function startElectronStartupRefresh("), false);
  assert.equal(source.includes("function scheduleReturningUserRefresh("), false);
});

test("legacy Electron automatic events observe state without submitting work", async () => {
  const harness = refreshHarness({ electron: true });
  runInContext("handleElectronAutomaticRefresh({ detail: { mode: 'quick' } });", harness.context);
  await new Promise(setImmediate);
  assert.deepEqual(harness.calls, ["status"]);
  assert.deepEqual(harness.routes, []);
  runInContext("handleElectronAutomaticRefresh({ detail: { mode: 'quick', extra: true } });", harness.context);
  await new Promise(setImmediate);
  assert.deepEqual(harness.calls, ["status"]);
});

test("an automatically started run owns busy state and quota publication before usage completes", async () => {
  const partial = { refreshId: "refresh-auto", mode: "overview", status: "running", running: true,
    quickResultAt: "2026-10-21T00:00:00.000Z", quota: { status: "published" }, usage: { status: "running" } };
  const harness = refreshHarness({ sidebar: true, refreshStates: [
    partial,
    { ...partial, status: "succeeded", running: false, finishedAt: "2026-10-21T00:01:00.000Z", usage: { status: "succeeded" } },
  ] });
  let release;
  const loaded = new Promise(resolve => { release = resolve; });
  harness.context.loadQuickResultDashboard = async () => { harness.calls.push("quick-reload"); await loaded; };
  const observation = harness.context.observeOverviewPublication();
  await new Promise(setImmediate);
  assert.equal(harness.context.localRefreshInProgress, true);
  assert.equal(harness.buttons.get("#refresh-button").classList.contains("is-refreshing"), true);
  assert.equal(harness.buttons.get("#refresh-button").getAttribute("aria-busy"), "true");
  assert.deepEqual(harness.routes, []);
  assert.equal(harness.calls.includes("reload"), false, "partial publication cannot be announced as completed");
  await harness.context.observeOverviewPublication();
  assert.equal(harness.calls.filter(call => call === "status").length, 1, "joining does not start a second polling owner");
  release();
  await observation;
  assert.deepEqual(harness.calls, ["status", "quick-reload", "status", "reload"]);
  assert.equal(harness.context.localRefreshInProgress, false);
  await harness.context.observeOverviewPublication();
  assert.equal(harness.calls.filter(call => call === "reload").length, 1, "the final receipt is consumed once");
});

test("submission pending is not a running controller and cannot be cancelled", async () => {
  const harness = refreshHarness({ sidebar: true });
  let release;
  harness.context.localClient.refresh = () => new Promise(resolve => { release = resolve; });
  const submission = harness.context.requestRefresh();
  assert.equal(harness.context.localRefreshSubmissionPending, true);
  assert.equal(harness.context.localRefreshInProgress, false);
  assert.equal(harness.buttons.get("#refresh-button").classList.contains("is-refreshing"), false);
  assert.equal(harness.buttons.get("#refresh-button").disabled, true);
  release();
  await submission;
  assert.equal(harness.context.localRefreshSubmissionPending, false);
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

  assert.deepEqual(harness.calls, ["overview", "status", "reload"]);
  assert.deepEqual(lifecycle, [["started", "detailed"], ["settled", 41]]);
});

test("a stranded main-process lease reports connection recovery", async () => {
  let status = {
    schemaVersion: "usagemonitor-desktop-refresh-status-v1",
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
  assert.equal(health.textContent, translate("dashboard.refresh.waitingForRecovery", {}, "en-US"));

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
        assert.equal(mode, "detailed");
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
  assert.match(noticeCopy(harness, harness.notices[0]), /did not start another update/u);
  assert.match(noticeCopy(harness, harness.notices[0]), /choose Refresh again if detailed accounting still needs updating/u);
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

// A notice may carry its text as a key or a composing function so a language
// change re-renders it; resolve whichever form it uses with the page's `t`.
function noticeCopy(harness, notice) {
  if (typeof notice.copyFn === "function") return notice.copyFn();
  if (notice.copyKey) return harness.context.t(notice.copyKey, notice.copyValues ?? {});
  return notice.copy;
}

test("a degraded refresh notice is composed again in the new language after a switch", () => {
  const harness = refreshHarness();
  harness.context.t = (key, values = {}) => translate(key, values, "en");
  harness.context.publishRefreshResultNotice({
    refreshId: "refresh-language-switch",
    status: "degraded",
    failedStep: "unified_index",
    failureCode: "local_unified_index_publication_timed_out",
    result: {
      unifiedIndex: { status: "failed", errorCode: "local_unified_index_publication_timed_out" },
      quotaRefresh: { attempted: true, recordWritten: false, errorCode: "app_server_unavailable" },
    },
  });
  const notice = harness.notices.at(-1);
  assert.equal(typeof notice.copyFn, "function", "the text is composed at render time, not stored");
  assert.match(notice.copyFn(), /exceeded its time limit/u);
  harness.context.t = (key, values = {}) => translate(key, values, "zh-Hans");
  assert.match(notice.copyFn(), /更新超时/u);
  assert.equal(/exceeded its time limit/u.test(notice.copyFn()), false,
    "no English sentence survives in the Chinese notice");
});


test("lost status transport retains last confirmed busy state and reconnects without resubmitting", async () => {
  const harness = refreshHarness({ sidebar: true });
  let readCount = 0;
  harness.context.localClient.refreshStatus = async () => {
    readCount += 1;
    if (readCount === 1) throw new Error("synthetic disconnect");
    return { refresh: { refreshId: "refresh-reconnect", status: "succeeded", running: false,
      finishedAt: "2026-10-21T00:01:00.000Z" } };
  };
  await harness.context.requestRefresh({ observeOnly: true,
    initialRefresh: { refreshId: "refresh-reconnect", status: "running", running: true } });
  assert.equal(harness.context.localRefreshInProgress, true);
  assert.equal(harness.context.localRefreshObserverActive, false);
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.buttons.get("#refresh-button").classList.contains("is-refreshing"), true);
  assert.equal(harness.buttons.get("#sidebar-refresh-summary").textContent, translate("refresh.stage.reconnecting", {}, "en-US"));
  assert.deepEqual(harness.notices, [], "unreadable status is not evidence of backend failure");
  await harness.context.observeOverviewPublication();
  assert.equal(harness.context.localRefreshInProgress, false);
  assert.deepEqual(harness.routes, []);
  assert.equal(harness.calls.filter(call => call === "reload").length, 1);
});

test("event observation waits through disconnection and publication before reloading", async () => {
  const harness = refreshHarness({ sidebar: true });
  let revision = 0, connection = 'connected', current = null, wake = null;
  harness.context.localProgressEvents = {
    cursor: () => revision, connection: () => connection, current: () => current,
    wait: after => after !== revision ? Promise.resolve() : new Promise(resolve => { wake = resolve; }),
  };
  const signal = (state, refresh) => {
    connection = state; current = refresh ? { refresh } : current; revision++;
    const resolve = wake; wake = null; resolve?.();
  };
  let status = { refreshId: 'task', status: 'running', running: true };
  let reads = 0;
  harness.context.localClient.refreshStatus = async () => { reads++; return { refresh: status }; };
  const operation = harness.context.requestRefresh({ observeOnly: true, initialRefresh: status });
  await new Promise(setImmediate);
  signal('disconnected');
  await new Promise(setImmediate);
  assert.equal(reads, 0);
  assert.equal(harness.context.localRefreshInProgress, true);
  assert.equal(harness.buttons.get('#sidebar-refresh-summary').textContent, translate('refresh.stage.reconnecting', {}, 'en-US'));
  status = { refreshId: 'task', status: 'succeeded', running: false };
  signal('connected', { ...status, publication: 'running', pending: null });
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  assert.equal(harness.calls.includes('reload'), false);
  signal('connected', { ...status, publication: null, pending: null });
  await operation;
  assert.equal(reads, 2);
  assert.equal(harness.calls.filter(call => call === 'reload').length, 1);
  assert.deepEqual(harness.routes, []);
});

test("closing the event stream ends observation without cancelling the refresh", async () => {
  const harness = refreshHarness({ sidebar: true });
  let wake;
  let state = 'connected';
  harness.context.localProgressEvents = {
    cursor: () => 0, connection: () => state, current: () => null,
    wait: () => new Promise(resolve => { wake = resolve; }),
  };
  const operation = harness.context.requestRefresh({ observeOnly: true,
    initialRefresh: { refreshId: 'task', status: 'running', running: true } });
  await new Promise(setImmediate);
  state = 'closed'; wake();
  await operation;
  assert.equal(harness.context.localRefreshObserverActive, false);
  assert.equal(harness.context.localRefreshInProgress, true);
  assert.deepEqual(harness.routes, []);
  assert.deepEqual(harness.notices, []);
});

function syntheticObservationStream() {
  let now = 0, id = 0;
  const timers = new Map();
  class Source {
    constructor() { this.handlers = new Map(); Source.instance = this; }
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    close() {}
    emit(name, value) { this.handlers.get(name)?.(value); }
  }
  const bus = createLocalProgressEvents({ EventSourceRef: Source,
    setTimeoutRef: (callback, delay) => { const key = ++id; timers.set(key, { callback, at: now + delay, delay }); return key; },
    clearTimeoutRef: key => timers.delete(key) });
  Source.instance.emit('progress', { data: JSON.stringify({
    instanceId: '11111111-1111-4111-8111-111111111111', sequence: 1,
    snapshot: { status: 'ready' }, report: null,
    refresh: { refreshId: 'task', status: 'running', mode: 'detailed', reason: 'manual',
      quota: { status: 'published' }, usage: { status: 'running' }, progress: null,
      pending: null, quickResultPublished: false, publication: null },
  }) });
  return { bus, timers, now: () => now,
    disconnect: () => Source.instance.emit('error'),
    advance(ms) { now += ms; for (const timer of [...timers.values()]) if (timer.at <= now) timer.callback(); } };
}

test('silent disconnected observation expires at the full budget without declaring the task failed', async () => {
  const harness = refreshHarness({ sidebar: true });
  const stream = syntheticObservationStream();
  stream.disconnect();
  harness.context.localProgressEvents = stream.bus;
  harness.context.createRefreshPollingBudget = () => createRefreshPollingBudget({ now: stream.now });
  const operation = harness.context.requestRefresh({ observeOnly: true,
    initialRefresh: { refreshId: 'task', status: 'running', running: true } });
  await new Promise(setImmediate);
  assert.equal([...stream.timers.values()][0].delay, 241 * 60_000);
  stream.advance(241 * 60_000 - 1);
  await new Promise(setImmediate);
  assert.equal(harness.context.localRefreshObserverActive, true);
  stream.advance(1);
  await operation;
  assert.equal(stream.timers.size, 0);
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.context.localRefreshObserverActive, false);
  assert.equal(harness.context.localRefreshInProgress, true);
  assert.equal(harness.context.localRefreshObservationWait, null);
  assert.equal(harness.buttons.get('#sidebar-refresh-summary').textContent, translate('refresh.stage.observationStopped', {}, 'en-US'));
  assert.deepEqual(harness.routes, []);
  assert.deepEqual(harness.notices, []);
  stream.bus.close();
});

test('timeout settlement uses 30 seconds even if no further event arrives', async () => {
  const harness = refreshHarness({ sidebar: true });
  const stream = syntheticObservationStream();
  harness.context.localProgressEvents = stream.bus;
  harness.context.createRefreshPollingBudget = () => createRefreshPollingBudget({ now: stream.now });
  const operation = harness.context.requestRefresh({ detailed: true, observeOnly: true,
    initialRefresh: { refreshId: 'task', mode: 'detailed', status: 'failed', running: true, errorCode: 'refresh_timed_out' } });
  await new Promise(setImmediate);
  assert.equal([...stream.timers.values()][0].delay, 30_000);
  stream.advance(29_999);
  await new Promise(setImmediate);
  assert.equal(harness.context.localRefreshObserverActive, true);
  stream.advance(1);
  await operation;
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.context.localRefreshObserverActive, false);
  assert.equal(harness.context.localRefreshInProgress, true);
  assert.deepEqual(harness.notices, []);
  assert.equal(stream.timers.size, 0);
  stream.bus.close();
});

test('cancel immediately wakes observation and still invokes the companion cancellation route', async () => {
  const harness = refreshHarness({ sidebar: true });
  const stream = syntheticObservationStream();
  stream.disconnect();
  harness.context.localProgressEvents = stream.bus;
  harness.context.createRefreshPollingBudget = () => createRefreshPollingBudget({ now: stream.now });
  const cancellation = Promise.withResolvers();
  let calls = 0;
  harness.context.localClient.cancelRefresh = () => { calls++; return cancellation.promise; };
  runInContext(productionFunction('cancelLocalAnalysis'), harness.context);
  const operation = harness.context.requestRefresh({ observeOnly: true,
    initialRefresh: { refreshId: 'task', status: 'running', running: true } });
  await new Promise(setImmediate);
  const oldTimer = [...stream.timers.keys()][0];
  const cancel = harness.context.cancelLocalAnalysis();
  assert.equal(calls, 1);
  await new Promise(setImmediate);
  assert.equal(stream.timers.has(oldTimer), false, 'the cancelled wait is released immediately');
  assert.equal(stream.timers.size, 1, 'observation remains bounded while awaiting backend evidence');
  assert.equal(harness.context.localRefreshInProgress, true);
  cancellation.resolve(); await cancel;
  stream.advance(241 * 60_000);
  await operation;
  assert.equal(harness.context.localRefreshObserverActive, false);
  assert.equal(harness.context.localRefreshInProgress, true);
  assert.equal(harness.notices.some(notice => notice.kind === 'error'), false);
  stream.bus.close();
});

test('refresh budget exposes its current deadline across settlement and continuation', () => {
  let now = 0;
  const budget = createRefreshPollingBudget({ now: () => now });
  assert.equal(budget.remainingMs(), 241 * 60_000);
  now = 1_000; budget.noteSettling();
  assert.equal(budget.remainingMs(), 30_000);
  now += 30_000;
  assert.equal(budget.remainingMs(), 0);
  assert.equal(budget.hasTime(), false);
  assert.equal(budget.noteContinuation(), true);
  assert.equal(budget.remainingMs(), 241 * 60_000);
});

test("partial quota publication does not hide a later failed usage phase", async () => {
  const initial = { refreshId: "refresh-partial", mode: "overview", status: "running", running: true,
    quickResultAt: "2026-10-21T00:00:00.000Z", quota: { status: "published" }, usage: { status: "running" } };
  const harness = refreshHarness({ sidebar: true, refreshStates: [
    { ...initial, running: false, status: "failed", usage: { status: "failed" },
      finishedAt: "2026-10-21T00:01:00.000Z", errorCode: "refresh_failed" },
  ] });
  await harness.context.requestRefresh({ observeOnly: true, initialRefresh: initial });
  assert.deepEqual(harness.calls, ["quick-reload", "status", "diagnostic"]);
  assert.equal(harness.context.localRefreshInProgress, false);
  assert.equal(harness.buttons.get("#sidebar-refresh-summary").textContent, "Refresh failed");
  assert.equal(harness.notices.at(-1).title, translate("refresh.failedTitle", {}, "en-US"));
});

test("optional status reads started before a manual request cannot overwrite its notice", async () => {
  const harness = refreshHarness();
  harness.context.localProgressEvents.connection = () => "unavailable";
  let release;
  harness.context.localClient.health = async () => null;
  harness.context.localClient.onboarding = async () => null;
  harness.context.localClient.refreshStatus = () => new Promise(resolve => { release = resolve; });
  harness.context.scheduleLocalReadinessPoll = () => {};
  const secondary = harness.context.loadLocalDashboardSecondaryState({ isCurrent: () => true });
  await new Promise(setImmediate);
  harness.context.localRefreshStatusVersion += 1;
  release({ refresh: { refreshId: "old", status: "succeeded", result: {
    quotaRefresh: { attempted: true, recordWritten: false, errorCode: "temporary_disconnect" } } } });
  await secondary;
  assert.deepEqual(harness.notices, []);
});


test("companion scheduling does not require a shell business timer", async () => {
  let status = { schemaVersion: "usagemonitor-desktop-refresh-status-v1",
    activeLease: false, cadenceTimerArmed: false, scheduleOwner: "companion" };
  const harness = refreshHarness({ electron: true, bridge: { getRefreshStatus: async () => status } });
  await harness.context.refreshElectronCadenceHealth();
  const health = harness.context.$("#automatic-refresh-health");
  assert.equal(health.hidden, true);
  status = { ...status, activeLease: true };
  await harness.context.refreshElectronCadenceHealth();
  assert.equal(health.hidden, false);
  assert.equal(health.textContent, translate("dashboard.refresh.recovering", {}, "en-US"));
});


test("a pending detailed request observes its follow-up instead of completing at the joined quota run", async () => {
  const weak = { refreshId: "refresh-weak", mode: "quick", status: "running", running: true,
    pending: { mode: "detailed" }, quota: { status: "running" } };
  const harness = refreshHarness({ sidebar: true, refreshStates: [
    { ...weak, running: false, status: "succeeded", finishedAt: "2026-10-21T00:00:01.000Z" },
    { refreshId: "refresh-detail", mode: "detailed", status: "running", running: true,
      quickResultAt: "2026-10-21T00:00:02.000Z", quota: { status: "published" }, usage: { status: "running" } },
    { refreshId: "refresh-detail", mode: "detailed", status: "succeeded", running: false,
      finishedAt: "2026-10-21T00:00:03.000Z", usage: { status: "reused" } },
  ] });
  harness.context.localClient.recalculateDetailedAccounting = async () => ({
    request: { started: false, joined: true, pending: true }, refresh: weak,
  });
  await harness.context.requestRefresh({ detailed: true });
  assert.deepEqual(harness.calls, ["status", "status", "quick-reload", "status", "reload", "continuation-check"]);
  assert.equal(harness.context.lastObservedRefreshPublication, "refresh-detail::2026-10-21T00:00:03.000Z");
  assert.equal(harness.context.localRefreshInProgress, false);
  assert.equal(harness.buttons.get("#sidebar-refresh-summary").textContent, "Update complete");
});


test("real client normalization keeps newly published quota freshness separate from old usage", async () => {
  const now = Date.parse("2026-10-21T12:00:00.000Z");
  const usageAt = "2026-10-20T00:00:00.000Z";
  const quotaAt = "2026-10-21T11:59:50.000Z";
  const overview = { mode: "local", freshness: { status: "stale", latestObservedAt: usageAt,
    ageSeconds: 129600, staleAfterSeconds: 1800, accountingStatus: "stale" },
    quotaFreshness: { status: "live", latestObservedAt: quotaAt, ageSeconds: 10,
      staleAfterSeconds: 1800, source: "content_free_collector_state", privateExtra: "omitted" },
    quotaWindows: [{ limitId: "codex", durationMinutes: 300, observedAt: quotaAt,
      usedPercent: 25, remainingPercent: 75, status: "live" }] };
  const requests = [];
  const client = new LocalCompanionClient({ fetchImpl: async url => {
    requests.push(url);
    return new Response(JSON.stringify(url.endsWith("/overview") ? overview : {}), { headers: { "content-type": "application/json" } });
  } });
  const loaded = await client.load();
  const harness = refreshHarness({ now });
  const usageRecency = observationRecency(loaded, now);
  const quotaRecency = harness.context.quotaObservationRecency(loaded);
  const presented = harness.context.dashboardObservationPresentation(loaded, usageRecency);
  assert.equal(requests.includes("/api/local/overview"), true);
  assert.equal(loaded.freshness.latestObservedAt, usageAt);
  assert.equal(loaded.quotaFreshness.latestObservedAt, quotaAt);
  assert.equal(Object.hasOwn(loaded.quotaFreshness, "privateExtra"), false);
  assert.equal(usageRecency.status, "stale");
  assert.equal(quotaRecency.status, "current");
  assert.equal(quotaRecency.ageSeconds, 10);
  assert.equal(presented.freshness.latestObservedAt, usageAt);
  assert.equal(presented.quotaWindows[0].status, "live", "old usage cannot stale a newly published quota card");

  harness.context.lastObservationPresentationStatus = null;
  harness.context.formatAge = value => `${value}s`;
  harness.context.formatLocal = value => value;
  harness.context.renderQuotaCards = value => { harness.context.lastQuotaPresentation = value; };
  harness.context.renderWeeklyPaceForecast = () => {};
  harness.context.renderOverviewPace = () => {};
  const freshnessCard = harness.context.$(".freshness-card");
  freshnessCard.dataset = {};
  const freshnessLabel = refreshElement("span");
  freshnessLabel.dataset = {};
  freshnessCard.querySelector = () => freshnessLabel;
  runInContext(productionFunction("renderLiveObservationPresentation"), harness.context);
  harness.context.renderLiveObservationPresentation(loaded, usageRecency);
  assert.equal(harness.context.$("#latest-observation").textContent, "10s");
  assert.equal(harness.context.$("#data-source").textContent, quotaAt);
  assert.equal(harness.context.lastQuotaPresentation.quotaWindows[0].status, "live");

  overview.quotaFreshness = { ...overview.quotaFreshness,
    latestObservedAt: "2026-10-21T12:01:00.000Z", status: "stale", ageSeconds: null };
  const future = await client.load();
  assert.equal(harness.context.quotaObservationRecency(future).status, "unknown");
  assert.equal(harness.context.quotaObservationRecency(future).ageSeconds, null);
  assert.equal(harness.context.dashboardObservationPresentation(future, usageRecency).quotaWindows[0].status, "stale");
  harness.context.renderLiveObservationPresentation(future, usageRecency);
  assert.equal(harness.context.$("#latest-observation").textContent, translate("page.observation.noTimestamp", {}, "en-US"));
  assert.equal(harness.context.lastQuotaPresentation.quotaWindows[0].status, "stale");
  overview.quotaFreshness.source = "unreviewed_source";
  const invalid = await client.load();
  assert.equal(invalid.quotaFreshness.status, "unavailable");
  assert.equal(harness.context.quotaObservationRecency(invalid).status, "unknown");
  delete overview.quotaFreshness;
  const legacy = await client.load();
  assert.equal(legacy.quotaFreshness, null);
  assert.equal(harness.context.quotaObservationRecency(legacy).latestObservedAt, usageAt);
});


test("real controller timeout ends observation only after its writer settles", async t => {
  for (const initialMode of ["quick", "detailed"]) await t.test(initialMode, async () => {
  const entered = Promise.withResolvers();
  const work = Promise.withResolvers();
  let expire;
  let runs = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async () => { runs += 1; entered.resolve(); await work.promise; return {}; },
    dataStore: { async reload() {} }, timeoutMs: 1000,
    monotonicClock: () => 0,
    setTimeoutImpl(callback) { expire = callback; return { unref() {} }; },
    clearTimeoutImpl() {},
  });
  controller.start({ mode: initialMode });
  await entered.promise;
  const accepted = controller.request({ mode: "detailed" });
  assert.equal(accepted.pending, initialMode === "quick");
  assert.equal(accepted.refresh.mode, initialMode);
  assert.equal(accepted.refresh.pending?.mode ?? null, initialMode === "quick" ? "detailed" : null);
  const harness = refreshHarness({ sidebar: true });
  let submissions = 0;
  let statusReads = 0;
  harness.context.createRefreshPollingBudget = createRefreshPollingBudget;
  harness.context.refreshNeedsContinuation = refreshNeedsContinuation;
  harness.context.localClient.recalculateDetailedAccounting = async () => {
    submissions += 1;
    return { request: { started: accepted.started, joined: accepted.joined, pending: accepted.pending }, refresh: accepted.refresh };
  };
  harness.context.localClient.refreshStatus = async () => {
    statusReads += 1;
    if (statusReads === 1) {
      expire();
      const timedOut = controller.getStatus();
      assert.equal(timedOut.status, "failed");
      assert.equal(timedOut.running, true, "the actual controller still owns the unsettled writer");
      assert.equal(timedOut.pending, null, "timeout revoked the actual pending request");
      return { refresh: timedOut };
    }
    if (statusReads === 2) {
      assert.equal(harness.context.localRefreshInProgress, true);
      assert.equal(harness.context.$("#refresh-button").classList.contains("is-refreshing"), true);
      work.resolve();
      await controller.whenSettled();
      const settled = controller.getStatus();
      assert.equal(settled.status, "failed");
      assert.equal(settled.running, false);
      assert.equal(settled.pending, null);
      return { refresh: settled };
    }
    throw new Error("The settled controller must not be polled as pending work.");
  };
  try {
    await harness.context.requestRefresh({ detailed: true });
    assert.equal(statusReads, 2, "an actual terminal receipt ends observation without another polling budget");
    assert.equal(submissions, 1, "the failed weak run cannot trigger a replacement detailed request");
    assert.equal(runs, 1, "the companion did not run the revoked pending work");
    assert.equal(harness.context.localRefreshInProgress, false);
    assert.equal(harness.context.localRefreshObserverActive, false);
    assert.equal(harness.context.$("#sidebar-refresh-summary").textContent, "Refresh failed");
    assert.equal(harness.notices.at(-1).title, translate("refresh.failedTitle", {}, "en-US"));
  } finally {
    work.resolve();
    await controller.whenSettled();
  }
  });
});


test("real bounded timeout waits for settlement and a joined continuation does not spend its continuation budget", async () => {
  const firstEntered = Promise.withResolvers();
  const firstWork = Promise.withResolvers();
  const secondWork = Promise.withResolvers();
  const paused = { mode: "recent_7d", status: "bounded_pause", phase: "paused",
    boundedBy: "modified_at_and_collection_start", filesDiscovered: 2, filesSelected: 2,
    filesProcessed: 1, recordsWritten: 1,
    coveredAt: { startAt: "2026-10-20T00:00:00.000Z", endAt: null } };
  let runs = 0;
  let expire;
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      runs += 1;
      if (runs === 1) { await onProgress(paused); firstEntered.resolve(); await firstWork.promise; }
      else await secondWork.promise;
      return {};
    },
    dataStore: { async reload() {} }, timeoutMs: 1000, monotonicClock: () => 0,
    setTimeoutImpl(callback) { expire = callback; return { unref() {} }; }, clearTimeoutImpl() {},
  });
  controller.start({ mode: "detailed" });
  await firstEntered.promise;
  const harness = refreshHarness({ sidebar: true });
  const budget = createRefreshPollingBudget({ now: () => 0 });
  harness.context.createRefreshPollingBudget = () => budget;
  harness.context.refreshNeedsContinuation = refreshNeedsContinuation;
  let submissions = 0;
  let statusReads = 0;
  harness.context.localClient.recalculateDetailedAccounting = async () => {
    submissions += 1;
    if (submissions === 2) {
      assert.equal(controller.getStatus().running, false, "the old writer must release before any continuation request");
      assert.equal(controller.start({ mode: "detailed" }), true, "another surface wins the continuation race");
    }
    const receipt = controller.request({ mode: "detailed" });
    assert.equal(receipt.joined, true);
    return { request: { started: receipt.started, joined: receipt.joined, pending: receipt.pending }, refresh: receipt.refresh };
  };
  harness.context.localClient.refreshStatus = async () => {
    statusReads += 1;
    if (statusReads === 1) expire();
    if (statusReads === 2) {
      assert.equal(submissions, 1, "bounded_pause cannot submit again while its timed-out writer is still owned");
      firstWork.resolve(); await controller.whenSettled();
    }
    if (statusReads === 3) { secondWork.resolve(); await controller.whenSettled(); }
    if (statusReads > 3) throw new Error("Unexpected repeated observer read");
    return { refresh: controller.getStatus() };
  };
  try {
    await harness.context.requestRefresh({ detailed: true });
    assert.equal(statusReads, 3);
    assert.equal(submissions, 2);
    assert.equal(budget.continuations, 0, "HTTP 200 joined is observation of existing work, not a started continuation");
    assert.equal(harness.context.localRefreshInProgress, false);
    assert.equal(harness.context.$("#sidebar-refresh-summary").textContent, "Update complete");
  } finally {
    firstWork.resolve(); secondWork.resolve(); await controller.whenSettled();
  }
});
