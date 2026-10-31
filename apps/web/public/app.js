import { CODEX_PLAN_TYPES, CODEX_PLAN_DISPLAY_NAMES } from "./codex-catalog.generated.js";
import { mountSettingsPage } from "./electron-settings.js";
import { mountLocalRefreshPause } from "./local-refresh-pause.js";
import { mountDesktopXReader } from "./x-reader-integration.js";
import {
  createObservationFreshnessClock,
  observationRecency,
} from "./dashboard-ui.js";
import { createElectronRefreshLease } from "./electron-refresh-lifecycle.js";
import { createReportingPeriod, reportingDays, reportingSelection, mountReportingPeriodDismissal } from "./reporting-period.js";
import { createCacheReuseMatrix } from "./cache-reuse-matrix.js";
import { cacheReuseMetricLines, cacheReuseCoverageNote } from "./cache-reuse-metrics.js";
import { mountTrendsHorizon, createSpendRateLookup } from "./trends-horizon.js";
import { modelUsagePresentation, modelThemeIcon } from "./model-visuals.js";
import { mountAllowancePage, retainedPageIndex, dashboardReadFailure, observedAllowancePoints } from "./allowance-page.js";
import { resetEventPresentation } from "./trends-horizon.js";
import { buildAllowanceTrends } from "./allowance-trends.js";
import { mountWorkUsageView } from "./work-usage-view.js";
import { mountModelPerformance } from "./model-performance.js";
import { renderOverviewWorkload } from "./overview-workload.js";
import { createDashboardReportPreloader } from "./dashboard-report-preload.js";
import {
  isPrimaryCodexQuotaWindow,
  isPrimaryCodexWeeklyQuotaWindow,
  isSparkQuotaLimitId,
  LocalCompanionClient,
  CODEX_PRIMARY_LIMIT_ID,
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
  cacheDropThreadLookupKey,
  demoDashboard,
  isValidQuotaWindowDuration,
  selectAllowancePlanPopulation,
  selectPrimaryCodexQuotaWindow
} from "./data-client.js";
import {
  createDiagnosticReference,
  createQuotaTimelineLookup,
  createRefreshPollingBudget,
  detectDeviationPeriods,
  diagnosticErrorCode,
  diagnosticReferenceSentence,
  diagnosticSurface,
  historyCoverageNoticeKind,
  historyIndexContinuationDecision,
  refreshAccountingStatus,
  refreshNeedsContinuation,
  serviceRequestId,
} from "./lib.js";
import {
  mountDashboardNavigation,
} from "./navigation.js";
import { isElectronDashboard, resolveElectronStartupAppearance } from "./desktop-appearance.js";
import {
  renderInstallerJourney as renderSharedInstallerJourney,
} from "./install-cta.js";
import {
  COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT,
  createBrowserLocalization,
  evidenceWarningLocalization,
} from "./localization.js";
import {
  compact,
  formatCodexThreadParts,
  formatApiMoney,
  formatSharePercent,
  adaptiveChartTickCount,
  classifyTimelineEvidence,
  createDomHelpers,
  finite,
  formatAge,
  formatChartTimestamp,
  formatChartTimeLabel,
  formatCount,
  formatDecimal,
  formatMoney,
  formatPercent,
  formatPp,
  formatLocal,
  formatModelName,
  formatNumber,
  formatReportingTime,
  formatSignedPp,
  formatSignedPpHours,
  formatSpanLength,
  formatTimeRemaining,
  dateTimeFormatter,
  formatTimeZoneLabel,
  getFormattingLocale,
  localCalendarParts,
  setFormattingLocale,
  setMessageLocale,
  USER_TIME_ZONE,
} from "./ui-format.js";

const NATIVE_APPEARANCE_THEMES = new Set(["light", "dark"]);

function applyNativeAppearanceTheme(theme) {
  if (!NATIVE_APPEARANCE_THEMES.has(theme)) return false;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.content = theme === "dark" ? "#161616" : "#fff";
  }
  return true;
}

// Electron applies nativeTheme before creating its BrowserWindow, so
// Chromium's effective color-scheme synchronously covers its first render.
// Reapplying both here owns live Settings changes and keeps the browser metadata
// in step without reloading a dashboard or losing in-memory state.
applyNativeAppearanceTheme(
  globalThis.__USAGE_MONITOR_APPEARANCE__?.resolvedTheme,
);
applyNativeAppearanceTheme(resolveElectronStartupAppearance());
window.addEventListener("usagemonitor:appearance-override", (event) => {
  applyNativeAppearanceTheme(event.detail?.resolvedTheme);
});

const localization = createBrowserLocalization();
setFormattingLocale(localization.formatLocale());
setMessageLocale(localization.locale());
const t = localization.t;
const tPlural = localization.tPlural;

const localClient = new LocalCompanionClient();
const localProgressEvents = localClient.progressEvents();
let dashboard = null;
// Private, local-only display enrichment. Thread names never become part of
// an accounting/dashboard DTO or browser storage.
const cacheDropThreadLinks = {
  dashboard: null,
  generation: null,
  generationFingerprint: null,
  requestToken: 0,
  loadToken: 0,
  requested: false,
  entries: new Map(),
  cells: { switch: [], continuity: [] },
};
// Owner decision 2026-08-06: the calibration rolling comparison window is
// fixed at three hours. The 15-minute and 1-hour widths the old segmented
// control offered proved inaccurate, so the chart, its summary tiles, the
// sensitivity lookup, and the exact-windows inspection table all read this
// one width instead of a selection.
const CALIBRATION_WINDOW_HOURS = 3;
let activeUsageRangeDays = 7;
let activeCalibrationRangeDays = 7;
let activeUsageGrouping = "hour";
let activeAccountingPeriod = "7d";
// Every date-range control on the dashboard now offers the same three bounded
// windows before "All", and the cost-accounting period selector's own middle
// window is a 30-day one published by the companion. A chart labelled 31d beside
// an accounting total labelled 30d described two different periods with no
// visible reason, which is the inconsistency this settles.
let activeWeeklyRangeDays = 30;
let activeWeeklyMinimumObservedSpanPp = 50;
// The seven-day allowance stays the preferred initial view whenever it has
// evidence. A user's explicit window choice survives redraws and refreshes;
// if that duration disappears from a later payload, resolution falls back to
// the best available window instead of leaving a stale selection on screen.
let activeAllowanceWindowMinutes = null;
// Null follows the latest observed plan, including an insufficient one. An
// explicit choice stays in memory across refreshes, ranges and locale changes.
let activeWeeklyPlanType = null;
let timelineViewport = null;
let usageTimelineViewport = null;
let timelinePointerStart = null;
let usagePointerStart = null;
// The exact-windows inspection table pages through its full merged row set
// (owner-directed 2026-08-08) instead of capping at eight rows: ten rows per
// page, newest first, with the shown range stated as "N–M of T". The rows are
// re-derived on every timeline render; the page index is clamped there and
// returns to the first page whenever the underlying selection changes shape,
// so Prev/Next can never show a stale slice of a different selection.
const RESIDUAL_TABLE_PAGE_SIZE = 6;
let residualTablePage = 0;
let residualInspectionRows = [];
let residualInspectionSignature = "";
// Accounting tables use the dashboard's established ten-row pager rather than
// growing indefinitely. Each table owns its page because the model, switch,
// time-band, and recent-continuity row sets change independently. A changed
// period or refreshed row set returns to page one.
const CACHE_IMPACT_TABLE_PAGE_SIZE = 6;
const accountingModelsTablePagination = { page: 0, signature: "" };
let usageSimpleMetric = "cost";
let usageSimpleCounts = null;
let usageSimpleCountsContext = null;
let usageSimpleModelAccounting = null;
let usageSimpleModelsUnavailable = false;
let usageSimpleFilters = { search: "", model: "" };
// Which model rows the reader has opened. Held outside the render so a
// background refresh redraws the table without collapsing a row mid-read.
const accountingExpandedModels = new Set();
const cacheSwitchTablePagination = { page: 0, signature: "" };
const cacheContinuityTablePagination = { page: 0, signature: "" };

function paginateCacheImpactRows(rows, state, signature, { preservePage = false } = {}) {
  const selectedRows = Array.isArray(rows) ? rows : [];
  if (state.signature !== signature) {
    state.signature = signature;
    if (!preservePage) state.page = 0;
  }
  const pageCount = Math.max(
    1,
    Math.ceil(selectedRows.length / CACHE_IMPACT_TABLE_PAGE_SIZE),
  );
  state.page = Math.min(Math.max(0, state.page), pageCount - 1);
  const start = state.page * CACHE_IMPACT_TABLE_PAGE_SIZE;
  const pageRows = selectedRows.slice(
    start,
    start + CACHE_IMPACT_TABLE_PAGE_SIZE,
  );
  return {
    rows: pageRows,
    start,
    end: start + pageRows.length,
    total: selectedRows.length,
    pageCount,
  };
}
// Last successful health read, kept separate from host presentation permissions.
let localCompanionHealth = null;
let localOnboarding = null;
let localReadinessPollTimer = null;
let localReadinessPollCount = 0;
// The last refresh run's accounting-rebuild deferral, read from the local
// refresh status alongside each dashboard load. A rebuild that keeps missing
// its memory budget is otherwise invisible here: the refresh SUCCEEDS, the
// cache-derived figures simply never appear, and the 2026-08-19 livelock ran
// for hours behind that silence. Only a successful status read updates this,
// so a transient poll failure cannot clear an honest note.
let accountingRebuildDeferral = null;
// One-time history-index build (and a parser-version reparse) advances one
// bounded pass per foreground refresh. Left to the sparse auto-cadence, a
// full build crawls across many timer ticks with the machine idle between
// them, and — while a reparse deletes-then-re-derives — cost reads low until
// it completes. So a successful refresh that leaves the history index
// incomplete chains the next one promptly, bounded, until coverage catches
// up. Reset on a manual refresh or when coverage completes.
let reindexAutoContinuations = 0;
const REINDEX_AUTO_CONTINUE_LIMIT = 40;
const REINDEX_AUTO_CONTINUE_DELAY_MS = 1_500;
let reindexAutoContinueTimer = null;
let lastReindexProgressReceipt = null;
let localActionBusy = false;
// Overlapping primary reads share the original busy owner. Publication uses
// the same load token as quick reloads and cache-drop links below.
let activeLocalDashboardLoad = null;
let localRefreshInProgress = false;
let localRefreshPaused = false;
let localRefreshPauseReady = !runsInsideElectronDashboard();
let localRefreshSubmissionPending = false;
let localRefreshObserverActive = false;
let localRefreshStatusVersion = 0;
let overviewPublicationPollingStarted = false;
let lastObservedRefreshPublication = null;
let lastOverviewScheduleError = null;
let localRefreshCancelRequested = false;
let localRefreshObservationWait = null;
let sidebarRefreshSummaryTimer = null;
let sidebarRefreshSummaryVersion = 0;
// The companion owns business scheduling. Electron leases only protect the
// renderer connection and bounded recovery of an accepted operation.
let electronRefreshLifecycleState = null;
let globalState = null;
let visibleConnectionNotice = null;
let refreshResultNotice = null;
let lastRefreshResultReceipt = null;
const PUBLIC_QUOTA_REFRESH_ERROR_CODES = new Set([
  "app_server_unavailable",
  "malformed_output",
  "temporary_disconnect",
  "collection_failed",
]);
let dashboardUnavailableState = null;
const pendingEvidenceControls = new Map();
let lastObservationPresentationStatus = null;

const $ = (selector) => document.querySelector(selector);
const { clear, node } = createDomHelpers(document);
const observationFreshnessClock = createObservationFreshnessClock({
  onTick(recency, source) {
    if (source !== dashboard) return;
    renderLiveObservationPresentation(source, recency);
    void refreshElectronCadenceHealth();
  },
});

// Product-owned legacy copy stays explicitly registered with the bounded
// migration bridge. Values originating in a local report, provider response,
// file, or user choice use the raw helpers instead, so localization can never
// reinterpret them just because they happen to equal an English UI label.
function setProductText(element, englishText) {
  if (!element) return;
  forgetLocalizedNode(element);
  element.removeAttribute("data-i18n-skip");
  localization.setLegacyText(element, englishText);
}

// Every node this page fills from a message key is remembered as it is
// written: the element, the key, and the values it was rendered with. A
// language change then re-runs the same translation over the same nodes.
//
// This deliberately replaces the previous hand-maintained list of renderers to
// call again after a switch. Text produced by `t(...)` is already in the old
// language, so the exact-text migration bridge cannot recover it — a status
// line whose renderer was missing from that list stayed frozen in the previous
// language forever. A registry cannot drift: a surface added later is covered
// the moment it writes its first localized string.
const localizedNodes = new Map();

function forgetLocalizedNode(element) {
  if (element) localizedNodes.delete(element);
}

function setRawText(element, value) {
  if (!element) return;
  forgetLocalizedNode(element);
  element.setAttribute("data-i18n-skip", "");
  element.textContent = value == null ? "" : String(value);
}

function setLocalizedText(element, key, values = {}) {
  if (!element) return;
  element.removeAttribute("data-i18n-skip");
  localizedNodes.set(element, { key, values, plural: null });
  element.textContent = t(key, values);
}

function setLocalizedPluralText(element, key, count, values = {}) {
  if (!element) return;
  element.removeAttribute("data-i18n-skip");
  localizedNodes.set(element, { key, values, plural: count });
  element.textContent = tPlural(key, count, values);
}

// A created element that carries localized copy, registered the same way.
function localizedNode(tag, className, key, values = {}) {
  const element = node(tag, className, "");
  setLocalizedText(element, key, values);
  return element;
}

function retranslateLocalizedNodes() {
  for (const [element, entry] of localizedNodes) {
    if (!element.isConnected) {
      localizedNodes.delete(element);
      continue;
    }
    const next = entry.plural === null
      ? t(entry.key, entry.values)
      : tPlural(entry.key, entry.plural, entry.values);
    if (element.textContent !== next) element.textContent = next;
  }
}

function rawNode(tag, className, value) {
  const element = node(tag, className, value == null ? "" : String(value));
  element.setAttribute("data-i18n-skip", "");
  return element;
}

function configuredSemanticOpenTarget(documentRef) {
  const target = documentRef
    .querySelector('meta[name="usage-monitor-semantic-open-target"]')
    ?.getAttribute("content")
    ?.trim();
  return target && /^[a-z][a-z0-9+.-]*:\/\/open$/iu.test(target)
    ? target
    : null;
}

const SEMANTIC_OPEN_TARGET = configuredSemanticOpenTarget(document);
const installedAppLink = $("#open-installed-app");
if (SEMANTIC_OPEN_TARGET) {
  installedAppLink.href = SEMANTIC_OPEN_TARGET;
} else {
  installedAppLink.removeAttribute("href");
  installedAppLink.setAttribute("aria-disabled", "true");
}

// A language change redraws browser-generated values using the same display
// locale and leaves data, timestamps, and request ownership untouched. The
// native host dispatches the same event after its Settings picker changes, so
// the existing WebView is updated rather than reloaded.
function rerenderLocalizedDashboard() {
  // Register the current English-owned text before replacing any generated
  // values, then run the bridge once more afterwards. This prevents a previous
  // locale's nodes from surviving a switch back to English (or Spanish) in the
  // same WebView.
  localization.localizeTree();
  renderSharedInstallerJourney(document, {
    formatLocale: getFormattingLocale(),
    translateMessage: t,
  });
  // Charts write formatted instants and numbers straight into an
  // `data-i18n-skip` SVG text layer, so the evidence view is redrawn from the
  // state it was built from. This is a single state-driven redraw, not a list
  // of surfaces someone has to remember to extend.
  if (dashboard) {
    renderDashboard(dashboard);
  } else if (dashboardUnavailableState) {
    renderDashboardUnavailableState(dashboardUnavailableState);
  } else if (globalState) {
    renderGlobalState();
  }
  // Everything else — every status line, chip, and button label written from a
  // message key anywhere on this page — re-translates from the registry those
  // writes populate. Nothing has to be named here for it to be covered.
  if (localOnboarding) renderLocalOnboarding(localOnboarding);
  updateLocalActionButtons();
  retranslateLocalizedNodes();
  if (visibleConnectionNotice) {
    const notice = $("#connection-notice");
    const compact = notice.classList.contains("notice-compact");
    renderConnectionNotice();
    notice.classList.toggle("notice-compact", compact);
  }
  localization.localizeTree();
}

window.addEventListener("usagemonitor:locale-change", (event) => {
  setFormattingLocale(event.detail?.formatLocale ?? localization.formatLocale());
  setMessageLocale(event.detail?.locale ?? localization.locale());
  rerenderLocalizedDashboard();
});

function openInstalledApp() {
  const status = $("#open-installed-app-status");
  status.hidden = false;
  status.textContent =
    "Opening Rhetrion… If no app appears, install the signed Windows download above, then try again.";
  window.setTimeout(() => {
    if (!status.hidden) {
      status.textContent =
        "Continue in the Rhetrion in-app window. If nothing opened, the app is not installed or Windows blocked the link.";
    }
  }, 2_000);
}

function isLoopbackDashboard() {
  const host = String(window.location?.hostname ?? "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function setJourneyState(state) {
  const body = document.body;
  body.classList.remove("first-run", "needs-local-setup", "local-ready", "demo-mode");
  body.classList.add(state);
  // The installation journey belongs to the hosted first-visit page. If the
  // loopback dashboard loses its local service briefly, showing instructions
  // for installing the app inside the already-installed app is actively
  // misleading.
  $("#companion-setup").hidden = state !== "first-run" || isLoopbackDashboard();
  const hasEvidence = state === "local-ready" || state === "demo-mode";
  for (const element of document.querySelectorAll("[data-requires-evidence]")) {
    element.hidden = !hasEvidence && !isElectronDashboard(document, window);
  }
}

// Desktop navigation and layout do not depend on evidence availability. Only
// the data controls wait; restore their initial state before their owners render.
function renderDesktopEvidenceState(state) {
  if (!isElectronDashboard(document, window)) return;
  allowancePage?.setLoadState(state);
  for (const element of document.querySelectorAll("[data-requires-evidence]")) {
    element.hidden = false;
    if (!element.hasAttribute("data-nav")) element.setAttribute("aria-busy", String(state === "loading"));
  }
  for (const status of document.querySelectorAll("[data-dashboard-load-status]")) {
    status.hidden = state === "ready";
    setLocalizedText(status, state === "error" ? "dashboard.unavailable.dashboardTitle" : "refresh.stage.localData");
  }
  if (state === "ready") {
    for (const [control, disabled] of pendingEvidenceControls) control.disabled = disabled;
    pendingEvidenceControls.clear();
  } else {
    for (const control of document.querySelectorAll("[data-requires-evidence] button:not([data-dashboard-retry]), [data-requires-evidence] input, [data-requires-evidence] select, #reporting-period-controls button")) {
      if (!pendingEvidenceControls.has(control)) pendingEvidenceControls.set(control, control.disabled);
      control.disabled = true;
    }
  }
}

function localAnalysisAllowed(value = localOnboarding) {
  return Boolean(
    value
      && value.state === "ready"
      && (value.sessionsReadable || value.archivedSessionsReadable)
      && value.rolloutFilesPresent
      && value.stateWritable
      && value.explicitRefresh,
  );
}

function localAnalysisMessageKey() {
  if (dashboard?.collector?.indexing?.status === "bounded_pause") {
    return "page.analysis.continue";
  }
  return dashboard?.activity?.lastScanAt || dashboard?.collector?.lastScanAt
    ? "page.analysis.update"
    : "page.analysis.analyze";
}

function setSidebarRefreshSummary(key, { success = false } = {}) {
  if ($("#refresh-button")?.getAttribute("data-sidebar-refresh") !== "true") return;
  const summary = $("#sidebar-refresh-summary");
  if (!summary) return;
  const version = ++sidebarRefreshSummaryVersion;
  if (sidebarRefreshSummaryTimer !== null) window.clearTimeout(sidebarRefreshSummaryTimer);
  sidebarRefreshSummaryTimer = null;
  if (key) {
    if (summary.textContent !== t(key)) setLocalizedText(summary, key);
    summary.hidden = false;
  } else {
    setRawText(summary, "");
    summary.hidden = true;
  }
  if (success) sidebarRefreshSummaryTimer = window.setTimeout(() => {
    if (version !== sidebarRefreshSummaryVersion) return;
    sidebarRefreshSummaryTimer = null;
    setRawText(summary, "");
    summary.hidden = true;
  }, 3_000);
}

// The sidebar shows only the phase; detailed controls retain their stable slots.
function renderRefreshProgress(button, phase, { processed = null, selected = null, elapsedSeconds = null } = {}) {
  button.classList.add("refresh-progress");
  const label = node("span", "refresh-progress-phase", phase);
  const phaseMessages = new Map([
    ["Starting detailed accounting…", "refresh.stage.usageStatistics"],
    ["Starting local analysis…", "refresh.stage.localData"],
    ["Update running…", "refresh.stage.localData"],
    ["Reading allowance…", "refresh.stage.quota"],
    ["Allowance updated; calculating usage…", "refresh.stage.usageRecords"],
    ["Update running; reconnecting…", "refresh.stage.reconnecting"],
    ["Stopping safely…", "refresh.progress.stopping"],
    ["Scanning local history…", "refresh.progress.history"],
    ["Calculating usage and allowance…", "refresh.progress.calculating"],
    ["Analyzing files…", "refresh.progress.files"],
    ["Analyzing local evidence…", "refresh.progress.evidence"],
    ["Analyzing…", "refresh.progress.analyzing"],
    ["Continuing local analysis…", "refresh.progress.continuing"],
    ["Stopping timed-out analysis…", "refresh.progress.timeout"],
    ["Loading saved results…", "refresh.stage.localData"],
    ["Loading updated evidence…", "refresh.stage.localData"],
    ["Loading evidence…", "refresh.stage.localData"],
    ["Calculating accounting…", "refresh.progress.accounting"],
    ["Preparing local summary…", "refresh.progress.summary"],
    ["Local summary updated · checking full history…", "refresh.progress.summaryReady"],
  ]);
  const phaseKey = phaseMessages.get(phase);
  if (phaseKey) setLocalizedText(label, phaseKey);
  if (button.getAttribute("data-sidebar-refresh") === "true") {
    button.classList.add("is-refreshing");
    button.setAttribute("aria-busy", "true");
    const action = t(localRefreshCancelRequested ? "page.analysis.cancelling" : "page.analysis.cancel");
    button.title = `${action} · ${label.textContent}`;
    button.setAttribute("aria-label", button.title);
    if (phaseKey) setSidebarRefreshSummary(phaseKey);
    else {
      setSidebarRefreshSummary(null);
      const summary = $("#sidebar-refresh-summary");
      setRawText(summary, phase);
      if (summary) summary.hidden = false;
    }
    return;
  }
  const count = node("span", "refresh-progress-count");
  if (processed !== null && selected !== null) {
    const current = node("span", "refresh-progress-current", String(processed));
    current.style.minWidth = `${String(selected).length}ch`;
    count.append(current, document.createTextNode(`/${selected}`));
  }
  const elapsed = elapsedSeconds === null ? "" :
    `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const timer = node("span", "refresh-progress-time", elapsed);
  const description = [label.textContent, count.textContent, elapsed].filter(Boolean).join(" · ");
  button.title = description;
  button.setAttribute("aria-label", description);
  button.replaceChildren(label, count, timer);
}

/**
 * Keep the elapsed display on wall-clock second boundaries instead of tying it
 * to companion notifications. The self-correcting timeout deliberately
 * recalculates its next boundary after every callback: a delayed renderer may
 * skip a hidden second, but it does not accumulate drift or create a repeating
 * fast-fast-fast-slow beat.
 */
function startRefreshProgressClock(button, phase, options = {}) {
  let {
    processed = null,
    selected = null,
    startedAtMs = Date.now(),
    now = () => Date.now(),
    schedule = (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel = (timer) => window.clearTimeout(timer),
  } = options;
  let active = true;
  let timer = null;
  let currentPhase = phase;
  let currentProcessed = processed;
  let currentSelected = selected;

  const elapsedMilliseconds = () => Math.max(0, now() - startedAtMs);
  const paint = () => {
    renderRefreshProgress(button, currentPhase, {
      processed: currentProcessed,
      selected: currentSelected,
      elapsedSeconds: Math.floor(elapsedMilliseconds() / 1_000),
    });
  };
  const scheduleNextBoundary = () => {
    if (!active) return;
    const remainder = elapsedMilliseconds() % 1_000;
    const delayMs = remainder === 0 ? 1_000 : 1_000 - remainder;
    timer = schedule(tick, Math.max(1, Math.ceil(delayMs)));
  };
  function tick() {
    timer = null;
    if (!active) return;
    paint();
    scheduleNextBoundary();
  }

  paint();
  scheduleNextBoundary();
  return Object.freeze({
    update(nextPhase, { processed: nextProcessed = null, selected: nextSelected = null } = {}) {
      if (!active) return;
      currentPhase = nextPhase;
      currentProcessed = nextProcessed;
      currentSelected = nextSelected;
      paint();
    },
    reset(nextPhase, { processed: nextProcessed = null, selected: nextSelected = null } = {}) {
      if (!active) return;
      if (timer !== null) cancel(timer);
      timer = null;
      startedAtMs = now();
      currentPhase = nextPhase;
      currentProcessed = nextProcessed;
      currentSelected = nextSelected;
      paint();
      scheduleNextBoundary();
    },
    stop() {
      if (!active) return;
      active = false;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  });
}

function updateLocalActionButtons() {
  allowancePage?.setLoadState(localRefreshInProgress || activeLocalDashboardLoad?.pending
    ? "loading" : dashboardReadFailed ? "error" : "ready");
  const allowed = localAnalysisAllowed();
  const labelKey = localAnalysisMessageKey();
  const refreshActive = localRefreshInProgress;
  for (const selector of ["#refresh-button", "#setup-refresh"]) {
    const button = $(selector);
    const sidebar = button.getAttribute("data-sidebar-refresh") === "true";
    // A refresh owns both visible controls for its whole lifetime. The
    // progress renderer and cancel action are deliberately independent of the
    // primary load lock, because a terminal dashboard reload can release that
    // lock before the refresh's finalizer clears its own lifecycle state.
    button.disabled = localRefreshPaused || !localRefreshPauseReady || (sidebar && refreshActive ? localRefreshCancelRequested : localActionBusy || refreshActive || !allowed);
    if (refreshActive && !button.classList.contains("refresh-progress")) {
      // Recover a progress affordance if a nested dashboard render released
      // the primary load lock after the refresh began.
      renderRefreshProgress(button, "Update running…");
    }
    if (!localActionBusy && !refreshActive) {
      if (sidebar) {
        button.classList.remove("refresh-progress", "is-refreshing");
        button.removeAttribute("aria-busy");
        button.setAttribute("aria-label", t(labelKey));
        button.title = t(labelKey);
        continue;
      }
      setLocalizedText(button, labelKey);
      button.classList.remove("refresh-progress");
      button.removeAttribute("aria-label");
      button.removeAttribute("title");
    }
  }
  const setupCheck = $("#setup-check-again");
  if (setupCheck) setupCheck.disabled = localActionBusy;
  const companionCheck = $("#companion-check");
  if (companionCheck) companionCheck.disabled = localActionBusy;
  const connectionCheck = $("#connection-check");
  if (connectionCheck) connectionCheck.disabled = localActionBusy;
  const cancel = $("#cancel-refresh");
  cancel.hidden = $("#refresh-button").getAttribute("data-sidebar-refresh") === "true" || !localRefreshInProgress;
  cancel.disabled = localRefreshCancelRequested;
  setLocalizedText(cancel, localRefreshCancelRequested
    ? "page.analysis.cancelling" : "page.analysis.cancel");
}

let activeInformationPopover = null;
let nextInformationPopoverId = 1;
let suppressInformationPopoverFocus = false;

function positionInformationPopover(popover, button) {
  const anchor = button.getBoundingClientRect();
  const viewportPadding = 16;
  const preferredTop = anchor.bottom + 8;
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const left = Math.min(
    Math.max(viewportPadding, anchor.left),
    Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
  );
  const top = preferredTop + height <= window.innerHeight - viewportPadding
    ? preferredTop
    : Math.max(viewportPadding, anchor.top - height - 8);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function closeInformationPopover({ restoreFocus = false } = {}) {
  const current = activeInformationPopover;
  if (!current) return;
  current.popover.remove();
  current.button.setAttribute("aria-expanded", "false");
  current.button.removeAttribute("aria-describedby");
  activeInformationPopover = null;
  if (restoreFocus && current.button.isConnected) {
    suppressInformationPopoverFocus = true;
    current.button.focus();
    suppressInformationPopoverFocus = false;
  }
}

function openInformationPopover(button, { pinned = false } = {}) {
  if (activeInformationPopover?.button === button) {
    activeInformationPopover.pinned ||= pinned;
    positionInformationPopover(activeInformationPopover.popover, button);
    return;
  }
  closeInformationPopover();
  const popover = node("span", "info-popover");
  const id = `information-popover-${nextInformationPopoverId++}`;
  popover.id = id;
  popover.setAttribute("role", "tooltip");
  popover.textContent = button.dataset.informationExplanation ?? "";
  document.body.append(popover);
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-describedby", id);
  activeInformationPopover = { button, popover, pinned };
  positionInformationPopover(popover, button);
}

function informationLabel(label, explanation, accessibleLabel = label) {
  label = localization.translateText(label);
  explanation = localization.translateText(explanation);
  accessibleLabel = localization.translateText(accessibleLabel);
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(label));
  const button = node("button", "info-button", "i");
  button.type = "button";
  button.dataset.informationExplanation = explanation;
  button.setAttribute("aria-label", t("aria.moreInformation", {
    label: accessibleLabel,
  }));
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("mouseenter", () => openInformationPopover(button));
  button.addEventListener("mouseleave", () => {
    if (activeInformationPopover?.button === button
        && !activeInformationPopover.pinned
        && document.activeElement !== button)
      closeInformationPopover();
  });
  button.addEventListener("focus", () => {
    if (!suppressInformationPopoverFocus) openInformationPopover(button);
  });
  button.addEventListener("blur", () => {
    if (activeInformationPopover?.button === button
        && !activeInformationPopover.pinned)
      closeInformationPopover();
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (activeInformationPopover?.button === button
        && activeInformationPopover.pinned) {
      closeInformationPopover();
      return;
    }
    openInformationPopover(button, { pinned: true });
  });
  fragment.append(button);
  return fragment;
}

const COMPONENT_LABELS = Object.freeze({
  input_uncached_tokens: "Uncached input",
  input_cache_read_tokens: "Cached input",
  input_cache_write_tokens: "Cache writes",
  output_text_tokens: "Output text",
  output_reasoning_tokens: "Reasoning output",
  output_combined_tokens: "Output (split unavailable)"
});

function componentLabel(value) {
  return Object.hasOwn(COMPONENT_LABELS, value)
    ? localization.translateText(COMPONENT_LABELS[value])
    : humanize(value);
}

function setGlobalState(state, { companionReachable = false } = {}) {
  globalState = { companionReachable, state };
  renderGlobalState();
}

// The state pill said "Fresh" while the history index was one-third built,
// because quota observation freshness and index completeness are different
// facts. This badge states the second fact until it stops being true.
function renderHistoryIndexBadge(data) {
  const badge = $("#history-index-badge");
  if (!badge) return;
  const history = data?.pricing?.historyCoverage
    ?? data?.accounting?.historyCoverage
    ?? null;
  const indexed = finite(history?.indexedSourceCount, null);
  const total = finite(history?.sourceCount, null);
  const complete = history?.status === "complete"
    || (indexed !== null && total !== null && total > 0 && indexed >= total);
  const partialTerminal = history?.phase === "partial_terminal"
    || (history?.phase === "aggregate_unavailable"
      && finite(history?.skippedSourceCount, 0) > 0);
  if (data?.mode === "demo" || history === null || complete
      || (total !== null && total <= 0)) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  if (indexed === null || total === null) {
    setLocalizedText(badge, "dashboard.history.coverageUnknownHeadline");
    return;
  }
  setRawText(badge, partialTerminal
    ? t("status.historyPartial", {
      skipped: compact(history?.skippedSourceCount ?? 0),
    })
    : t("status.indexingHistory", {
      indexed: compact(indexed),
      total: compact(total),
    }));
}

function renderGlobalState() {
  if (!globalState) return;
  const keys = {
    live: "status.fresh",
    updating: "status.running",
    stale: "status.needsRefresh",
    insufficient: "status.moreDataNeeded",
    setup: "status.setUpMac",
    offline: globalState.companionReachable
      ? "status.readyToAnalyze"
      : "status.openMacApp",
    demo: "status.labeledDemoData",
  };
  const pill = $("#global-state");
  if (!pill) return;
  const state = localRefreshInProgress ? "updating" : globalState.state;
  pill.hidden = state === "live" || $("#refresh-button")?.getAttribute("data-sidebar-refresh") === "true" && state === "updating";
  pill.className = `global-status state-${state}`;
  pill.replaceChildren(
    document.createTextNode(t(keys[state] ?? "status.unknown")),
  );
}

// `titleFn` and `copyFn` render a notice whose text is composed from several
// messages. They run again on every render, so a language change re-composes
// the sentence instead of leaving the old language's words in place.
function showConnectionNotice({
  title,
  titleKey = null,
  titleFn = null,
  copy,
  copyKey = null,
  copyFn = null,
  copyValues = null,
  kind = "warning",
  showDemo = false,
  showCheck = false,
}) {
  visibleConnectionNotice = {
    copy,
    copyKey,
    copyFn,
    ...(copyValues === null ? {} : { copyValues }),
    kind,
    showCheck,
    showDemo,
    title,
    titleKey,
    titleFn,
  };
  renderConnectionNotice();
}

function renderConnectionNotice() {
  if (!visibleConnectionNotice) return;
  const {
    copy,
    copyKey,
    copyFn = null,
    copyValues = null,
    kind,
    showCheck,
    showDemo,
    title,
    titleKey,
    titleFn = null,
  } = visibleConnectionNotice;
  const notice = $("#connection-notice");
  notice.className = `refresh-notice notice-${kind}`;
  if (titleFn) {
    setRawText($("#connection-title"), titleFn());
  } else if (titleKey) {
    setLocalizedText($("#connection-title"), titleKey);
  } else {
    setProductText($("#connection-title"), title);
  }
  if (copyFn) {
    setRawText($("#connection-copy"), copyFn());
  } else if (copyKey) {
    setLocalizedText($("#connection-copy"), copyKey, copyValues ?? {});
  } else {
    setProductText($("#connection-copy"), copy);
  }
  $("#connection-check").hidden = !showCheck;
  $("#demo-button").hidden = !showDemo;
  notice.hidden = false;
}

function hideConnectionNotice() {
  visibleConnectionNotice = null;
  $("#connection-notice").open = false;
  $("#connection-notice").hidden = true;
}

function renderDashboardUnavailableState(kind) {
  if (!dashboard) renderDesktopEvidenceState("error");
  // The last accounting rows remain visible during a failed refresh.
  resetCacheDropThreadLinks(cacheDropThreadLinks.dashboard);
  const companionCopy = isLoopbackDashboard()
    ? "dashboard.unavailable.companionInAppCopy"
    : "dashboard.unavailable.companionCopy";
  const variants = {
    "backend-only": {
      latestObservation: "dashboard.unavailable.backendOnlyOrigin",
      title: "dashboard.unavailable.backendOnlyTitle",
      copy: "dashboard.unavailable.backendOnlyCopy",
    },
    "dashboard-unavailable": {
      latestObservation: "dashboard.unavailable.companionUnavailable",
      title: "dashboard.unavailable.dashboardTitle",
      copy: "dashboard.unavailable.dashboardCopy",
    },
    "companion-unavailable": {
      latestObservation: "dashboard.unavailable.companionUnavailable",
      title: "dashboard.unavailable.companionTitle",
      copy: companionCopy,
    },
  };
  const selected = variants[kind] ?? variants["companion-unavailable"];
  dashboardUnavailableState = Object.hasOwn(variants, kind)
    ? kind
    : "companion-unavailable";
  setGlobalState("offline");
  setLocalizedText($("#latest-observation"), selected.latestObservation);
  setLocalizedText($("#data-source"), "dashboard.unavailable.noRealUsage");
  showConnectionNotice({
    titleKey: selected.title,
    copyKey: selected.copy,
    kind: "error",
    showDemo: true,
    showCheck: true,
  });
  renderDashboardSkeleton();
}

function onboardingSourceGuidance(value) {
  const values = { location: t(value.customCodexHomeConfigured
    ? "setup.location.custom" : "setup.location.default") };
  const guidance = {
    codex_home_missing: [value.customCodexHomeConfigured
      ? "setup.source.missingTitle" : "setup.source.openTitle",
    value.customCodexHomeConfigured
      ? "setup.source.customMissing" : "setup.source.defaultMissing",
    "setup.source.missingCheck"],
    codex_home_unreadable: ["setup.source.unreadableTitle", "setup.source.unreadableCopy", "setup.source.unreadableCheck"],
    session_directories_missing: ["setup.source.sessionsMissingTitle", "setup.source.sessionsMissingCopy", "setup.source.sessionsMissingCheck"],
    session_directories_unreadable: ["setup.source.sessionsUnreadableTitle", "setup.source.sessionsUnreadableCopy", "setup.source.sessionsUnreadableCheck"],
    no_rollout_files: ["setup.source.noResponsesTitle", "setup.source.noResponsesCopy", "setup.source.noResponsesCheck"],
  };
  const [titleKey, summaryKey, checkKey] = guidance[value.sourceStatus]
    ?? ["setup.source.openTitle", "setup.source.notReadyCopy", "setup.source.notReadyCheck"];
  return { titleKey, summaryKey, checkKey, values };
}

let reportingWindow = null;
let reportingAccountingPeriod = null;
const reportingPeriod = createReportingPeriod({
  onChange: () => {
    allowancePage?.close();
    resetTimelineViewport();
    resetUsageTimelineViewport();
    timelineSeriesMemo = null;
    if (dashboard) {
      renderDashboard(dashboard);
      dashboardReportPreloader.schedule();
    } else renderReportingPeriod();
  },
});

function renderReportingPeriod(data = dashboard) {
  const selection = reportingSelection(data, reportingPeriod.period);
  reportingWindow = selection.window;
  reportingAccountingPeriod = selection.accountingPeriod;
  activeAccountingPeriod = reportingAccountingPeriod;
  activeUsageRangeDays = reportingDays(selection.period);
  activeCalibrationRangeDays = activeUsageRangeDays;
  activeWeeklyRangeDays = activeUsageRangeDays;
  if (data) {
    data.reportingWindow = reportingWindow;
    data.reportingAccountingPeriod = reportingAccountingPeriod;
  }
  for (const control of document.querySelectorAll("#reporting-period-controls button")) {
    const selected = control.dataset.period === selection.period;
    control.classList.toggle("active", selected);
    control.setAttribute("aria-pressed", String(selected));
  }
  const range = document.querySelector("#reporting-period-range");
  if (range) range.textContent = reportingWindow
    ? reportingWindow.startAt
      ? t("reporting.range", { start: formatLocal(reportingWindow.startAt), end: formatLocal(reportingWindow.endAt) })
      : t("reporting.allThrough", { end: formatLocal(reportingWindow.endAt) })
    : t("reporting.waiting");
  const rangeToggle = document.querySelector(".reporting-period-details > summary");
  if (rangeToggle && range) rangeToggle.title = range.textContent;
  workUsageView.setReportingWindow(reportingWindow);
  modelPerformance.setReportingWindow(reportingWindow);
}

function renderLocalOnboarding(value) {
  localOnboarding = value;
  const card = $("#setup-card");
  if (!card) return;
  if (!value || value.state === "unavailable") {
    card.hidden = true;
    setJourneyState(
      dashboard?.mode === "demo"
        ? "demo-mode"
        : dashboard
          ? "local-ready"
          : "first-run",
    );
    updateLocalActionButtons();
    return;
  }
  const sourceReady = value.sourceStatus === "ready";
  const sourceAccessible = ["ready", "no_rollout_files"].includes(
    value.sourceStatus,
  );
  const sourceGuidance = onboardingSourceGuidance(value);
  const indexing = dashboard?.collector?.indexing ?? null;
  const boundedPause = indexing?.status === "bounded_pause";
  const ready = localAnalysisAllowed(value);
  card.classList.toggle("needs-attention", !ready);
  // Setup reading opens in a dialog so a readiness change cannot expand Overview.
  const compactSetup = ready && !boundedPause && Boolean(dashboard);
  card.hidden = compactSetup;
  if (compactSetup) card.setAttribute("aria-hidden", "true");
  else card.removeAttribute("aria-hidden");
  const setupMode = compactSetup ? "ready" : "attention";
  card.open = false;
  card.dataset.setupMode = setupMode;
  setLocalizedText($("#setup-title"), boundedPause
    ? "setup.state.continueTitle"
    : ready ? "setup.title"
      : value.stateStatus === "unwritable" && sourceReady
        ? "setup.state.unwritableTitle" : sourceGuidance.titleKey,
  sourceGuidance.values);
  $("#setup-ready-label").hidden = !ready || boundedPause;
  setLocalizedText($("#setup-summary"), boundedPause
    ? "setup.state.boundedCopy"
    : ready ? "setup.state.readyCopy"
      : value.stateStatus === "unwritable" && sourceReady
        ? "setup.state.unwritableCopy" : sourceGuidance.summaryKey,
  { ...sourceGuidance.values,
    processed: compact(indexing?.filesProcessed), selected: compact(indexing?.filesSelected) });

  const checks = $("#setup-checks");
  clear(checks);
  const items = [
    { ok: sourceAccessible, key: sourceAccessible ? "setup.check.readable" : sourceGuidance.checkKey,
      values: sourceGuidance.values },
    { ok: value.stateWritable, key: value.stateWritable ? "setup.check.writable" : "setup.check.reopen" },
    { ok: value.rolloutFilesPresent, key: value.rolloutFilesPresent
      ? "setup.check.files" : "setup.source.noResponsesCheck",
    values: { count: `${compact(value.rolloutFilesObserved)}${value.rolloutFilesObservedCapped ? "+" : ""}` } },
  ];
  for (const item of items) {
    const row = node("li", item.ok ? "" : "missing");
    row.append(localizedNode("span", "", item.key, item.values));
    checks.append(row);
  }
  setLocalizedText($("#setup-note"), ready
    ? boundedPause ? "setup.note.continue" : "setup.note.ready"
    : "setup.note.check");
  if (!ready) setGlobalState("setup", { companionReachable: true });
  setJourneyState(ready ? "local-ready" : "needs-local-setup");
  updateLocalActionButtons();
}

function quotaObservationRecency(data, now = Date.now()) {
  return observationRecency(data?.quotaFreshness === null || data?.quotaFreshness === undefined
    ? data : { mode: data.mode, freshness: data.quotaFreshness.status === "unavailable"
      ? null : data.quotaFreshness }, now);
}

function dashboardObservationPresentation(data, recency) {
  const observationStale = recency.status === "stale";
  const observationUnavailable = recency.status === "unknown";
  const observationNotCurrent = observationStale || observationUnavailable;
  const quotaRecency = data?.quotaFreshness === null || data?.quotaFreshness === undefined
    ? recency : quotaObservationRecency(data);
  const quotaNotCurrent = ["stale", "unknown"].includes(quotaRecency.status);
  const freshnessStatus = recency.status === "current"
    ? "live"
    : observationStale
      ? "stale"
      : observationUnavailable
        ? "insufficient"
        : data?.freshness?.status;
  return {
    ...data,
    state: observationNotCurrent && data?.state === "live"
      ? (observationStale ? "stale" : "insufficient")
      : data?.state,
    freshness: {
      ...data?.freshness,
      status: freshnessStatus,
      latestObservedAt: recency.latestObservedAt ?? data?.freshness?.latestObservedAt ?? null,
      ageSeconds: recency.ageSeconds,
      staleAfterSeconds: recency.staleAfterSeconds ?? data?.freshness?.staleAfterSeconds,
    },
    quotaWindows: quotaNotCurrent
      ? (Array.isArray(data?.quotaWindows) ? data.quotaWindows : []).map((window) => ({
        ...window,
        status: window?.status === "live" ? "stale" : window?.status,
      }))
      : data?.quotaWindows,
  };
}

function renderObservationConnectionState(data, recency) {
  if (refreshResultNotice !== null) {
    showConnectionNotice(refreshResultNotice);
    $("#connection-notice").classList.toggle("notice-compact", data.state === "stale");
    return;
  }
  if (data.mode === "demo") {
    showConnectionNotice({
      titleKey: "refresh.demoTitle",
      copyKey: "refresh.demoCopy",
      kind: "demo",
      showCheck: true
    });
  } else if (data.state === "stale") {
    if (recency.status === "current" && data.freshness.accountingStatus === "stale") {
      showConnectionNotice({
        copyKey: "dashboard.stale.accountingCopy",
        kind: "warning",
        titleKey: "dashboard.stale.accountingTitle",
      });
    } else {
      showConnectionNotice({
        titleKey: "dashboard.stale.observationTitle",
        copyKey: "dashboard.stale.observationCopy",
        kind: "warning"
      });
    }
  } else if (data.state === "insufficient") {
    showConnectionNotice({
      titleKey: "refresh.incompleteTitle",
      copyKey: "refresh.incompleteCopy",
      kind: "warning",
      showCheck: true
    });
  } else {
    hideConnectionNotice();
  }
  $("#connection-notice").classList.toggle("notice-compact", data.state === "stale");
}

function quotaRefreshDisposition(refresh) {
  const result = refresh?.result?.quotaRefresh;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  if (typeof result.errorCode === "string" && result.errorCode.length > 0) return "failed";
  if (result.attempted === true && result.recordWritten === true) return "written";
  if (result.attempted === true && result.recordWritten === false) return "no-new";
  return null;
}

function quotaRefreshFailureMessage(refresh) {
  const errorCode = refresh?.result?.quotaRefresh?.errorCode;
  if (errorCode === "app_server_unavailable") {
    return { copyKey: "refresh.quota.appServerUnavailableCopy" };
  }
  if (PUBLIC_QUOTA_REFRESH_ERROR_CODES.has(errorCode)) {
    return {
      copyKey: "refresh.quota.failureCodeCopy",
      copyValues: { code: errorCode },
    };
  }
  return { copyKey: "refresh.quota.failureCopy" };
}

function historyRefreshFailureMessage(refresh) {
  const unifiedIndex = refresh?.result?.unifiedIndex;
  if (["ingested", "partial"].includes(unifiedIndex?.status)) return null;
  if (refresh?.failedStep !== "unified_index" && unifiedIndex?.status !== "failed") return null;
  const code = refresh.failureCode ?? unifiedIndex?.errorCode;
  switch (code) {
    case "local_unified_index_publication_busy":
      return { copyKey: "refresh.history.publicationBusyCopy", copyValues: { code } };
    case "local_unified_index_publication_timed_out":
      return { copyKey: "refresh.history.publicationTimedOutCopy", copyValues: { code } };
    case "local_unified_index_publication_failed":
      return { copyKey: "refresh.history.publicationFailedCopy", copyValues: { code } };
    case "codex_rollout_source_changed":
      return { copyKey: "refresh.history.sourceChangedCopy", copyValues: { code } };
    case "codex_response_usage_legacy_conflict":
    case "codex_response_usage_legacy_scope_unattributed":
    case "codex_response_usage_identity_conflict":
    case "codex_response_usage_checkpoint_conflict":
    case "codex_response_usage_chain_incomplete":
      return { copyKey: "refresh.history.usageEvidenceCopy", copyValues: { code } };
    default:
      return null;
  }
}

function refreshResultReceipt(refresh) {
  if (!refresh || typeof refresh !== "object") return null;
  const quota = refresh.result?.quotaRefresh;
  if (!quota && refresh.status !== "degraded") return null;
  return JSON.stringify({
    refreshId: typeof refresh.refreshId === "string" ? refresh.refreshId : null,
    status: refresh.status ?? null,
    errorCode: typeof refresh.errorCode === "string" ? refresh.errorCode : null,
    failureCode: typeof refresh.failureCode === "string" ? refresh.failureCode : null,
    quotaRefresh: quota ?? null,
  });
}

function renderCurrentObservationConnectionState() {
  if (!dashboard) return;
  const recency = observationRecency(dashboard);
  renderObservationConnectionState(
    dashboardObservationPresentation(dashboard, recency),
    recency,
  );
}

function publishRefreshResultNotice(refresh) {
  if (!refresh || !["succeeded", "degraded"].includes(refresh.status)) return;
  const disposition = quotaRefreshDisposition(refresh);
  const receipt = refreshResultReceipt(refresh);
  if (receipt !== null && receipt === lastRefreshResultReceipt) return;
  if (receipt !== null) lastRefreshResultReceipt = receipt;

  if (refresh.status === "degraded") {
    const unifiedIndex = refresh.result?.unifiedIndex ?? null;
    const accountingFailed = refresh.failedStep === "accounting"
      || (unifiedIndex?.status !== "failed" && refresh.result?.accounting?.status === "unavailable");
    const usageFailed = accountingFailed || unifiedIndex?.status === "failed"
      || (refresh.failedStep === "unified_index" && !["ingested", "partial"].includes(unifiedIndex?.status));
    const history = dashboard?.pricing?.historyCoverage
      ?? dashboard?.accounting?.historyCoverage
      ?? null;
    const skipped = finite(unifiedIndex?.generation?.skippedSourceCount, 0);
    const threads = finite(unifiedIndex?.generation?.skippedThreadCount, 0);
    const historyFailureMessage = historyRefreshFailureMessage(refresh);
    const failureMessage = quotaRefreshFailureMessage(refresh);
    // Composed on every render, never stored as text: the notice outlives a
    // language switch, and a stored sentence would stay in the old language.
    const composeCopy = () => {
      const degradedCopy = historyFailureMessage
        ? t(historyFailureMessage.copyKey, historyFailureMessage.copyValues)
        : skipped > 0 && !usageFailed
        ? t("refresh.degradedCopy", {
          sources: tPlural("format.rolloutSourceCount", skipped, {
            count: formatNumber(skipped),
          }),
          threads: tPlural("format.affectedThreadCount", threads, {
            count: formatNumber(threads),
          }),
        })
        : accountingFailed
        ? t("refresh.accounting.failureCopy", { code: refresh.failureCode ?? "accounting_unified_source_unavailable" })
        : usageFailed ? t("refresh.degradedGenericCopy", {
          code: refresh.failureCode ?? "unified_index",
        }) : "";
      const quotaCopy = disposition === "failed"
        ? t(failureMessage.copyKey, failureMessage.copyValues ?? {})
        : disposition === "no-new"
          ? t("refresh.quota.noNewCopy")
          : "";
      return [degradedCopy, quotaCopy].filter(Boolean).join(" ");
    };
    refreshResultNotice = {
      titleKey: usageFailed
        ? disposition === "failed" ? "refresh.usageQuotaFailureTitle" : "refresh.usageFailureTitle"
        : disposition === "failed"
        ? skipped > 0 ? "refresh.degradedQuotaFailureTitle" : "refresh.quota.failureTitle"
        : "refresh.degradedTitle",
      copyFn: composeCopy,
      kind: usageFailed || disposition === "failed"
        ? "error"
        : historyCoverageNoticeKind({
          history,
          accountingProjection: dashboard?.accounting?.projection,
        }),
    };
    showConnectionNotice(refreshResultNotice);
    return;
  }

  if (disposition === "failed" || disposition === "no-new") {
    refreshResultNotice = disposition === "failed"
      ? {
        titleKey: "refresh.quota.failureTitle",
        ...quotaRefreshFailureMessage(refresh),
        kind: "warning",
      }
      : {
        titleKey: "refresh.quota.checkedTitle",
        copyKey: "refresh.quota.noNewCopy",
        kind: "info",
      };
    showConnectionNotice(refreshResultNotice);
    return;
  }

  if (disposition === "written" && refreshResultNotice !== null) {
    refreshResultNotice = null;
    renderCurrentObservationConnectionState();
  }
}

function renderLiveObservationPresentation(data, recency = observationRecency(data)) {
  const presentation = dashboardObservationPresentation(data, recency);
  const quotaRecency = quotaObservationRecency(data);
  const presentationStatus = `${recency.status}:${quotaRecency.status}`;
  const priorStatus = lastObservationPresentationStatus;
  lastObservationPresentationStatus = presentationStatus;
  const card = $(".freshness-card");
  card.dataset.freshness = quotaRecency.status;
  const freshnessLabel = card.querySelector("span");
  const freshnessKey = quotaRecency.status === "stale"
    ? "dashboard.freshness.stale" : "dashboard.freshness.observation";
  freshnessLabel.dataset.i18n = freshnessKey;
  setLocalizedText(freshnessLabel, freshnessKey);
  if (quotaRecency.ageSeconds !== null) setRawText($("#latest-observation"), formatAge(quotaRecency.ageSeconds));
  else setLocalizedText($("#latest-observation"), "page.observation.noTimestamp");
  if (data.mode === "demo") setLocalizedText($("#data-source"), "page.dataSource.demo");
  else setRawText($("#data-source"), formatLocal(data.quotaFreshness === null || data.quotaFreshness === undefined
    ? data.freshness.latestObservedAt : data.quotaFreshness.latestObservedAt));

  if (priorStatus !== presentationStatus) {
    setGlobalState(presentation.state, {
      companionReachable: data.mode !== "demo"
    });
    renderObservationConnectionState(presentation, recency);
    renderQuotaCards(presentation);
    renderWeeklyPaceForecast(presentation);
    renderOverviewPace(presentation);
  }
}

async function refreshElectronCadenceHealth() {
  const element = $("#automatic-refresh-health");
  if (!element) return;
  const bridge = runsInsideElectronDashboard() ? globalThis.usageMonitorDesktop : null;
  if (localRefreshInProgress || typeof bridge?.getRefreshStatus !== "function") {
    element.hidden = true;
    return;
  }
  let status = null;
  try {
    status = await bridge.getRefreshStatus();
  } catch {
    status = null;
  }
  const leaseAwaitingRecovery = status?.schemaVersion === "usagemonitor-desktop-refresh-status-v1"
    && status.activeLease === true
    && (status.scheduleOwner === "companion" || status.cadenceTimerArmed === false);
  if (!leaseAwaitingRecovery) {
    element.hidden = true;
    return;
  }
  setLocalizedText(element, status?.scheduleOwner === "companion" || electronRefreshLifecycleState?.reason === "settlement_failed"
    ? "dashboard.refresh.recovering"
    : "dashboard.refresh.waitingForRecovery");
  element.hidden = false;
}

function renderDashboard(data) {
  renderDesktopEvidenceState("ready");
  renderReportingPeriod(data);
  dashboardUnavailableState = null;
  dashboard = data;
  if (!isCacheDropThreadDashboard(data) || !data?.accounting?.cacheDiagnosticsSource
      || cacheDropThreadLinks.dashboard !== data
      || cacheDropThreadLinks.generation !== data?.accounting?.cacheDiagnosticsSource?.generation
      || cacheDropThreadLinks.generationFingerprint
        !== data?.accounting?.cacheDiagnosticsSource?.generationFingerprint) {
    resetCacheDropThreadLinks(data);
  }
  if (data.mode === "demo") {
    setJourneyState("demo-mode");
    $("#setup-card").hidden = true;
  }
  renderHistoryIndexBadge(data);
  const recency = observationRecency(data);
  lastObservationPresentationStatus = null;
  renderLiveObservationPresentation(data, recency);
  // The footer's "Dashboard contract" line is gone (owner-directed,
  // 2026-08-08): the version stays machine-discoverable on data.schemaVersion
  // and was never a user fact.

  renderEvidenceWarnings(data);
  renderPricing(data);
  renderComparison(data);
  renderUsageTimeline(data);
  renderTimeline(data);
  renderWeekly(data);
  renderAccounting(data);
  const overviewRoot = $("#overview");
  overviewRoot.querySelector(".overview-allowances").hidden = true;
  overviewRoot.querySelector(".overview-panels").hidden = true;
  let workloadRoot = $("#overview-workload");
  if (!workloadRoot) { workloadRoot = node("div"); workloadRoot.id="overview-workload"; overviewRoot.append(workloadRoot); }
  renderOverviewWorkload(workloadRoot,data.workload,{translate:t,locale:getFormattingLocale(),
    currentQuota:{status:data.quotaWindows.length?'available':'unavailable',windows:data.quotaWindows}});
  observationFreshnessClock.update(data);
  // This optional lookup must never delay the native readiness marker or the
  // accounting render. Only the first-column cells are updated when it lands.
  void loadCacheDropThreadLinks(data);
}

function renderQuotaCards(data) {
  closeInformationPopover();
  const container = $("#quota-cards");
  // Keep the live region with its weekly pool across refreshes.
  const overviewPace = $("#overview-pace") ?? node("aside", "overview-pace");
  overviewPace.id = "overview-pace";
  overviewPace.setAttribute("aria-live", "polite");
  overviewPace.hidden = true;
  clear(container);
  if ($("#allowance-context")) $("#allowance-context").hidden = true;
  const normalWindows = data.quotaWindows.filter(isPrimaryCodexQuotaWindow);
  const sparkWindows = data.quotaWindows.filter((window) => (
    isSparkQuotaLimitId(window?.limitId)
      && isValidQuotaWindowDuration(finite(window?.durationMinutes))
  ));
  const otherWindows = data.quotaWindows.filter((window) => (
    !isPrimaryCodexQuotaWindow(window)
      && !isSparkQuotaLimitId(window?.limitId)
      && isValidQuotaWindowDuration(finite(window?.durationMinutes))
  ));
  const primaryWindow = selectPrimaryCodexQuotaWindow(normalWindows);
  const normalOrderedWindows = primaryWindow === null
    ? normalWindows
    : [primaryWindow, ...normalWindows.filter((window) => window !== primaryWindow)];
  // Spark is a separate provider limit. Keep it out of the normal allowance
  // selection so it cannot be mistaken for the five-hour or seven-day track.
  // The forecast's primary pool leads the tanks. Within Spark, order by
  // duration rather than the provider's slot assignment. Future pools follow
  // both reviewed groups and never enter primary selection or calibration.
  const sparkOrderedWindows = [...sparkWindows].sort((left, right) => (
    finite(left.durationMinutes) - finite(right.durationMinutes)
  ));
  // Unknown pools stay out of both headline selection and calibration, but a
  // bounded local observation should not disappear. Technical ids only keep
  // separate future pools distinct; they are never rendered as copy.
  const otherOrderedWindows = [...otherWindows].sort((left, right) => (
    String(left.limitId).localeCompare(String(right.limitId))
      || finite(left.durationMinutes) - finite(right.durationMinutes)
      || String(left.slot).localeCompare(String(right.slot))
  ));
  const windows = [
    ...normalOrderedWindows,
    ...sparkOrderedWindows,
    ...otherOrderedWindows,
  ];
  if (!windows.length) {
    const card = node("article", "metric-card insufficient");
    const header = node("div", "metric-card-header");
    const name = node("span", "metric-name");
    setLocalizedText(name, "dashboard.quota.observations");
    const chip = node("span", "evidence-chip");
    setLocalizedText(chip, "dashboard.quota.insufficient");
    const value = node("strong", "metric-value", "—");
    const copy = node("p");
    setLocalizedText(copy, "dashboard.quota.noCurrent");
    header.append(name, chip);
    card.append(header, value, copy);
    container.append(card);
    return;
  }
  const context = $("#allowance-context");
  if (context) {
    context.textContent = data.mode === "demo" ? t("dashboard.quota.demo") : "";
    context.hidden = !context.textContent;
  }
  for (const window of windows) {
    const reportedRemaining = finite(window.remainingPercent);
    const remaining = reportedRemaining !== null
      && reportedRemaining >= 0 && reportedRemaining <= 100
      ? reportedRemaining : null;
    const spark = isSparkQuotaLimitId(window.limitId);
    const card = node("article", [
      "metric-card quota-tank quota-summary",
      spark ? "quota-card-spark" : "",
      window.status === "stale" ? "stale" : "",
      remaining === null ? "insufficient" : "",
    ].filter(Boolean).join(" "));
    card.setAttribute("aria-label", spark
      ? `GPT-5.3 Codex Spark · ${localizedQuotaWindowDuration(window.durationMinutes)}`
      : localizedQuotaWindowLabel(window));
    card.dataset.shortWindow = String(window.durationMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES);
    card.dataset.remaining = remaining === null ? "" : String(remaining);
    card.dataset.forecastPool = String(isPrimaryCodexWeeklyQuotaWindow(window));
    card.dataset.resetAt = String(forecastTimestamp(window.resetAt) ?? "");
    card.dataset.stale = String(window.status === "stale");
    const header = node("div", "quota-tank-header");
    const family = node("span", "quota-tank-family");
    if (spark) {
      family.className += " allowance-model-spark";
      family.append(modelThemeIcon(document, "spark"), node("span", "", "GPT-5.3 Codex Spark"));
    } else if (isPrimaryCodexQuotaWindow(window)) {
      const logo = node("img", "quota-codex-icon");
      logo.setAttribute("src", "./codex-color.svg");
      logo.setAttribute("alt", "");
      logo.setAttribute("aria-hidden", "true");
      family.append(logo, node("span", "", "Codex"));
    } else {
      family.textContent = window.limitName || t("dashboard.quota.windowOther");
    }
    header.append(family);
    header.append(node("span", "quota-tank-period",
      localizedQuotaWindowDuration(window.durationMinutes)));
    if (window.status === "stale") {
      header.append(node("span", "evidence-chip", t("allowance.stale")));
    }
    const bottom = node("div", "quota-tank-bottom");
    const amount = node("div");
    amount.append(node("strong", "quota-tank-value", remaining === null
      ? "—" : formatPercent(remaining, window.precision ?? 0)));
    amount.append(node("span", "quota-tank-caption", t(remaining === null
      ? "allowance.unknown" : "allowance.remaining")));
    const reset = node("div", "quota-tank-reset");
    const resetAt = forecastTimestamp(window.resetAt);
    const hoursLeft = resetAt === null ? null : (resetAt - Date.now()) / 3_600_000;
    reset.append(node("span", "", t(hoursLeft !== null && hoursLeft > 0
      ? "allowance.resetsIn" : resetAt !== null ? "allowance.resets" : "dashboard.quota.resetUnknown")));
    if (hoursLeft !== null && hoursLeft > 0) {
      reset.append(allowanceTimestamp(formatAllowanceDuration(hoursLeft), resetAt));
    } else if (resetAt !== null) {
      reset.append(allowanceTimestamp(t("allowance.resetPassed"), resetAt));
    }
    bottom.append(amount, reset);
    card.append(header, bottom);
    if (remaining !== null) {
      const progress = node("div", "quota-summary-progress");
      progress.setAttribute("aria-hidden", "true");
      const fuel = node("div", "quota-tank-fuel");
      fuel.style.inlineSize = `${remaining}%`;
      fuel.setAttribute("aria-hidden", "true");
      progress.append(fuel);
      card.append(progress);
    }
    const observedAt = forecastTimestamp(window.observedAt);
    const observed = node("small", "quota-summary-observed");
    observed.textContent = observedAt === null
      ? t("page.observation.noTimestamp")
      : t("dashboard.quota.observedAtPlain", { time: formatLocal(new Date(observedAt).toISOString()) });
    card.append(observed);
    // Allowance changes plots the primary seven-day track only, so other pools
    // get no detail link rather than one that shows someone else's data.
    if (isPrimaryCodexWeeklyQuotaWindow(window)) {
      const link = node("a", "overview-card-link");
      link.href = "#allowance/changes";
      setLocalizedText(link, "dashboard.overview.openAllowanceChanges");
      card.append(link);
      card.append(overviewPace);
    }
    container.append(card);
  }
}

function providerReportedPlanEvidence(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (candidate === "" || candidate.toLowerCase() === "unknown") return "";
  return t("dashboard.quota.providerPlan", { plan: candidate });
}

function localizedQuotaWindowDuration(durationMinutes) {
  const duration = finite(durationMinutes, null);
  if (!isValidQuotaWindowDuration(duration)) return "";
  if (duration % (24 * 60) === 0) {
    return tPlural("quota.durationDay", duration / (24 * 60));
  }
  if (duration % 60 === 0) {
    return tPlural("quota.durationHour", duration / 60);
  }
  return tPlural("quota.durationMinute", duration);
}

function localizedQuotaWindowLabel(window) {
  const duration = finite(window?.durationMinutes, null);
  if (isSparkQuotaLimitId(window?.limitId)) {
    // The provider re-introduced the 5-hour "Codex Spark" window on the Spark
    // limit (wire: codex_bengalfox, window_minutes 300) alongside the Spark
    // seven-day window, so the two Spark cards need distinct duration-named
    // titles. An unfamiliar Spark duration keeps the honest generic name.
    if (duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES) {
      return t("dashboard.quota.windowSparkFiveHour");
    }
    if (duration === CODEX_WEEKLY_ALLOWANCE_MINUTES) {
      return t("dashboard.quota.windowSparkSevenDay");
    }
    return t("dashboard.quota.windowSpark");
  }
  if (window?.limitId === CODEX_PRIMARY_LIMIT_ID
      && duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES) {
    return t("dashboard.quota.windowFiveHour");
  }
  if (window?.limitId === CODEX_PRIMARY_LIMIT_ID
      && duration === CODEX_WEEKLY_ALLOWANCE_MINUTES) {
    return t("dashboard.quota.windowSevenDay");
  }
  if (window?.limitId === CODEX_PRIMARY_LIMIT_ID
      && isValidQuotaWindowDuration(duration)) {
    return t("dashboard.quota.windowProviderReported", {
      duration: localizedQuotaWindowDuration(duration),
    });
  }
  if (isValidQuotaWindowDuration(duration)) {
    const localizedDuration = localizedQuotaWindowDuration(duration);
    if (window?.limitName) {
      return t("dashboard.quota.windowNamedObserved", {
        name: window.limitName,
        duration: localizedDuration,
      });
    }
    return t("dashboard.quota.windowOtherDuration", {
      duration: localizedDuration,
    });
  }
  return t("dashboard.quota.windowOther");
}

function dashboardAccountingProjection(data) {
  return data?.accounting?.projection ?? {
    status: "available",
    reason: null,
    terminal: false,
  };
}

function accountingRequiresNewerBuild(data) {
  return dashboardAccountingProjection(data).reason
    === "local_unified_index_schema_newer";
}

function accountingIsUnavailable(data) {
  return dashboardAccountingProjection(data).status === "unavailable";
}

function projectionUnavailableCopyKey(data) {
  return accountingRequiresNewerBuild(data)
    ? "accounting.projection.newerBuild"
    : "accounting.projection.unavailable";
}

function renderPricing(data) {
  const selected = data.reportingWindow ? accountingPeriod(data) : null;
  const coverage = selected?.pricingCoverage ?? data.accounting?.pricingCoverage;
  $("#cost-partial").hidden = !(finite(coverage?.partiallyPricedEvents, 0) > 0
    || finite(coverage?.unpricedEvents, 0) > 0
    || (!coverage && finite(data.accounting?.unknownModelEvents, 0) > 0));
  if (data.reportingWindow && selected === null) {
    $("#cost-partial").hidden = true;
    setRawText($("#cost-period"), t("reporting.unavailable"));
    $("#cost-total").textContent = "—";
    clear($("#cost-components"));
    $("#cost-components").append(node("p", "empty-inline", t("reporting.unavailable")));
    renderHistoryProgress(data);
    return;
  }
  const pricing = selected ? {
    ...data.pricing,
    periodLabel: t(`reporting.${data.reportingWindow.period}`),
    totalCostUsd: selected.apiPriceEquivalentUsd,
    quotaWeightedTotalCostUsd: selected.quotaWeightedApiPriceEquivalentUsd,
    fastMode: selected.fastMode,
    components: Object.entries(selected.componentCosts).map(([name, row]) => ({ name, ...row })),
  } : data.pricing;
  const projection = dashboardAccountingProjection(data);
  const retainedPeriod = projection.status === "retained"
    ? data.reportingWindow ? selected : staleAccountingServePeriod(data) ?? data.accounting
    : null;
  const retainedEvidence = retainedPeriod !== null
    && finite(retainedPeriod.apiPriceEquivalentUsd, 0) > 0;
  if (projection.status !== "available") {
    setLocalizedText(
      $("#cost-period"),
      retainedEvidence
        ? "accounting.projection.lastVerifiedPeriod"
        : "accounting.projection.periodUnavailable",
      retainedEvidence ? { period: localization.translateText(retainedPeriod.periodLabel) } : {},
    );
    setLocalizedText(
      $("#cost-metric-kicker"),
      retainedEvidence
        ? "accounting.projection.lastVerifiedMetric"
        : "accounting.projection.metricUnavailable",
    );
    $("#cost-metric-kicker").title = t(projectionUnavailableCopyKey(data));
    $("#cost-total").textContent = retainedEvidence
      ? formatApiMoney(retainedPeriod.apiPriceEquivalentUsd)
      : "—";
    if (!retainedEvidence) $("#cost-partial").hidden = true;
    renderHistoryProgress(data);
    const list = $("#cost-components");
    clear(list);
    list.append(node(
      "p",
      "empty-inline",
      t(retainedEvidence
        ? "accounting.projection.retainedComponents"
        : projectionUnavailableCopyKey(data)),
    ));
    return;
  }
  const fastMode = pricing.fastMode;
  setProductText($("#cost-period"), pricing.periodLabel);
  // The headline is the speed-priced figure whenever a weighting exists;
  // when nothing can be weighted legitimately the label falls back to the
  // Standard-rate name rather than presenting an unweighted number under a
  // weighted heading.
  const weighted = pricing.quotaWeightedTotalCostUsd;
  const useWeighted = weighted !== null && fastMode.weightingStatus !== "unknown";
  setProductText($("#cost-metric-kicker"), useWeighted
    ? fastMode.metricLabel
    : fastMode.standardMetricLabel);
  $("#cost-metric-kicker").title = useWeighted
    ? localization.translateText(fastMode.metricExplainer)
    : t("dashboard.pricing.noWeightedTitle");
  $("#cost-total").textContent = formatMoney(
    useWeighted ? weighted : pricing.totalCostUsd,
    2
  );
  renderHistoryProgress(data);
  // The metadata line under the total ("100% coverage · stale replay-safe
  // cache · price registry … · History index complete") is gone
  // (owner-directed, 2026-08-10). Trace of its "stale replay-safe cache"
  // fragment: the companion called the cache stale from wall-clock age since
  // the last rebuild, while the refresh loop deliberately reuses the cache on
  // passes that add no rollout usage — so the label condemned totals that
  // covered every known usage record. The companion now derives staleness
  // against the newest exportable evidence (src/local-companion-data.js), and
  // the surviving honesty surfaces here are the history-progress block above,
  // and the routed evidence warnings.
  const list = $("#cost-components");
  clear(list);
  const components = pricing.components.filter(
    (row) => finite(row.costUsd, 0) > 0 || finite(row.tokens, 0) > 0
  );
  if (!components.length) {
    list.append(node("p", "empty-inline", t("dashboard.pricing.noComponents")));
    return;
  }
  const max = Math.max(...components.map((row) => row.costUsd ?? 0), .01);
  for (const component of components) {
    const row = node("div", "component-row");
    row.append(node("span", "", componentLabel(component.name)));
    const track = node("div", "component-track");
    const fill = node("i");
    fill.style.width = `${Math.max(component.costUsd > 0 ? 1 : 0, ((component.costUsd ?? 0) / max) * 100)}%`;
    track.append(fill);
    row.append(
      track,
      node("strong", "", formatApiMoney(component.costUsd))
    );
    row.title = t("dashboard.pricing.tokens", { count: compact(component.tokens) });
    list.append(row);
  }
}

// Decimal steps, so the unit named here is the unit the companion counted in.
const BYTE_UNITS = Object.freeze([
  "byte",
  "kilobyte",
  "megabyte",
  "gigabyte",
  "terabyte",
]);

function formatBytes(value) {
  const number = finite(value);
  if (number === null || number < 0) return "—";
  let amount = number;
  let index = 0;
  while (amount >= 1_000 && index < BYTE_UNITS.length - 1) {
    amount /= 1_000;
    index += 1;
  }
  return formatNumber(amount, {
    style: "unit",
    unit: BYTE_UNITS[index],
    unitDisplay: "short",
    maximumFractionDigits: index === 0 ? 0 : 1,
  });
}

/**
 * How much of the discovered history the figures on this page are drawn from.
 *
 * Every number here is measured: the local companion publishes how many
 * sources it discovered and how many it has indexed, and the share is that
 * division. Nothing estimates a finish time, because none is known — a
 * progress bar that implied one would be the same invention this product
 * refuses everywhere else. The block is absent once both indexed history and
 * its accounting summary are available, or there is no measured denominator.
 *
 * It sits with the API-price-equivalent total because that total, and every
 * figure derived from it, covers only the indexed share.
 */
function renderHistoryProgress(data) {
  const container = $("#history-progress");
  if (!container) return;
  const history = data?.pricing?.historyCoverage
    ?? data?.accounting?.historyCoverage
    ?? null;
  const total = finite(history?.sourceCount, null);
  const indexed = finite(history?.indexedSourceCount, null);
  const partialTerminal = history?.phase === "partial_terminal";
  const aggregateUnavailable = history?.phase === "aggregate_unavailable";
  if (history === null || history.status === "complete"
      || (total !== null && total <= 0)) {
    container.hidden = true;
    return false;
  }
  container.hidden = false;
  const track = $("#history-progress-track");
  if (total === null || indexed === null) {
    track.hidden = true;
    $("#history-progress-fill").style.width = "0%";
    setLocalizedText(
      $("#history-progress-headline"),
      "dashboard.history.coverageUnknownHeadline",
    );
    setLocalizedText(
      $("#history-progress-detail"),
      "dashboard.history.coverageUnknownDetail",
    );
    setLocalizedText(
      $("#history-progress-note"),
      "dashboard.history.coverageUnknownNote",
    );
    return true;
  }
  const percent = (indexed / total) * 100;
  const skippedSourceCount = finite(history?.skippedSourceCount, 0);
  const skippedSources = tPlural(
    "format.rolloutSourceCount",
    skippedSourceCount,
    { count: formatNumber(skippedSourceCount) },
  );
  if (aggregateUnavailable) {
    setLocalizedText(
      $("#history-progress-headline"),
      "dashboard.history.scanFinished",
    );
  } else if (partialTerminal) {
    setRawText(
      $("#history-progress-headline"),
      t("dashboard.history.partialHeadline", {
        sources: skippedSources,
      }),
    );
  } else {
    setLocalizedText(
      $("#history-progress-headline"),
history.phase === "not_started"
        ? "dashboard.history.indexingNotStarted"
        : "dashboard.history.indexingPaused",
      { percent: formatPercent(percent, 1) },
    );
  }
  track.hidden = false;
  track.setAttribute("aria-valuenow", String(Math.round(percent)));
  const coverageKey = partialTerminal
      || (aggregateUnavailable && skippedSourceCount > 0)
    ? "dashboard.history.partialSources"
    : aggregateUnavailable
      ? "dashboard.history.indexedSources"
      : "dashboard.history.indexingSources";
  const coverageValues = {
    bytesIndexed: formatBytes(history.indexedBytes),
    bytesTotal: formatBytes(history.sourceBytes),
    indexed: formatNumber(indexed),
    total: formatNumber(total),
    sources: skippedSources,
  };
  // The bar alone would announce a bare percentage. The counted sources are
  // the fact worth hearing, so they are what it reports.
  track.setAttribute("aria-valuetext", t(coverageKey, coverageValues));
  // A started-but-tiny index must still be visibly non-empty, or 2.7% reads as
  // "nothing has happened".
  $("#history-progress-fill").style.width =
    `${indexed > 0 ? Math.max(1.5, percent) : 0}%`;
  setLocalizedText($("#history-progress-detail"), coverageKey, coverageValues);
  if (aggregateUnavailable) {
    setLocalizedText(
      $("#history-progress-note"),
      "dashboard.history.summaryUnavailable",
    );
  } else if (partialTerminal) {
    const affectedThreads = finite(history?.skippedThreadCount, 0);
    setRawText(
      $("#history-progress-note"),
      tPlural("dashboard.history.partialNote", affectedThreads, {
        count: formatNumber(affectedThreads),
      }),
    );
  } else {
    setLocalizedText(
      $("#history-progress-note"),
      "dashboard.history.indexingResumes",
    );
  }
  return true;
}

/**
 * Statements the local companion published about the evidence behind a figure.
 *
 * The companion writes each one as a finished English sentence and publishes no
 * category alongside it. This page therefore decides only *where* a sentence
 * appears. Repeated freshness, indexing and unknown-model notices are represented
 * by the existing freshness status, history progress and partial-price marker. Other strings
 * are written with `setRawText`, so each one
 * reaches the document as text, unreworded and untruncated, and localization
 * cannot reinterpret it.
 *
 * Placement is matched on the vocabulary the companion itself assembles these
 * strings from. A sentence this build does not recognize is still shown — with
 * the observations at the top of the overview — rather than dropped.
 */
const EVIDENCE_WARNING_ROUTES = Object.freeze([
  // Anything about the history index qualifies the indexed-history totals,
  // which are the figures the accounting period selector can show.
  { pattern: /\bindex(?:ed|ing)\b/iu, selector: "#accounting-warnings" },
  // Anything about prices, cost, or the accounting cache qualifies the
  // API-price-equivalent figure the overview headlines.
  {
    pattern: /\b(?:accounting|cost|price|prices|priced|pricing|unpriced)\b/iu,
    selector: "#cost-warnings",
  },
]);
const EVIDENCE_WARNING_FALLBACK = "#evidence-warnings";
// Coverage that is still growing is progress, not a failure. A caveat on a
// figure that is already being shown is not progress, and must not be dressed
// as it.
const EVIDENCE_WARNING_PROGRESS =
  /\b(?:advance|advances|advancing|expand|expands|still)\b/iu;
// A load already in flight, and tracking that simply started fresh, are
// information, not faults: the sentence names its own resolution. These share
// the quiet blue treatment, so the alert color is reserved for caveats on
// figures that are actually degraded (owner-directed, 2026-08-19: degraded
// notes read as errors in dogfood). Deliberately absent: the withheld-cache
// sentences and their vocabulary — that state is being replaced wholesale by
// serve-stale-while-recalculating, and its rendering is owned there.
const EVIDENCE_WARNING_INFORMATIONAL =
  /\b(?:loading|indexing|started fresh|limited history coverage)\b/iu;

function evidenceWarningTarget(message) {
  return EVIDENCE_WARNING_ROUTES
    .find((route) => route.pattern.test(message))
    ?.selector ?? EVIDENCE_WARNING_FALLBACK;
}

function renderEvidenceWarnings(data) {
  const grouped = new Map([
    ...EVIDENCE_WARNING_ROUTES.map((route) => [route.selector, []]),
    [EVIDENCE_WARNING_FALLBACK, []],
  ]);
  for (const message of Array.isArray(data?.warnings) ? data.warnings : []) {
    if (typeof message !== "string" || message === "") continue;
    const localized = evidenceWarningLocalization(message);
    if (localized?.key === "dashboard.warning.collectorOld") continue;
    if (localized?.key === "dashboard.warning.indexing") continue;
    if (localized?.key === "dashboard.warning.unknownModel") {
      continue;
    }
    if (/^Quota tracking started fresh on this computer, so its retained records begin /u.test(message)) continue;
    grouped.get(evidenceWarningTarget(message)).push(message);
  }
  for (const [selector, messages] of grouped) {
    const list = $(selector);
    if (!list) continue;
    clear(list);
    // Nothing published means nothing rendered: no empty container and no
    // "no warnings" state.
    list.hidden = messages.length === 0;
    for (const message of messages) {
      const item = node("li", EVIDENCE_WARNING_PROGRESS.test(message)
        ? "evidence-warning progress"
        : EVIDENCE_WARNING_INFORMATIONAL.test(message)
          ? "evidence-warning informational"
          : "evidence-warning");
      const localized = evidenceWarningLocalization(message);
      if (localized) setLocalizedText(item, localized.key, localized.values);
      else setRawText(item, message);
      list.append(item);
    }
  }
}

function humanize(value) {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function matchedRollingPairs(data) {
  if (allowanceTimelineUsage(data).length) {
    return liveTimelinePoints(data, {
      windowHours: CALIBRATION_WINDOW_HOURS,
      rangeDays: activeUsageRangeDays,
    })
      .filter((row) => row.observed !== null && row.expected !== null);
  }
  // Retained gradient artifacts are Standard-priced. They remain historical
  // diagnostics, but cannot supply an allowance comparison without the
  // bucket-level speed evidence needed to match the numerator and capacity.
  return [];
}

function allowanceTimelineUsage(data) {
  return data.allowancePlanSelection
    ? data.timeline?.selectedPlanUsage ?? []
    : data.timeline?.usage ?? [];
}

function renderPublishedUnknownSpeedPolicy(target, data) {
  if (!target) return;
  const policy = data?.timeline?.unknownSpeedPolicy;
  target.hidden = !policy;
  if (!policy) { target.textContent = ""; return; }
  setLocalizedText(target, `allowance.unknownSpeed.${policy.mode}`, policy.mode === "custom"
    ? { percent: formatDecimal(policy.customFastRatioBps / 100, 2) } : {});
}

function renderComparison(data) {
  data = selectAllowancePlanPopulation(data, activeWeeklyPlanType);
  renderPublishedUnknownSpeedPolicy($("#calibration-unknown-speed-policy"), data);
  const gapValue = $("#comparison-gap");
  const status = $("#comparison-status");
  if (gapValue) gapValue.textContent = "—";
  if (status) { status.hidden = true; status.textContent = ""; }
  const planNote = $("#comparison-plan-note");
  if (planNote) {
    planNote.hidden = data.allowancePlanSelection?.comparisonAvailable !== true;
    if (!planNote.hidden) setLocalizedText(planNote,
      "weekly.plan.comparisonConditional",
      { plan: allowancePlanLabel(data.weekly.planType) || t("weekly.plan.unknown") });
  }
  // The observed-versus-calculated comparison depends on the calibration
  // capacity; when that capacity is served from the previous version's cache
  // during a recalculation, the comparison says so, quietly.
  renderStaleServeNote(
    $("#comparison-stale-note"),
    data?.timeline?.allowanceCapacity?.stale?.stale === true,
  );
  const matchedPairs = matchedRollingPairs(data);
  const pair = matchedPairs.at(-1) ?? null;
  const summary = data.gradient.summary ?? {};
  const weeklySummary = data.weekly.summary ?? {};
  const legacyDemo = data.mode === "demo" && !data.allowancePlanSelection;
  const mae = matchedPairs.length > 0
    ? matchedPairs.reduce(
      (sum, row) => sum + Math.abs(row.observed - row.expected),
      0,
    ) / matchedPairs.length
    : legacyDemo
      ? finite(summary.mean_absolute_error_pp ?? summary.meanAbsoluteErrorPp)
      : null;
  const within = legacyDemo
    ? finite(
      summary.points_within_80_band_fraction
        ?? summary.pointsWithin80BandFraction,
    )
    : null;
  // Allowance rates use the published unknown-speed scenario capacity.
  // The independent Standard-priced composition vector remains model detail.
  const capacity = finite(
    weeklySummary.median_weekly_value_usd
      ?? weeklySummary.medianWeeklyValueUsd
      ?? (legacyDemo ? summary.capacity_usd ?? summary.capacityUsd : null),
  );
  const capacityByModel = weeklySummary.capacity_by_model
      && typeof weeklySummary.capacity_by_model === "object"
      && !Array.isArray(weeklySummary.capacity_by_model)
    ? weeklySummary.capacity_by_model
    : null;
  // The fitted mix behind that vector, so the disclosure can name the models
  // that consumed the allowance without earning a column of their own.
  const modelCostShares = weeklySummary.model_cost_shares
      && typeof weeklySummary.model_cost_shares === "object"
      && !Array.isArray(weeklySummary.model_cost_shares)
    ? weeklySummary.model_cost_shares
    : null;
  const lower = finite(
    weeklySummary.lower_80_across_resets_usd
      ?? weeklySummary.lower80Usd
      ?? (legacyDemo ? summary.lower_80_usd ?? summary.lower80Usd : null),
  );
  const upper = finite(
    weeklySummary.upper_80_across_resets_usd
      ?? weeklySummary.upper80Usd
      ?? (legacyDemo ? summary.upper_80_usd ?? summary.upper80Usd : null),
  );
  const qualifyingResets = finite(
    weeklySummary.qualifying_resets ?? weeklySummary.qualifyingResets,
    0,
  );
  const chip = $("#fit-chip");
  renderCalibrationRate({
    capacity,
    lower,
    upper,
    qualifyingResets,
    capacityByModel,
    modelCostShares,
  });
  if (!pair || pair.observed === null || pair.expected === null) {
    // A new population must not retain the previous plan's visible bars.
    for (const row of $("#comparison-visual").querySelectorAll(".comparison-row")) {
      row.querySelector("i").style.width = "0%";
      row.querySelector("strong").textContent = "—";
    }
    setProductText(chip, "Insufficient");
    if (data.allowancePlanSelection?.comparisonAvailable === false) {
      setLocalizedText($("#comparison-result"), "weekly.plan.comparisonPending");
    } else {
      setProductText(
        $("#comparison-result"),
        "There is not yet a matched quota-and-cost window to compare.",
      );
    }
    if (status) {
      status.textContent = $("#comparison-result").textContent;
      status.hidden = false;
    }
    return;
  }
  const max = Math.max(Math.abs(pair.observed), Math.abs(pair.expected), 1);
  const rows = $("#comparison-visual").querySelectorAll(".comparison-row");
  const values = [pair.observed, pair.expected];
  rows.forEach((row, index) => {
    row.querySelector("i").style.width = `${Math.min(100, Math.abs(values[index]) / max * 100)}%`;
    row.querySelector("strong").textContent = formatPp(values[index]);
  });
  const residual = pair.residual ?? pair.observed - pair.expected;
  if (gapValue) gapValue.textContent = formatPp(Math.abs(residual));
  chip.textContent = mae === null
    ? t("dashboard.comparison.matchedWindow")
    : t("dashboard.comparison.mae", { value: formatDecimal(mae, 1) });
  const latestMovement = t("dashboard.comparison.latestMovement", {
    residual: formatPp(Math.abs(residual)),
  });
  const seriesBand = within === null
    ? ""
    : ` ${t("dashboard.comparison.seriesBand", {
      percent: formatPercent(within * 100),
    })}`;
  $("#comparison-result").textContent = latestMovement + seriesBand;
}

// Owner-directed restyle (2026-08-10): the fitted-rate facts render as a
// compact stat row. Each tile holds the bare figure; its unit lives in the
// fixed label beneath it, and the sentence-length "example translation" moved
// into the prose below the stats — it is a sentence, not a datum.
function renderCalibrationRate({
  capacity,
  lower,
  upper,
  qualifyingResets = 0,
  capacityByModel = null,
  modelCostShares = null,
}) {
  const rate = $("#calibration-rate");
  const range = $("#calibration-range");
  const example = $("#calibration-example");
  const explanation = $("#calibration-explanation");
  renderCalibrationModelRates(capacityByModel, modelCostShares);
  if (capacity === null || capacity <= 0) {
    setProductText(rate, "Not estimable");
    setProductText(range, "Not estimable");
    if (example) example.hidden = true;
    setLocalizedText(explanation, "dashboard.calibration.noRate");
    return;
  }
  const perPoint = capacity / 100;
  const movementForHundred = 10_000 / capacity;
  const hasRange = lower !== null && lower > 0 && upper !== null && upper > 0;
  setRawText(rate, formatMoney(perPoint, 2));
  if (hasRange) {
    setRawText(
      range,
      `${formatMoney(lower / 100, 2)}–${formatMoney(upper / 100, 2)}`,
    );
  } else {
    setLocalizedText(range, "dashboard.calibration.rangeUnavailable");
  }
  if (example) example.hidden = false;
  setLocalizedText(example, "dashboard.calibration.example", {
    points: formatDecimal(movementForHundred, 1),
  });
  if (hasRange) {
    setLocalizedText(explanation, "dashboard.calibration.withRange", {
      count: Math.max(1, Math.round(qualifyingResets)),
      amount: formatMoney(capacity, 0),
      lower: formatMoney(lower, 0),
      upper: formatMoney(upper, 0),
    });
  } else {
    setLocalizedText(explanation, "dashboard.calibration.withoutRange", {
      amount: formatMoney(capacity, 0),
    });
  }
}

// Mirrors `MODEL_COMPOSITION_POLICY.otherModelKey` in the composition kernel:
// the column every model under the share floor is folded into. It is a rate,
// not a model, so it is never listed as one.
const COMPOSITION_OTHER_MODEL_KEY = "other";

// One row of the per-model disclosure: the model's display name, an optional
// qualifier explaining why it has no fitted rate of its own, and the rate the
// fit charges it.
function calibrationModelRow(model, perPointUsd, qualifier) {
  const item = node("li", "");
  const label = node("span", "calibration-model-label");
  const name = node("span", "");
  // Model identifiers arrive from the local companion payload; the formatter
  // maps only reviewed fragments and never echoes free text.
  setRawText(name, formatModelName(model));
  label.append(name);
  if (qualifier) {
    label.append(localizedNode("small", "", qualifier.key, qualifier.values));
  }
  const perPoint = node("strong", "");
  if (perPointUsd === null) {
    setLocalizedText(perPoint, "dashboard.calibration.perModelRateUnavailable");
  } else {
    setLocalizedText(perPoint, "dashboard.calibration.perModelRate", {
      amount: formatMoney(perPointUsd, 2),
    });
  }
  item.append(label, perPoint);
  return item;
}

// The per-model disclosure under the blended headline (owner decision
// 2026-08-10: blended "$X per point" stays the headline; per-model detail on
// expand).
//
// The rates the NNLS fit resolved lead the list. Under them come the models
// the fit saw but could not price on their own — anything below the kernel's
// share floor is folded into the pooled remainder column, which is exactly
// how their cost is priced downstream. Listing only the resolved rates read as
// if the missing models had never been used at all, which is the one thing
// this card must not imply about real usage. With no resolved rate the whole
// disclosure still stays hidden: there is no per-model detail to disclose.
function renderCalibrationModelRates(capacityByModel, modelCostShares) {
  const details = $("#calibration-models");
  const list = $("#calibration-model-list");
  const sharedNote = $("#calibration-model-shared");
  if (!details || !list) return;
  const vector = capacityByModel && typeof capacityByModel === "object"
      && !Array.isArray(capacityByModel)
    ? capacityByModel
    : {};
  const fittedRate = (model) => (
    model !== COMPOSITION_OTHER_MODEL_KEY
      && Number.isFinite(vector[model])
      && vector[model] > 0
      ? vector[model]
      : null
  );
  const rows = Object.keys(vector)
    .filter((model) => typeof model === "string" && fittedRate(model) !== null)
    .sort((left, right) => fittedRate(right) - fittedRate(left));
  const pooled = Number.isFinite(vector[COMPOSITION_OTHER_MODEL_KEY])
      && vector[COMPOSITION_OTHER_MODEL_KEY] > 0
    ? vector[COMPOSITION_OTHER_MODEL_KEY]
    : null;
  const shares = modelCostShares && typeof modelCostShares === "object"
      && !Array.isArray(modelCostShares)
    ? modelCostShares
    : {};
  const shared = Object.entries(shares)
    .filter(([model, share]) => typeof model === "string"
      && model !== COMPOSITION_OTHER_MODEL_KEY
      && fittedRate(model) === null
      && Number.isFinite(share)
      && share > 0)
    .sort(([, left], [, right]) => right - left);
  list.textContent = "";
  if (sharedNote) sharedNote.hidden = true;
  if (rows.length === 0) {
    details.hidden = true;
    details.open = false;
    return;
  }
  for (const model of rows) {
    list.append(calibrationModelRow(model, fittedRate(model) / 100, null));
  }
  for (const [model, share] of shared) {
    list.append(calibrationModelRow(
      model,
      pooled === null ? null : pooled / 100,
      {
        key: pooled === null
          ? "dashboard.calibration.perModelNoRate"
          : "dashboard.calibration.perModelShared",
        values: { share: formatPercent(share * 100, 1) },
      },
    ));
  }
  if (sharedNote && shared.length > 0) {
    setLocalizedText(sharedNote, "dashboard.calibration.perModelSharedExplainer", {
      threshold: formatPercent(COMPOSITION_MINIMUM_MODEL_COST_SHARE_PERCENT),
    });
    sharedNote.hidden = false;
  }
  details.hidden = false;
}

// ---------------------------------------------------------------------------
// Allowance display labels
// ---------------------------------------------------------------------------

// The friendly name the dashboard prints for a reported Codex plan. The keys
// are Codex's own KnownPlan vocabulary (CODEX_PLAN_TYPES) verbatim. Product
// labels state the configured personal-plan ratios independently of upstream
// display aliases; the Pro rename does not alter the recorded plan identity.
// Plans without a configured ratio are named without a fabricated number.
// "unknown" is Codex's sentinel for an unnamed plan and is deliberately
// absent, so it - like any unmapped or empty reading - draws no label.
const ALLOWANCE_PLAN_LABELS = Object.freeze({
  ...CODEX_PLAN_DISPLAY_NAMES,
  self_serve_business_prolite: "Business · Pro Lite (5×)",
  self_serve_business_usage_based: "Business · usage-based",
  enterprise_cbp_automation: "Enterprise · automation",
  enterprise_cbp_usage_based: "Enterprise · usage-based",
});

/**
 * The display label for one reported plan_type, or "" when nothing nameable
 * was reported. Only the bounded KnownPlan enum reaches a label: "unknown",
 * an empty reading, and any value outside the map all resolve to "", so the
 * dashboard prints no plan label rather than an invented one.
 */
function allowancePlanLabel(planType) {
  const candidate = typeof planType === "string" ? planType.trim() : "";
  return CODEX_PLAN_TYPES.includes(candidate)
    && Object.hasOwn(ALLOWANCE_PLAN_LABELS, candidate)
    ? ALLOWANCE_PLAN_LABELS[candidate]
    : "";
}

/**
 * A date-only label for a derived reset estimate or the latest observation.
 * It deliberately omits a time of day and any raw-log timestamp.
 */
function allowanceDateLabel(timestamp) {
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(getFormattingLocale(), {
    ...(USER_TIME_ZONE === "local time" ? {} : { timeZone: USER_TIME_ZONE }),
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(timestamp);
}

function groupRolling(rows, hours) {
  const groups = new Map();
  for (const row of rows) {
    const rowHours = finite(row.smoothing_hours ?? row.smoothingHours, hours);
    if (rowHours !== hours) continue;
    const timestamp = row.timestamp ?? row.window_end_utc ?? row.observed_at;
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) continue;
    const group = groups.get(timestamp)
      ?? { timestamp, timestampMs: Date.parse(timestamp), observed: null, expected: null };
    const series = String(row.series ?? "").toLowerCase();
    const value = finite(row.quota_change_pp ?? row.quotaChangePp);
    if (series.includes("observ")) group.observed = value;
    else if (series.includes("expect") || series.includes("cost")) group.expected = value;
    else {
      group.observed ??= finite(row.observed_quota_change_pp);
      group.expected ??= finite(row.expected_quota_change_pp);
    }
    groups.set(timestamp, group);
  }
  return [...groups.values()]
    .filter((row) => row.observed !== null || row.expected !== null)
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function latestTimelineObservationMs(data) {
  const latest = allowanceTimelineUsage(data).at(-1)?.endAt
    ?? mainWeeklyQuotaTrack(data.timeline.quota).at(-1)?.observedAt
    ?? data.freshness.latestObservedAt;
  const latestMs = Date.parse(latest);
  return Number.isFinite(latestMs) ? latestMs : null;
}

function timelineCutoffMs(data, rangeDays) {
  const selectedEnd = Date.parse(data.reportingWindow?.endAt ?? "");
  const latestMs = Number.isFinite(selectedEnd) ? selectedEnd : latestTimelineObservationMs(data);
  if (data.reportingWindow?.startAt === null) return Number.NEGATIVE_INFINITY;
  return latestMs === null
    ? Number.NEGATIVE_INFINITY
    : latestMs - rangeDays * 24 * 60 * 60 * 1_000;
}

// The "All" range button claims everything retained, so it is covered by
// definition and is the one range that cannot fall short.
const ALL_HISTORY_RANGE_DAYS = 36_500;
// A retained series legitimately begins a bucket or so inside the requested
// window, so only a real shortfall is reported rather than rounding.
const SERIES_COVERAGE_TOLERANCE = 0.95;

/**
 * How much of the labelled range the retained series can actually cover.
 *
 * A range control labels the chart with a period; the series behind that label
 * can reach back far less far, and a line chart cannot show the difference
 * between "nothing happened then" and "that time is missing". Two different
 * things produce it and neither is visible: the evidence may simply not go back
 * that far, and a rejected accounting cache makes the companion fall back to a
 * much smaller live collector projection. Rebuilding identical evidence with
 * the cache withheld took the usage series from 1,716 points spanning 30.9 days
 * to 589 spanning 16.7, and the quota series from 10,000 points spanning 30.9
 * days to 940 spanning 10.1, while the only warning the dashboard offered was
 * about prices.
 *
 * The comparison is against the extent of the retained series, not against the
 * first drawn point. An idle night at the start of a selected week leaves the
 * first bucket hours inside the window while the week itself is fully covered
 * by evidence; that is an honest label, and reporting it would bury the case
 * where the evidence really does stop short.
 *
 * Returns null when the label is honest.
 */
function seriesCoverageShortfall(data, rangeDays) {
  if (!Number.isFinite(rangeDays) || rangeDays >= ALL_HISTORY_RANGE_DAYS) return null;
  const usage = data?.timeline?.usage;
  if (!Array.isArray(usage) || usage.length === 0) return null;
  const latestMs = latestTimelineObservationMs(data);
  // The series is ascending by time - the rolling-window walk in
  // `liveTimelinePoints` and the `at(-1)` read above both depend on it - so the
  // earliest retained observation is the head, not a scan on every pan frame.
  const earliestMs = Date.parse(usage[0].startAt ?? usage[0].endAt);
  if (latestMs === null || !Number.isFinite(earliestMs)) return null;
  const claimedMs = rangeDays * 24 * 60 * 60 * 1_000;
  const coveredMs = Math.max(0, latestMs - earliestMs);
  if (coveredMs >= claimedMs * SERIES_COVERAGE_TOLERANCE) return null;
  return { claimedMs, coveredMs };
}

/**
 * State the shortfall next to the chart that is understating its own history.
 *
 * When the cause is known it is named: a withheld accounting cache is
 * repairable by a local replay, and saying only that prices are withheld leaves
 * the reader to interpret two thirds of their history vanishing as a quiet
 * month.
 */
function renderSeriesCoverage(element, data, rangeDays) {
  if (!element) return;
  const shortfall = seriesCoverageShortfall(data, rangeDays);
  if (shortfall === null) {
    element.hidden = true;
    setRawText(element, "");
    return;
  }
  element.hidden = false;
  setLocalizedText(
    element,
    data?.pricing?.accountingCacheStatus === "unavailable"
      ? "dashboard.series.shortOfRangeWithheldCache"
      : "dashboard.series.shortOfRange",
    {
      claimed: formatSpanLength(shortfall.claimedMs),
      covered: formatSpanLength(shortfall.coveredMs),
    },
  );
}

function timelineBounds(points) {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  let counted = 0;
  // A single loop over stamped milliseconds, rather than map/filter/spread over
  // re-parsed strings: this runs several times per redraw and once more for the
  // residual chart, on every frame of a pan.
  for (const point of points) {
    const at = pointTimestampMs(point);
    if (!Number.isFinite(at)) continue;
    counted += 1;
    if (at < startMs) startMs = at;
    if (at > endMs) endMs = at;
  }
  if (counted < 2) return null;
  return { startMs, endMs };
}

function normalizeTimelineViewport(points) {
  const bounds = timelineBounds(points);
  if (bounds === null) return null;
  const stored = chartViewportTarget.read();
  if (stored === null) return bounds;
  const startMs = Math.max(bounds.startMs, Math.min(stored.startMs, bounds.endMs));
  const endMs = Math.max(startMs + 1, Math.min(stored.endMs, bounds.endMs));
  if (endMs - startMs < 60_000) return bounds;
  return { startMs, endMs };
}

function timelinePointsInViewport(points, viewport) {
  if (viewport === null) return points;
  return points.filter((point) => {
    const timestamp = pointTimestampMs(point);
    return Number.isFinite(timestamp)
      && timestamp >= viewport.startMs
      && timestamp <= viewport.endMs;
  });
}

function resetTimelineViewport() {
  chartViewportTarget.write(null);
}

/**
 * Which chart the shared zoom and pan policy is acting on.
 *
 * Every interactive chart on the dashboard zooms and pans by the same rules:
 * the clamped per-event step, the minimum useful span, the rule that a fully
 * zoomed-out chart stores no viewport at all, and the reset that returns to the
 * selected date range. Those rules live once, in `zoomTimeline`, `panTimeline`,
 * and `updateTimelineViewport` below, and are reviewed there.
 *
 * A chart is therefore not a copy of that policy — it is a place to keep a
 * viewport and a way to redraw. `withChartViewport` names one for the duration
 * of a single synchronous gesture call and restores the previous target on the
 * way out, so a chart can never leak its identity into another chart's handler.
 * The calibration chart is the default target because it is the chart every
 * pre-existing caller was written against.
 */
const CALIBRATION_CHART_VIEWPORT = Object.freeze({
  read: () => timelineViewport,
  write: (value) => { timelineViewport = value; usageTimelineViewport = value; },
  render: () => scheduleUsageTimelineRender(),
});

const USAGE_CHART_VIEWPORT = Object.freeze({
  read: () => usageTimelineViewport,
  write: (value) => { usageTimelineViewport = value; timelineViewport = value; },
  render: () => scheduleUsageTimelineRender(),
});

let chartViewportTarget = CALIBRATION_CHART_VIEWPORT;

function withChartViewport(chart, run) {
  const previous = chartViewportTarget;
  chartViewportTarget = chart;
  try {
    return run();
  } finally {
    chartViewportTarget = previous;
  }
}

// Zoom is a ratio applied per step, so one step feels the same at every scale.
// A wheel step is one mouse notch — trackpads emit many small deltas per
// gesture, and each one moves only its own fraction of that step.
const TIMELINE_WHEEL_ZOOM_STEP = 1.12;
const TIMELINE_WHEEL_NOTCH_PIXELS = 100;
const TIMELINE_BUTTON_ZOOM_STEP = 1.25;
// No single wheel event, however large, may move more than one button press.
const TIMELINE_MAXIMUM_ZOOM_STEP = 1.25;
const TIMELINE_MINIMUM_SPAN_MS = 15 * 60_000;
const TIMELINE_FLOOR_SPAN_MS = 60_000;

function minimumTimelineSpanMs(bounds) {
  return Math.min(
    TIMELINE_MINIMUM_SPAN_MS,
    Math.max(TIMELINE_FLOOR_SPAN_MS, (bounds.endMs - bounds.startMs) / 200),
  );
}

function updateTimelineViewport(points, update) {
  const bounds = timelineBounds(points);
  const current = normalizeTimelineViewport(points);
  if (bounds === null || current === null) return;
  const next = update({ ...current }, bounds);
  if (!next || !Number.isFinite(next.startMs) || !Number.isFinite(next.endMs)) return;
  const minimumSpanMs = minimumTimelineSpanMs(bounds);
  const startMs = Math.max(bounds.startMs, Math.min(next.startMs, bounds.endMs - minimumSpanMs));
  const endMs = Math.min(bounds.endMs, Math.max(next.endMs, startMs + minimumSpanMs));
  chartViewportTarget.write(endMs - startMs >= bounds.endMs - bounds.startMs - 1
    ? null
    : { startMs, endMs });
  chartViewportTarget.render();
}

/**
 * One redraw per displayed frame, however many input events arrive.
 *
 * A mouse notch is one event, but a trackpad flick emits dozens of small wheel
 * deltas and a drag emits a `pointermove` for every sampled position — the
 * pointer sampling rate is well above the display rate on current hardware.
 * Redrawing synchronously inside each handler meant the chart was rebuilt many
 * times for a single painted frame, and the extra rebuilds were never shown to
 * anyone. The viewport arithmetic still runs on every event, so the gesture
 * stays exact; only the drawing is coalesced.
 */
let timelineRenderFrame = 0;

function scheduleTimelineRender() {
  if (!dashboard) return;
  if (typeof requestAnimationFrame !== "function") {
    renderTimeline(dashboard);
    return;
  }
  if (timelineRenderFrame !== 0) return;
  timelineRenderFrame = requestAnimationFrame(() => {
    timelineRenderFrame = 0;
    if (dashboard) renderTimeline(dashboard);
  });
}

function wheelZoomFactor(event) {
  // deltaMode 1 reports lines and 2 reports pages; both are converted to the
  // pixel delta a mouse notch reports so one notch is one step on any device.
  const pixels = event.deltaMode === 1
    ? event.deltaY * 16
    : event.deltaMode === 2
      ? event.deltaY * 400
      : event.deltaY;
  return TIMELINE_WHEEL_ZOOM_STEP ** (pixels / TIMELINE_WHEEL_NOTCH_PIXELS);
}

function zoomTimeline(points, factor, anchorRatio = .5) {
  const step = Math.max(
    1 / TIMELINE_MAXIMUM_ZOOM_STEP,
    Math.min(TIMELINE_MAXIMUM_ZOOM_STEP, factor),
  );
  const anchorAt = Math.max(0, Math.min(1, anchorRatio));
  updateTimelineViewport(points, (current, bounds) => {
    const span = current.endMs - current.startMs;
    const nextSpan = Math.min(
      bounds.endMs - bounds.startMs,
      Math.max(minimumTimelineSpanMs(bounds), span * step),
    );
    const anchor = current.startMs + span * anchorAt;
    return {
      startMs: anchor - nextSpan * anchorAt,
      endMs: anchor + nextSpan * (1 - anchorAt),
    };
  });
}

function panTimeline(points, fraction) {
  updateTimelineViewport(points, (current, bounds) => {
    const span = current.endMs - current.startMs;
    const shift = span * fraction;
    let startMs = current.startMs + shift;
    let endMs = current.endMs + shift;
    if (startMs < bounds.startMs) {
      endMs += bounds.startMs - startMs;
      startMs = bounds.startMs;
    }
    if (endMs > bounds.endMs) {
      startMs -= endMs - bounds.endMs;
      endMs = bounds.endMs;
    }
    return { startMs, endMs };
  });
}

// Evidence-state names reach both the SVG text layer (as shaded-interval
// tooltips) and the residual table, so they resolve through the catalogue like
// every other chart string rather than being stamped as English.
const TIMELINE_STATUS_KEYS = Object.freeze({
  matched: "chart.status.matched",
  inactive: "chart.status.inactive",
  unpriced_local_activity: "chart.status.unpricedLocalActivity",
  quota_weighting_unavailable: "chart.status.quotaWeightingUnavailable",
  unexplained_without_local_activity: "chart.status.unexplainedWithoutLocalActivity",
  missing_quota_bracket: "chart.status.missingQuotaBracket",
  reset_or_track_change: "chart.status.resetOrTrackChange",
  backward_or_ambiguous: "chart.status.backwardOrAmbiguous",
  pool_saturated: "chart.status.poolSaturated",
});

function timelineStatusKey(status) {
  return TIMELINE_STATUS_KEYS[status] ?? "chart.status.historical";
}

function timelineStatusLabel(status) {
  return t(timelineStatusKey(status));
}

function timelineStatusIntervals(points, viewport) {
  // Sorting through `Date.parse` in the comparator re-parsed each instant
  // O(log n) times. The instants are read once, then sorted as numbers.
  const rows = points
    .map((point) => ({ point, at: pointTimestampMs(point) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((left, right) => left.at - right.at);
  // A run of consecutive windows excluded by ONE mechanism is one region, and
  // merging it is a correctness fix rather than a tidy-up. Emitted per window,
  // each rect is floored to a full viewBox unit by the renderer; at 30d the
  // spacing between windows is well under a unit, so neighbours in a run
  // overlapped and composited their alpha on top of each other. The wash then
  // darkened with point DENSITY instead of duration — dense runs read as solid
  // blocks while isolated windows stayed invisible, which is precisely the
  // "I never see them" the exclusion legend was failing to explain.
  const merged = [];
  rows.forEach(({ point, at: current }, index) => {
    if (!TIMELINE_STATUS_BAND_CLASSES[point.status]) return;
    const previous = index === 0 ? viewport.startMs : rows[index - 1].at;
    const next = index === rows.length - 1 ? viewport.endMs : rows[index + 1].at;
    const startMs = Math.max(viewport.startMs, (previous + current) / 2);
    const endMs = Math.min(viewport.endMs, (current + next) / 2);
    const last = merged[merged.length - 1];
    // Adjacent windows meet exactly at their shared midpoint, so touching is
    // the test for contiguity. A matched window in between pushes the next
    // start past the previous end and correctly breaks the run.
    if (last && last.status === point.status && startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, endMs);
      return;
    }
    merged.push({ status: point.status, startMs, endMs });
  });
  return merged;
}

// The weekly track is identified by (limitId, duration) alone. The provider's
// primary/secondary slots are server-assigned UI roles — the weekly window
// flipped from `secondary` to `primary` around 2026-07-06 — so filtering by
// slot here cut the entire pre-flip era out of the series. Distinct concurrent
// instances stay separated downstream by their reset boundaries
// (sameResetBoundary), and the local pipeline already emits at most one row
// per (limitId, duration, instant).
function mainWeeklyQuotaTrack(rows) {
  return rows.filter(isPrimaryCodexWeeklyQuotaWindow);
}

// The provider restates the same reset boundary with a slightly different
// instant on each snapshot; the observed drift across this corpus is one to
// twenty-two seconds. Comparing the two strings exactly therefore reported a
// reset or track change for roughly one window in ten that had neither, and
// discarded a usable observation each time.
//
// A genuine change moves the boundary by hours — the short window is five
// hours and the long one is seven days — so two minutes is wide enough to
// absorb every observed restatement and still far too narrow to merge two
// distinct reset cycles.
const RESET_BOUNDARY_TOLERANCE_MS = 2 * 60 * 1_000;
// The weekly pool's displayed ceiling. A window whose start edge already
// reads 100 is measuring a pegged pool: observed cannot rise while cost
// keeps accruing, so the residual machinery suspends there instead of
// booking the interregnum as negative drift (pool-lifecycle addendum,
// docs/design/composition-aware-expected-line.md).
const POOL_SATURATION_CEILING_PP = 100;
// A displayed used_percent DECREASE beyond display jitter inside one reset
// boundary is a genuine reset (banked or automatic): the drift accumulation
// re-anchors rather than reading the drop as movement.
const RESET_DECREASE_THRESHOLD_PP = 5;

function sameResetBoundary(before, after) {
  if (!before || !after) return false;
  const beforeMs = Date.parse(before);
  const afterMs = Date.parse(after);
  if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) {
    // An unparseable boundary carries no tolerance to reason about, so fall
    // back to demanding that the provider repeated itself verbatim.
    return before === after;
  }
  return Math.abs(afterMs - beforeMs) <= RESET_BOUNDARY_TOLERANCE_MS;
}

function timelineCalibrationCapacity(data) {
  const capacity = data?.timeline?.allowanceCapacity;
  if (capacity?.status !== "available") return null;
  const scenario = capacity.selectedScenario;
  const selected = capacity.scenarios?.[scenario];
  const medianCapacityUsd = finite(selected?.medianCapacityUsd);
  return scenario !== null && medianCapacityUsd !== null
      && medianCapacityUsd > 0
    ? {
      scenario,
      basisId: selected.basisId,
      medianCapacityUsd,
    }
    : null;
}

function timelineAllowanceWeightedCost(row, capacitySelection) {
  const weighting = row?.allowanceWeighting;
  return capacitySelection !== null
      && weighting?.status === "complete"
      && weighting.selectedScenario === capacitySelection.scenario
      && weighting.scenarios?.[capacitySelection.scenario]?.basisId
        === capacitySelection.basisId
    ? finite(weighting.selectedUsd)
    : null;
}

function timelineComparisonInterval(data, startMs, endMs) {
  // Legacy DTOs have no plan-selection contract. A selected-plan view must
  // positively cover the entire span; absence is not evidence of continuity.
  if (!data.allowancePlanSelection) return null;
  const intervals = data.timeline.comparisonIntervals ?? [];
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (intervals[middle][0] <= startMs) low = middle + 1;
    else high = middle;
  }
  const interval = intervals[low - 1];
  return interval && endMs <= interval[1] ? interval : false;
}

// Reset classification comes from the validated companion DTO. Quota boundary
// events follow the selected main weekly plan; credits belong to the account
// and are explicitly labelled that way in the Horizon inspection text.
function timelineTypedResetEvents(data) {
  const planType = data.allowancePlanSelection?.planType ?? data.weekly?.planType;
  return (data.timeline.resetEvents ?? []).flatMap(event => {
    const lifecycle = event.kind === "reset_credit_granted" || event.kind === "reset_credit_expired";
    if (!lifecycle && (event.planType !== planType || !isPrimaryCodexWeeklyQuotaWindow({
      limitId: event.limitId, durationMinutes: event.windowDurationMins,
    }))) return [];
    return [{ ...event,
      // An interval observation cannot provide an exact reset instant. Locate
      // its marker at the confirming observation and show both interval ends.
      timestampMs: Date.parse(event.precision === "observation_interval" ? event.observedAt : event.occurredAt),
      observedAtMs: Date.parse(event.observedAt),
      intervalStartedAtMs: Date.parse(event.intervalStartedAt),
    }];
  });
}

function liveTimelinePoints(
  data,
  {
    windowHours = CALIBRATION_WINDOW_HOURS,
    rangeDays = activeCalibrationRangeDays,
    usage = allowanceTimelineUsage(data),
  } = {},
) {
  const capacitySelection = timelineCalibrationCapacity(data);
  const capacity = capacitySelection?.medianCapacityUsd ?? null;
  if (!usage.length) return [];
  const windowMs = windowHours * 60 * 60 * 1_000;
  const cutoff = timelineCutoffMs(data, rangeDays);
  const quota = mainWeeklyQuotaTrack(data.timeline.quota);
  const quotaLookup = createQuotaTimelineLookup(quota);
  // Prefix sums over the usage buckets so a shrunken window (see the
  // forward-recovery branch below) can integrate cost and events over exactly
  // the span it actually measured, instead of scaling the full-window sums.
  const usageEndsMs = usage.map((row) => Date.parse(row.endAt));
  const weightedCosts = usage.map((row) => (
    timelineAllowanceWeightedCost(row, capacitySelection)
  ));
  const costPrefix = new Float64Array(usage.length + 1);
  const weightingGapPrefix = new Uint32Array(usage.length + 1);
  const eventsPrefix = new Float64Array(usage.length + 1);
  for (let index = 0; index < usage.length; index += 1) {
    costPrefix[index + 1] = costPrefix[index]
      + (weightedCosts[index] ?? 0);
    weightingGapPrefix[index + 1] = weightingGapPrefix[index]
      + (weightedCosts[index] === null ? 1 : 0);
    eventsPrefix[index + 1] = eventsPrefix[index] + usage[index].usageEvents;
  }
  const points = [];
  let startIndex = 0;
  let rollingCost = 0;
  let rollingWeightingGaps = 0;
  let rollingEvents = 0;
  // Cumulative drift (owner-directed, 2026-08-08): the running sum of
  // per-bucket observed-minus-expected movement since the last reset boundary
  // or track change — the same signed observed-versus-expected accumulation
  // the reporting module's signed AUC integrates (see buildRollingResidual in
  // src/simple-quota-gradient.js), expressed over NON-OVERLAPPING usage
  // buckets so the rolling windows above can never double-count an hour. The
  // sum re-anchors at each boundary: within one reset it answers "how far
  // ahead of the cost-implied line has observed quota movement run since this
  // reset began". Honesty guards: no capacity or no quota row means no value,
  // and a stale quota bracket suspends the line rather than letting a static
  // observation read as growing negative drift.
  let driftAnchor = null;
  let driftCostUsd = 0;
  let comparisonSegment = 0;
  let previousComparable = false;
  let previousPlanInterval = null;
  for (let index = 0; index < usage.length; index += 1) {
    const current = usage[index];
    const endMs = Date.parse(current.endAt);
    const currentWeightedCost = weightedCosts[index];
    const planInterval = timelineComparisonInterval(data, Date.parse(current.startAt), endMs);
    if (planInterval === false || planInterval !== previousPlanInterval) {
      driftAnchor = null;
      driftCostUsd = 0;
    }
    previousPlanInterval = planInterval;
    if (currentWeightedCost === null) rollingWeightingGaps += 1;
    else rollingCost += currentWeightedCost;
    rollingEvents += current.usageEvents;
    if (currentWeightedCost === null) {
      // A missing or basis-mismatched bucket is a hard break. No rolling
      // comparison or cumulative residual may bridge an unweighted interval.
      driftAnchor = null;
      driftCostUsd = 0;
    } else if (driftAnchor !== null) {
      driftCostUsd += currentWeightedCost;
    }
    while (startIndex <= index
        && Date.parse(usage[startIndex].endAt) <= endMs - windowMs) {
      const expiredWeightedCost = weightedCosts[startIndex];
      if (expiredWeightedCost === null) rollingWeightingGaps -= 1;
      else rollingCost -= expiredWeightedCost;
      rollingEvents -= usage[startIndex].usageEvents;
      startIndex += 1;
    }
    if (endMs > Date.parse(data.reportingWindow?.endAt ?? "9999-12-31")) continue;
    const startMs = endMs - windowMs;
    const afterMatch = quotaLookup.atOrBefore(endMs);
    const maximumBracketGapMs = Math.max(30 * 60 * 1_000, windowMs);
    // The start edge prefers a backward observation, like the end edge. But
    // backward-only matching poisons every window whose start edge falls in a
    // collection silence (sleep or idle): the first ~windowMs of the next
    // work session would reach back into the silence and be excluded even
    // though observations exist just inside the window. When no backward
    // match lands within the gap, anchor on the earliest observation inside
    // the window instead and shrink the measured span to what the two
    // observations actually cover; the cost-implied side below integrates
    // the same shrunken span, so observed and expected stay commensurable.
    // A recovered span needs TWO distinct observations: with a single one,
    // the end anchor resolves to the same row as the start anchor, observed
    // is zero by construction over a zero-length span, and any cost in the
    // window would fabricate a negative residual nobody measured — so that
    // window stays honestly unbracketed.
    let startMatch = quotaLookup.atOrBefore(startMs);
    let spanStartMs = startMs;
    let spanEndMs = endMs;
    let shrunkenSpan = false;
    if (!(startMatch && startMs - startMatch.timestampMs <= maximumBracketGapMs)) {
      const forwardMatch = quotaLookup.atOrAfter(startMs);
      if (forwardMatch && forwardMatch.timestampMs < endMs
          && afterMatch && afterMatch.timestampMs > forwardMatch.timestampMs) {
        startMatch = forwardMatch;
        spanStartMs = forwardMatch.timestampMs;
        // Observed movement ends at the end-edge observation, not at the
        // bucket boundary: integrate the expected side to the same instant.
        spanEndMs = afterMatch.timestampMs;
        shrunkenSpan = true;
      } else {
        startMatch = null;
      }
    }
    if (startMatch && afterMatch && afterMatch.timestampMs > startMatch.timestampMs) {
      spanStartMs = startMatch.timestampMs;
      spanEndMs = afterMatch.timestampMs;
      shrunkenSpan = true;
    } else startMatch = null;
    const before = startMatch?.row ?? null;
    const after = afterMatch?.row ?? null;
    const planComparable = timelineComparisonInterval(data,
      Math.min(spanStartMs, startMatch?.timestampMs ?? spanStartMs),
      Math.max(spanEndMs, afterMatch?.timestampMs ?? spanEndMs)) !== false;
    const bracketed = before && after
      && planComparable
      && spanStartMs - startMatch.timestampMs <= maximumBracketGapMs
      && endMs - afterMatch.timestampMs <= maximumBracketGapMs;
    const sameReset = Boolean(bracketed)
      && sameResetBoundary(before.resetAt, after.resetAt);
    // Pool saturated: the window STARTS at the ceiling, so the display
    // cannot move no matter what the workload costs. Both series suspend —
    // a zero observed against a live expected here is not a measurement.
    //
    // Gated on `bracketed`, NOT on `sameReset`. Exhausting a pool spawns a
    // fresh pool carrying a new `resets_at`, so a window that starts pegged
    // almost always ends on a different boundary; requiring `sameReset` here
    // made saturation unobservable in exactly the case it exists to describe,
    // and every such window was booked as a plain track change instead. This
    // also restores parity with the local pipeline, which has always read
    // saturation off the start edge alone (`src/simple-quota-gradient.js`).
    // `observed` already required `sameReset`, so no window changes from
    // measured to suspended — only the label it is suspended under.
    const poolSaturated = Boolean(bracketed)
      && before.usedPercent >= POOL_SATURATION_CEILING_PP;
    const observed = !poolSaturated
        && sameReset
        && after.usedPercent >= before.usedPercent
      ? after.usedPercent - before.usedPercent
      : null;
    let windowCostUsd = Math.max(0, rollingCost);
    let windowWeightingGaps = rollingWeightingGaps;
    let windowEvents = Math.max(0, rollingEvents);
    if (shrunkenSpan) {
      // Only the usage buckets ending inside the measured span count, so the
      // expected line integrates the interval the observed delta covers —
      // (spanStartMs, spanEndMs], both edges pinned to real observations.
      let lower = 0;
      let upper = index + 1;
      while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (usageEndsMs[middle] <= spanStartMs) {
          lower = middle + 1;
        } else {
          upper = middle;
        }
      }
      let top = lower;
      let topUpper = index + 1;
      while (top < topUpper) {
        const middle = top + Math.floor((topUpper - top) / 2);
        if (usageEndsMs[middle] <= spanEndMs) {
          top = middle + 1;
        } else {
          topUpper = middle;
        }
      }
      windowCostUsd = Math.max(0, costPrefix[top] - costPrefix[lower]);
      windowWeightingGaps = weightingGapPrefix[top]
        - weightingGapPrefix[lower];
      windowEvents = Math.max(0, eventsPrefix[top] - eventsPrefix[lower]);
    }
    const expected = !poolSaturated
        && planComparable
        && capacity !== null && capacity > 0
        && windowWeightingGaps === 0
      ? windowCostUsd / capacity * 100
      : null;
    const classifiedEvidence = classifyTimelineEvidence({
      bracketed,
      sameReset,
      observed,
      expected,
      usageEvents: windowEvents,
      apiCostUsd: windowWeightingGaps === 0 ? windowCostUsd : 0,
      poolSaturated,
    });
    const evidence = !planComparable
      ? { status: "reset_or_track_change", residual: null }
      : windowWeightingGaps === 0 ? classifiedEvidence
        : { status: "quota_weighting_unavailable", residual: null };
    const costAt = timestamp => {
      let low = 0, high = index + 1;
      while (low < high) { const mid = (low + high) >>> 1;
        if (usageEndsMs[mid] <= timestamp) low = mid + 1; else high = mid; }
      return costPrefix[low];
    };
    if (driftAnchor && afterMatch) driftCostUsd = costAt(afterMatch.timestampMs) - driftAnchor.costAt;
    let cumulativeResidual = null;
    // A re-anchor marks the first drift observation of a new reset or track:
    // the deviation-period detector splits its runs here, so a sustained drift
    // that crosses a boundary is never read as one continuous period across the
    // reset. Stamped on the point so the flag survives viewport filtering.
    let driftReanchor = false;
    let resetEvent = null;
    if (capacity !== null && capacity > 0
        && currentWeightedCost !== null
        && after !== null
        && timelineComparisonInterval(data,
          Math.min(Date.parse(current.startAt), afterMatch.timestampMs), endMs) !== false
        && Number.isFinite(finite(after.usedPercent))
        && endMs - afterMatch.timestampMs <= maximumBracketGapMs) {
      // A used_percent DECREASE beyond display jitter inside one boundary is
      // a genuine reset (banked/automatic resets keep resets_at) — but ONLY
      // when a SECOND, distinct observation confirms it. A single sub-envelope
      // reading that immediately recovers is a stale interleaved source (the
      // composition kernel's rule; live-corpus precedent 59 -> 6 -> 61), and
      // re-anchoring on it would poison the baseline so the recovery reads as
      // a fabricated +50pp drift period.
      const boundaryChanged = driftAnchor === null
        || !sameResetBoundary(driftAnchor.resetAt, after.resetAt);
      const subEnvelope = !boundaryChanged
        && after.usedPercent
          < driftAnchor.maxUsedPercent - RESET_DECREASE_THRESHOLD_PP;
      const confirmedReset = subEnvelope
        && driftAnchor.pendingDrop !== null
        && afterMatch.timestampMs !== driftAnchor.pendingDrop.timestampMs
        && after.usedPercent
          <= driftAnchor.pendingDrop.usedPercent + RESET_DECREASE_THRESHOLD_PP;
      if (boundaryChanged || confirmedReset) {
        // Expose the existing anchor decision; do not classify scheduled/banked
        // resets without provider evidence. Initial anchors and recovery after
        // missing pricing or a plan transition are not reset events.
        if (driftAnchor !== null) {
          resetEvent = {
            timestampMs: confirmedReset ? driftAnchor.pendingDrop.timestampMs : afterMatch.timestampMs,
            confirmedAtMs: afterMatch.timestampMs,
            kind: confirmedReset || after.usedPercent < driftAnchor.maxUsedPercent - RESET_DECREASE_THRESHOLD_PP
              ? "observed_reset" : "window_change",
          };
        }
        // A boundary or track change re-anchors the accumulation: drift is
        // zero by definition at the first observation of a new reset.
        driftAnchor = {
          resetAt: after.resetAt,
          costAt: costAt(afterMatch.timestampMs),
          usedPercent: after.usedPercent,
          maxUsedPercent: after.usedPercent,
          pendingDrop: null,
        };
        driftCostUsd = 0;
        cumulativeResidual = 0;
        driftReanchor = true;
      } else if (subEnvelope) {
        // First (or non-confirming) sub-envelope observation: either a stale
        // source or the first sight of a reset — unmeasurable against this
        // anchor either way, so the accumulation suspends for this point
        // (null splits detector runs) instead of booking the dip as drift.
        if (driftAnchor.pendingDrop === null
            || afterMatch.timestampMs !== driftAnchor.pendingDrop.timestampMs) {
          driftAnchor.pendingDrop = {
            usedPercent: after.usedPercent,
            timestampMs: afterMatch.timestampMs,
          };
        }
        if (driftAnchor.maxUsedPercent >= POOL_SATURATION_CEILING_PP) {
          // Still inside a pegged span: keep post-peg cost out of the
          // accumulation exactly as the saturated branch below does.
          driftCostUsd -= currentWeightedCost;
        }
        cumulativeResidual = null;
      } else if (driftAnchor.maxUsedPercent >= POOL_SATURATION_CEILING_PP) {
        driftAnchor.pendingDrop = null;
        // The pool pegged earlier in this reset: post-peg cost cannot be
        // measured against a display that can no longer move. Suspend the
        // accumulation (null splits detector runs) and keep the accrued cost
        // out of it, so a later re-anchor starts clean.
        driftCostUsd -= currentWeightedCost;
        cumulativeResidual = null;
      } else {
        // Recovery or normal movement clears any unconfirmed drop candidate.
        driftAnchor.pendingDrop = null;
        driftAnchor.maxUsedPercent = Math.max(
          driftAnchor.maxUsedPercent,
          after.usedPercent,
        );
        cumulativeResidual = after.usedPercent - driftAnchor.usedPercent
          - driftCostUsd / capacity * 100;
      }
    }
    const comparable = observed !== null && expected !== null;
    if (comparable && !previousComparable) comparisonSegment += 1;
    previousComparable = comparable;
    if (endMs < cutoff) continue;
    points.push({
      timestamp: current.endAt,
      timestampMs: endMs,
      observed,
      expected,
      residual: evidence.residual,
      cumulativeResidual,
      driftReanchor,
      resetEvent,
      // Kept under the legacy internal key for downstream chart diagnostics,
      // but this is now the selected speed-priced amount, never Standard
      // dollars paired with a Fast-adjusted capacity.
      apiCostUsd: planComparable && windowWeightingGaps === 0 ? windowCostUsd : null,
      allowanceWeightedUsd: planComparable && windowWeightingGaps === 0
        ? windowCostUsd
        : null,
      allowanceBasisId: capacitySelection?.basisId ?? null,
      residualSegment: comparable ? comparisonSegment : null,
      usageEvents: windowEvents,
      // The span both lines actually integrate: the nominal window unless the
      // start edge was recovered forward past a collection silence, in which
      // case both edges sit on real observations.
      measuredSpanMs: spanEndMs - spanStartMs,
      measurementStartedAt: spanStartMs,
      measurementEndedAt: spanEndMs,
      status: evidence.status,
    });
  }
  return points;
}

function groupedUsageTimeline(data) {
  const capacitySelection = timelineCalibrationCapacity(data);
  const hourMs = 60 * 60 * 1_000;
  const cutoff = timelineCutoffMs(data, activeUsageRangeDays);
  const groups = new Map();
  for (const row of allowanceTimelineUsage(data)) {
    const timestamp = Date.parse(row.startAt);
    if (!Number.isFinite(timestamp) || timestamp < cutoff
        || Date.parse(row.endAt) > Date.parse(data.reportingWindow?.endAt ?? "9999-12-31")) continue;
    let key;
    let sortMs;
    if (activeUsageGrouping === "hour") {
      sortMs = Math.floor(timestamp / hourMs) * hourMs;
      key = `hour:${sortMs}`;
    } else {
      const parts = Object.fromEntries(
        localCalendarParts().formatToParts(timestamp)
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value])
      );
      const civilDayMs = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day)
      );
      sortMs = activeUsageGrouping === "week"
        ? civilDayMs - ((new Date(civilDayMs).getUTCDay() + 6) % 7) * 24 * hourMs
        : civilDayMs;
      key = `${activeUsageGrouping}:${new Date(sortMs).toISOString().slice(0, 10)}`;
    }
    const rowStartMs = Date.parse(row.startAt);
    const rowEndMs = Date.parse(row.endAt);
    const group = groups.get(key) ?? {
      sortMs,
      periodStartMs: rowStartMs,
      periodEndMs: rowEndMs,
      standardApiCostUsd: 0,
      quotaWeightedCostUsd: 0,
      weightingGaps: 0,
      usageEvents: 0,
      totalTokens: 0
    };
    group.periodStartMs = Math.min(group.periodStartMs, rowStartMs);
    group.periodEndMs = Math.max(group.periodEndMs, rowEndMs);
    group.standardApiCostUsd += row.apiPriceEquivalentUsd;
    const weighted = timelineAllowanceWeightedCost(row, capacitySelection);
    if (weighted === null) group.weightingGaps += 1;
    else group.quotaWeightedCostUsd += weighted;
    group.usageEvents += row.usageEvents;
    group.totalTokens += row.totalTokens;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => left.sortMs - right.sortMs)
    .map(({ sortMs: _sortMs, periodStartMs, periodEndMs, ...row }) => {
      const quotaWeightedCostUsd = row.weightingGaps === 0
        ? Number(row.quotaWeightedCostUsd.toFixed(6))
        : null;
      return {
        ...row,
        timestamp: new Date(periodEndMs).toISOString(),
        timestampMs: periodEndMs,
        periodStartAt: new Date(periodStartMs).toISOString(),
        periodEndAt: new Date(periodEndMs).toISOString(),
        standardApiCostUsd: Number(row.standardApiCostUsd.toFixed(6)),
        quotaWeightedCostUsd,
        allowanceBasisId: quotaWeightedCostUsd === null
          ? null
          : capacitySelection.basisId,
      };
    });
}

function usagePointsWithAllowance(data, points, includeAllowance) {
  const quota = mainWeeklyQuotaTrack(data.timeline.quota);
  const quotaLookup = createQuotaTimelineLookup(quota);
  const maximumObservationAgeMs = {
    hour: 6 * 60 * 60 * 1_000,
    day: 12 * 60 * 60 * 1_000,
    week: 24 * 60 * 60 * 1_000
  }[activeUsageGrouping] ?? 6 * 60 * 60 * 1_000;
  let allowanceSegment = 0;
  let lastResetAt = null;
  return points.map((point) => {
    const endMs = Date.parse(point.periodEndAt ?? point.timestamp);
    const observationMatch = quotaLookup.atOrBefore(endMs);
    const observationAge = observationMatch
      ? endMs - observationMatch.timestampMs
      : Number.POSITIVE_INFINITY;
    const resetAt = observationMatch?.row.resetAt ?? null;
    if (lastResetAt !== null && !sameResetBoundary(lastResetAt, resetAt)) allowanceSegment += 1;
    lastResetAt = resetAt;
    return {
      ...point,
      allowanceSegment,
      allowanceObservedAt: observationMatch?.row.observedAt ?? null,
      allowanceRemaining: includeAllowance
          && point.quotaWeightedCostUsd !== null
          && observationAge <= maximumObservationAgeMs
        ? finite(observationMatch.row.remainingPercent)
        : null
    };
  });
}

function usageGroupingsForRange(rangeDays = activeUsageRangeDays) {
  if (rangeDays <= 1) return ["hour"];
  if (rangeDays <= 7) return ["hour", "day"];
  return ["hour", "day", "week"];
}

function syncUsageGroupingControls() {
  const controls = $("#usage-group-controls");
  if (!controls) return;
  const allowed = new Set(usageGroupingsForRange());
  if (!allowed.has(activeUsageGrouping)) activeUsageGrouping = "hour";
  for (const control of controls.querySelectorAll("button[data-group]")) {
    const visible = allowed.has(control.dataset.group);
    const active = visible && control.dataset.group === activeUsageGrouping;
    control.hidden = !visible;
    control.disabled = !visible;
    control.setAttribute("aria-hidden", String(!visible));
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
}

// The vertical axis has to state its unit and its aggregation together: the
// same series is dollars per hour, per day, or per week depending on the
// selected grouping, and "API equivalent" alone said neither.
const USAGE_GROUPING_UNIT_KEYS = Object.freeze({
  hour: "chart.unit.hour",
  day: "chart.unit.day",
  week: "chart.unit.week",
});

const USAGE_GROUPING_AXIS_KEYS = Object.freeze({
  hour: "chart.axis.apiEquivalentPerHour",
  day: "chart.axis.apiEquivalentPerDay",
  week: "chart.axis.apiEquivalentPerWeek",
});

function usageGroupingUnitKey(grouping = activeUsageGrouping) {
  return USAGE_GROUPING_UNIT_KEYS[grouping] ?? "chart.unit.interval";
}

function usageChartAxisLabels(
  grouping = activeUsageGrouping,
  quotaWeighted = true,
) {
  return Object.freeze({
    primary: {
      key: quotaWeighted
        ? {
          hour: "chart.axis.quotaWeightedPerHour",
          day: "chart.axis.quotaWeightedPerDay",
          week: "chart.axis.quotaWeightedPerWeek",
        }[grouping] ?? "chart.axis.quotaWeightedPerInterval"
        : USAGE_GROUPING_AXIS_KEYS[grouping]
          ?? "chart.axis.apiEquivalentPerInterval",
    },
    secondary: { key: "chart.axis.sevenDayAllowanceRemaining" },
  });
}

// The usage chart's own derive/draw split, for the same reason the calibration
// chart has one: grouping every usage bucket in the artifact and matching each
// one against the quota track depends on the evidence and the two segmented
// controls, never on the zoom viewport, so a pan must not pay for it.
let usageSeriesMemo = null;

function selectedUsagePoints(data) {
  data = selectAllowancePlanPopulation(data, activeWeeklyPlanType);
  if (usageSeriesMemo !== null
      && usageSeriesMemo.data === data
      && usageSeriesMemo.grouping === activeUsageGrouping
      && usageSeriesMemo.rangeDays === activeUsageRangeDays) {
    return usageSeriesMemo.points;
  }
  const includeAllowance = timelineCalibrationCapacity(data) !== null;
  const points = usagePointsWithAllowance(
    data,
    groupedUsageTimeline(data),
    includeAllowance,
  );
  usageSeriesMemo = {
    data,
    grouping: activeUsageGrouping,
    rangeDays: activeUsageRangeDays,
    points,
  };
  return points;
}

let usageRenderFrame = 0;

function scheduleUsageTimelineRender() {
  if (!dashboard) return;
  if (typeof requestAnimationFrame !== "function") {
    renderUsageTimeline(dashboard);
    renderTimeline(dashboard);
    return;
  }
  if (usageRenderFrame !== 0) return;
  usageRenderFrame = requestAnimationFrame(() => {
    usageRenderFrame = 0;
    if (dashboard) { renderUsageTimeline(dashboard); renderTimeline(dashboard); }
  });
}

function resetUsageTimelineViewport() {
  timelineViewport = null;
  usageTimelineViewport = null;
}

function completeUsageTimelineTotal(points, key) {
  let total = 0;
  for (const point of points) {
    const value = finite(point?.[key]);
    if (value === null) return null;
    total += value;
  }
  return total;
}

function renderUsageTimeline(data) {
  data = selectAllowancePlanPopulation(data, activeWeeklyPlanType);
  syncUsageGroupingControls();
  const points = selectedUsagePoints(data);
  const allowancePoints = observedAllowancePoints(mainWeeklyQuotaTrack(data.timeline.quota), {
    startMs: timelineCutoffMs(data, activeUsageRangeDays),
    endMs: Date.parse(data.reportingWindow?.endAt ?? "9999-12-31"),
  }, sameResetBoundary);
  const navigationPoints = [...points, ...allowancePoints];
  const viewport = withChartViewport(
    USAGE_CHART_VIEWPORT,
    () => normalizeTimelineViewport(navigationPoints),
  );
  const visiblePoints = timelinePointsInViewport(points, viewport);
  const visibleAllowance = timelinePointsInViewport(allowancePoints, viewport);
  const shell = $("#usage-timeline-chart");
  const empty = $("#usage-timeline-empty");
  const unit = t(usageGroupingUnitKey());
  const quotaComparable = timelineCalibrationCapacity(data) !== null;
  const axisLabels = usageChartAxisLabels(activeUsageGrouping, quotaComparable);
  const unavailable = accountingIsUnavailable(data);
  empty.classList.toggle('allowance-simple-missing-usage', !visiblePoints.length && !unavailable
    && data.allowancePlanSelection?.usageAvailable === false);
  $('#usage-group-controls').hidden=!points.length;
  setLocalizedText(
    $("#usage-cost-legend-label"),
    quotaComparable
      ? "chart.series.quotaWeightedUsage"
      : "chart.series.standardApiUsage",
  );
  $("#usage-allowance-legend").hidden = !quotaComparable;
  // The shared header owns the reporting period; a numerical "All" sentinel
  // must never become a user-visible duration in a chart heading.
  setLocalizedText(
    $("#usage-timeline-title"),
    "trends.allowanceActivity",
  );
  const allowanceShell = $("#allowance-timeline-chart");
  const hasAllowance = visibleAllowance.some(point => finite(point.allowanceRemaining) !== null);
  allowanceShell.hidden = !hasAllowance;
  $("#allowance-timeline-empty").hidden = hasAllowance;
  if (hasAllowance) drawChart(allowanceShell, lineChart({
    points: visibleAllowance,
    series: [{ key: "allowanceRemaining", className: "chart-line-observed", label: { key: "trends.allowance" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY, format: value => formatPercent(value, 1),
      segmentKey: "allowanceSegment", maxGapMs: 6 * 3_600_000 }],
    yLabel: { key: "trends.remainingPercent" }, title: { key: "trends.allowance" },
    description: { key: "trends.allowanceDescription" },
    yDomain: { low: 0, high: 100, ticks: [0, 25, 50, 75, 100] }, height: 180, xDomain: viewport,
    width: Math.max(360, allowanceShell.clientWidth || 900),
  }));
  if (hasAllowance) bindUsageTimelineInteractions(allowanceShell, navigationPoints, viewport);
  if (!visiblePoints.length) {
    shell.hidden = true;
    empty.hidden = false;
    empty.dataset.state = unavailable ? "unavailable" : "empty";
    empty.querySelector("strong").textContent = unavailable
      ? t(accountingRequiresNewerBuild(data)
        ? "chart.usage.newerBuildTitle"
        : "chart.usage.unavailableTitle")
      : t(data.allowancePlanSelection?.usageAvailable === false
        ? "allowance.simple.usageUnavailable" : "chart.usage.emptyTitle");
    empty.querySelector("p").textContent = unavailable
      ? t(projectionUnavailableCopyKey(data))
      : data.allowancePlanSelection?.usageAvailable === false ? "" : t("chart.usage.emptyCopy");
  } else {
    shell.hidden = false;
    empty.hidden = true;
    drawChart(shell, lineChart({
      points: visiblePoints,
      series: [{
        key: quotaComparable ? "quotaWeightedCostUsd" : "standardApiCostUsd",
        className: "chart-line-value",
        label: {
          key: quotaComparable
            ? "chart.series.quotaWeightedUsage"
            : "chart.series.standardApiUsage",
        },
        // Bars carry per-interval activity; hover targets retain exact values.
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        connect: false,
        format: (value) => formatApiMoney(value),
      }],
      yLabel: axisLabels.primary,
      yTickFormat: (value) => formatApiMoney(value),
      title: {
        key: quotaComparable
          ? "chart.usage.title"
          : "chart.usage.standardTitle",
      },
      description: {
        key: quotaComparable
          ? "chart.usage.description"
          : "chart.usage.standardDescription",
        values: { unit, timeZone: formatTimeZoneLabel() },
      },
      includeZero: true,
      height: 150,
      width: Math.max(360, shell.clientWidth || 900),
      xDomain: viewport,
    }));
    bindUsageTimelineInteractions(shell, navigationPoints, viewport);
  }
  setLocalizedText($("#usage-timeline-copy"), "chart.timeZoneNote", {
    timeZone: formatTimeZoneLabel(),
  });
  renderSeriesCoverage(
    $("#usage-timeline-coverage"),
    data,
    activeUsageRangeDays,
  );
  const summary = $("#usage-timeline-summary");
  clear(summary);
  // The plotted weighted series already renders a missing interval as a gap.
  // Its summary must do the same: adding only finite points would publish a
  // deceptively partial allowance-facing aggregate.
  const missingUsage = unavailable || data.allowancePlanSelection?.usageAvailable === false;
  const total = missingUsage && visiblePoints.length === 0
    ? null
    : completeUsageTimelineTotal(
      visiblePoints,
      quotaComparable ? "quotaWeightedCostUsd" : "standardApiCostUsd",
    );
  for (const [name, explanation, value] of [
    [
      "Time intervals",
      "The number of displayed hour, day, or week intervals.",
      missingUsage && visiblePoints.length === 0
        ? "—"
        : compact(visiblePoints.length)
    ],
    [
      quotaComparable
        ? "Speed-priced API equivalent"
        : "Standard-rate API-price equivalent",
      quotaComparable
        ? "Standard API prices with Fast and Ultrafast increments priced at their published API rates, compared only with a capacity fitted on the same basis. This is a comparison, not a bill or included-allowance formula."
        : "A Standard-rate accounting series. Provider allowance is hidden because no matching weighted capacity is available.",
      total === null ? "—" : formatApiMoney(total)
    ]
  ]) {
    const item = node("div");
    const label = node("span");
    label.append(informationLabel(name, explanation));
    item.append(label, node("strong", "", value));
    summary.append(item);
  }
}

/**
 * Wheel, drag, and keyboard zoom for the usage chart.
 *
 * This is deliberately the same gesture vocabulary as the calibration chart
 * below it — wheel to zoom about the pointer, drag to pan, `+`/`-` and the
 * arrow keys from the keyboard, `Home` to reset — and it reaches the same
 * `zoomTimeline` and `panTimeline` policy, so both charts move by identical
 * steps and clamp identically. It is a separate binder rather than a shared one
 * because it targets a different element with its own pointer state and its own
 * viewport; the behaviour that has to stay uniform lives in the functions both
 * binders call, not in the wiring.
 */
function bindUsageTimelineInteractions(shell, points, viewport) {
  if (viewport === null) return;
  shell.classList.add("interactive-chart");
  shell.tabIndex = 0;
  shell.setAttribute("aria-label", t("chart.usage.aria", {
    timeZone: USER_TIME_ZONE,
  }));
  setLocalizedText($("#usage-zoom-status"), "dashboard.timeline.status", {
    start: formatLocal(new Date(viewport.startMs).toISOString()),
    end: formatLocal(new Date(viewport.endMs).toISOString()),
    span: formatSpanLength(viewport.endMs - viewport.startMs),
  });
  shell.onwheel = (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    const bounds = shell.getBoundingClientRect();
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : .5;
    zoomUsageTimeline(points, wheelZoomFactor(event), ratio);
  };
  shell.onpointerdown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    usagePointerStart = { x: event.clientX, dragging: false };
    shell.setPointerCapture?.(event.pointerId);
    shell.classList.add("is-pointer-active");
  };
  shell.onpointermove = (event) => {
    if (usagePointerStart === null) return;
    const width = Math.max(1, shell.getBoundingClientRect().width);
    const delta = event.clientX - usagePointerStart.x;
    if (Math.abs(delta) < 8) return;
    usagePointerStart.dragging = true;
    usagePointerStart.x = event.clientX;
    shell.classList.add("is-panning");
    event.preventDefault();
    panUsageTimeline(points, -delta / width);
  };
  const stopPanning = (event) => {
    const wasDragging = usagePointerStart?.dragging === true;
    usagePointerStart = null;
    shell.releasePointerCapture?.(event.pointerId);
    shell.classList.remove("is-pointer-active");
    shell.classList.remove("is-panning");
    if (wasDragging) event.preventDefault();
  };
  shell.onpointerup = stopPanning;
  shell.onpointercancel = stopPanning;
  shell.onselectstart = (event) => {
    if (usagePointerStart !== null) event.preventDefault();
  };
  shell.onkeydown = (event) => {
    if (["+", "="].includes(event.key)) {
      event.preventDefault();
      zoomUsageTimeline(points, 1 / TIMELINE_BUTTON_ZOOM_STEP);
    } else if (["-", "_"].includes(event.key)) {
      event.preventDefault();
      zoomUsageTimeline(points, TIMELINE_BUTTON_ZOOM_STEP);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      panUsageTimeline(points, -.2);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      panUsageTimeline(points, .2);
    } else if (event.key === "Home") {
      event.preventDefault();
      resetUsageTimelineViewport();
      scheduleUsageTimelineRender();
    }
  };
}

function zoomUsageTimeline(points, factor, anchorRatio = .5) {
  withChartViewport(
    USAGE_CHART_VIEWPORT,
    () => zoomTimeline(points, factor, anchorRatio),
  );
}

function panUsageTimeline(points, fraction) {
  withChartViewport(USAGE_CHART_VIEWPORT, () => panTimeline(points, fraction));
}

/**
 * Deriving the calibration series is the expensive half of this page: it walks
 * every usage bucket in the artifact to rebuild the rolling window, builds a
 * quota lookup, and classifies each window's evidence state. None of that
 * depends on the zoom or pan viewport — only on the loaded evidence and the
 * date-range control above the chart — yet it ran again for every wheel event,
 * which is what made the chart feel heavy to drag.
 *
 * The result is remembered against exactly the inputs it is a function of. The
 * dashboard payload is compared by identity, so a refresh that produces a new
 * object invalidates the memo without any explicit clearing, and a payload that
 * has not changed cannot serve a stale series.
 */
let timelineSeriesMemo = null;

function selectedTimelinePoints(data) {
  if (timelineSeriesMemo !== null
      && timelineSeriesMemo.data === data
      && timelineSeriesMemo.rangeDays === activeCalibrationRangeDays) {
    return timelineSeriesMemo.selection;
  }
  const scopedUsage = allowanceTimelineUsage(data);
  const livePoints = liveTimelinePoints(data, { usage: scopedUsage });
  // Retained gradient artifacts carry only Standard-rate rolling cost. They
  // can remain historical evidence elsewhere, but may never replace the
  // speed-priced allowance comparison. An unavailable weighted live series
  // therefore stays unavailable instead of silently drawing the old red line.
  const selection = {
    points: livePoints,
    usingLive: true,
  };
  timelineSeriesMemo = {
    data,
    rangeDays: activeCalibrationRangeDays,
    selection,
  };
  return selection;
}

let spendRateMemo = null;
function selectedSpendRateLookup(data) {
  if (spendRateMemo?.data === data) return spendRateMemo.lookup;
  const capacity = timelineCalibrationCapacity(data);
  const buckets = allowanceTimelineUsage(data).map(row => ({
    startMs: Date.parse(row.startAt), endMs: Date.parse(row.endAt),
    usd: timelineAllowanceWeightedCost(row, capacity),
  }));
  const lookup = createSpendRateLookup(buckets, {
    intervals: data.allowancePlanSelection ? data.timeline.comparisonIntervals ?? [] : undefined,
    // The plan-scoped contract publishes fixed fifteen-minute buckets even
    // when the legacy all-plan timeline uses a different grouping.
    bucketMs: data.allowancePlanSelection ? 900_000 : (data.timeline.bucketMinutes ?? 15) * 60_000,
  });
  spendRateMemo = { data, lookup };
  return lookup;
}

function renderTimeline(data) {
  data = selectAllowancePlanPopulation(data, activeWeeklyPlanType);
  const {
    points,
    usingLive,
  } = selectedTimelinePoints(data);
  const usageBounds = timelineBounds(selectedUsagePoints(data));
  const viewport = usageTimelineViewport ?? timelineViewport ?? usageBounds ?? normalizeTimelineViewport(points);
  const visiblePoints = timelinePointsInViewport(points, viewport);
  const matchedVisible = visiblePoints.filter(
    (point) => point.observed !== null && point.expected !== null,
  );
  const windowLabel = t("dashboard.timeWindow.hours", {
    count: CALIBRATION_WINDOW_HOURS,
  });
  setLocalizedText($("#timeline-chart-title"), "dashboard.timeline.title", {
    window: windowLabel,
  });
  $("#timeline-chart-copy").textContent = usingLive
    ? t(
      "dashboard.timeline.liveCopy",
      { timeZone: formatTimeZoneLabel() },
    )
    : t("dashboard.timeline.historicalCopy", {
      generatedAt: formatLocal(data.artifactStatus.gradient.generatedAt),
      window: windowLabel,
    });
  const empty = $("#timeline-empty");
  const shell = $("#timeline-chart");
  const unavailable = accountingIsUnavailable(data);
  if (!visiblePoints.length || (usingLive && matchedVisible.length === 0)) {
    shell.hidden = true;
    empty.hidden = false;
    empty.dataset.state = unavailable ? "unavailable" : "empty";
    empty.querySelector("strong").textContent = unavailable
      ? t(accountingRequiresNewerBuild(data)
        ? "dashboard.timeline.newerBuildTitle"
        : "dashboard.timeline.unavailableTitle")
      : visiblePoints.length
        ? t("dashboard.timeline.notComparableYet")
        : tPlural("dashboard.timeline.series", 0, { window: windowLabel });
    empty.querySelector("p").textContent = unavailable
      ? t(projectionUnavailableCopyKey(data))
      : data.allowancePlanSelection?.comparisonAvailable === false
        ? t("weekly.plan.comparisonPending")
      : visiblePoints.length
        ? t("dashboard.timeline.noBracket", { window: windowLabel })
        : t("dashboard.timeline.missingData");
  } else {
    empty.hidden = true;
    shell.hidden = false;
    drawChart(shell, lineChart({
      points: visiblePoints,
      series: [
        {
          key: "observed",
          className: "chart-line-observed",
          label: { key: "dashboard.timeline.observedQuota" },
          segmentKey: "residualSegment",
          pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
          format: formatPp,
        },
        {
          key: "expected",
          className: "chart-line-expected",
          label: { key: "dashboard.timeline.expectedCost" },
          segmentKey: "residualSegment",
          pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
          format: formatPp,
        }
      ],
      yLabel: { key: "dashboard.timeline.percentagePoints" },
      title: {
        key: "dashboard.timeline.movementTitle",
        values: { window: windowLabel },
      },
      description: {
        key: "dashboard.timeline.chartDescription",
        values: { timeZone: formatTimeZoneLabel() },
      },
      includeZero: true,
      height: 200,
      width: Math.max(360, shell.clientWidth || 900),
      xDomain: viewport,
      statusIntervals: usingLive && viewport !== null
        ? timelineStatusIntervals(points, viewport)
        : [],
    }));
    bindTimelineInteractions(shell, selectedUsagePoints(data).length > 1 ? selectedUsagePoints(data) : points, viewport);
  }
  renderSeriesCoverage(
    $("#timeline-coverage"),
    data,
    activeCalibrationRangeDays,
  );
  renderTimelineSummary(data, visiblePoints, usingLive);
  renderTimelineConfidence(data, points, visiblePoints, usingLive, viewport);
  const differenceShell = $("#difference-timeline-chart");
  const differenceLimit = visiblePoints.reduce((maximum, point) => Math.max(maximum, Math.abs(finite(point.residual, 0))), 1) * 1.1;
  differenceShell.hidden = shell.hidden;
  if (!shell.hidden) drawChart(differenceShell, lineChart({
    points: visiblePoints,
    series: [{ key: "residual", className: "chart-line-value", label: { key: "trends.difference" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY, format: formatPp, connect: false }],
    yLabel: { key: "dashboard.timeline.percentagePoints" }, title: { key: "trends.difference" },
    description: { key: "trends.differenceDescription" }, includeZero: true, height: 125, xDomain: viewport,
    width: Math.max(360, differenceShell.clientWidth || 900),
    yDomain: { low: -differenceLimit, high: differenceLimit },
  }));
  renderResiduals(data, visiblePoints, viewport);
  // The divergence panel reads the whole selected calibration range, not the
  // zoomed viewport: it answers "across this range, where did observed and
  // priced usage persistently disagree", so pan and zoom must not reshape it.
  renderDivergencePeriods(data, points);
  trendsHorizonView?.setSpendLookup(selectedSpendRateLookup(data));
  // The instrument reads observations, not the end-of-hour/day chart buckets.
  // Incompatible intervals explicitly interrupt the sample stream.
  trendsHorizonView?.setAllowanceSamples(mainWeeklyQuotaTrack(data.timeline.quota).map(row => {
    const timestampMs = Date.parse(row.observedAt);
    return { timestampMs, allowanceRemaining: finite(row.remainingPercent) };
  }));
  trendsHorizonView?.setEvents(timelineTypedResetEvents(data));
  trendsHorizonView?.refresh();
  const observations = mainWeeklyQuotaTrack(data.timeline.quota).filter(row => {
    const at = Date.parse(row.observedAt);
    return at >= Date.parse(data.reportingWindow?.startAt ?? "0001-01-01")
      && at <= Date.parse(data.reportingWindow?.endAt ?? "9999-12-31");
  }).sort((a,b) => Date.parse(b.observedAt)-Date.parse(a.observedAt));
  const allObservations = mainWeeklyQuotaTrack(data.timeline.quota).slice().sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
  allowancePage?.update({
    weeklyApi: data.timeline.selectedWeeklyApiIntervals ?? data.timeline.weeklyApiIntervals,
    period: reportingPeriod.period,
    planType: data.allowancePlanSelection?.planType ?? data.weekly?.planType,
    generatedAt: data.generatedAt,
    endMs: Date.parse(data.reportingWindow?.endAt ?? data.generatedAt),
    startMs: Number.isFinite(data.timeline.weeklyApiIntervals?.rows?.[0]?.startMs)
      ? data.timeline.weeklyApiIntervals.rows[0].startMs : Date.parse(data.reportingWindow?.startAt ?? data.generatedAt),
    scope: `${reportingPeriod.period}:${data.allowancePlanSelection?.planType ?? data.weekly?.planType}`,
    observations, points: visiblePoints,
    current: data.allowancePlanSelection?.isCurrentPlan === false ? allObservations[0] ?? null
      : data.quotaWindows?.filter(isPrimaryCodexWeeklyQuotaWindow).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0] ?? allObservations[0] ?? null,
    currentIsHistorical: data.allowancePlanSelection?.isCurrentPlan === false,
    comparisonAvailable: data.allowancePlanSelection?.comparisonAvailable,
    comparisonGaps: (data.timeline.excludedIntervals ?? []).filter(([start, end]) =>
      end > Date.parse(data.reportingWindow?.startAt ?? "0001-01-01")
      && start <= Date.parse(data.reportingWindow?.endAt ?? "9999-12-31")),
    comparisonFailure: data.allowancePlanSelection?.failure,
    events: timelineTypedResetEvents(data).filter(e => e.timestampMs >= Date.parse(data.reportingWindow?.startAt ?? "0001-01-01")
      && e.timestampMs <= Date.parse(data.reportingWindow?.endAt ?? "9999-12-31"))
      .map(e=>({...e,caption:resetEventPresentation(e,{t,formatInstant:at=>formatChartTimestamp(new Date(at).toISOString())}).caption}))
      .sort((a,b)=>b.timestampMs-a.timestampMs),
  });
}

// The copy names each exclusion mechanism that actually fired, in classifier
// order. A mechanism with zero windows is never mentioned, so the sentence
// cannot claim ambiguity (or anything else) that did not occur.
const TIMELINE_EXCLUSION_MESSAGE_KEYS = Object.freeze([
  ["quota_weighting_unavailable", "dashboard.timeline.excludedQuotaWeighting"],
  ["missing_quota_bracket", "dashboard.timeline.excludedMissingBracket"],
  ["reset_or_track_change", "dashboard.timeline.excludedResetOrTrackChange"],
  ["backward_or_ambiguous", "dashboard.timeline.excludedAmbiguousMovement"],
  ["pool_saturated", "dashboard.timeline.excludedPoolSaturated"],
]);

function describeTimelineExclusions(activePoints) {
  const counts = new Map();
  for (const point of activePoints) {
    if (point.observed !== null && point.expected !== null) continue;
    counts.set(point.status, (counts.get(point.status) ?? 0) + 1);
  }
  const described = TIMELINE_EXCLUSION_MESSAGE_KEYS
    .filter(([status]) => (counts.get(status) ?? 0) > 0)
    .map(([status, key]) => tPlural(key, counts.get(status)))
    .join(t("dashboard.timeline.exclusionJoin"));
  return described === "" ? t("dashboard.timeline.noExclusions") : described;
}

function renderTimelineConfidence(
  data,
  allPoints,
  visiblePoints,
  usingLive,
  viewport,
) {
  const element = $("#timeline-confidence");
  if (accountingIsUnavailable(data)) {
    element.classList.add("low");
    setLocalizedText(element, projectionUnavailableCopyKey(data));
    return;
  }
  if (data.allowancePlanSelection?.comparisonAvailable === false) {
    element.classList.add("low");
    setLocalizedText(element, "weekly.plan.comparisonPending");
    return;
  }
  const activePoints = visiblePoints.filter((point) => point.status !== "inactive");
  const matched = activePoints.filter((point) => point.observed !== null && point.expected !== null).length;
  const excluded = activePoints.length - matched;
  const full = timelineBounds(allPoints);
  const zoomed = viewport !== null && full !== null
    && (viewport.startMs !== full.startMs || viewport.endMs !== full.endMs);
  element.classList.toggle("low", matched < 3 || excluded > matched);
  if (!visiblePoints.length) {
    setLocalizedText(element, "dashboard.timeline.noVisiblePoints");
  } else if (activePoints.length === 0) {
    setLocalizedText(element, "dashboard.timeline.noActivity");
  } else if (!usingLive) {
    setLocalizedText(element, "dashboard.timeline.historicalOnly");
  } else if (matched < 3) {
    setLocalizedText(element, "dashboard.timeline.lowConfidence", {
      visible: tPlural("dashboard.timeline.visibleWindow", matched),
      excluded: describeTimelineExclusions(activePoints),
    });
  } else if (excluded > 0) {
    setLocalizedText(element, "dashboard.timeline.excludedShown", {
      shown: tPlural("dashboard.timeline.shownWindow", matched),
      excluded: describeTimelineExclusions(activePoints),
    });
  } else {
    setLocalizedText(element, "dashboard.timeline.allMatched", {
      visible: tPlural("dashboard.timeline.visibleWindow", matched),
    });
  }
  if (zoomed) element.textContent += ` ${t("dashboard.timeline.resetView")}`;
}

function bindTimelineInteractions(shell, points, viewport) {
  if (viewport === null) return;
  shell.classList.add("interactive-chart");
  shell.tabIndex = 0;
  shell.setAttribute("aria-label", t("dashboard.timeline.aria", {
    timeZone: USER_TIME_ZONE,
  }));
  const status = $("#timeline-zoom-status");
  setLocalizedText(status, "dashboard.timeline.status", {
    start: formatLocal(new Date(viewport.startMs).toISOString()),
    end: formatLocal(new Date(viewport.endMs).toISOString()),
    span: formatSpanLength(viewport.endMs - viewport.startMs),
  });
  shell.onwheel = (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    const bounds = shell.getBoundingClientRect();
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : .5;
    zoomTimeline(points, wheelZoomFactor(event), ratio);
  };
  shell.onpointerdown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    timelinePointerStart = { x: event.clientX, dragging: false };
    shell.setPointerCapture?.(event.pointerId);
    shell.classList.add("is-pointer-active");
  };
  shell.onpointermove = (event) => {
    if (timelinePointerStart === null) return;
    const width = Math.max(1, shell.getBoundingClientRect().width);
    const delta = event.clientX - timelinePointerStart.x;
    if (Math.abs(delta) < 8) return;
    timelinePointerStart.dragging = true;
    timelinePointerStart.x = event.clientX;
    shell.classList.add("is-panning");
    event.preventDefault();
    panTimeline(points, -delta / width);
  };
  const stopPanning = (event) => {
    const wasDragging = timelinePointerStart?.dragging === true;
    timelinePointerStart = null;
    shell.releasePointerCapture?.(event.pointerId);
    shell.classList.remove("is-pointer-active");
    shell.classList.remove("is-panning");
    if (wasDragging) event.preventDefault();
  };
  shell.onpointerup = stopPanning;
  shell.onpointercancel = stopPanning;
  shell.onselectstart = (event) => {
    if (timelinePointerStart !== null) event.preventDefault();
  };
  shell.onkeydown = (event) => {
    if (["+", "="].includes(event.key)) {
      event.preventDefault();
      zoomTimeline(points, 1 / TIMELINE_BUTTON_ZOOM_STEP);
    } else if (["-", "_"].includes(event.key)) {
      event.preventDefault();
      zoomTimeline(points, TIMELINE_BUTTON_ZOOM_STEP);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      panTimeline(points, -.2);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      panTimeline(points, .2);
    } else if (event.key === "Home") {
      event.preventDefault();
      resetTimelineViewport();
      renderUsageTimeline(dashboard);
      renderTimeline(dashboard);
    }
  };
}

/**
 * The signed observed-minus-expected area under a matched residual series, in
 * percentage-point-hours. Trapezoidal over consecutive matched points, the
 * same integration buildRollingResidual performs for the artifact summary in
 * src/simple-quota-gradient.js: positive means observed quota movement ran
 * ahead of what recorded cost implies across the covered span.
 */
function signedResidualAucPpHours(matched) {
  if (!Array.isArray(matched) || matched.length < 2) return null;
  let area = 0;
  for (let index = 1; index < matched.length; index += 1) {
    const prior = matched[index - 1];
    const current = matched[index];
    if (prior.residualSegment === null
        || current.residualSegment === null
        || prior.residualSegment !== current.residualSegment) continue;
    const elapsedHours =
      (pointTimestampMs(current) - pointTimestampMs(prior)) / 3_600_000;
    if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) continue;
    area += elapsedHours
      * ((prior.observed - prior.expected) + (current.observed - current.expected))
      / 2;
  }
  return area;
}

function renderTimelineSummary(
  data,
  points,
  usingLive = true,
) {
  const summary = data.gradient.summary ?? {};
  const sensitivity = data.gradient.windowSensitivity.find((row) => finite(row.smoothing_hours ?? row.window_hours ?? row.hours) === CALIBRATION_WINDOW_HOURS);
  const activePoints = points.filter((row) => row.status !== "inactive");
  const matched = activePoints.filter((row) => row.observed !== null && row.expected !== null);
  const live = usingLive;
  const unavailable = accountingIsUnavailable(data) && activePoints.length === 0;
  const liveMae = matched.length
    ? matched.reduce((sum, row) => sum + Math.abs(row.observed - row.expected), 0) / matched.length
    : null;
  const livePeak = matched.length
    ? Math.max(...matched.map((row) => Math.abs(row.observed - row.expected)))
    : null;
  // Signed AUC over the visible matched residuals (owner-directed,
  // 2026-08-08): the trapezoidal observed-minus-expected integral in
  // pp·hours, exactly as buildRollingResidual computes it for the artifact
  // summary in src/simple-quota-gradient.js. The historical view reports the
  // artifact's own whole-history figure instead of re-deriving one.
  const liveSignedAuc = signedResidualAucPpHours(matched);
  const values = [
    [
      t("dashboard.summary.matchedWindows"),
      t("dashboard.summary.matchedWindowsExplanation"),
      unavailable ? "—" : compact(matched.length),
    ],
    [
      t("dashboard.summary.meanAbsoluteError"),
      t("dashboard.summary.meanAbsoluteErrorExplanation"),
      formatPp(live ? liveMae : sensitivity?.mae_pp ?? sensitivity?.weighted_mae_pp ?? summary.mean_absolute_error_pp),
    ],
    [
      t("dashboard.summary.peakResidual"),
      t("dashboard.summary.peakResidualExplanation"),
      formatPp(live ? livePeak : summary.rolling_peak_absolute_residual_pp),
    ],
    [
      t("dashboard.summary.cumulativeDrift"),
      t("dashboard.summary.cumulativeDriftExplanation"),
      formatSignedPpHours(
        live ? liveSignedAuc : summary.rolling_signed_auc_pp_hours,
      ),
    ],
    [
      t("dashboard.summary.usableCoverage"),
      t("dashboard.summary.usableCoverageExplanation"),
      activePoints.length
        ? formatPercent(matched.length / activePoints.length * 100, 1)
        : "—",
    ],
  ];
  const container = $("#timeline-summary");
  clear(container);
  for (const [label, explanation, value] of values) {
    const item = node("div");
    const labelElement = node("span");
    labelElement.append(informationLabel(label, explanation));
    item.append(labelElement, node("strong", "", value));
    container.append(item);
  }
}

function residualRows(data, points) {
  const live = points.some((row) => Object.hasOwn(row, "status"));
  const visibleBounds = timelineBounds(points);
  const pointResiduals = points.map((row) => ({
    ...row,
    residual: row.observed === null || row.expected === null
      ? null
      : row.observed - row.expected,
  }));
  const artifactResiduals = !live && data.gradient.residual.length
    ? data.gradient.residual.map((row) => {
        const timestamp = row.timestamp ?? row.window_end_utc;
        return {
          timestamp,
          timestampMs: Date.parse(timestamp),
          observed: finite(row.observed_quota_change_pp),
          expected: finite(row.expected_quota_change_pp),
          residual: finite(row.residual_pp)
        };
      })
    : [];
  const visibleArtifactResiduals = artifactResiduals.filter((row) => {
    const timestamp = pointTimestampMs(row);
    return Number.isFinite(timestamp)
      && visibleBounds !== null
      && timestamp >= visibleBounds.startMs
      && timestamp <= visibleBounds.endMs;
  });
  const source = visibleArtifactResiduals.length
    ? visibleArtifactResiduals
    : pointResiduals;
  // Windows that cannot be differenced are kept with a null residual so the
  // chart spans the same history as the calibration chart and shows the gap,
  // instead of quietly starting at the first computable point.
  return source
    .filter((row) => {
      const timestamp = pointTimestampMs(row);
      return row.status !== "inactive"
        && Number.isFinite(timestamp)
        && (visibleBounds === null
          || (timestamp >= visibleBounds.startMs && timestamp <= visibleBounds.endMs));
    })
    .sort((a, b) => pointTimestampMs(a) - pointTimestampMs(b));
}

function residualGapReasons(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.residual !== null) continue;
    const label = row.status
      ? timelineStatusLabel(row.status)
      : "no recorded evidence state";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([label, total]) => `${total} ${label.toLowerCase()}`);
}

function renderResidualCoverage(rows, computed) {
  const element = $("#residual-coverage");
  const missing = rows.length - computed.length;
  element.classList.toggle("low", rows.length > 0 && missing > computed.length);
  if (!rows.length) {
    setProductText(element, "No windows fall inside this date range.");
  } else if (missing === 0) {
    setLocalizedPluralText(element, "dashboard.residual.allComputable", rows.length);
  } else {
    setLocalizedText(element, "dashboard.residual.partial", {
      computed: computed.length,
      total: rows.length,
      missing,
      reasons: residualGapReasons(rows).join(", "),
    });
  }
}

/**
 * Merge two already-ranked lists into one bounded inspection list without
 * letting the longer list starve the shorter one.
 *
 * Each list is guaranteed its own half of `limit`; whatever a short list does
 * not use is handed to the other. Rows are deduplicated by timestamp, keeping
 * the first (higher-ranked) occurrence, and returned newest first.
 */
function balancedInspectionRows(first, second, limit) {
  const firstShare = Math.min(first.length, Math.ceil(limit / 2));
  const selected = [];
  const seen = new Set();
  const take = (rows, count) => {
    for (const row of rows) {
      if (selected.length >= limit || count <= 0) return;
      if (seen.has(row.timestamp)) continue;
      seen.add(row.timestamp);
      selected.push(row);
      count -= 1;
    }
  };
  take(first, firstShare);
  take(second, limit - selected.length);
  // Backfill only after the second list has had its reserved share, so a long
  // unmatched list can still fill the table when nothing is comparable.
  take(first, limit - selected.length);
  return selected.sort(
    (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp),
  );
}

function renderResiduals(data, points, viewport = null) {
  const timeHeading = $("#residual-time-heading");
  if (timeHeading) {
    setLocalizedText(timeHeading, "format.localTime");
  }
  const residuals = residualRows(data, points);
  const computed = residuals.filter((row) => row.residual !== null);
  // The residual axis is pinned to the calibration chart's own domain so a
  // shorter run of computable residuals cannot silently shorten the history.
  const domain = viewport ?? timelineBounds(points);
  const empty = $("#residual-empty");
  const shell = $("#residual-chart");
  if (!residuals.some(row => finite(row.cumulativeResidual) !== null)) {
    empty.hidden = false;
    shell.hidden = true;
  } else {
    empty.hidden = true;
    shell.hidden = false;
    drawChart(shell, lineChart({
      points: residuals,
      series: [{
        key: "cumulativeResidual", className: "chart-line-observed",
        label: { key: "trends.drift" }, pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        format: formatPp, breakBefore: "driftReanchor",
      }],
      yLabel: { key: "dashboard.timeline.percentagePoints" },
      title: { key: "trends.drift" },
      description: {
        key: "trends.driftCopy",
        values: { timeZone: formatTimeZoneLabel() },
      },
      includeZero: true,
      height: 230,
      width: Math.max(360, shell.clientWidth || 900),
      xDomain: domain,

    }));
  }
  renderResidualCoverage(residuals, computed);
  setLocalizedText($("#trends-drift-coverage"), "trends.driftCoverage", {
    computed: formatNumber(residuals.filter(row => finite(row.cumulativeResidual) !== null).length),
    total: formatNumber(residuals.length),
  });
  const unmatched = points
    .filter((point) => point.timestamp && point.status
      && !["matched", "inactive"].includes(point.status))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  const largest = [...computed]
    .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
  // Both halves of this table matter: the windows that could not be compared,
  // and the comparable windows whose residual is largest. Pagination replaced
  // the old eight-row cap (owner-directed, 2026-08-08): nothing is dropped
  // any more — the merge keeps every row from both halves, deduplicated by
  // timestamp and ordered newest first, and the reader pages through it ten
  // rows at a time.
  const inspection = balancedInspectionRows(
    unmatched,
    largest,
    unmatched.length + largest.length,
  );
  // A changed selection restarts at the first page: the page index describes
  // a position within ONE row set, and surviving a range change would show an
  // arbitrary slice of a different one.
  const signature = `${inspection.length}`
    + `:${inspection[0]?.timestamp ?? ""}`
    + `:${inspection.at(-1)?.timestamp ?? ""}`;
  if (signature !== residualInspectionSignature) {
    residualInspectionSignature = signature;
    residualTablePage = retainedPageIndex(residualInspectionRows, inspection, residualTablePage, RESIDUAL_TABLE_PAGE_SIZE, row => row.timestamp);
  }
  residualInspectionRows = inspection;
  renderResidualInspectionTable();
}

// Explain the existing classification; do not promote absent quality metadata
// or an absent estimate into a comparable window.
function residualEvidence(row) {
  const status = row.status;
  if (status === "matched") {
    if (finite(row.observed) === null) return ["trends.evidenceMissing", "trends.evidenceMissingWhy"];
    if (finite(row.expected) === null) return ["trends.evidenceEstimate", "trends.evidenceEstimateWhy"];
    return ["trends.evidenceComparable", "trends.evidenceComparableWhy"];
  }
  const keys = {
    missing_quota_bracket: ["trends.evidenceMissing", "trends.evidenceMissingWhy"],
    reset_or_track_change: ["trends.evidenceReset", "trends.evidenceResetWhy"],
    backward_or_ambiguous: ["trends.evidenceBackward", "trends.evidenceBackwardWhy"],
    pool_saturated: ["trends.evidenceExhausted", "trends.evidenceExhaustedWhy"],
    quota_weighting_unavailable: ["trends.evidencePricing", "trends.evidencePricingWhy"],
    unpriced_local_activity: ["trends.evidenceUnpriced", "trends.evidenceUnpricedWhy"],
    unexplained_without_local_activity: ["trends.evidenceUnrecorded", "trends.evidenceUnrecordedWhy"],
    inactive: ["trends.evidenceQuiet", "trends.evidenceQuietWhy"],
  };
  return Object.hasOwn(keys, status) ? keys[status] : ["trends.evidenceUnknown", "trends.evidenceUnknownWhy"];
}

/**
 * One page of the exact-windows inspection table, plus the pager beneath it.
 * Rendered from the module-held row set so Prev/Next can redraw the table
 * without re-deriving the timeline.
 */
function renderResidualInspectionTable() {
  const table = $("#residual-table");
  clear(table);
  const rows = residualInspectionRows;
  const pagination = $("#residual-pagination");
  if (!rows.length) {
    if (pagination) pagination.hidden = true;
    const row = node("tr");
    const cell = node("td", "empty-cell", t("residual.table.empty"));
    cell.colSpan = 5;
    row.append(cell);
    table.append(row);
    return;
  }
  const pageCount = Math.ceil(rows.length / RESIDUAL_TABLE_PAGE_SIZE);
  residualTablePage = Math.min(Math.max(0, residualTablePage), pageCount - 1);
  const start = residualTablePage * RESIDUAL_TABLE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + RESIDUAL_TABLE_PAGE_SIZE);
  for (const item of pageRows) {
    const row = node("tr");
    const residual = item.observed === null || item.expected === null
      ? null
      : item.residual;
    const [labelKey, detailKey] = residualEvidence(item);
    const evidence = node("td", "residual-evidence");
    evidence.append(node("strong", "residual-evidence-label", t(labelKey)),
      node("span", "residual-evidence-detail", t(detailKey)));
    const time = node("td", "residual-window-time", formatChartTimestamp(item.timestamp));
    if (finite(item.measuredSpanMs) > 0) time.append(node("small", "residual-window-span",
      t("trends.measuredSpan", { duration: formatSpanLength(item.measuredSpanMs) })));
    row.append(
      time,
      node("td", "", formatPp(item.observed)),
      node("td", "", formatPp(item.expected)),
      node("td", residual === null ? "" : residual >= 0 ? "positive" : "negative", residual === null ? t("residual.table.notComparable") : `${residual >= 0 ? "+" : ""}${formatPp(residual)}`),
      evidence,
    );
    table.append(row);
  }
  if (!pagination) return;
  // Same rule as the weekly and model tables: no pager for a single page.
  pagination.hidden = pageCount <= 1;
  setLocalizedText($("#residual-page-status"), "residual.table.page", {
    start: formatNumber(start + 1),
    end: formatNumber(start + pageRows.length),
    total: formatNumber(rows.length),
  });
  const previous = $("#residual-page-prev");
  const next = $("#residual-page-next");
  if (previous) previous.disabled = residualTablePage === 0;
  if (next) next.disabled = residualTablePage >= pageCount - 1;
}

/**
 * The range-level model and observed-speed context for the divergence panel.
 *
 * This is deliberately NOT period-specific: the timeline usage buckets carry
 * cost, tokens, and price coverage but no per-bucket model or speed breakdown,
 * so the only model/speed evidence client-side is the whole-selected-period
 * `byModel`/`bySpeed` on the accounting payload. Each period surfaces its own
 * exact cost/token/unpriced mix from its buckets; this line adds the range's
 * dominant priced model and observed speed as clearly-marked context.
 */
function focusTrendsPeriod(period) {
  if (!dashboard) return;
  const padding = Math.max(30 * 60_000, period.durationMs * .12);
  updateTimelineViewport(selectedUsagePoints(dashboard), () => ({
    startMs: period.startMs - padding, endMs: period.endMs + padding,
  }));
  requestAnimationFrame(() => {
    trendsHorizonView?.select(period.endMs, true);
    document.dispatchEvent(new CustomEvent("usagemonitor:page-view", { detail: { page: "allowance", view: "changes" } }));
    $("#trends-time").focus({ preventScroll: true });
  });
}

// One id per rendered divergence period, so each expandable breakdown has a
// stable target for its toggle's aria-controls.
let nextDivergenceBreakdownId = 0;

// Display-only state for the detector's ranked windows. Index revisions refresh
// details without changing a window's identity; a changed population or
// contributor mix cannot inherit another window's answer. Pagination controls
// readability without dropping evidence from the detector result.
const divergenceDetails = new Map();
const DIVERGENCE_PAGE_SIZE = 4;
let divergenceTablePage = 0;
let divergencePeriodRows = [];
let divergencePeriodDetailScope = "";
let divergencePeriodRangeContext = null;
let divergencePeriodSignature = "";

function divergenceDetailScope(data) {
  const scope = data?.timeline?.planScoped?.planScope;
  return JSON.stringify([
    data?.mode,
    data?.allowancePlanSelection?.planType ?? null,
    scope?.planType ?? null,
    scope?.methodVersion ?? null,
    scope?.basisFamilyId ?? null,
    scope?.cohortId ?? null,
  ]);
}

function divergenceDetailKey(period, scope) {
  return JSON.stringify([scope, period.startMs, period.endMs, period.contributors]);
}

function prepareDivergenceDetails(data, periods) {
  const scope = divergenceDetailScope(data);
  const generation = data?.accounting?.generation;
  const planScope = data?.timeline?.planScoped?.planScope;
  const revision = generation == null && !planScope?.sourceGeneration
    ? data
    : JSON.stringify([generation, data?.accounting?.generationFingerprint,
      planScope?.sourceGeneration, planScope?.sourceGenerationFingerprint]);
  const retained = new Set();
  for (const period of periods) {
    const key = divergenceDetailKey(period, scope);
    retained.add(key);
    let state = divergenceDetails.get(key);
    if (!state) {
      state = { key, expanded: false, breakdown: null, loadedRevision: null,
        pending: false, render: null, load: null };
      divergenceDetails.set(key, state);
    }
    state.revision = revision;
    state.local = ["local", "real_local_evidence"].includes(data?.mode);
  }
  for (const key of divergenceDetails.keys()) {
    if (!retained.has(key)) divergenceDetails.delete(key);
  }
  return scope;
}

function divergenceRangeContext(data) {
  const accounting = accountingPeriod(data);
  if (!accounting) return null;
  const models = modelUsageRows(accounting);
  const topModel = models.find((row) => !modelRowIsSeparateAllowance(row))
    ?? models[0]
    ?? null;
  const modelLabel = topModel === null ? null
    : topModel.model === "unknown"
      ? t("accounting.model.identityUnavailable")
      : topModel.pricingStatus === "unrecognized"
        ? t("accounting.model.unrecognized")
        : formatModelName(topModel.model) || topModel.model;
  const bySpeed = accounting.bySpeed ?? {};
  const rankedSpeed = ["ultrafast", "fast", "standard", "unknown"]
    .map((key) => [key, finite(bySpeed?.[key]?.events, 0)])
    .sort((left, right) => right[1] - left[1]);
  const topSpeed = rankedSpeed[0]?.[1] > 0 ? rankedSpeed[0][0] : null;
  if (modelLabel === null && topSpeed === null) return null;
  return {
    model: modelLabel ?? t("divergence.speed.unknown"),
    speed: divergenceSpeedLabel(topSpeed ?? "unknown"),
  };
}

// Static speed keys so the translated-inventory gate can verify every one. A
// computed `t(\`divergence.speed.${key}\`)` would resolve at runtime but read
// as no key to the source scanner.
function divergenceSpeedLabel(key) {
  if (key === "ultrafast") return t("divergence.speed.ultrafast");
  if (key === "fast") return t("divergence.speed.fast");
  if (key === "standard") return t("divergence.speed.standard");
  return t("divergence.speed.unknown");
}

/**
 * One detected divergence period, rendered to match the Trends card copy: a
 * localized date range and duration, the finding in plain words, the signed
 * magnitude, and the contributor mix (exact per-period totals plus range-level
 * model/speed context).
 */
function divergencePeriodItem(period, rangeContext, state) {
  const item = node(
    "li",
    `divergence-period ${period.direction === "under_costed"
      ? "under-costed"
      : "over-costed"}`,
  );

  const header = node("div", "divergence-period-header");
  header.append(
    rawNode(
      "span",
      "divergence-period-range",
      t("divergence.dateRange", {
        start: formatChartTimestamp(period.startAt),
        end: formatChartTimestamp(period.endAt),
      }),
    ),
    localizedNode("span", "divergence-period-duration", "divergence.duration", {
      duration: formatSpanLength(period.durationMs),
    }),
  );

  const finding = localizedNode(
    "p",
    "divergence-period-finding",
    period.direction === "under_costed"
      ? "trends.faster"
      : "trends.slower",
    { pp: formatPp(period.absPeakDriftPp) },
  );

  const magnitude = localizedNode(
    "p",
    "divergence-period-magnitude",
    "divergence.magnitude",
    {
      peak: formatSignedPp(period.peakDriftPp),
      auc: formatSignedPpHours(period.signedAucPpHours),
    },
  );

  const contributors = period.contributors;
  const mix = localizedNode("p", "divergence-period-mix", "divergence.mix", {
    cost: formatApiMoney(contributors.costUsd),
    tokens: compact(contributors.totalTokens),
    events: compact(contributors.usageEvents),
  });

  const gap = node("div", "divergence-gap");
  gap.append(rawNode("strong", "divergence-gap-value", formatSignedPp(period.peakDriftPp)),
    localizedNode("span", "", "trends.maxGap"));
  gap.setAttribute("title", t("trends.gapExplanation"));
  const focus = localizedNode("button", "button button-quiet compact divergence-focus", "trends.viewPeriod");
  focus.type = "button";
  focus.addEventListener("click", () => focusTrendsPeriod(period));
  item.append(header, gap, finding, focus);

  if (contributors.unpricedEventShare !== null
      && contributors.unpricedEvents > 0) {
    item.append(localizedNode(
      "p",
      "divergence-period-unpriced",
      "divergence.unpricedShare",
      { share: formatPercent(contributors.unpricedEventShare * 100, 1) },
    ));
  }

  // The per-period model and speed mix is not in the timeline payload, so it is
  // fetched on demand: expanding the period asks the companion to reprice just
  // this window from the unified index. This replaces the old whole-selected-
  // range context line with the window's OWN contributor mix; the range context
  // survives only as the fallback when a companion predating the route cannot
  // answer.
  const breakdownId = `divergence-breakdown-${nextDivergenceBreakdownId++}`;
  const toggle = node("button", "divergence-period-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", breakdownId);
  setLocalizedText(toggle, "divergence.breakdown.show");
  const panel = node("div", "divergence-period-breakdown");
  panel.id = breakdownId;
  panel.hidden = true;

  const renderBreakdown = () => {
    if (state.breakdown !== null || !state.pending) {
      renderDivergenceBreakdown(panel, state.breakdown, rangeContext);
    } else {
      clear(panel);
      panel.append(localizedNode(
        "p",
        "divergence-breakdown-status",
        "divergence.breakdown.loading",
      ));
    }
    panel.append(magnitude, mix);
    if (state.failed && !state.pending && state.local) {
      if (state.breakdown) panel.append(localizedNode("p", "divergence-breakdown-status", "trends.mixRetained"));
      const retry = localizedNode("button", "button button-quiet compact divergence-retry", "trends.mixRetry");
      retry.type = "button";
      retry.addEventListener("click", () => {
        state.toggle.focus({ preventScroll: true });
        state.load();
      });
      panel.append(retry);
    }
  };
  state.render = renderBreakdown;
  const loadBreakdown = async () => {
    if (!state.local || state.pending
        || state.loadedRevision === state.revision) return;
    const revision = state.revision;
    state.pending = true;
    state.failed = false;
    renderBreakdown();
    let breakdown = null;
    try {
      breakdown = await localClient.windowBreakdown(period.startMs, period.endMs);
    } catch {
      breakdown = null;
    }
    state.pending = false;
    if (divergenceDetails.get(state.key) !== state) return;
    if (state.revision !== revision) {
      if (state.expanded) state.load();
      return;
    }
    // A companion that lacks or refuses the route answers the same way every
    // time, so that answer is settled for this revision and offers no Retry.
    const unsupported = breakdown?.status === "unsupported";
    state.failed = breakdown?.status !== "available" && !unsupported;
    if (breakdown?.status === "available") {
      state.breakdown = breakdown;
      state.loadedRevision = revision;
    } else if (unsupported) state.loadedRevision = revision;
    // Failed refreshes never erase a successful answer or mark failure as
    // loaded. Reopening or the next dashboard refresh can try again.
    state.render();
  };
  state.load = loadBreakdown;
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    state.expanded = !open;
    toggle.setAttribute("aria-expanded", open ? "false" : "true");
    setLocalizedText(
      toggle,
      open ? "divergence.breakdown.show" : "divergence.breakdown.hide",
    );
    panel.hidden = open;
    if (!open) loadBreakdown();
  });
  toggle.setAttribute("aria-expanded", String(state.expanded));
  setLocalizedText(toggle, state.expanded
    ? "divergence.breakdown.hide" : "divergence.breakdown.show");
  panel.hidden = !state.expanded;
  renderBreakdown();
  if (state.expanded) loadBreakdown();

  state.toggle = toggle;
  item.append(toggle, panel);
  return item;
}

// The window's own repriced contributor mix, or a clearly-marked fallback. The
// per-model and per-speed rows are the true per-period evidence the endpoint
// exists to supply; an unavailable breakdown falls back to the range-level
// context rather than pretending this window had none.
function divergenceModelLabel(model) {
  if (model === "unknown") return t("accounting.model.identityUnavailable");
  return formatModelName(model) || model;
}

function renderDivergenceBreakdown(panel, breakdown, rangeContext) {
  clear(panel);
  panel.append(localizedNode("p", "divergence-breakdown-purpose", "trends.mixPurpose"));
  if (!breakdown || breakdown.status !== "available") {
    panel.append(rangeContext !== null
      ? localizedNode(
        "p",
        "divergence-breakdown-status",
        "divergence.breakdown.unavailable",
        { model: rangeContext.model, speed: rangeContext.speed },
      )
      : localizedNode(
        "p",
        "divergence-breakdown-status",
        "divergence.breakdown.unavailablePlain",
      ));
    return;
  }
  if (!breakdown.byModel.length) {
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-status",
      "divergence.breakdown.empty",
    ));
    return;
  }

  panel.append(localizedNode(
    "p",
    "divergence-breakdown-heading",
    "divergence.breakdown.modelHeading",
  ));
  const modelList = node("ul", "divergence-breakdown-list");
  for (const row of breakdown.byModel) {
    const share = breakdown.costUsd > 0 ? row.costUsd / breakdown.costUsd : 0;
    modelList.append(localizedNode(
      "li",
      "divergence-breakdown-row",
      "divergence.breakdown.modelRow",
      {
        model: divergenceModelLabel(row.model),
        cost: formatApiMoney(row.costUsd),
        share: formatPercent(share * 100, 1),
      },
    ));
  }
  panel.append(modelList);

  const speedEntries = Object.entries(breakdown.bySpeed)
    .map(([speed, row]) => ({ ...row, speed }))
    .filter((row) => row.events > 0)
    .sort((left, right) => right.costUsd - left.costUsd);
  if (speedEntries.length) {
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-heading",
      "divergence.breakdown.speedHeading",
    ));
    const speedList = node("ul", "divergence-breakdown-list");
    for (const row of speedEntries) {
      speedList.append(localizedNode(
        "li",
        "divergence-breakdown-row",
        "divergence.breakdown.speedRow",
        {
          speed: divergenceSpeedLabel(row.speed),
          cost: formatApiMoney(row.costUsd),
          events: compact(row.events),
        },
      ));
    }
    panel.append(speedList);
  }

  if (breakdown.fastCostUsd > 0) {
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-fast",
      "divergence.breakdown.fastCost",
      { cost: formatApiMoney(breakdown.fastCostUsd) },
    ));
  }
  if (breakdown.ultrafastCostUsd > 0) {
    panel.append(localizedNode("p", "divergence-breakdown-fast", "divergence.breakdown.ultrafastCost",
      { cost: formatApiMoney(breakdown.ultrafastCostUsd) }));
  }
  if (breakdown.unpricedShare > 0) {
    panel.append(localizedNode(
      "p",
      "divergence-breakdown-unpriced",
      "divergence.breakdown.unpriced",
      { share: formatPercent(breakdown.unpricedShare * 100, 1) },
    ));
  }
}

function divergenceRowsSignature(periods, detailScope) {
  return JSON.stringify([
    detailScope,
    periods.map((period) => [
      period.startMs,
      period.endMs,
      period.contributors,
    ]),
  ]);
}

/**
 * Render one readable page of the complete, widest-first divergence set.
 * Detail state is retained for every detected window, so a reader can page
 * away from an expanded row and return without losing its loaded evidence.
 */
function renderDivergencePeriodPage({ focusedKey = null } = {}) {
  const list = $("#divergence-list");
  const pagination = $("#divergence-pagination");
  if (!list) return;
  clear(list);

  const pageCount = Math.max(
    1,
    Math.ceil(divergencePeriodRows.length / DIVERGENCE_PAGE_SIZE),
  );
  divergenceTablePage = Math.min(
    Math.max(0, divergenceTablePage),
    pageCount - 1,
  );
  const start = divergenceTablePage * DIVERGENCE_PAGE_SIZE;
  const pageRows = divergencePeriodRows.slice(
    start,
    start + DIVERGENCE_PAGE_SIZE,
  );

  for (const period of pageRows) {
    const key = divergenceDetailKey(period, divergencePeriodDetailScope);
    const state = divergenceDetails.get(key);
    list.append(divergencePeriodItem(
      period,
      divergencePeriodRangeContext,
      state,
    ));
    if (key === focusedKey) state.toggle.focus({ preventScroll: true });
  }

  if (!pagination) return;
  pagination.hidden = pageCount <= 1;
  if (pagination.hidden) return;
  setLocalizedText(
    $("#divergence-page-status"),
    "divergence.pagination.page",
    {
      start: formatNumber(start + 1),
      end: formatNumber(start + pageRows.length),
      total: formatNumber(divergencePeriodRows.length),
    },
  );
  const previous = $("#divergence-page-prev");
  const next = $("#divergence-page-next");
  if (previous) previous.disabled = divergenceTablePage === 0;
  if (next) next.disabled = divergenceTablePage >= pageCount - 1;
}

/**
 * The "Where observed and priced usage diverge" panel. It runs the pure
 * detector over the whole selected calibration range and lists each sustained
 * period, or states plainly that nothing diverged in this range.
 */
function renderDivergencePeriods(data, points) {
  const list = $("#divergence-list");
  const empty = $("#divergence-empty");
  const summary = $("#divergence-summary");
  const caveat = $("#divergence-caveat");
  const pagination = $("#divergence-pagination");
  if (!list || !empty || !summary) return;
  const focusedKey = [...divergenceDetails.values()]
    .find((state) => state.toggle === document.activeElement)?.key;
  clear(list);

  const result = detectDeviationPeriods(points, {
    usageBuckets: data?.timeline?.usage ?? [],
  });
  const detailScope = prepareDivergenceDetails(data, result.periods);
  const signature = divergenceRowsSignature(result.periods, detailScope);
  if (signature !== divergencePeriodSignature) {
    divergencePeriodSignature = signature;
    divergenceTablePage = 0;
  }
  divergencePeriodRows = result.periods;
  divergencePeriodDetailScope = detailScope;
  divergencePeriodRangeContext = divergenceRangeContext(data);

  if (!result.periods.length) {
    list.hidden = true;
    summary.hidden = true;
    if (pagination) pagination.hidden = true;
    if (caveat) caveat.hidden = true;
    empty.hidden = false;
    // "Nothing diverged" and "there is no drift series to judge" are different
    // facts: the historical artifact view carries no per-window reset anchors,
    // so it can never earn the clean-bill-of-health copy.
    setLocalizedText(
      empty,
      result.hasDriftSeries ? "divergence.empty" : "divergence.emptyNoDrift",
    );
    return;
  }

  empty.hidden = true;
  list.hidden = false;
  summary.hidden = false;
  // Honest-estimator label (2026-08-10): the constant-rate expected line
  // reads model-mix shifts as divergence (established by the full-history
  // deviation investigation — sol-heavy stretches imply ~$2,300/100pp and
  // terra-heavy ~$1,100 against one blended constant). Until the per-model
  // expected line ships, every listed period carries this caveat.
  if (caveat) {
    caveat.hidden = false;
    setLocalizedText(caveat, "trends.divergenceBasis");
  }
  setLocalizedPluralText(summary, "divergence.count", result.totalFound, {
    count: formatNumber(result.totalFound),
  });
  renderDivergencePeriodPage({ focusedKey });
}

/**
 * Whether a series draws its data points. This is decided per chart, and there
 * is deliberately no global switch, because the dashboard's two chart families
 * want opposite answers and both answers are correct:
 *
 *  - EVIDENCE_DOTS — the allowance estimate history. Each dot is one observed
 *    seven-day reset: sparse, individually meaningful evidence. The dots are
 *    what that chart is for, and they must be visible.
 *  - HOVER_ONLY — the dense usage, calibration, and residual timelines. Those
 *    plot hundreds of adjacent samples, where dots smear into a band. The line
 *    carries the shape while every sample keeps an invisible hit target, so
 *    hover, keyboard focus, and assistive technology still reach each value.
 *
 * Every series must name one. There is no default to fall back to and no
 * boolean to flip in one place, so "hide the dots" can only ever be said about
 * a single chart. A previous change that flipped one shared flag silently
 * erased the allowance chart's points; this makes that edit impossible to
 * write by accident.
 */
const CHART_POINT_STYLE = Object.freeze({
  EVIDENCE_DOTS: "evidence-dots",
  HOVER_ONLY: "hover-only",
});

const CHART_POINT_STYLES = new Set(Object.values(CHART_POINT_STYLE));

/**
 * Drawing heights, in viewBox units, for the charts whose CSS lets them take
 * their height from the shape of their drawing rather than from a fixed pixel
 * value.
 *
 * The timeline charts were drawn into a 900x300 box inside a shell that is
 * routinely 977px wide. An SVG scales its viewBox to fit, so the smaller ratio
 * won: the plot was pinned to 300px tall and letterboxed with 77px of dead
 * space across the width. These heights pair with `aspect-ratio` rules in
 * `styles.css` so each chart fills its card in both directions, which roughly
 * doubles the plot area the same evidence is drawn into.
 *
 * Each value must stay in step with the matching `aspect-ratio`; a height with
 * no matching rule only reintroduces the letterbox.
 */
const TIMELINE_CHART_HEIGHT = 420;
const COMPACT_CHART_HEIGHT = 340;

/**
 * The one place a plotted point's instant is turned into milliseconds.
 *
 * Every series carries its instant as an ISO string, because that is what the
 * evidence artifacts and the local companion emit and what the tooltips print.
 * Re-parsing that string is not free, and the viewport helpers, the status
 * intervals, the residual filter, and the x-scale each parsed the same strings
 * again on every redraw: a single wheel notch over a month of calibration
 * evidence was measured at 18,177 `Date.parse` calls.
 *
 * Series builders now stamp `timestampMs` alongside `timestamp`, and this
 * reader prefers it. The fallback keeps the helper honest for points that come
 * straight from an artifact — a caller never has to know which kind it holds.
 */
function pointTimestampMs(point) {
  const stamped = point?.timestampMs;
  if (typeof stamped === "number" && Number.isFinite(stamped)) return stamped;
  return Date.parse(point?.timestamp ?? point?.date);
}

/**
 * Swap a chart into its shell, releasing what the outgoing chart still held.
 *
 * `lineChart` attaches a `ResizeObserver` so the axis can shed tick labels as
 * the card narrows. A pan or zoom replaces the whole SVG on every frame, so
 * without this the page kept one live observer per rendered frame, each still
 * watching a detached tree and each waking on the next real resize.
 */
let trendsHorizonView = null;

function drawChart(shell, chart) {
  for (const previous of shell.children ?? []) {
    previous.chartTickDensityObserver?.disconnect();
  }
  shell.replaceChildren(chart);
  if (["usage-timeline-chart", "allowance-timeline-chart", "timeline-chart", "difference-timeline-chart", "residual-chart"].includes(shell.id) && chart.timelinePresentation) {
    trendsHorizonView ??= mountTrendsHorizon($("#allowance-screen"), { t, locale: getFormattingLocale(), timeZone: USER_TIME_ZONE,
      formatMoney: formatApiMoney, formatPercent, formatDuration: formatSpanLength });
    trendsHorizonView.refreshLocale(getFormattingLocale());
    trendsHorizonView.register(shell, chart.timelinePresentation);
  }
}

function chartSeriesDrawsPoints(item, field) {
  const style = item?.pointStyle;
  if (!CHART_POINT_STYLES.has(style)) {
    throw new TypeError(
      `lineChart ${field} needs an explicit pointStyle: CHART_POINT_STYLE.EVIDENCE_DOTS draws visible data points, CHART_POINT_STYLE.HOVER_ONLY keeps them reachable without drawing them.`,
    );
  }
  return style === CHART_POINT_STYLE.EVIDENCE_DOTS;
}

/**
 * The localization hook for everything the chart writes into the SVG text
 * layer: axis labels, series names, the `<title>`/`<desc>` accessibility pair,
 * and hover tooltips.
 *
 * SVG text nodes are stamped `data-i18n-skip` because they already contain
 * formatted numbers and instants that exact-text translation must never touch.
 * That left the text layer as the one surface the localization bridge could not
 * see, and hardcoded English flowed straight through it. Resolving the strings
 * here, at the single chart-rendering helper, closes that gap for every chart
 * at once.
 *
 * Callers pass a descriptor rather than a string:
 *   { key: "chart.residual.title" }               → t(key)
 *   { key: "weekly.point.detail", values: {...} } → t(key, values)
 *   { key: "weekly.chart.resetFit", plural: count }      → tPlural(key, count, values)
 *   { data: alreadyFormattedSourceValue }         → verbatim, never translated
 *
 * A bare string throws. That is the enforcement: a chart added later cannot
 * reintroduce untranslated English without failing the moment it renders.
 */
function chartText(descriptor, field = "text") {
  if (descriptor === null || descriptor === undefined) return "";
  if (typeof descriptor === "object" && !Array.isArray(descriptor)) {
    if (typeof descriptor.key === "string") {
      return typeof descriptor.plural === "number"
        ? tPlural(descriptor.key, descriptor.plural, descriptor.values ?? {})
        : t(descriptor.key, descriptor.values ?? {});
    }
    if (Object.hasOwn(descriptor, "data")) {
      return descriptor.data == null ? "" : String(descriptor.data);
    }
  }
  throw new TypeError(
    `lineChart ${field} must be a localization descriptor ({ key }) or explicit source data ({ data }). Hardcoded strings cannot reach the SVG text layer.`,
  );
}

function chartSeriesCaption(label, value) {
  return t("chart.seriesValue", { label, value });
}

/**
 * Which evidence states shade the plot, and under which hue.
 *
 * This is an explicit table with NO fallback, and both properties matter. The
 * renderer used to end its status test in `: "ambiguous"`, so three unrelated
 * states — `quota_weighting_unavailable`, `unpriced_local_activity` and
 * `unexplained_without_local_activity` — all drew in the violet the legend
 * captions "Movement needs context". Violet therefore meant four different
 * things and mapped back to nothing.
 *
 * Worse, the last two carry BOTH series and are counted as matched windows, so
 * the chart was shading spans the caption underneath it calls excluded. A
 * status absent from this table is not shaded at all: shading is reserved for
 * the mechanisms that actually suspend a measurement, which is exactly the set
 * `TIMELINE_EXCLUSION_MESSAGE_KEYS` enumerates and the legend keys.
 */
const TIMELINE_STATUS_BAND_CLASSES = Object.freeze({
  missing_quota_bracket: "missing",
  reset_or_track_change: "reset",
  quota_weighting_unavailable: "weighting",
  backward_or_ambiguous: "ambiguous",
  pool_saturated: "saturated",
});

// A band narrower than this cannot be seen, so every region also draws a
// full-strength tick along the top edge of the plot at no less than this
// width. The wash keeps the true extent and never widens; the tick is an
// explicit presence marker, which is why the two are allowed to disagree.
const STATUS_TICK_MINIMUM_WIDTH = 3;
const STATUS_TICK_HEIGHT = 4;

function lineChart({
  points,
  series,
  yLabel,
  title,
  description,
  includeZero = false,
  confidence = null,
  errorBars = null,
  xDomain = null,
  xTicks = null,
  yDomain = null,
  yTickFormat = null,
  statusIntervals = [],
  secondarySeries = [],
  secondaryYLabel = null,
  // The drawing height, in viewBox units. It pairs with an `aspect-ratio` in
  // `styles.css`: the SVG is laid out at the card's full width and takes its
  // height from this ratio, so the plot fills the box in both directions
  // instead of being letterboxed by a fixed CSS height. A chart whose CSS
  // pins an explicit height keeps the default, because raising this without
  // raising that one only reintroduces the letterbox it is meant to remove.
  height = 300,
  width = 900,
}) {
  // Hover, keyboard focus, and the accessible name are unconditional. Only the
  // visible dot is a per-chart decision, and every series has to state it.
  const chartSeries = (Array.isArray(series) ? series : []).map((item) => ({
    ...item,
    label: chartText(item.label, "series label"),
    markers: chartSeriesDrawsPoints(item, "series"),
    focusable: item.focusable !== false,
    tooltip: item.tooltip !== false,
  }));
  const chartSecondarySeries = (Array.isArray(secondarySeries) ? secondarySeries : []).map((item) => ({
    ...item,
    label: chartText(item.label, "secondary series label"),
    markers: chartSeriesDrawsPoints(item, "secondary series"),
    focusable: item.focusable !== false,
    tooltip: item.tooltip !== false,
  }));
  const hasSecondary = chartSecondarySeries.length > 0;
  const margin = {
    top: 12,
    right: hasSecondary ? 96 : 24,
    // Tick labels are horizontal. They used to be rotated -24° and given a
    // 66px gutter because each one carried a full date and time; now that a
    // tick reads "Jul 15" or "2:04 PM", rotation only made short text harder
    // to read and cost the plot 22px of height. The gutter is sized to the one
    // line of 10px text it holds — it was carrying 22px of slack beneath the
    // baseline, which is plot area no chart was using.
    bottom: 30,
    left: 72,
  };
  const tickLabelBaseline = height - 11;
  let min = finite(yDomain?.low);
  let max = finite(yDomain?.high);
  if (min === null || max === null || max <= min) {
    const values = points.flatMap((point) => chartSeries.map((item) => finite(point[item.key])).filter((value) => value !== null));
    if (confidence) values.push(...points.flatMap((point) => [finite(point[confidence.low]), finite(point[confidence.high])].filter((value) => value !== null)));
    if (errorBars) values.push(...points.flatMap((point) => [finite(point[errorBars.low]), finite(point[errorBars.high])].filter((value) => value !== null)));
    if (includeZero) values.push(0);
    min = Math.min(...values);
    max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * .1;
    min = includeZero && min >= 0 ? 0 : min - pad;
    max += pad;
  }
  const timestamps = points.map(pointTimestampMs);
  const timed = timestamps.every(Number.isFinite);
  const dataStartMs = timed ? Math.min(...timestamps) : 0;
  const dataEndMs = timed ? Math.max(...timestamps) : Math.max(1, points.length - 1);
  const domainStartMs = timed && Number.isFinite(xDomain?.startMs)
    ? xDomain.startMs
    : dataStartMs;
  const domainEndMs = timed && Number.isFinite(xDomain?.endMs)
    ? xDomain.endMs
    : dataEndMs;
  const safeDomainEndMs = domainEndMs > domainStartMs
    ? domainEndMs
    : domainStartMs + 1;
  // `timestamps` was already computed above, once per point, so the x-scale
  // reads that array instead of re-parsing the same ISO string on every call.
  const plotWidth = width - margin.left - margin.right;
  const lastIndex = Math.max(1, points.length - 1);
  const x = (index, point = points[index]) => {
    const at = timed
      ? (index >= 0 && timestamps[index] !== undefined
        ? timestamps[index]
        : pointTimestampMs(point))
      : null;
    const coordinate = timed
      ? (at - domainStartMs) / (safeDomainEndMs - domainStartMs)
      : index / lastIndex;
    return margin.left + coordinate * plotWidth;
  };
  const y = (value) => margin.top + (max - value) / (max - min) * (height - margin.top - margin.bottom);
  const ySecondary = (value) => margin.top
    + (100 - Math.max(0, Math.min(100, value))) / 100
      * (height - margin.top - margin.bottom);

  // Six candidate divisions rather than five. Ticks are now kept inside the
  // domain instead of rounding outwards past each end, which costs the axis
  // roughly one tick; asking for one more division back restores the density a
  // chart this tall needs to stay readable.
  const chartTickStep = (low, high, target = 6) => {
    const span = Math.abs(high - low);
    if (!Number.isFinite(span) || span <= 0) return 1;
    const raw = span / Math.max(1, target - 1);
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;
    const factor = normalized <= 1 ? 1
      : normalized <= 2 ? 2
        : normalized <= 2.5 ? 2.5
          : normalized <= 5 ? 5
            : 10;
    return factor * magnitude;
  };
  // The fewest decimals that write the step exactly. The old rule returned 0
  // for any step of 1 or more, so a 2.5 step printed its own grid lines as
  // "0, -3, -5, -8, -10" — two labels naming a value their line was not drawn
  // at. It also under-reported fractional steps: 0.25 needs two places, not
  // one.
  const chartTickDigits = (step) => {
    if (!Number.isFinite(step) || step <= 0) return 0;
    for (let digits = 0; digits < 3; digits += 1) {
      if (Math.abs(step - Number(step.toFixed(digits))) <= step * 1e-9) return digits;
    }
    return 3;
  };
  const yStep = chartTickStep(min, max);
  const yDigits = chartTickDigits(yStep);
  const yTicks = Array.isArray(yDomain?.ticks) && yDomain.ticks.length > 0
    ? yDomain.ticks.filter((value) => Number.isFinite(value))
    : (() => {
      // Ticks sit on round multiples of the step, but only where the axis
      // actually goes. Rounding outwards put a grid line and a label a whole
      // step beyond each end of the domain: on the residual chart that drew
      // two of five grid lines outside the SVG box entirely, and `overflow:
      // visible` meant they were painted over the card below rather than
      // clipped. Rounding inwards keeps every tick on the plot.
      const first = Math.floor(max / yStep) * yStep;
      const last = Math.ceil(min / yStep) * yStep;
      const values = [];
      for (let value = first; value >= last - yStep / 100; value -= yStep) {
        values.push(Number(value.toFixed(Math.max(0, yDigits + 2))));
        if (values.length >= 8) break;
      }
      return values.length >= 2 ? values : [max, min];
    })();

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  // The chart's accessible name and description live on aria attributes
  // rather than a root <title>/<desc> pair: a root <title> also acts as a
  // delayed grey native tooltip over every hover target inside the SVG, which
  // is the double-tooltip the owner removed (2026-08-08). Both strings still
  // pass through chartText, so hardcoded English still cannot reach them.
  svg.setAttribute("aria-label", chartText(title, "title"));
  const chartDescription = chartText(description, "description");
  if (chartDescription !== "") {
    svg.setAttribute("aria-description", chartDescription);
  }

  const tooltipWidth = Math.min(330, width - margin.left - margin.right);
  const tooltipHeight = 48;
  const tooltip = document.createElementNS(svg.namespaceURI, "g");
  tooltip.setAttribute("class", "chart-hover-tooltip");
  tooltip.setAttribute("visibility", "hidden");
  tooltip.setAttribute("aria-hidden", "true");
  const tooltipBackground = document.createElementNS(svg.namespaceURI, "rect");
  tooltipBackground.setAttribute("width", String(tooltipWidth));
  tooltipBackground.setAttribute("height", String(tooltipHeight));
  tooltipBackground.setAttribute("rx", "6");
  const tooltipHeading = svgText(10, 18, "", "chart-tooltip-heading");
  const tooltipDetail = svgText(10, 36, "", "chart-tooltip-detail");
  tooltip.append(tooltipBackground, tooltipHeading, tooltipDetail);
  const showTooltip = (xPosition, yPosition, heading, detail = "") => {
    const tooltipX = Math.max(
      margin.left,
      Math.min(width - margin.right - tooltipWidth, xPosition + 10),
    );
    const tooltipY = yPosition - tooltipHeight - 10 < margin.top
      ? yPosition + 10
      : yPosition - tooltipHeight - 10;
    tooltip.setAttribute("transform", `translate(${tooltipX} ${tooltipY})`);
    tooltipHeading.textContent = heading.slice(0, Math.min(72, Math.floor((tooltipWidth - 20) / 6)));
    tooltipDetail.textContent = detail.slice(0, Math.min(86, Math.floor((tooltipWidth - 20) / 5.5)));
    tooltip.setAttribute("visibility", "visible");
    tooltip.setAttribute("aria-hidden", "false");
  };
  const hideTooltip = () => {
    tooltip.setAttribute("visibility", "hidden");
    tooltip.setAttribute("aria-hidden", "true");
  };

  const bindChartInteraction = ({
    element,
    heading,
    detail = "",
    xPosition,
    yPosition,
    pointer = true,
    focus = true,
    label = `${heading}${detail ? ` · ${detail}` : ""}`,
  }) => {
    if (focus) {
      element.setAttribute("tabindex", "0");
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", label);
    }
    if (typeof element.addEventListener !== "function") return;
    if (pointer) {
      element.addEventListener("pointerenter", () => showTooltip(
        xPosition,
        yPosition,
        heading,
        detail,
      ));
      element.addEventListener("pointerleave", hideTooltip);
    }
    if (focus) {
      element.addEventListener("focus", () => showTooltip(
        xPosition,
        yPosition,
        heading,
        detail,
      ));
      element.addEventListener("blur", hideTooltip);
    }
  };

  const installTickDensity = (tickLabels) => {
    if (tickLabels.length === 0) return;
    const update = (renderedWidth) => {
      const widthForDensity = Number.isFinite(renderedWidth) && renderedWidth > 0
        ? renderedWidth
        : width;
      const target = Math.min(
        tickLabels.length,
        adaptiveChartTickCount(widthForDensity, {
          left: margin.left,
          right: margin.right,
        }),
      );
      const visible = new Set();
      if (target === 1) {
        visible.add(0);
      } else {
        for (let index = 0; index < target; index += 1) {
          visible.add(Math.round(index * (tickLabels.length - 1) / (target - 1)));
        }
      }
      tickLabels.forEach((label, index) => {
        label.setAttribute("display", visible.has(index) ? "inline" : "none");
        label.setAttribute("aria-hidden", visible.has(index) ? "false" : "true");
      });
    };
    const renderedWidth = typeof svg.getBoundingClientRect === "function"
      ? svg.getBoundingClientRect().width
      : width;
    update(renderedWidth);
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver((entries) => {
        // A pan redraws the chart every frame, discarding the SVG this observer
        // was created for. Once that SVG leaves the document the observer has
        // nothing to report, so it releases itself rather than accumulating one
        // live observer per rendered frame.
        if (svg.isConnected === false) {
          observer.disconnect();
          return;
        }
        update(entries[0]?.contentRect?.width ?? renderedWidth);
      });
      observer.observe(svg);
      svg.chartTickDensityObserver = observer;
    }
  };

  for (const value of yTicks) {
    const yPosition = y(value);
    svg.append(svgLine(margin.left, yPosition, width - margin.right, yPosition, "chart-grid"));
    const label = yTickFormat === null
      ? formatDecimal(value, yDigits)
      : yTickFormat(value, yDigits);
    svg.append(svgText(margin.left - 8, yPosition + 3, label, "chart-axis-label", "end"));
  }

  if (hasSecondary) {
    // The percentage axis is drawn on its own round quarters. It used to reuse
    // the left axis's tick positions, so a four-tick dollar axis produced
    // 100 / 67 / 33 / 0 % — arithmetically true and unreadable. The percentage
    // scale is fixed at 0–100, so its ticks do not depend on the other axis.
    for (const percent of [100, 75, 50, 25, 0]) {
      svg.append(svgText(
        width - margin.right + 8,
        ySecondary(percent) + 3,
        formatPercent(percent, 0),
        "chart-axis-label",
        "start"
      ));
    }
  }

  if (includeZero && min <= 0 && max >= 0) {
    svg.append(svgLine(margin.left, y(0), width - margin.right, y(0), "chart-zero"));
  }

  if (timed) {
    // Render the widest useful candidate set once, then hide labels as the
    // SVG's actual CSS width changes. The plotted geometry stays stable while
    // narrow cards shed labels instead of acquiring a horizontal scrollbar.
    const automaticTickCount = adaptiveChartTickCount(width, {
      left: margin.left,
      right: margin.right,
    });
    const domainSpanMs = safeDomainEndMs - domainStartMs;
    const ticks = Array.isArray(xTicks) && xTicks.length > 0
      ? xTicks
      : Array.from({ length: automaticTickCount }, (_, index) => {
        const at = domainStartMs + domainSpanMs * index / (automaticTickCount - 1);
        return {
          at,
          label: formatChartTimeLabel(at, { spanMs: domainSpanMs }),
          alignment: index === 0
            ? "start"
            : index === automaticTickCount - 1
              ? "end"
              : "middle",
        };
      });
    const tickLabels = [];
    for (const tick of ticks) {
      const at = finite(tick?.at);
      if (at === null) continue;
      const position = margin.left + (at - domainStartMs)
        / (safeDomainEndMs - domainStartMs) * (width - margin.left - margin.right);
      const tickLabel = svgText(
        position,
        tickLabelBaseline,
        typeof tick.label === "string"
          ? tick.label
          : formatChartTimeLabel(at, { spanMs: domainSpanMs }),
        "chart-axis-label",
        tick.alignment ?? "middle",
      );
      svg.append(tickLabel);
      tickLabels.push(tickLabel);
    }
    installTickDensity(tickLabels);
  } else {
    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1])];
    const tickLabels = [];
    for (const index of labelIndexes) {
      const timestamp = points[index]?.timestamp ?? points[index]?.date;
      const tickLabel = svgText(x(index), tickLabelBaseline, formatChartTimeLabel(timestamp, { dateOnly: true }), "chart-axis-label", index === 0 ? "start" : index === points.length - 1 ? "end" : "middle");
      svg.append(tickLabel);
      tickLabels.push(tickLabel);
    }
    installTickDensity(tickLabels);
  }
  const yAxisLabel = svgText(
    15,
    height / 2,
    chartText(yLabel, "yLabel"),
    "chart-axis-label",
    "middle",
  );
  yAxisLabel.setAttribute("transform", `rotate(-90 15 ${height / 2})`);
  svg.append(yAxisLabel);
  if (hasSecondary && secondaryYLabel) {
    const secondaryLabel = svgText(
      width - 8,
      height / 2,
      chartText(secondaryYLabel, "secondaryYLabel"),
      "chart-axis-label",
      "middle"
    );
    secondaryLabel.setAttribute(
      "transform",
      `rotate(90 ${width - 8} ${height / 2})`
    );
    svg.append(secondaryLabel);
  }

  if (confidence) {
    const confidencePoints = points
      .map((point, index) => ({
        point,
        index,
        low: finite(point[confidence.low]),
        high: finite(point[confidence.high]),
      }))
      .filter((point) => point.low !== null && point.high !== null);
    if (confidencePoints.length >= 2) {
      const upper = confidencePoints.map(
        ({ point, index, high }) => [x(index, point), y(high)],
      );
      const lower = confidencePoints.map(
        ({ point, index, low }) => [x(index, point), y(low)],
      ).reverse();
      const polygon = document.createElementNS(svg.namespaceURI, "polygon");
      polygon.setAttribute("points", [...upper, ...lower].map(([a, b]) => `${a},${b}`).join(" "));
      polygon.setAttribute("class", "chart-area-confidence");
      const bandLow = Math.min(...confidencePoints.map(({ low }) => low));
      const bandHigh = Math.max(...confidencePoints.map(({ high }) => high));
      const bandFormat = confidence.format ?? formatMoney;
      const bandHeading = chartText(confidence.label, "confidence label");
      const bandDetail = `${bandFormat(bandLow)}–${bandFormat(bandHigh)}`;
      const bandCaption = chartSeriesCaption(bandHeading, bandDetail);
      // No native <title> here: the styled hover tooltip already shows this
      // caption immediately, and the browser's delayed grey tooltip repeated
      // it (owner-reported double tooltip, 2026-08-08). The caption stays on
      // aria-label for assistive technology.
      const middlePoint = confidencePoints[Math.floor(confidencePoints.length / 2)];
      bindChartInteraction({
        element: polygon,
        heading: bandHeading,
        detail: bandDetail,
        xPosition: x(middlePoint.index, middlePoint.point),
        yPosition: y((bandLow + bandHigh) / 2),
        pointer: confidence.tooltip !== false,
        focus: confidence.focusable !== false,
        label: bandCaption,
      });
      svg.append(polygon);
    }
  }

  if (errorBars) {
    const format = errorBars.format ?? formatMoney;
    points.forEach((point, index) => {
      const low = finite(point[errorBars.low]);
      const high = finite(point[errorBars.high]);
      if (low === null || high === null) return;
      const position = x(index, point);
      const group = document.createElementNS(svg.namespaceURI, "g");
      group.setAttribute("class", errorBars.className);
      group.append(
        svgLine(position, y(low), position, y(high), "chart-error-bar-line"),
        svgLine(position - 5, y(low), position + 5, y(low), "chart-error-bar-cap"),
        svgLine(position - 5, y(high), position + 5, y(high), "chart-error-bar-cap"),
      );
      if (errorBars.tooltip !== false) {
        const barTitle = document.createElementNS(svg.namespaceURI, "title");
        const barCaption = chartSeriesCaption(
          chartText(errorBars.label, "errorBars label"),
          `${format(low)}–${format(high)}`,
        );
        setRawText(
          barTitle,
          point.timestamp
            ? `${barCaption} · ${formatChartTimestamp(point.timestamp)}`
            : barCaption,
        );
        group.append(barTitle);
      }
      svg.append(group);
    });
  }

  for (const interval of statusIntervals) {
    if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs)
        || interval.endMs <= interval.startMs) continue;
    const band = TIMELINE_STATUS_BAND_CLASSES[interval.status];
    // No entry means no legend swatch, so nothing is drawn. Silently shading
    // an unkeyed status is what made the violet band unreadable.
    if (!band) continue;
    const plotWidth = width - margin.left - margin.right;
    const start = margin.left + (interval.startMs - domainStartMs)
      / (safeDomainEndMs - domainStartMs) * plotWidth;
    const end = margin.left + (interval.endMs - domainStartMs)
      / (safeDomainEndMs - domainStartMs) * plotWidth;
    const left = Math.max(margin.left, start);
    const bandWidth = Math.max(1, Math.min(width - margin.right, end) - left);
    const label = chartText(
      { key: timelineStatusKey(interval.status) },
      "status interval",
    );
    const shade = (element) => {
      const elementTitle = document.createElementNS(svg.namespaceURI, "title");
      setRawText(elementTitle, label);
      element.append(elementTitle);
      svg.append(element);
    };

    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("x", String(left));
    rect.setAttribute("y", String(margin.top));
    rect.setAttribute("width", String(bandWidth));
    rect.setAttribute("height", String(height - margin.top - margin.bottom));
    rect.setAttribute("class", `chart-status-${band}`);
    shade(rect);

    // The wash carries EXTENT and is never widened, so it cannot overstate how
    // long a mechanism was in force. This tick carries IDENTITY: a fixed
    // minimum width at legend-swatch strength, so a single excluded window —
    // four in the owner's 30d view, each under half a unit wide — reads as a
    // marker in its own hue instead of resolving to nothing. Drawn before the
    // series, so a line crossing the top of the plot still wins.
    const tickWidth = Math.max(STATUS_TICK_MINIMUM_WIDTH, bandWidth);
    const tickLeft = Math.min(
      width - margin.right - tickWidth,
      Math.max(margin.left, left + bandWidth / 2 - tickWidth / 2),
    );
    const tick = document.createElementNS(svg.namespaceURI, "rect");
    tick.setAttribute("x", String(tickLeft));
    tick.setAttribute("y", String(margin.top));
    tick.setAttribute("width", String(tickWidth));
    tick.setAttribute("height", String(STATUS_TICK_HEIGHT));
    tick.setAttribute("class", `chart-status-tick chart-status-${band}`);
    shade(tick);
  }

  for (const item of chartSeries) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = finite(point[item.key]);
      const previous = segment.at(-1);
      if (previous && ((item.segmentKey && previous.point[item.segmentKey] !== point[item.segmentKey])
          || (item.breakBefore && point[item.breakBefore])
          || (Number.isFinite(item.maxGapMs) && pointTimestampMs(point) - pointTimestampMs(previous.point) > item.maxGapMs))) {
        segments.push(segment);
        segment = [];
      }
      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else segment.push({
        point,
        index,
        value,
        x: x(index, point),
        y: y(value),
      });
    });
    if (segment.length) segments.push(segment);
    if (item.connect !== false) for (const pathPoints of segments) {
      const path = document.createElementNS(svg.namespaceURI, "polyline");
      path.setAttribute("points", pathPoints.map(({ x: xPosition, y: yPosition }) => `${xPosition},${yPosition}`).join(" "));
      path.setAttribute("class", item.className);
      if (item.lineFocusable === true) {
        const format = item.format ?? formatMoney;
        const representative = pathPoints[Math.floor(pathPoints.length / 2)];
        const heading = chartSeriesCaption(item.label, format(representative.value));
        const detail = typeof item.lineDetail === "function"
          ? chartText(
            item.lineDetail(pathPoints.map(({ point }) => point)),
            "lineDetail",
          )
          : "";
        const caption = [heading, detail].filter(Boolean).join(" · ");
        // The styled hover is the one tooltip; a native <title> repeated it
        // after a delay as the grey system tooltip. The caption survives on
        // aria-label.
        bindChartInteraction({
          element: path,
          heading,
          detail,
          xPosition: representative.x,
          yPosition: representative.y,
          pointer: item.lineTooltip !== false,
          focus: item.focusable !== false,
          label: caption,
        });
      }
      svg.append(path);
    }
    {
      const format = item.format ?? formatMoney;
      points.forEach((point, index) => {
        // A classified series must not leave an invisible hover target over
        // a point belonging to another series. Marker visibility alone is
        // separate: dense timelines intentionally retain hover-only points.
        if (typeof item.pointFilter === "function" && !item.pointFilter(point)) return;
        const value = finite(point[item.key]);
        if (value === null) return;
        // Both coordinates are used three times each — the attribute, the
        // tooltip anchor, and the focus anchor — so they are computed once.
        const markerX = x(index, point);
        const markerY = y(value);
        const marker = document.createElementNS(svg.namespaceURI, "circle");
        marker.setAttribute("cx", String(markerX));
        marker.setAttribute("cy", String(markerY));
        const visualRadius = typeof item.markerRadius === "function"
          ? item.markerRadius(point)
          : item.markerRadius ?? 4;
        const showMarker = item.markers
          && Number.isFinite(visualRadius)
          && visualRadius > 0;
        const markerOpacity = typeof item.markerOpacity === "function"
          ? item.markerOpacity(point)
          : item.markerOpacity;
        marker.setAttribute("r", String(showMarker
          ? visualRadius
          : Math.max(7, finite(item.hitRadius, 8))));
        if (showMarker && Number.isFinite(markerOpacity)) {
          marker.setAttribute(
            "opacity",
            String(Math.max(0, Math.min(1, markerOpacity))),
          );
        }
        marker.setAttribute("class", showMarker
          ? `${item.className} chart-point`
          : `${item.className} chart-point chart-point-hit-target`);
        const timestamp = point.timestamp ?? point.date;
        const heading = chartSeriesCaption(item.label, format(value));
        const timestampDetail = timestamp ? formatChartTimestamp(timestamp) : null;
        const seriesDetail = item.detail
          ? chartText(item.detail(point), "series detail")
          : null;
        const detail = (item.timestampFirst
          ? [timestampDetail, seriesDetail]
          : [seriesDetail, timestampDetail]
        ).filter(Boolean).join(" · ");
        const caption = [heading, detail].filter(Boolean).join(" · ");
        // Deliberately no native <title> on a point: the styled hover shows
        // this caption immediately, and the browser's delayed grey tooltip
        // then repeated it word for word (owner-reported double tooltip,
        // 2026-08-08). Keyboard and assistive technology keep the identical
        // sentence through the aria-label below.
        bindChartInteraction({
          element: marker,
          heading,
          detail,
          xPosition: markerX,
          yPosition: markerY,
          pointer: item.tooltip !== false,
          focus: item.focusable !== false,
          label: caption,
        });
        svg.append(marker);
      });
    }
  }
  for (const item of chartSecondarySeries) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = finite(point[item.key]);
      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else {
        segment.push({
          point,
          index,
          value,
          x: x(index, point),
          y: ySecondary(value),
        });
      }
    });
    if (segment.length) segments.push(segment);
    for (const pathPoints of segments) {
      const path = document.createElementNS(svg.namespaceURI, "polyline");
      path.setAttribute(
        "points",
        pathPoints.map(({ x: xPosition, y: yPosition }) => `${xPosition},${yPosition}`).join(" ")
      );
      path.setAttribute("class", item.className);
      if (item.lineFocusable === true) {
        const format = item.format ?? ((value) => formatPercent(value, 1));
        const representative = pathPoints[Math.floor(pathPoints.length / 2)];
        const heading = chartSeriesCaption(item.label, format(representative.value));
        const detail = typeof item.lineDetail === "function"
          ? chartText(
            item.lineDetail(pathPoints.map(({ point }) => point)),
            "secondary lineDetail",
          )
          : "";
        const caption = [heading, detail].filter(Boolean).join(" · ");
        // Same rule as the primary series: the styled hover owns the
        // tooltip, aria-label owns the accessible name, no native <title>.
        bindChartInteraction({
          element: path,
          heading,
          detail,
          xPosition: representative.x,
          yPosition: representative.y,
          pointer: item.lineTooltip !== false,
          focus: item.focusable !== false,
          label: caption,
        });
      }
      svg.append(path);
    }
    {
      const format = item.format ?? ((value) => formatPercent(value, 1));
      points.forEach((point, index) => {
        // A classified series must not leave an invisible hover target over
        // a point belonging to another series. Marker visibility alone is
        // separate: dense timelines intentionally retain hover-only points.
        if (typeof item.pointFilter === "function" && !item.pointFilter(point)) return;
        const value = finite(point[item.key]);
        if (value === null) return;
        const markerX = x(index, point);
        const markerY = ySecondary(value);
        const marker = document.createElementNS(svg.namespaceURI, "circle");
        marker.setAttribute("cx", String(markerX));
        marker.setAttribute("cy", String(markerY));
        const visualRadius = typeof item.markerRadius === "function"
          ? item.markerRadius(point)
          : item.markerRadius ?? 2.6;
        const showMarker = item.markers
          && Number.isFinite(visualRadius)
          && visualRadius > 0;
        marker.setAttribute("r", String(showMarker
          ? visualRadius
          : Math.max(7, finite(item.hitRadius, 8))));
        marker.setAttribute("class", showMarker
          ? `${item.className} chart-point`
          : `${item.className} chart-point chart-point-hit-target`);
        const heading = chartSeriesCaption(item.label, format(value));
        const detail = point.timestamp ? formatChartTimestamp(point.timestamp) : "";
        const caption = [heading, detail].filter(Boolean).join(" · ");
        // No native <title>: the styled hover is the one tooltip on a point.
        bindChartInteraction({
          element: marker,
          heading,
          detail,
          xPosition: markerX,
          yPosition: markerY,
          pointer: item.tooltip !== false,
          focus: item.focusable !== false,
          label: caption,
        });
        svg.append(marker);
      });
    }
  }
  svg.append(tooltip);
  svg.timelinePresentation = {
    svg, points: points.map((point, index) => ({ ...point, timestampMs: timestamps[index] })),
    series: chartSeries.map(item => ({ ...item, format: item.format ?? formatMoney })),
    x: point => margin.left + (point.timestampMs - domainStartMs) / (safeDomainEndMs - domainStartMs) * plotWidth,
    y, domain: { startMs: domainStartMs, endMs: safeDomainEndMs }, margin, width, height,
  };
  return svg;
}

function svgLine(x1, y1, x2, y2, className) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "line");
  element.setAttribute("x1", x1);
  element.setAttribute("y1", y1);
  element.setAttribute("x2", x2);
  element.setAttribute("y2", y2);
  element.setAttribute("class", className);
  return element;
}

function svgText(x, y, value, className, anchor = "start") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "text");
  element.setAttribute("x", x);
  element.setAttribute("y", y);
  element.setAttribute("class", className);
  element.setAttribute("text-anchor", anchor);
  // SVG text stays out of the exact-text bridge: it mixes localized copy with
  // formatted numbers and instants that must never be matched against an
  // English phrase table. Its words are localized upstream instead, by
  // `chartText` inside `lineChart`, which is why that helper refuses a bare
  // string — this attribute is the reason a gap here would be invisible.
  element.setAttribute("data-i18n-skip", "");
  element.textContent = value;
  return element;
}

function isWellObservedWeeklyFit(observedSpanPp) {
  // An unrecorded span cannot be promoted to primary evidence. It remains an
  // outlined diagnostic so a missing measurement is never silently discarded.
  return observedSpanPp !== null && observedSpanPp >= activeWeeklyMinimumObservedSpanPp;
}

/**
 * The one presentation model for the allowance history. It deliberately
 * contains only derived numerical evidence and date-only labels, so every
 * rendering inherits the same inclusion, range, point-classification, and
 * axis decisions without exposing source rows.
 */
function allowanceHistoryChartModel(data, {
  rangeDays = activeWeeklyRangeDays,
} = {}) {
  const summary = data?.weekly?.summary ?? {};
  const estimate = finite(summary.median_weekly_value_usd ?? summary.medianWeeklyValueUsd);
  const lower = finite(summary.lower_80_across_resets_usd ?? summary.lower80Usd);
  const upper = finite(summary.upper_80_across_resets_usd ?? summary.upper80Usd);
  const allPoints = (Array.isArray(data?.weekly?.weeklyValues) ? data.weekly.weeklyValues : [])
    .map((row, index) => {
      const at = Date.parse(row?.last_observed_at ?? row?.first_observed_at ?? "");
      const value = finite(row?.value_usd ?? row?.value);
      const observedSpanPp = finite(row?.displayed_span_pp);
      if (!Number.isFinite(at) || value === null) return null;
      return Object.freeze({
        timestamp: row?.last_observed_at ?? row?.first_observed_at,
        at,
        dateLabel: allowanceDateLabel(at),
        resetDueAt: row?.reset_due_at ?? row?.resetAt ?? null,
        value,
        low: finite(row?.pairwise_p10_usd ?? row?.lower),
        high: finite(row?.pairwise_p90_usd ?? row?.upper),
        observedSpanPp,
        wellObserved: isWellObservedWeeklyFit(observedSpanPp),
        historicalMedian: estimate,
        acrossResetLow: lower,
        acrossResetHigh: upper,
        index,
      });
    })
    .filter((point) => point !== null)
    .sort((left, right) => left.at - right.at);
  const selectedEnd = Date.parse(data.reportingWindow?.endAt ?? "");
  const latestObservedAt = Number.isFinite(selectedEnd) ? selectedEnd : allPoints.at(-1)?.at ?? null;
  const validRangeDays = Number.isFinite(rangeDays) && rangeDays > 0 ? rangeDays : null;
  const boundedRangeDays = validRangeDays !== null
    && validRangeDays < ALL_HISTORY_RANGE_DAYS
    ? validRangeDays
    : null;
  const cutoffAt = latestObservedAt === null || boundedRangeDays === null
    ? Number.NEGATIVE_INFINITY
    : latestObservedAt - validRangeDays * 24 * 60 * 60 * 1_000;
  // A 7-day window over a roughly weekly per-reset series holds one or two
  // fits at most, and the shared span slider then filtered those away almost
  // every time, so the 7d button was near-guaranteed to show an empty chart
  // (estimator audit, 2026-08-08). Short ranges therefore relax the span
  // floor to zero: every fit in range draws, with short observations keeping
  // their outlined diagnostic styling. The effective floor travels with the
  // model so the hero sentence and the chart caption both describe the
  // filter that actually applied.
  const spanFloorPp = boundedRangeDays !== null && boundedRangeDays <= 7
    ? 0
    : activeWeeklyMinimumObservedSpanPp;
  const inRange = allPoints.filter((point) => point.at >= cutoffAt
    && (latestObservedAt === null || point.at <= latestObservedAt));
  const points = inRange.filter((point) => (
    spanFloorPp === 0
      || (point.observedSpanPp !== null
        && point.observedSpanPp >= spanFloorPp)
  ));
  // Fit once after population/range/span selection. Both the dashboard and
  // the social image consume these exact values, including null gap breaks.
  const trends = buildAllowanceTrends(points);
  const axis = allowanceHistoryAxis(trends.points);
  return Object.freeze({
    allPoints: Object.freeze(allPoints),
    points: Object.freeze(trends.points.map((point) => Object.freeze(point))),
    lowessCount: trends.lowessCount,
    lowessReason: trends.reason,
    axis,
    xTicks: allowanceHistoryDateTicks(points),
    // The population facts the sentences around this model state: the corpus
    // size, how many fits fall in the selected range, the span floor that was
    // actually applied, the bounded range (null for "All"), and the selected
    // reporting end (falling back to the newest fit for standalone charts).
    totalCount: allPoints.length,
    inRangeCount: inRange.length,
    spanFloorPp,
    // The floor `wellObserved` classified against, which a relaxed range
    // leaves above `spanFloorPp`: the inclusion filter and the marker split
    // are two different decisions, and a surface that named the applied floor
    // beside an outlined point would explain the outline with the wrong
    // number. It travels with the model so the card can name it without
    // reading the slider itself.
    wellObservedFloorPp: activeWeeklyMinimumObservedSpanPp,
    rangeDays: boundedRangeDays,
    anchorAt: latestObservedAt,
  });
}

/**
 * Keep both renderers on the same vertical scale. This is the dashboard's
 * former chart-domain calculation expressed once: fitted values, across-reset
 * range, and each measured sensitivity range all count toward the domain.
 */
function allowanceHistoryAxis(points) {
  const values = (Array.isArray(points) ? points : [])
    .flatMap((point) => [
      finite(point?.value),
      finite(point?.historicalMedian),
      finite(point?.acrossResetLow),
      finite(point?.acrossResetHigh),
      finite(point?.low),
      finite(point?.high),
    ])
    .filter((value) => value !== null);
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    low = 0;
    high = 1;
  }
  if (low === high) {
    low -= 1;
    high += 1;
  }
  const padding = (high - low) * .1;
  low -= padding;
  high += padding;
  // Tick values a person could have chosen: snap outward to a 1/2/2.5/5-step
  // grid instead of slicing the raw data range into equal fourths, which
  // printed amounts like $1,006 and $2,447 on a dollar axis.
  const rawStep = (high - low) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10]
    .map((base) => base * magnitude)
    .find((candidate) => candidate >= rawStep) ?? rawStep;
  const firstTick = Math.max(0, Math.floor(low / step) * step);
  const lastTick = Math.ceil(high / step) * step;
  const ticks = [];
  for (let value = lastTick; value >= firstTick - step / 2; value -= step) {
    ticks.push(Math.round(value * 100) / 100);
  }
  return Object.freeze({
    low: firstTick,
    high: lastTick,
    ticks: Object.freeze(ticks),
  });
}

/**
 * Four evenly spaced date labels are legible in both the interactive view and
 * a posted image. They are based on the selected history domain rather than
 * on the density of reset fits.
 */
function allowanceHistoryDateTicks(points, maximum = 4) {
  const first = points?.[0]?.at;
  const last = points?.at(-1)?.at;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return Object.freeze([]);
  // Ticks take their resolution from the span they cover, so a month of resets
  // reads "Jan 5" while a multi-year history reads "Jan 2026" instead of every
  // tick repeating a full date.
  const spanMs = Math.max(0, last - first);
  if (last <= first) {
    return Object.freeze([
      Object.freeze({
        at: first,
        label: formatChartTimeLabel(first, { spanMs }),
        alignment: "middle",
      }),
    ]);
  }
  return Object.freeze(Array.from({ length: maximum }, (_, index) => {
    const at = first + spanMs * index / (maximum - 1);
    return Object.freeze({
      at,
      label: formatChartTimeLabel(at, { spanMs }),
      alignment: index === 0 ? "start" : index === maximum - 1 ? "end" : "middle",
    });
  }));
}

function weeklySpanLabel() {
  return activeWeeklyMinimumObservedSpanPp === 0
    ? t("weekly.span.all")
    : t("weekly.span.minimum", {
      span: formatDecimal(activeWeeklyMinimumObservedSpanPp, 0),
    });
}

// Sentences describe the floor the model actually applied, not the slider
// position: a short range relaxes the floor to zero, and a caption that kept
// naming the slider's floor would describe points the chart is not drawing.
function spanFloorSentenceLabel(spanFloorPp) {
  return spanFloorPp === 0
    ? t("weekly.span.none")
    : t("weekly.span.minimum", {
      span: formatDecimal(spanFloorPp, 0),
    });
}


function weeklyObservedSeriesLabel() {
  return activeWeeklyMinimumObservedSpanPp === 0
    ? { key: "weekly.series.allSpans" }
    : {
      key: "weekly.series.wellObserved",
      values: { span: formatDecimal(activeWeeklyMinimumObservedSpanPp, 0) },
    };
}

function weeklyPointDetail(point) {
  return {
    key: "weekly.point.detail",
    values: {
      span: formatPp(point.observedSpanPp),
      low: formatMoney(point.low),
      high: formatMoney(point.high),
    },
  };
}

function renderAllowanceHistoryChart(
  history,
  windowMinutes = CODEX_WEEKLY_ALLOWANCE_MINUTES,
) {
  const fiveHour = windowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES;
  const lowessLegend = $("#weekly-lowess-legend");
  if (lowessLegend) lowessLegend.hidden = history.lowessCount === 0;
  const note = $("#weekly-trend-note");
  if (note) {
    note.hidden = false;
    setLocalizedText(note, history.lowessReason === "tooMany"
      ? "weekly.controls.trendTooMany"
      : history.lowessCount === 0 ? "weekly.controls.trendSparse" : "weekly.controls.trendNote");
  }
  return lineChart({
    points: history.points,
    width: Math.max(240, $("#weekly-chart")?.clientWidth || 900),
    series: [
      {
        key: "historicalMedian",
        className: "chart-line-weekly-center",
        label: { key: "weekly.series.allDataMedian" },
        // A flat reference line: one value repeated at every x, so a dot per
        // point would say nothing the line does not already say.
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        lineFocusable: true,
        lineDetail: (points) => ({
          key: "weekly.chart.resetFit",
          plural: points.length,
        }),
        format: (value) => formatMoney(value),
      },
      {
        key: "allowanceLowess",
        className: "chart-line-weekly-lowess",
        label: { key: "weekly.controls.lowess" },
        pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
        format: (value) => formatMoney(value),
      },
      {
        key: "value",
        className: "chart-point-weekly-mature",
        label: weeklyObservedSeriesLabel(),
        connect: false,
        // Each dot is one observed seven-day reset. These are the plotted
        // points the chart exists to show; a shared "hide markers" flag once
        // turned every one of them into an invisible hit target. `markerRadius`
        // still splits well-observed from short observations across the two
        // point series, so exactly one of the pair draws each estimate.
        pointStyle: CHART_POINT_STYLE.EVIDENCE_DOTS,
        format: (value) => formatMoney(value),
        detail: weeklyPointDetail,
        timestampFirst: true,
        pointFilter: (point) => point.wellObserved,
        markerRadius: (point) => point.wellObserved ? 4 : 0,
      },
      {
        key: "value",
        className: "chart-point-weekly-partial",
        label: { key: "weekly.series.shortObservation" },
        connect: false,
        pointStyle: CHART_POINT_STYLE.EVIDENCE_DOTS,
        format: (value) => formatMoney(value),
        detail: weeklyPointDetail,
        timestampFirst: true,
        pointFilter: (point) => !point.wellObserved,
        markerRadius: (point) => point.wellObserved ? 0 : 4,
      },
    ],
    confidence: {
      low: "acrossResetLow",
      high: "acrossResetHigh",
      label: { key: "weekly.series.acrossResetRange" },
      format: (value) => formatMoney(value),
    },
    errorBars: {
      low: "low",
      high: "high",
      className: "chart-error-bar-weekly",
      label: { key: "weekly.series.measuredRange" },
      tooltip: false,
    },
    xDomain: {
      startMs: history.points[0]?.at,
      endMs: history.points.at(-1)?.at,
    },
    xTicks: history.xTicks,
    yDomain: history.axis,
    yTickFormat: (value, digits) => formatMoney(value, digits),
    yLabel: { key: fiveHour
      ? "weekly.chart.fiveHourAxis"
      : "chart.axis.apiEquivalentPerSevenDays" },
    title: { key: fiveHour
      ? "weekly.chart.fiveHourTitle"
      : "weekly.chart.title" },
    description: {
      key: fiveHour
        ? "weekly.chart.fiveHourDescription"
        : "weekly.chart.description",
      values: {
        span: spanFloorSentenceLabel(history.spanFloorPp),
        timeZone: formatTimeZoneLabel(),
      },
    },
  });
}

// The local pace engine is deliberately optional. Older companions and
// community/demo payloads do not carry this field, so the card is mounted
// lazily and remains hidden unless the engine returns current, safe weekly
// allowance evidence. One clean observation gets a quiet collecting state;
// this presentation never calls the allowance "tokens" and does not turn a
// pace estimate into a probability.
function firstFiniteForecastNumber(...values) {
  for (const value of values) {
    const number = finite(value);
    if (number !== null) return number;
  }
  return null;
}

function forecastTimestamp(...values) {
  for (const value of values) {
    if (value instanceof Date && Number.isFinite(value.valueOf())) {
      return value.valueOf();
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length > 0) {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) return timestamp;
    }
  }
  return null;
}

function formatAllowanceDuration(hours) {
  const value = finite(hours);
  if (value === null || value < 0) return null;
  if (value < 1) return t("allowance.lessThanHour");
  const wholeHours = Math.floor(value + 1e-8);
  const days = Math.floor(wholeHours / 24);
  return days > 0
    ? t("allowance.daysHours", { days: formatDecimal(days), hours: formatDecimal(wholeHours % 24) })
    : t("allowance.hours", { hours: formatDecimal(wholeHours) });
}

function allowanceTimestamp(label, timestamp) {
  if (timestamp === null) return node("span", "", label);
  const button = node("button", "allowance-timestamp", label);
  button.type = "button";
  const exact = dateTimeFormatter({
    timeZone: USER_TIME_ZONE, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(timestamp));
  button.dataset.informationExplanation = exact;
  button.setAttribute("aria-label", `${label} · ${exact}`);
  button.setAttribute("aria-expanded", "false");
  const show = () => {
    if (activeInformationPopover?.button !== button) openInformationPopover(button);
  };
  const hide = () => {
    if (activeInformationPopover?.button === button) closeInformationPopover();
  };
  button.addEventListener("mouseenter", show);
  button.addEventListener("mouseleave", () => {
    if (document.activeElement !== button) hide();
  });
  button.addEventListener("focus", show);
  button.addEventListener("blur", hide);
  button.addEventListener("click", (event) => { event.stopPropagation(); show(); });
  return button;
}

function formatForecastDuration(hours) {
  const value = finite(hours);
  if (value === null || value <= 0) return null;
  const totalMinutes = Math.max(1, Math.ceil(value * 60));
  const days = Math.floor(totalMinutes / 1_440);
  const remainingHours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${remainingHours}h`;
  if (remainingHours > 0) return `${remainingHours}h ${minutes}m`;
  return `${minutes}m`;
}

let weeklyPaceDetailsOpen = false;

function ensureWeeklyPaceForecastCard() {
  const section = $("#weekly");
  if (!section) return null;
  let card = $("#weekly-pace-forecast");
  if (!card) {
    card = node("aside", "weekly-pace-forecast");
    card.id = "weekly-pace-forecast";
    card.setAttribute("aria-live", "polite");
    card.setAttribute("aria-atomic", "true");
    // A direct child of the Allowance section, so the Forecast view owns it
    // and the Equivalent view's container never does.
    section.prepend(card);
  }
  return card;
}

// Over, on and under pace are judged against the pace this window can still
// sustain - the allowance that is left, spread evenly across the time that is
// left - and never against a fixed 100%-per-seven-days rate.
//
// The fixed rate cannot answer the question a reader is actually asking,
// because it ignores where in the window they already stand. At 3% left with
// a day to go, "a steady weekly pace" is more than ten times too fast to
// survive the reset, yet the card called that "ahead of a steady weekly pace"
// and stayed green, because colour tracked whether the engine had an ETA
// rather than whether the reader was about to run dry (community report,
// 2026-08-18).
const PACE_ON_TRACK_LOWER_RATIO = .85;
const PACE_ON_TRACK_UPPER_RATIO = 1.15;
// At twice the sustainable pace the allowance covers less than half the time
// that is left, so the window ends with more dry hours than covered ones.
const PACE_CRITICAL_RATIO = 2;
// Under an hour of observations an overall rate is whatever the reader
// happened to be doing in that hour, so the headline falls back to the
// engine's active-interval pace and the card keeps saying it is early.
const PACE_AVERAGE_MINIMUM_HOURS = 1;
const PACE_STATE_LABELS = Object.freeze({
  over: "allowance.over",
  on: "allowance.on",
  under: "allowance.under",
});

/**
 * The two rates this card carries answer different questions and routinely
 * disagree by an order of magnitude.
 *
 * `pace.activePercentagePointsPerHour` is the engine's median over adjacent
 * intervals that actually moved, so it measures the pace *while working* and
 * discards every idle gap. Extrapolated across a whole window it assumes the
 * reader never stops, which is why a forecast built on it alone always lands
 * earlier than what happens - the "it always underestimates the time I have
 * left" complaint this card drew.
 *
 * `pace.overallPercentagePointsPerHour` is the same window's rate with idle
 * time included, and since quota-pace-forecast-v0.2 it is what the engine's
 * own `etaAt` and `status` are built from. That is the honest headline; the
 * active rate remains in the evidence disclosure as the without-pausing edge.
 * Only the headline run-out is marked on the track.
 *
 * The `movementPp / elapsedHours` fallback covers a payload that predates the
 * named rates. It carries a minimum-span guard the engine field does not need,
 * because a derived average over a few minutes is whatever the reader happened
 * to be doing; the engine gates the same risk through `earlyEstimate` instead.
 */
function weeklyPaceRates(pace, forecast) {
  const active = firstFiniteForecastNumber(
    pace.activePercentagePointsPerHour,
    pace.percentPerHour,
    pace.pacePercentPerHour,
    forecast.percentagePointsPerHour,
    forecast.pacePercentPerHour,
    forecast.pacePpPerHour,
  );
  const elapsedHours = firstFiniteForecastNumber(pace.elapsedHours);
  const movementPp = firstFiniteForecastNumber(pace.movementPp);
  const derivedAverage = elapsedHours !== null
    && elapsedHours >= PACE_AVERAGE_MINIMUM_HOURS
    && movementPp !== null
    && movementPp > 0
    ? movementPp / elapsedHours
    : null;
  const reported = firstFiniteForecastNumber(
    pace.overallPercentagePointsPerHour,
  );
  const average = reported !== null && reported > 0 ? reported : derivedAverage;
  return {
    active: active !== null && active > 0 ? active : null,
    average,
    // The wall-clock rate leads. Falling back to the working rate keeps the
    // card readable rather than blank when only that one is available.
    headline: average ?? (active !== null && active > 0 ? active : null),
  };
}

/**
 * Where the reader stands relative to the pace that just reaches the reset.
 *
 * `ratio` is the whole classification: 1 means the allowance runs out exactly
 * at the reset, above 1 means it runs out early, below 1 means some is left
 * over. Because the sustainable pace is `remaining / hoursToReset`, the ratio
 * is also `hoursToReset / hoursToExhaustion`, so the track below can be drawn
 * straight from it without a second, separately-rounded division.
 */
function weeklyPaceStanding({ remainingPercent, hoursToReset, pacePpPerHour }) {
  const remaining = finite(remainingPercent);
  const hoursLeft = finite(hoursToReset);
  const pace = finite(pacePpPerHour);
  if (remaining === null
      || hoursLeft === null
      || hoursLeft <= 0
      || remaining <= 0
      || pace === null
      || pace <= 0) return null;
  const sustainable = remaining / hoursLeft;
  const ratio = pace / sustainable;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const coveredHours = Math.min(hoursLeft, remaining / pace);
  const state = ratio > PACE_ON_TRACK_UPPER_RATIO
    ? "over"
    : ratio < PACE_ON_TRACK_LOWER_RATIO ? "under" : "on";
  return {
    ratio,
    state,
    critical: state === "over" && ratio >= PACE_CRITICAL_RATIO,
    sustainable,
    coveredHours,
    dryHours: Math.max(0, hoursLeft - coveredHours),
    // Only meaningful when the pace does not exhaust the window; an over-pace
    // reading leaves nothing spare by definition.
    sparePercent: Math.max(0, remaining - pace * hoursLeft),
  };
}

function formatPaceRatio(ratio) {
  const value = finite(ratio);
  if (value === null) return null;
  return `${formatDecimal(value, value < 10 ? 1 : 0)}×`;
}

/**
 * The window as a single track: how much of the time left to the reset the
 * remaining allowance actually covers, and how much of it is dry.
 *
 * The bar is deliberately a picture of time, not of allowance. "You have 3%
 * left" tells a reader nothing on its own; "that covers the next 20 minutes
 * of a day and five hours" is the fact they act on. The state name, the
 * heading and this track's own label all state the standing in words, so
 * colour is never the only carrier.
 */
function weeklyPaceTrack(standing, hoursToReset, resetAt) {
  const hoursLeft = finite(hoursToReset);
  if (!standing || hoursLeft === null || hoursLeft <= 0) return null;
  const coveredShare = Math.max(0, Math.min(1, standing.coveredHours / hoursLeft));
  const track = node("div", "weekly-pace-track");
  track.style.setProperty("--pace-covered", `${(coveredShare * 100).toFixed(2)}%`);
  // Near either edge, stack callouts and retain the exact marker position.
  // This avoids overlapping labels without falsifying the time geometry.
  track.classList.toggle("is-edge", coveredShare < .22 || coveredShare > .78);
  const labels = node("div", "weekly-pace-track-labels");
  const dry = standing.dryHours > 0;
  if (dry) {
    const runout = node("div", "weekly-pace-track-runout");
    runout.append(node("span", "", t("allowance.runout")),
      allowanceTimestamp(t("allowance.inDuration", {
        duration: formatAllowanceDuration(standing.coveredHours),
      }), resetAt - standing.dryHours * 3_600_000));
    labels.append(runout);
  }
  const reset = node("div", "weekly-pace-track-reset");
  reset.append(node("span", "", t("allowance.resets")),
    allowanceTimestamp(t("allowance.inDuration", {
      duration: formatAllowanceDuration(hoursLeft),
    }), resetAt));
  labels.append(reset);
  const bar = node("div", "weekly-pace-track-bar");
  const covered = node("div", "weekly-pace-track-covered");
  covered.style.inlineSize = `${(coveredShare * 100).toFixed(2)}%`;
  bar.append(covered);
  if (dry) {
    const mark = node("div", "weekly-pace-track-mark");
    mark.style.insetInlineStart = `${(coveredShare * 100).toFixed(2)}%`;
    bar.append(mark);
  }
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", t(dry ? "allowance.trackDry" : "allowance.trackCovered", {
    reset: formatAllowanceDuration(hoursLeft),
    covered: formatAllowanceDuration(standing.coveredHours),
    dry: formatAllowanceDuration(standing.dryHours),
  }));
  const scale = node("div", "weekly-pace-track-scale");
  scale.append(node("span", "", t("allowance.now")));
  scale.append(node("span", "weekly-pace-track-gap", dry
    ? t("allowance.dryDuration", { duration: formatAllowanceDuration(standing.dryHours) })
    : t("allowance.untilReset")));
  track.append(labels, bar, scale);
  return track;
}

function weeklyPaceWaitingText(primary) {
  if (primary.status === "stale") {
    return { title: "allowance.waitingStaleTitle", copy: "allowance.waitingStaleCopy" };
  }
  if (primary.accountAttribution === "unattributed") {
    return { title: "allowance.waitingAccountTitle", copy: "allowance.waitingAccountCopy" };
  }
  return { title: "allowance.waitingTitle", copy: "allowance.waitingCopy" };
}

function renderWeeklyPaceWaiting(card, data) {
  const primary = Array.isArray(data?.quotaWindows)
    ? data.quotaWindows.find(isPrimaryCodexWeeklyQuotaWindow)
    : null;
  if (!primary) return;
  const stale = primary.status === "stale";
  const waiting = weeklyPaceWaitingText(primary);
  const heading = node("div", "weekly-pace-forecast-heading");
  const kicker = node("p", "panel-kicker");
  const logo = node("img", "quota-codex-icon");
  logo.setAttribute("src", "./codex-color.svg");
  logo.setAttribute("alt", "");
  logo.setAttribute("aria-hidden", "true");
  kicker.append(logo, node("span", "", t("allowance.forecast")));
  heading.append(kicker, node("span", "evidence-chip weekly-pace-forecast-collecting-chip",
    t(stale ? "allowance.stale" : "allowance.waiting")));
  const title = node("h3", "weekly-pace-forecast-title",
    t(waiting.title));
  title.id = "weekly-pace-forecast-title";
  card.setAttribute("aria-labelledby", title.id);
  card.className = "weekly-pace-forecast is-insufficient is-waiting";
  card.append(heading, title, node("p", "weekly-pace-forecast-copy",
    t(waiting.copy)));
  card.hidden = false;
}

/**
 * One reading of the weekly pace forecast, shared by the Forecast card and the
 * Overview summary so both always state the same standing, rate and run-out.
 *
 * Returns `null` when the payload cannot support a reading - no forecast, a
 * stale primary window, a reset already behind us, or a status that
 * contradicts its own dates. Callers then show their own waiting state; a
 * missing reading is never rendered as a pace of zero.
 */
function weeklyPaceReading(data, now = Date.now()) {
  const forecast = data?.weekly?.paceForecast;
  const stalePrimary = Array.isArray(data?.quotaWindows)
    && data.quotaWindows.some(window => isPrimaryCodexWeeklyQuotaWindow(window)
      && window.status === "stale");
  if (stalePrimary || !forecast || typeof forecast !== "object" || Array.isArray(forecast)) {
    return null;
  }
  const pace = forecast.pace && typeof forecast.pace === "object"
    ? forecast.pace
    : {};
  const rawStatus = String(forecast.status ?? forecast.state ?? "")
    .trim()
    .toLowerCase();
  const status = rawStatus === "reset_before_exhaustion"
    ? "will_reach_reset_first"
    : rawStatus;
  const resetAt = forecastTimestamp(
    forecast.resetsAt,
    forecast.resetAt,
    forecast.reset_at,
  );
  if (resetAt === null || resetAt <= now) return null;

  let remaining = firstFiniteForecastNumber(
    forecast.remainingPercent,
    forecast.remaining_percentage,
    forecast.currentRemainingPercent,
  );
  const used = firstFiniteForecastNumber(
    forecast.currentUsedPercent,
    forecast.usedPercent,
    forecast.current_used_percent,
  );
  if (remaining === null && used !== null) remaining = 100 - used;
  if (remaining !== null && (remaining < 0 || remaining > 100)) remaining = null;

  const rates = weeklyPaceRates(pace, forecast);
  const headlinePace = rates.headline;
  const hoursToReset = firstFiniteForecastNumber(
    (resetAt - now) / 3_600_000,
    forecast.hoursToReset,
    forecast.resetHours,
  );
  const suppliedHoursToExhaustion = firstFiniteForecastNumber(
    forecast.hoursToExhaustion,
    forecast.hoursToAllowance,
    forecast.etaHours,
  );
  let etaAt = forecastTimestamp(
    forecast.etaAt,
    forecast.exhaustionAt,
    forecast.allowanceAt,
  );
  if (etaAt === null && suppliedHoursToExhaustion !== null && suppliedHoursToExhaustion > 0) {
    etaAt = now + suppliedHoursToExhaustion * 3_600_000;
  }
  const available = status === "available"
    || (status === "" && etaAt !== null && headlinePace !== null);
  const reachesResetFirst = status === "will_reach_reset_first"
    || status === "reset_before_exhaustion";
  const paceIntervals = firstFiniteForecastNumber(pace.sampleCount);
  const observations = firstFiniteForecastNumber(
    forecast.observationCount,
    forecast.observations,
    forecast.sampleCount,
    paceIntervals === null ? null : paceIntervals + 1,
  );
  const canonicalResetAt = typeof forecast.resetsAt === "string"
    && resetAt !== null
    && new Date(resetAt).toISOString() === forecast.resetsAt;
  const observedExhaustion = status === "exhausted"
    && forecast.status === "exhausted"
    && forecast.currentUsedPercent === 100
    && forecast.remainingPercent === 0
    && canonicalResetAt
    && forecast.etaAt === null
    && etaAt === null
    && forecast.hoursToExhaustion === 0
    && Number.isSafeInteger(forecast.observationCount)
    && forecast.observationCount >= 1
    && observations === forecast.observationCount
    && hoursToReset !== null
    && hoursToReset > 0
    && pace.method === "median_adjacent_quota_slope";
  if (observedExhaustion) {
    return {
      remaining: 0,
      hoursToReset,
      resetAt,
      rates: { active: null, average: null, headline: null },
      headlinePace: null,
      observations,
      paceElapsedHours: null,
      collectingEvidence: false,
      earlyEstimate: false,
      available: false,
      reachesResetFirst: false,
      standing: null,
      paceState: null,
      projectedEtaAt: null,
      exhausted: true,
    };
  }
  const paceElapsedHours = firstFiniteForecastNumber(pace.elapsedHours);
  // A single trusted snapshot cannot establish a rate, but it is useful to
  // say why the forecast is not visible yet. Do not surface an unbounded or
  // otherwise unusable engine result as a generic empty state.
  const collectingEvidence = status === "insufficient_observations"
    && observations === 1;
  const earlyEstimate = available && (
    (observations !== null && observations <= 2)
    || (paceElapsedHours !== null && paceElapsedHours < 1)
  );
  // A contradiction between the status and dates is an integration error, not
  // a reason to show a confident-looking card. Wait for the next refresh.
  if (available && (etaAt === null || etaAt <= now || etaAt > resetAt)) return null;
  if (!available && !reachesResetFirst && !collectingEvidence) return null;
  if (collectingEvidence && remaining === null) return null;
  if (!collectingEvidence
      && remaining === null
      && headlinePace === null
      && !reachesResetFirst) return null;

  // The standing is computed from the headline rate, so the card's colour,
  // its heading and its arithmetic all come from one number. The engine's own
  // `available` / `will_reach_reset_first` split still gates whether a card
  // appears at all, but it no longer decides how the card reads: an engine ETA
  // built on the active-interval pace is exactly the reading that overstated
  // the burn.
  const standing = collectingEvidence
    ? null
    : weeklyPaceStanding({
      remainingPercent: remaining,
      hoursToReset,
      pacePpPerHour: headlinePace,
    });
  const paceState = standing?.state
    ?? (collectingEvidence ? null : reachesResetFirst ? "under" : null);
  const projectedEtaAt = standing !== null && standing.state === "over"
    ? now + standing.coveredHours * 3_600_000
    : null;
  return {
    remaining,
    hoursToReset,
    resetAt,
    rates,
    headlinePace,
    observations,
    paceElapsedHours,
    collectingEvidence,
    earlyEstimate,
    available,
    reachesResetFirst,
    standing,
    paceState,
    projectedEtaAt,
  };
}

function weeklyPaceHeadlineText({ collectingEvidence, exhausted, paceState, projectedEtaAt, standing }) {
  if (collectingEvidence) return t("allowance.collectingTitle");
  if (exhausted) return t("trends.evidenceExhausted");
  if (paceState === "over") {
    return projectedEtaAt === null
      ? t("allowance.beforeReset")
      : t("allowance.headline", { duration: formatAllowanceDuration(standing.coveredHours) });
  }
  return paceState === "on" ? t("allowance.nearReset") : t("allowance.spareTitle");
}

function weeklyPaceCopyText({ collectingEvidence, exhausted, standing, earlyEstimate }) {
  if (collectingEvidence) return t("allowance.collectingCopy");
  if (exhausted) return t("trends.evidenceExhaustedWhy");
  let copy;
  if (standing === null) {
    copy = t("allowance.slowCopy");
  } else if (standing.state === "over") {
    const gap = standing.dryHours > 0 ? formatAllowanceDuration(standing.dryHours) : null;
    copy = t("allowance.overCopy", {
      ratio: formatPaceRatio(standing.ratio),
      gap: gap ? t("allowance.gapCopy", { duration: gap }) : "",
    });
  } else if (standing.state === "on") {
    copy = t("allowance.onCopy");
  } else {
    copy = t("allowance.underCopy", { ratio: formatPaceRatio(standing.ratio) });
  }
  return earlyEstimate ? `${copy} ${t("allowance.earlyCopy")}` : copy;
}

/**
 * The Overview's short answer to "how fast am I using the allowance, and when
 * does it run out?". It states the same reading as the Forecast card - one
 * headline, one rate sentence and four figures - and links there for the
 * track, the evidence and both rates. The weekly pool is the only one the pace
 * engine models, so nothing is shown when no weekly window was observed, and a
 * waiting reading says so rather than rendering a rate of zero.
 */
function renderOverviewPace(data) {
  const element = $("#overview-pace");
  if (!element) return;
  clear(element);
  element.hidden = true;
  element.className = "overview-pace";
  element.removeAttribute("aria-labelledby");
  const primary = Array.isArray(data?.quotaWindows)
    ? data.quotaWindows.find(isPrimaryCodexWeeklyQuotaWindow)
    : null;
  if (!primary) return;
  const reading = weeklyPaceReading(data);
  const stale = primary.status === "stale";
  const heading = node("div", "overview-pace-heading");
  const kicker = node("p", "panel-kicker");
  const logo = node("img", "quota-codex-icon");
  logo.setAttribute("src", "./codex-color.svg");
  logo.setAttribute("alt", "");
  logo.setAttribute("aria-hidden", "true");
  kicker.append(logo, node("span", "", t("allowance.forecast")));
  heading.append(kicker);
  const title = node("h3", "overview-pace-title");
  title.id = "overview-pace-title";
  element.setAttribute("aria-labelledby", title.id);
  const link = node("a", "overview-card-link", t("dashboard.overview.openForecast"));
  link.setAttribute("href", "#allowance/forecast");

  if (reading === null) {
    const waiting = weeklyPaceWaitingText(primary);
    element.classList.add("is-waiting");
    heading.append(node("span", "evidence-chip overview-pace-chip",
      t(stale ? "allowance.stale" : "allowance.waiting")));
    title.textContent = t(waiting.title);
    element.append(heading, title, node("p", "overview-pace-copy", t(waiting.copy)), link);
    element.hidden = false;
    return;
  }

  const { standing, paceState, collectingEvidence, exhausted, earlyEstimate, remaining,
    hoursToReset, headlinePace } = reading;
  if (collectingEvidence) {
    element.classList.add("is-insufficient");
    heading.append(node("span", "evidence-chip overview-pace-chip", t("allowance.oneMore")));
  } else if (paceState) {
    element.classList.add(`is-${paceState}-pace`);
    if (standing?.critical) element.classList.add("is-critical");
    heading.append(node("span", "evidence-chip overview-pace-chip",
      t(standing?.critical ? "allowance.wayOver" : PACE_STATE_LABELS[paceState])));
  }
  if (earlyEstimate) {
    heading.append(node("span", "evidence-chip overview-pace-early-chip", t("allowance.early")));
  }
  title.textContent = weeklyPaceHeadlineText(reading);
  if (reading.projectedEtaAt !== null) {
    const [before, after] = t("allowance.headline", { duration: "{duration}" }).split("{duration}");
    title.replaceChildren(document.createTextNode(before),
      allowanceTimestamp(formatAllowanceDuration(standing.coveredHours), reading.projectedEtaAt),
      document.createTextNode(after ?? ""));
  }

  const metrics = node("div", "overview-pace-metrics");
  const addMetric = (label, value) => {
    const item = node("div", "overview-pace-metric");
    item.append(node("span", "", label));
    item.append(node("strong", "", value));
    metrics.append(item);
  };
  if (remaining !== null) addMetric(t("allowance.left"), formatPercent(remaining));
  const resetDuration = formatAllowanceDuration(hoursToReset);
  if (resetDuration) addMetric(t("allowance.resetsIn"), resetDuration);
  if (!collectingEvidence && headlinePace !== null) {
    addMetric(t("allowance.recentPace"), t("allowance.rate", { rate: formatDecimal(headlinePace, 1) }));
  }
  if (standing !== null && standing.dryHours > 0) {
    addMetric(t("allowance.runout"), t("allowance.inDuration", {
      duration: formatAllowanceDuration(standing.coveredHours),
    }));
  } else if (standing !== null) {
    addMetric(t("allowance.spare"), formatPercent(standing.sparePercent));
  }
  element.append(heading, title);
  if (!collectingEvidence) element.append(node("p", "overview-pace-copy", weeklyPaceCopyText(reading)));
  if (metrics.childElementCount > 0) element.append(metrics);
  element.append(link);
  element.hidden = false;
}

function renderWeeklyPaceForecast(data) {
  const card = ensureWeeklyPaceForecastCard();
  if (!card) return;
  card.hidden = true;
  card.className = "weekly-pace-forecast";
  delete card.dataset.tankRatio;
  delete card.dataset.tankReset;
  delete card.dataset.tankRemaining;
  card.removeAttribute("aria-labelledby");
  clear(card);

  const reading = weeklyPaceReading(data);
  if (reading === null) return renderWeeklyPaceWaiting(card, data);
  const {
    remaining, hoursToReset, resetAt, rates, headlinePace, observations,
    paceElapsedHours, collectingEvidence, exhausted, earlyEstimate, available,
    reachesResetFirst, standing, paceState, projectedEtaAt,
  } = reading;
  if (standing) {
    card.dataset.tankRatio = String(standing.ratio);
    card.dataset.tankReset = String(resetAt);
    card.dataset.tankRemaining = String(remaining);
  }

  const title = node("h3", "weekly-pace-forecast-title");
  const cardId = "weekly-pace-forecast-title";
  title.id = cardId;
  title.textContent = weeklyPaceHeadlineText(reading);
  if (projectedEtaAt !== null) {
    const [before, after] = t("allowance.headline", { duration: "{duration}" }).split("{duration}");
    title.replaceChildren(document.createTextNode(before),
      allowanceTimestamp(formatAllowanceDuration(standing.coveredHours), projectedEtaAt),
      document.createTextNode(after ?? ""));
  }
  card.setAttribute("aria-labelledby", cardId);

  const heading = node("div", "weekly-pace-forecast-heading");
  const kicker = node("p", "panel-kicker");
  if (collectingEvidence) {
    kicker.textContent = t("allowance.collecting");
  } else {
    const logo = node("img", "quota-codex-icon");
    logo.setAttribute("src", "./codex-color.svg");
    logo.setAttribute("alt", "");
    logo.setAttribute("aria-hidden", "true");
    kicker.append(logo, node("span", "", t("allowance.forecast")));
  }
  heading.append(kicker);
  if (collectingEvidence) {
    heading.append(node(
      "span",
      "evidence-chip weekly-pace-forecast-collecting-chip",
      t("allowance.oneMore"),
    ));
  } else if (paceState) {
    // The standing is named in words on the chip as well as carried in the
    // card's colour, so the over/on/under reading survives a monochrome
    // screen, a colour-vision difference and a screen reader alike.
    heading.append(node(
      "span",
      "evidence-chip weekly-pace-forecast-state-chip",
      t(standing?.critical ? "allowance.wayOver" : PACE_STATE_LABELS[paceState]),
    ));
  }
  if (earlyEstimate) {
    heading.append(node(
      "span",
      "evidence-chip weekly-pace-forecast-early-chip",
      t("allowance.early"),
    ));
  }

  const dryDuration = standing === null
    ? null
    : standing.dryHours > 0 ? formatAllowanceDuration(standing.dryHours) : null;
  const copy = node("p", "weekly-pace-forecast-copy");
  copy.textContent = weeklyPaceCopyText(reading);

  const metrics = node("div", "weekly-pace-forecast-metrics");
  const addMetric = (label, value) => {
    const item = node("div", "weekly-pace-forecast-metric");
    item.append(node("span", "", label), node("strong", "", value));
    metrics.append(item);
  };
  if (remaining !== null) addMetric(t("allowance.left"), formatPercent(remaining));
  const resetDuration = formatAllowanceDuration(hoursToReset);
  if (resetDuration) addMetric(t("allowance.resetsIn"), resetDuration);
  if (collectingEvidence) {
    addMetric(t("allowance.evidence"), t("allowance.oneSaved"));
  } else if (dryDuration) {
    // A dry stretch and spare allowance are mutually exclusive, and the tile
    // reports whichever one the reading actually produced rather than pinning
    // itself to the state name.
    addMetric(t("allowance.dry"), dryDuration);
  } else if (standing !== null) {
    addMetric(t("allowance.spare"), formatPercent(standing.sparePercent));
  } else if (headlinePace !== null && headlinePace > 0) {
    addMetric(t("allowance.recentPace"), t("allowance.rate", { rate: formatDecimal(headlinePace, 1) }));
  }

  const track = collectingEvidence || exhausted
    ? null
    : weeklyPaceTrack(standing, hoursToReset, resetAt);

  // The evidence line names both rates. A reader who wondered why the old
  // card's forecast kept arriving early can see the difference between the
  // pace with idle time counted and the pace while working, instead of being
  // handed one number with no way to tell which it was.
  const observationDuration = formatForecastDuration(paceElapsedHours);
  const rateSentences = [];
  if (rates.average !== null) {
    rateSentences.push(t("allowance.overallRate", { rate: formatDecimal(rates.average, 1) }));
  }
  if (rates.active !== null) {
    rateSentences.push(t("allowance.activeRate", { rate: formatDecimal(rates.active, 1) }));
  }
  const evidence = observations !== null && observations >= 1
    ? node(
      "p",
      "weekly-pace-forecast-evidence",
      collectingEvidence
        ? t("allowance.oneObservation")
        : t("allowance.observations", { count: formatDecimal(Math.round(observations), 0), duration: observationDuration ? t("allowance.overDuration", { duration: observationDuration }) : "", rates: rateSentences.length > 0 ? `: ${rateSentences.join(", ")}` : "" }),
    )
    : null;
  card.className = [
    "weekly-pace-forecast",
    collectingEvidence
      ? "is-insufficient"
      : exhausted
        ? "is-exhausted"
        : paceState === "over"
          ? "is-over-pace"
          : paceState === "on" ? "is-on-pace" : "is-under-pace",
    standing?.critical ? "is-critical" : "",
    earlyEstimate ? "is-early-estimate" : "",
    // Retained so the engine's own split stays inspectable from the DOM even
    // though it no longer drives presentation.
    reachesResetFirst ? "is-reset-first" : "",
    available ? "is-available" : "",
  ].filter(Boolean).join(" ");
  card.append(heading, title, copy);
  if (track) card.append(track);
  const details = node("details", "weekly-pace-details");
  details.open = weeklyPaceDetailsOpen;
  details.addEventListener("toggle", () => { weeklyPaceDetailsOpen = details.open; });
  details.append(node("summary", "", t("allowance.basis")), metrics);
  if (evidence) details.append(evidence);
  if (rates.active !== null && remaining !== null && rates.active > 0) {
    details.append(node("p", "weekly-pace-track-note", t("allowance.active", {
      duration: formatAllowanceDuration(remaining / rates.active),
    })));
  }
  card.append(details);
  card.hidden = false;
}

function allowanceHistoryForWindow(data, windowMinutes) {
  if (windowMinutes === CODEX_WEEKLY_ALLOWANCE_MINUTES) return data?.weekly ?? null;
  if (windowMinutes !== CODEX_FIVE_HOUR_ALLOWANCE_MINUTES) return null;
  return data?.allowanceHistoryByWindow?.[
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
  ] ?? null;
}

function allowanceHistoryHasEvidence(history) {
  return history !== null && (
    history?.status === "available"
    || (Array.isArray(history?.weeklyValues) && history.weeklyValues.length > 0)
  );
}

function resolvedAllowanceWindowMinutes(data) {
  const fiveHour = allowanceHistoryForWindow(
    data,
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  );
  if (activeAllowanceWindowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
      && fiveHour !== null) return CODEX_FIVE_HOUR_ALLOWANCE_MINUTES;
  if (activeAllowanceWindowMinutes === CODEX_WEEKLY_ALLOWANCE_MINUTES) {
    return allowanceHistoryHasEvidence(data?.weekly) || fiveHour === null
      ? CODEX_WEEKLY_ALLOWANCE_MINUTES
      : CODEX_FIVE_HOUR_ALLOWANCE_MINUTES;
  }
  if (allowanceHistoryHasEvidence(data?.weekly)) {
    return CODEX_WEEKLY_ALLOWANCE_MINUTES;
  }
  return fiveHour !== null
    ? CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
    : CODEX_WEEKLY_ALLOWANCE_MINUTES;
}

function allowanceWindowView(data) {
  const windowMinutes = resolvedAllowanceWindowMinutes(data);
  if (windowMinutes === CODEX_WEEKLY_ALLOWANCE_MINUTES) {
    return {
      ...selectAllowancePlanPopulation(data, activeWeeklyPlanType),
      allowanceWindowDurationMinutes: windowMinutes,
    };
  }
  const windowData = {
    ...data,
    weekly: allowanceHistoryForWindow(data, windowMinutes),
    quotaWindows: (Array.isArray(data?.quotaWindows) ? data.quotaWindows : [])
      .filter((window) => (
        isPrimaryCodexQuotaWindow(window)
        && finite(window?.durationMinutes) === windowMinutes
      )),
    allowanceWindowDurationMinutes: windowMinutes,
  };
  return selectAllowancePlanPopulation(windowData, activeWeeklyPlanType);
}

function renderAllowanceWindowChrome(data, windowMinutes) {
  const fiveHourSelected = windowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES;
  const fiveHourAvailable = allowanceHistoryForWindow(
    data,
    CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  ) !== null;
  const controls = $("#allowance-window-controls");
  const buttons = typeof controls?.querySelectorAll === "function"
    ? controls.querySelectorAll("button[data-window-minutes]")
    : [];
  for (const button of buttons) {
    const duration = Number(button.dataset.windowMinutes);
    const active = duration === windowMinutes;
    const unavailable = duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
      && !fiveHourAvailable;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = unavailable;
    button.title = unavailable ? t("weekly.window.unavailable") : "";
    setLocalizedText(button, duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
      ? "weekly.window.fiveHour"
      : "weekly.window.sevenDay");
  }
  const note = $("#allowance-window-note");
  note.hidden = !fiveHourSelected && fiveHourAvailable;
  if (!note.hidden) setLocalizedText(note, fiveHourSelected
    ? "weekly.window.historyOnly"
    : "weekly.window.unavailable");
  setLocalizedText($("#weekly-table-caption"), fiveHourSelected
    ? "weekly.table.fiveHourCaption"
    : "weekly.table.sevenDayCaption");
}

function renderWeeklyPlanControl(data) {
  const control = $("#weekly-plan-control");
  const select = $("#weekly-plan-select");
  const note = $("#weekly-plan-note");
  if (!control || !select || !note) return;
  const optionPlanLabel = (planType) => allowancePlanLabel(planType).replace(/\s*\((\d+)×\)/u, "$1x");
  const selection = data.allowancePlanSelection;
  const previewPlan = data.mode === "demo"
    ? optionPlanLabel(data?.weekly?.planType)
    : "";
  control.hidden = !selection && previewPlan === "";
  note.hidden = !selection;
  if (!selection) {
    if (previewPlan !== "") {
      const signature = `preview:${data.weekly.planType}:${localization.locale()}`;
      if (select.dataset.populationSignature !== signature) {
        const option = node("option");
        option.value = data.weekly.planType;
        option.textContent = t("weekly.plan.latestOption", { plan: previewPlan });
        select.replaceChildren(option);
        select.dataset.populationSignature = signature;
      }
      select.value = data.weekly.planType;
      select.disabled = true;
    }
    return;
  }
  const populations = data.weekly.planPopulations ?? [];
  const signature = JSON.stringify([
    populations.map((row) => row.planType),
    selection.currentPlanType,
    localization.locale(),
  ]);
  if (select.dataset.populationSignature !== signature) {
    select.replaceChildren(...populations.map((row) => {
      const option = node("option");
      option.value = row.planType;
      option.textContent = t(row.planType === selection.currentPlanType
        ? "weekly.plan.latestOption" : "weekly.plan.historyOption", {
        plan: (row.planType === selection.currentPlanType
          ? optionPlanLabel(row.planType) : allowancePlanLabel(row.planType)) || t("weekly.plan.unknown"),
      });
      return option;
    }));
    select.dataset.populationSignature = signature;
  }
  select.value = selection.planType;
  select.disabled = populations.length < 2;
  setLocalizedText(note, selection.isCurrentPlan
    ? "weekly.plan.conditional" : "weekly.plan.historicalConditional", {
    plan: allowancePlanLabel(selection.planType) || t("weekly.plan.unknown"),
  });
}

function renderWeekly(data) {
  const rootData = data;
  data = allowanceWindowView(data);
  const windowMinutes = data.allowanceWindowDurationMinutes;
  renderAllowanceWindowChrome(rootData, windowMinutes);
  renderWeeklyPlanControl(selectAllowancePlanPopulation(rootData, activeWeeklyPlanType));
  renderPublishedUnknownSpeedPolicy($("#weekly-unknown-speed-policy"), data);
  // A weekly estimate carried over from the previous app version while the
  // recalculation runs announces itself here, quietly.
  renderStaleServeNote(
    $("#weekly-stale-note"),
    data?.weekly?.stale?.stale === true,
  );
  const summary = data.weekly.summary ?? {};
  const estimate = finite(summary.median_weekly_value_usd ?? summary.medianWeeklyValueUsd);
  const lower = finite(summary.lower_80_across_resets_usd ?? summary.lower80Usd);
  const upper = finite(summary.upper_80_across_resets_usd ?? summary.upper80Usd);
  const qualifying = finite(summary.qualifying_resets ?? summary.qualifyingResets, 0);

  const history = allowanceHistoryChartModel(data);
  const values = history.allPoints;
  const chartValues = history.points;

  // The headline is a stable all-data median. The range buttons and the
  // minimum-observed-span slider filter the chart and nothing else, so the two
  // numbers could differ by hundreds of dollars with nothing on screen saying
  // why. They now say so: the hero names its population, and the sentence
  // underneath reports how much of that population the chart is drawing. The
  // headline is deliberately not made to follow the filter — a figure people
  // quote should not move when they adjust a chart control.
  const planLabel = allowancePlanLabel(data.weekly.planType) || t("weekly.plan.unknown");
  setLocalizedText($("#weekly-estimate-label"), data.allowancePlanSelection
    ? "weekly.headline.planLabel" : "weekly.headline.label", { plan: planLabel });
  $("#weekly-estimate").textContent = estimate === null
    ? t("weekly.headline.insufficient")
    : t("weekly.headline.value", { amount: formatMoney(estimate) });
  $("#weekly-range").textContent = lower === null || upper === null
    ? t("weekly.headline.rangeUnavailable")
    : t(data.allowancePlanSelection
      ? "weekly.headline.planRange" : "weekly.headline.range", {
      plan: planLabel,
      lower: formatMoney(lower),
      upper: formatMoney(upper),
    });
  $("#weekly-explanation").textContent = qualifying
    ? t("weekly.headline.relationship", {
      qualifying: formatDecimal(qualifying, 0),
      shown: formatDecimal(chartValues.length, 0),
      total: formatDecimal(values.length, 0),
      // The floor the model actually applied — a short range relaxes it —
      // and the selected reporting end. Standalone charts fall back to the
      // newest fit, while the dashboard follows the shared reporting window.
      span: spanFloorSentenceLabel(history.spanFloorPp),
      anchor: history.anchorAt === null
        ? "—"
        : allowanceDateLabel(history.anchorAt),
    })
    : t("weekly.headline.pending");

  setLocalizedText($("#weekly-chart-timezone"), "chart.timeZoneNote", {
    timeZone: formatTimeZoneLabel(),
  });
  // Short ranges include every fit; here the slider only classifies markers.
  // Name that role explicitly instead of presenting an inactive minimum filter.
  const shortRange = history.rangeDays !== null && history.rangeDays <= 7;
  setLocalizedText($("#weekly-span-label"), shortRange
    ? "weekly.controls.observedSpan" : "weekly.controls.minimumSpan");
  const spanNote = $("#weekly-span-note");
  spanNote.hidden = !shortRange;
  setLocalizedText(spanNote, "weekly.controls.shortRangeNote");
  $("#weekly-span-value").textContent = weeklySpanLabel();
  $("#weekly-span-legend").textContent = chartText(weeklyObservedSeriesLabel());
  $("#weekly-partial-legend").hidden = !chartValues.some((row) => !row.wellObserved);
  const empty = $("#weekly-empty");
  const shell = $("#weekly-chart");
  if (!chartValues.length) {
    $("#weekly-lowess-legend").hidden = true;
    $("#weekly-trend-note").hidden = true;
    empty.hidden = false;
    shell.hidden = true;
    // An empty chart names its reason instead of the generic sentence: either
    // no fits fall in the selected range at all, or fits are in range and the
    // span floor filtered every one of them (estimator audit, 2026-08-08).
    if (values.length === 0) {
      setLocalizedText(empty, windowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
        ? "weekly.chart.fiveHourEmpty"
        : "weekly.chart.empty");
    } else if (history.inRangeCount === 0) {
      setLocalizedText(empty, "weekly.chart.emptyRange");
    } else {
      setLocalizedPluralText(
        empty,
        "weekly.chart.emptyBelowFloor",
        history.inRangeCount,
        { span: formatDecimal(history.spanFloorPp, 0) },
      );
    }
  } else {
    empty.hidden = true;
    shell.hidden = false;
    shell.replaceChildren(renderAllowanceHistoryChart(history, windowMinutes));
  }
  renderWeeklyTable(values, windowMinutes);
}

// The Allowance page's reset-estimate table pages through its full row set
// (owner-directed 2026-08-10) instead of truncating to the newest fourteen:
// Six rows per batch, newest first, same pager idiom as the exact-windows
// inspection table. The state lives beside its renderers so the render
// harness that extracts this section gets the whole mechanism.
const WEEKLY_TABLE_PAGE_SIZE = 6;
let weeklyTablePage = 0;
let weeklyTableRows = [];
let weeklyTableSignature = "";
let weeklyTableWindowMinutes = CODEX_WEEKLY_ALLOWANCE_MINUTES;

function renderWeeklyTable(values, windowMinutes = CODEX_WEEKLY_ALLOWANCE_MINUTES) {
  // Newest first over the FULL set: the old `.slice(-14)` silently dropped
  // every earlier reset estimate. A changed row set restarts at the first
  // page, exactly like the exact-windows inspection table: a page index only
  // describes a position within one row set.
  const rows = [...values].reverse();
  const signature = `${rows.length}`
    + `:${rows[0]?.timestamp ?? ""}`
    + `:${rows.at(-1)?.timestamp ?? ""}`;
  if (signature !== weeklyTableSignature) {
    weeklyTableSignature = signature;
    weeklyTablePage = retainedPageIndex(weeklyTableRows, rows, weeklyTablePage, WEEKLY_TABLE_PAGE_SIZE, row => row.timestamp);
  }
  weeklyTableRows = rows;
  weeklyTableWindowMinutes = windowMinutes;
  renderWeeklyTablePage();
}

function renderWeeklyTablePage() {
  const table = $("#weekly-table");
  if (!table) return;
  clear(table);
  const rows = weeklyTableRows;
  const pagination = $("#weekly-table-pagination");
  if (!rows.length) {
    if (pagination) pagination.hidden = true;
    const row = node("tr");
    const cell = node("td", "empty-cell", t(
      weeklyTableWindowMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
        ? "weekly.table.fiveHourEmpty"
        : "weekly.table.empty",
    ));
    cell.colSpan = 5;
    row.append(cell);
    table.append(row);
    return;
  }
  const pageCount = Math.ceil(rows.length / WEEKLY_TABLE_PAGE_SIZE);
  weeklyTablePage = Math.min(Math.max(0, weeklyTablePage), pageCount - 1);
  const start = weeklyTablePage * WEEKLY_TABLE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + WEEKLY_TABLE_PAGE_SIZE);
  for (const row of pageRows) {
    const span = row.observedSpanPp ?? finite(row.displayed_span_pp);
    const status = isWellObservedWeeklyFit(span)
      ? t("weekly.table.wellObserved")
      : span === null
        ? t("weekly.table.spanNotRecorded")
        : t("weekly.series.shortObservation");
    const evidenceDate = formatLocal(row.timestamp, { dateOnly: true });
    const tr = node("tr");
    tr.append(
      node("td", "", evidenceDate),
      node("td", "", formatPp(span)),
      node("td", "", formatMoney(row.value)),
      node("td", "", row.low === null || row.high === null ? "—" : `${formatMoney(row.low)}–${formatMoney(row.high)}`),
      node("td", "", status),
    );
    table.append(tr);
  }
  if (!pagination) return;
  // The pager renders only when there is something to page through; a set
  // that fits one page keeps the plain table.
  pagination.hidden = pageCount <= 1;
  setLocalizedText($("#weekly-table-status"), "weekly.table.page", {
    start: formatNumber(start + 1),
    end: formatNumber(start + pageRows.length),
    total: formatNumber(rows.length),
  });
  const previous = $("#weekly-table-prev");
  const next = $("#weekly-table-next");
  if (previous) previous.disabled = weeklyTablePage === 0;
  if (next) next.disabled = weeklyTablePage >= pageCount - 1;
}

function accountingPeriod(data) {
  const periods = Array.isArray(data?.accounting?.periods)
    ? data.accounting.periods
    : [];
  const selected = periods.find(
    (period) => period?.periodId === activeAccountingPeriod,
  );
  if (!selected) return null;
  // Accounting calls the archive-backed broad period `history`; the switch
  // analyzer calls the same complete unified-index scan `all`.
  const cacheSwitchPeriodId = selected.periodId === "history"
    ? "all"
    : selected.periodId;
  const rootCacheSwitchImpact = data.accounting.cacheSwitchImpact;
  const periodCacheSwitchImpact = Array.isArray(rootCacheSwitchImpact?.periods)
    ? rootCacheSwitchImpact.periods.find(
      (period) => period?.periodId === cacheSwitchPeriodId,
    )
    : null;
  const selectedCacheSwitchImpact = selected.cacheSwitchImpact?.status === "available"
    ? selected.cacheSwitchImpact
    : periodCacheSwitchImpact?.status === "available"
      ? periodCacheSwitchImpact
      : rootCacheSwitchImpact?.status === "available"
          && rootCacheSwitchImpact.periodId === cacheSwitchPeriodId
        ? rootCacheSwitchImpact
        : { status: "unavailable", recent: [], allowanceImpact: { status: "unavailable" } };
  // The weekly allowance translation is attached only to the selected root
  // summary unless the companion explicitly places one on this period. Never
  // let a 7-day translation leak onto a 24-hour or history selection.
  const allowanceImpact = ["complete", "range"].includes(
    selectedCacheSwitchImpact.allowanceImpact?.status,
  )
    ? selectedCacheSwitchImpact.allowanceImpact
    : rootCacheSwitchImpact?.periodId === cacheSwitchPeriodId
      ? rootCacheSwitchImpact.allowanceImpact
      : { status: "unavailable" };
  const rootCacheContinuityImpact = data.accounting.cacheContinuityImpact;
  const periodCacheContinuityImpact = Array.isArray(
    rootCacheContinuityImpact?.periods,
  )
    ? rootCacheContinuityImpact.periods.find(
      (period) => period?.periodId === cacheSwitchPeriodId,
    )
    : null;
  const selectedCacheContinuityImpact = selected.cacheContinuityImpact?.status
      === "available"
    ? selected.cacheContinuityImpact
    : periodCacheContinuityImpact?.status === "available"
      ? periodCacheContinuityImpact
      : rootCacheContinuityImpact?.status === "available"
          && rootCacheContinuityImpact.periodId === cacheSwitchPeriodId
        ? rootCacheContinuityImpact
        : { status: "unavailable", recent: [], allowanceImpact: { status: "unavailable" } };
  const continuityAllowanceImpact = selectedCacheContinuityImpact
    .allowanceImpact?.status && ["complete", "range"].includes(
      selectedCacheContinuityImpact.allowanceImpact.status,
    )
    ? selectedCacheContinuityImpact.allowanceImpact
    : rootCacheContinuityImpact?.periodId === cacheSwitchPeriodId
      ? rootCacheContinuityImpact.allowanceImpact
      : { status: "unavailable" };
  return {
    ...data.accounting,
    ...selected,
    cacheSwitchImpact: {
      ...selectedCacheSwitchImpact,
      allowanceImpact,
    },
    cacheContinuityImpact: {
      ...selectedCacheContinuityImpact,
      allowanceImpact: continuityAllowanceImpact,
    },
    replayExclusionDiagnostics: data.accounting.replayExclusionDiagnostics,
    accountingSource: data.accounting.accountingSource,
  };
}

function renderAccountingDimension(containerSelector, dimension, {
  emptyMessage = "No observations in this period.",
  unknownLabel = "Not recorded",
  eventNoun = "usage changes",
  labels = {}
} = {}) {
  const container = $(containerSelector);
  clear(container);
  const rows = Object.entries(dimension ?? {})
    .filter(([, row]) => finite(row.events, 0) > 0)
    .sort((left, right) => right[1].events - left[1].events);
  if (!rows.length) {
    container.append(node("p", "empty-inline", emptyMessage));
    return;
  }
  const totalCost = rows.reduce(
    (sum, [, row]) => sum + finite(row.apiPriceEquivalentUsd, 0),
    0
  );
  const totalEvents = rows.reduce((sum, [, row]) => sum + row.events, 0);
  const useCost = totalCost > 0;
  for (const [key, row] of rows) {
    const item = node("div", "dimension-row");
    const copy = node("div");
    copy.append(
      node(
        "strong",
        "",
        key === "unknown" ? unknownLabel : labels[key] ?? humanize(key)
      ),
      node(
        "span",
        "",
        useCost
          ? `${formatApiMoney(row.apiPriceEquivalentUsd)} · ${compact(row.events)} ${eventNoun}`
          : `${compact(row.events)} ${eventNoun}`
      )
    );
    item.append(
      copy,
      node(
        "span",
        "dimension-share",
        formatPercent(
          (useCost ? row.apiPriceEquivalentUsd / totalCost : row.events / Math.max(1, totalEvents)) * 100,
          1
        )
      )
    );
    container.append(item);
  }
}

function renderAccountingComponentBars(containerSelector, rows, {
  emptyMessage,
  valueFor,
  displayValue,
  titleFor = () => ""
}) {
  const container = $(containerSelector);
  clear(container);
  if (!rows.length) {
    container.append(node("p", "empty-inline", emptyMessage));
    return;
  }
  const maximum = Math.max(1, ...rows.map(valueFor));
  for (const rowData of rows) {
    const value = valueFor(rowData);
    const row = node("div", "component-row");
    const label = node("span", "", componentLabel(rowData.key));
    const title = titleFor(rowData);
    if (title) label.title = title;
    const track = node("div", "component-track");
    const fill = node("i");
    fill.style.width = `${Math.max(value > 0 ? 1 : 0, value / maximum * 100)}%`;
    track.append(fill);
    row.append(label, track, node("strong", "", displayValue(rowData)));
    container.append(row);
  }
}

function cacheSwitchMetricValue(impact) {
  const cost = cacheImpactCostView(impact);
  if (cost === null) return "—";
  const weighting = cost.allowanceWeighting;
  const display = (value) => value;
  if (weighting?.status === "complete") {
    const premium = finite(weighting.selectedPremiumUsd, null);
    return premium === null ? "—" : display(formatApiMoney(premium));
  }
  if (weighting?.status === "range") {
    const lower = finite(weighting.rangePremiumUsd?.lower, null);
    const upper = finite(weighting.rangePremiumUsd?.upper, null);
    return lower === null || upper === null
      ? "—"
      : display(`${formatApiMoney(lower)}–${formatApiMoney(upper)}`);
  }
  if (cost.isSubtotal && cost.standardApiPremiumUsd !== null) {
    return display(formatApiMoney(cost.standardApiPremiumUsd));
  }
  return "—";
}

function cacheContinuityStandardMetricValue(impact) {
  const cost = cacheImpactCostView(impact);
  if (cost === null || cost.standardApiPremiumUsd === null) return "—";
  const amount = formatApiMoney(cost.standardApiPremiumUsd);
  return amount;
}

function cacheContinuityMetricValue(impact) {
  const weighted = cacheSwitchMetricValue(impact);
  return weighted === "—"
    ? cacheContinuityStandardMetricValue(impact)
    : weighted;
}

function cacheContinuityUsesStandardFallback(impact) {
  const cost = cacheImpactCostView(impact);
  return cost !== null && cost.standardApiPremiumUsd !== null
    && !["complete", "range"].includes(cost.allowanceWeighting?.status);
}

function cacheImpactCostView(impact) {
  if (impact?.status !== "available") return null;
  // No compared requests is not an observed zero-dollar overhead.
  if (impact.cacheReadDrops === 0
      && (impact.proximateConfigurationChanges ?? impact.comparableReturns) === 0) {
    return null;
  }
  const isSubtotal = impact.coverageStatus === "incomplete"
    || impact.unpricedDrops > 0;
  const selected = isSubtotal ? impact.coveredSubtotal : impact;
  if (!selected || (isSubtotal
      && (selected.scope !== "covered_priced_drops"
        || !Number.isSafeInteger(selected.pricedDrops)
        || selected.pricedDrops <= 0
        || selected.pricedDrops !== impact.pricedDrops))) return null;
  return {
    isSubtotal,
    pricedDrops: selected.pricedDrops,
    standardApiPremiumUsd: finite(selected.standardApiPremiumUsd, null),
    allowanceWeighting: selected.allowanceWeighting,
  };
}

function appendCacheImpactSubtotalNote(container, impact) {
  const cost = cacheImpactCostView(impact);
  if (cost === null || !cost.isSubtotal) return false;
  container.append(
    document.createTextNode(" "),
    localizedNode("span", "", "accounting.cacheImpact.subtotalScope", {
      priced: formatCount(cost.pricedDrops),
    }),
  );
  if (cost.standardApiPremiumUsd !== null) {
    container.append(
      document.createTextNode(" "),
      localizedNode("span", "", cacheContinuityUsesStandardFallback(impact)
        ? "accounting.cacheImpact.subtotalStandardOnly"
        : "accounting.cacheImpact.subtotalStandard", {
        amount: formatApiMoney(cost.standardApiPremiumUsd),
      }),
    );
  }
  if (finite(impact.unpricedDrops, 0) > 0) {
    container.append(
      document.createTextNode(" "),
      localizedNode("span", "", "accounting.cacheImpact.subtotalUnpriced", {
        unpriced: formatCount(impact.unpricedDrops),
      }),
    );
  }
  return true;
}

function cacheImpactMetricBullets(impact, appendDetails) {
  const details = node("span");
  appendDetails(details, impact);
  const list = node("ul", "cache-impact-bullets");
  // Keep the full evidence explanation reachable without crowding the card.
  list.title = details.textContent;
  const cost = cacheImpactCostView(impact);
  if (cost === null) {
    list.append(node("li", "", details.textContent));
    return list;
  }
  list.append(localizedNode("li", "", cost.isSubtotal
    ? "accounting.cacheImpact.bulletPartial" : "accounting.cacheImpact.bulletPriced", {
    priced: formatCount(cost.pricedDrops ?? impact.pricedDrops),
  }));
  list.append(localizedNode("li", "", "accounting.cacheImpact.evidenceUnknown"));
  if (finite(impact.observationUnits?.unresolvedIncrementPairs, 0) > 0) {
    list.append(localizedNode("li", "", "accounting.cacheImpact.bulletIncrement"));
  }
  const excluded = [];
  for (const [count, key] of [
    [impact.unpricedDrops, "accounting.cacheImpact.bulletUnpriced"],
    [impact.uncoveredConfigurationChanges ?? impact.uncoveredReturns, "accounting.cacheImpact.bulletUncovered"],
  ]) {
    if (finite(count, 0) > 0) excluded.push(t(key, { count: formatCount(count) }));
  }
  if (excluded.length) list.append(node("li", "", excluded.join(" · ")));
  return list;
}

function formatCacheSwitchPercentagePoints(value) {
  const number = finite(value, null);
  if (number === null) return "—";
  if (number > 0 && number < 0.01) return `<${formatDecimal(0.01, 2)}`;
  return formatDecimal(number, 2);
}

function appendCacheSwitchMetricNote(container, impact) {
  if (impact?.status !== "available") {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheSwitch.noteUnavailable",
    ));
    return;
  }
  if (impact.coverageStatus !== "complete") {
    const uncovered = finite(impact.uncoveredConfigurationChanges, 0);
    const ordering = finite(impact.orderingCoverageGaps, 0);
    container.append(localizedNode(
      "span",
      "",
      ordering > 0
        ? uncovered > 0
          ? "accounting.cacheSwitch.noteIncompleteCombined"
          : "accounting.cacheSwitch.noteIncompleteOrdering"
        : "accounting.cacheSwitch.noteIncomplete",
      {
        uncovered: formatCount(uncovered),
        ordering: formatCount(ordering),
      },
    ));
    appendCacheImpactSubtotalNote(container, impact);
    return;
  }
  const drops = finite(impact.cacheReadDrops, 0);
  const proximate = finite(impact.proximateConfigurationChanges, 0);
  if (drops === 0) {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheSwitch.noteZero",
      { proximate: formatCount(proximate) },
    ));
  } else {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheSwitch.noteObserved",
      {
        drops: formatCount(drops),
        proximate: formatCount(proximate),
      },
    ));
    if (finite(impact.unpricedDrops, 0) > 0) {
      container.append(
        document.createTextNode(" "),
        localizedNode(
          "span",
          "",
          finite(impact.pricedDrops, 0) > 0
            ? "accounting.cacheSwitch.notePartialPricing"
            : "accounting.cacheSwitch.noteUnpriced",
          {
            priced: formatCount(impact.pricedDrops),
            total: formatCount(drops),
          },
        ),
      );
    }
  }
  if (appendCacheImpactSubtotalNote(container, impact)) return;
  if (cacheImpactCostView(impact) === null) return;
  if (finite(impact.standardApiPremiumUsd, null) !== null) {
    container.append(
      document.createTextNode(" "),
      localizedNode(
        "span",
        "",
        "accounting.cacheSwitch.standardPremium",
        { amount: formatApiMoney(impact.standardApiPremiumUsd) },
      ),
    );
  }
  const allowance = impact.allowanceImpact;
  if (!["complete", "range"].includes(allowance?.status)) return;
  const range = allowance.status === "range"
    ? allowance.percentagePointRange
    : allowance.plausibleRangePercentagePoints;
  container.append(
    document.createTextNode(" "),
    localizedNode(
      "span",
      "",
      range === null
        ? "accounting.cacheSwitch.allowanceMedian"
        : "accounting.cacheSwitch.allowanceRange",
      range === null
        ? { median: formatCacheSwitchPercentagePoints(allowance.medianPercentagePoints) }
        : {
          lower: formatCacheSwitchPercentagePoints(range.lower),
          upper: formatCacheSwitchPercentagePoints(range.upper),
        },
    ),
  );
}

function cacheSwitchChangeDescription(row) {
  const previousModel = formatModelName(row?.previous?.model);
  const currentModel = formatModelName(row?.current?.model);
  const previousEffort = t(
    `accounting.cacheSwitch.effort.${row?.previous?.reasoningEffort}`,
  );
  const currentEffort = t(
    `accounting.cacheSwitch.effort.${row?.current?.reasoningEffort}`,
  );
  if (row?.changeType === "model_only") {
    return t("accounting.cacheSwitch.change.model", {
      previous: previousModel,
      current: currentModel,
    });
  }
  if (row?.changeType === "reasoning_only") {
    return t("accounting.cacheSwitch.change.reasoning", {
      previous: previousEffort,
      current: currentEffort,
    });
  }
  return t("accounting.cacheSwitch.change.both", {
    previousModel,
    currentModel,
    previousEffort,
    currentEffort,
  });
}

function cacheImpactTableSignature(kind, impact, rows) {
  const first = rows[0];
  const last = rows.at(-1);
  return [
    kind,
    impact?.periodId ?? "unavailable",
    rows.length,
    first?.observedAt ?? first?.model ?? first?.id ?? "",
    last?.observedAt ?? last?.model ?? last?.id ?? "",
  ].join(":");
}

function renderCacheImpactPagination(prefix, state, page) {
  const pagination = $(`#${prefix}-pagination`);
  if (!pagination) return;
  // The pager renders only when there is something to page through; a set that
  // fits one page keeps the plain table. A control whose two buttons are both
  // disabled above a "1–6 of 6" status is furniture: it says only what the
  // rows underneath it already show. This matches the weekly table, which has
  // always drawn its pager this way.
  pagination.hidden = page.total === 0 || page.pageCount <= 1;
  if (pagination.hidden) return;
  setLocalizedText($(`#${prefix}-page-status`), "table.pagination.page", {
    start: formatNumber(page.start + 1),
    end: formatNumber(page.end),
    total: formatNumber(page.total),
  });
  const previous = $(`#${prefix}-page-prev`);
  const next = $(`#${prefix}-page-next`);
  if (previous) previous.disabled = state.page === 0;
  if (next) next.disabled = state.page >= page.pageCount - 1;
}

function cacheSwitchDataCell(className, value, labelKey) {
  const cell = rawNode("td", className, value);
  cell.setAttribute("data-label", t(labelKey));
  return cell;
}


function isCacheDropThreadDashboard(data) {
  return ["local", "real_local_evidence"].includes(data?.mode);
}

function cacheDropThreadParts(thread) {
  return formatCodexThreadParts(thread, t);
}

function fillCacheDropThreadCell(cell, thread, observedAt) {
  const focused = cell.contains(document.activeElement)
    ? document.activeElement
    : null;
  const focusedHref = focused?.getAttribute("href") ?? null;
  clear(cell);
  cell.setAttribute("data-label", t("accounting.cacheDropThread.column"));
  const time = t("accounting.cacheDropThread.localTime", {
    time: formatLocal(observedAt),
  });
  cell.setAttribute("title", time);
  const content = rawNode("span", "cache-drop-thread-content", "");
  const parts = cacheDropThreadParts(thread);
  if (parts.length === 0) {
    const unavailable = rawNode("span", "cache-drop-thread-unavailable",
      t("accounting.cacheDropThread.unavailable"));
    unavailable.tabIndex = 0;
    unavailable.setAttribute("title", time);
    unavailable.setAttribute("aria-label",
      `${t("accounting.cacheDropThread.unavailable")}. ${time}`);
    content.append(unavailable);
  }
  for (const part of parts) {
    if (part.href === null) {
      const unavailableText = `${part.name}: ${t("accounting.cacheDropThread.unavailable")}`;
      const unavailable = rawNode("span", "cache-drop-thread-unavailable", unavailableText);
      unavailable.tabIndex = 0;
      unavailable.setAttribute("title", time);
      unavailable.setAttribute("aria-label", `${unavailableText}. ${time}`);
      content.append(unavailable);
      continue;
    }
    const link = rawNode("a", "cache-drop-thread-link", part.name);
    link.href = part.href;
    link.setAttribute("title", time);
    link.setAttribute("aria-label", t("accounting.cacheDropThread.open", {
      name: part.name,
      time,
    }));
    // Suppress any page URL as a referrer when the operating system opens
    // Codex. No arbitrary upstream URL is ever accepted by this renderer.
    link.setAttribute("rel", "noreferrer");
    if (part.worker) {
      const worker = rawNode("span", "cache-drop-subworker", "");
      worker.append(document.createTextNode("["), link, document.createTextNode("]"));
      content.append(document.createTextNode(parts.length > 1 ? " " : ""), worker);
    } else {
      content.append(link);
      if (part.autoReview) {
        const origin = rawNode("span", "cache-drop-subworker", "");
        origin.append(document.createTextNode(" ["),
          document.createTextNode(t("accounting.cacheDropThread.autoReview")),
          document.createTextNode("]"));
        content.append(origin);
      }
    }
  }
  cell.append(content);
  if (focused) {
    const links = [...content.querySelectorAll("a")];
    const target = links.find((link) => link.getAttribute("href") === focusedHref)
      ?? links[0]
      ?? content.querySelector(".cache-drop-thread-unavailable");
    target?.focus({ preventScroll: true });
  }
}

function cacheDropThreadCell(kind, item) {
  const cell = rawNode("td", "cache-drop-thread-cell", "");
  fillCacheDropThreadCell(cell,
    cacheDropThreadLinks.entries.get(cacheDropThreadLookupKey(kind, item)),
    item.observedAt);
  cacheDropThreadLinks.cells[kind].push({ cell, item });
  return cell;
}

function updateCacheDropThreadCells() {
  for (const [kind, cells] of Object.entries(cacheDropThreadLinks.cells)) {
    for (const { cell, item } of cells) {
      if (!cell.isConnected) continue;
      fillCacheDropThreadCell(cell,
        cacheDropThreadLinks.entries.get(cacheDropThreadLookupKey(kind, item)),
        item.observedAt);
    }
  }
}

function cacheDropThreadKeys(data) {
  const keys = new Set();
  if (!isCacheDropThreadDashboard(data) || !isLoopbackDashboard()) return keys;
  for (const [kind, impact] of [
    ["switch", data.accounting?.cacheSwitchImpact],
    ["continuity", data.accounting?.cacheContinuityImpact],
  ]) {
    if (impact?.status !== "available") continue;
    const periods = Array.isArray(impact.periods) ? impact.periods.slice(0, 4) : [];
    for (const period of [impact, ...periods]) {
      const recent = Array.isArray(period?.recent) ? period.recent.slice(0, 250) : [];
      for (const row of recent) {
        const key = cacheDropThreadLookupKey(kind, row);
        if (key !== null) keys.add(key);
        if (keys.size === 2_000) return keys;
      }
    }
  }
  return keys;
}

function resetCacheDropThreadLinks(data = null) {
  const sameDashboard = cacheDropThreadLinks.dashboard === data;
  const previousGeneration = cacheDropThreadLinks.generation;
  const previousFingerprint = cacheDropThreadLinks.generationFingerprint;
  cacheDropThreadLinks.requestToken += 1;
  cacheDropThreadLinks.dashboard = data;
  cacheDropThreadLinks.generation = isCacheDropThreadDashboard(data)
      && typeof data.accounting?.cacheDiagnosticsSource?.generation === "string"
    ? data.accounting.cacheDiagnosticsSource.generation
    : null;
  cacheDropThreadLinks.generationFingerprint =
    data?.accounting?.cacheDiagnosticsSource?.generationFingerprint ?? null;
  cacheDropThreadLinks.requested = false;
  // An unchanged tuple can become ambiguous when another source is indexed.
  // Reuse navigation only within the same attested diagnostic publication;
  // a changed or missing proof requires a new successful identity lookup.
  if (previousGeneration !== cacheDropThreadLinks.generation
      || previousFingerprint !== cacheDropThreadLinks.generationFingerprint) {
    cacheDropThreadLinks.entries.clear();
  }
  const retainedKeys = cacheDropThreadKeys(data);
  for (const key of cacheDropThreadLinks.entries.keys()) {
    if (!retainedKeys.has(key)) cacheDropThreadLinks.entries.delete(key);
  }
  updateCacheDropThreadCells();
  if (!sameDashboard) cacheDropThreadLinks.cells = { switch: [], continuity: [] };
}

async function loadCacheDropThreadLinks(data) {
  const generation = cacheDropThreadLinks.generation;
  const fingerprint = cacheDropThreadLinks.generationFingerprint;
  if (data !== dashboard || data !== cacheDropThreadLinks.dashboard
      || !isCacheDropThreadDashboard(data) || !isLoopbackDashboard()
      || generation === null || generation === ""
      || fingerprint === null
      || generation !== data.accounting?.cacheDiagnosticsSource?.generation
      || fingerprint !== data.accounting?.cacheDiagnosticsSource?.generationFingerprint
      || cacheDropThreadLinks.requested
      || typeof localClient.cacheDropThreadLinks !== "function") return;
  cacheDropThreadLinks.requested = true;
  const token = ++cacheDropThreadLinks.requestToken;
  const loadToken = cacheDropThreadLinks.loadToken;
  let completed = false;
  try {
    const result = await localClient.cacheDropThreadLinks();
    if (token !== cacheDropThreadLinks.requestToken
        || loadToken !== cacheDropThreadLinks.loadToken
        || data !== dashboard || data !== cacheDropThreadLinks.dashboard
        || !isCacheDropThreadDashboard(data) || !isLoopbackDashboard()
        || generation !== data.accounting?.cacheDiagnosticsSource?.generation
        || fingerprint !== data.accounting?.cacheDiagnosticsSource?.generationFingerprint
        || result?.status !== "available"
        || result.generation !== generation) return;
    const selectedKeys = cacheDropThreadKeys(data);
    const resolvedEntries = new Map();
    for (const { key, thread } of result.entries) {
      if (!selectedKeys.has(key)) continue;
      const previous = cacheDropThreadLinks.entries.get(key);
      // Optional name-store failures must not erase details already known for
      // this UUID. A newly resolved identity replaces the old entry outright.
      resolvedEntries.set(key, previous?.id === thread.id ? {
        ...thread,
        name: thread.name ?? previous.name,
        nickname: thread.nickname ?? previous.nickname,
        parent: thread.parent === null ? previous.parent : {
          ...thread.parent,
          name: thread.parent.name ?? (thread.parent.id === previous.parent?.id
            ? previous.parent.name : null),
        },
      } : thread);
    }
    // A qualified empty/partial result withdraws unresolved identities. It is
    // different from a failed lookup, which leaves same-publication UI intact.
    cacheDropThreadLinks.entries = resolvedEntries;
    completed = true;
    updateCacheDropThreadCells();
  } catch {
    // Keep resolved details usable through temporary local lookup failures.
  } finally {
    if (!completed && token === cacheDropThreadLinks.requestToken) {
      cacheDropThreadLinks.requested = false;
    }
  }
}

function renderAccountingCacheSwitchDetails(impact) {
  const disclosure = $("#cache-switch-details");
  const rows = $("#cache-switch-rows");
  if (!disclosure || !rows) return;
  cacheDropThreadLinks.cells.switch = [];
  clear(rows);
  const available = impact?.status === "available";
  disclosure.hidden = !available;
  if (!available) {
    disclosure.open = false;
    renderCacheImpactPagination(
      "cache-switch",
      cacheSwitchTablePagination,
      paginateCacheImpactRows(
        [],
        cacheSwitchTablePagination,
        "switch:unavailable",
      ),
    );
    return;
  }
  const recent = Array.isArray(impact.recent) ? impact.recent : [];
  const sampleNote = $("#cache-switch-sample");
  if (sampleNote) {
    sampleNote.hidden = impact.cacheReadDrops <= recent.length;
    setLocalizedText(sampleNote, "accounting.cacheImpact.bulletSample", {
      shown: formatCount(recent.length), total: formatCount(impact.cacheReadDrops),
    });
  }
  const page = paginateCacheImpactRows(
    recent,
    cacheSwitchTablePagination,
    cacheImpactTableSignature("switch", impact, recent),
    { preservePage: Boolean($("#overview-details-dialog")?.open) },
  );
  renderCacheImpactPagination("cache-switch", cacheSwitchTablePagination, page);
  if (!recent.length) {
    const row = node("tr");
    const cell = localizedNode(
      "td",
      "empty-cell",
      "accounting.cacheSwitch.detailsEmpty",
    );
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const item of page.rows) {
    const row = node("tr");
    row.append(
      cacheDropThreadCell("switch", item),
      cacheSwitchDataCell(
        "cache-switch-change",
        cacheSwitchChangeDescription(item),
        "accounting.cacheSwitch.column.change",
      ),
      cacheSwitchDataCell(
        "numeric-cell",
        `${formatCount(item.previousCacheReadTokens)} → ${formatCount(item.currentCacheReadTokens)}`,
        "accounting.cacheSwitch.column.cacheRead",
      ),
      cacheSwitchDataCell(
        "numeric-cell",
        formatCount(item.lostCacheTokens),
        "accounting.cacheSwitch.column.lostTokens",
      ),
      // A drop without a price says so rather than showing a bare dash. Rows
      // carry no pricing status, so "not priced" is the one honest reason.
      item.estimatedPremiumUsd === null
        ? Object.assign(cacheSwitchDataCell(
          "model-api-equivalent data-value-unavailable",
          t("accounting.cacheImpact.notPriced"),
          "accounting.cacheSwitch.column.apiEquivalent",
        ), { title: t("accounting.cacheImpact.notPricedTitle") })
        : cacheSwitchDataCell(
          "model-api-equivalent",
          formatApiMoney(item.estimatedPremiumUsd),
          "accounting.cacheSwitch.column.apiEquivalent",
        ),
    );
    rows.append(row);
  }
}

function appendCacheContinuityAllowance(container, impact, {
  includeStandardPremium = true,
} = {}) {
  if (includeStandardPremium
      && finite(impact?.standardApiPremiumUsd, null) !== null) {
    container.append(
      document.createTextNode(" "),
      localizedNode(
        "span",
        "",
        "accounting.cacheSwitch.standardPremium",
        { amount: formatApiMoney(impact.standardApiPremiumUsd) },
      ),
    );
  }
  const allowance = impact?.allowanceImpact;
  if (!["complete", "range"].includes(allowance?.status)) return;
  const range = allowance.status === "range"
    ? allowance.percentagePointRange
    : allowance.plausibleRangePercentagePoints;
  container.append(
    document.createTextNode(" "),
    localizedNode(
      "span",
      "",
      range === null
        ? "accounting.cacheSwitch.allowanceMedian"
        : "accounting.cacheSwitch.allowanceRange",
      range === null
        ? { median: formatCacheSwitchPercentagePoints(allowance.medianPercentagePoints) }
        : {
          lower: formatCacheSwitchPercentagePoints(range.lower),
          upper: formatCacheSwitchPercentagePoints(range.upper),
        },
    ),
  );
}

function appendCacheContinuityMetricNote(container, impact) {
  if (impact?.status !== "available") {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheContinuity.noteUnavailable",
    ));
    return;
  }
  if (impact.coverageStatus !== "complete") {
    const uncovered = finite(impact.uncoveredReturns, 0);
    const ordering = finite(impact.orderingCoverageGaps, 0);
    container.append(localizedNode(
      "span",
      "",
      ordering > 0
        ? uncovered > 0
          ? "accounting.cacheContinuity.noteIncompleteCombined"
          : "accounting.cacheContinuity.noteIncompleteOrdering"
        : "accounting.cacheContinuity.noteIncomplete",
      {
        uncovered: formatCount(uncovered),
        ordering: formatCount(ordering),
      },
    ));
  } else if (finite(impact.cacheReadDrops, 0) === 0) {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheContinuity.noteZero",
      { comparable: formatCount(impact.comparableReturns) },
    ));
  } else {
    container.append(localizedNode(
      "span",
      "",
      "accounting.cacheContinuity.noteObserved",
      {
        drops: formatCount(impact.cacheReadDrops),
        comparable: formatCount(impact.comparableReturns),
      },
    ));
    if (finite(impact.unpricedDrops, 0) > 0) {
      container.append(
        document.createTextNode(" "),
        localizedNode(
          "span",
          "",
          "accounting.cacheContinuity.noteUnpriced",
          {
            priced: formatCount(impact.pricedDrops),
            total: formatCount(impact.cacheReadDrops),
          },
        ),
      );
    }
  }
  if (finite(impact.postCompactionRequests, 0) > 0) {
    container.append(
      document.createTextNode(" "),
      localizedNode(
        "span",
        "",
        "accounting.cacheContinuity.noteCompaction",
        {
          requests: formatCount(impact.postCompactionRequests),
          drops: formatCount(impact.postCompactionCacheReadDrops),
        },
      ),
    );
  }
  if (appendCacheImpactSubtotalNote(container, impact)) return;
  if (cacheImpactCostView(impact) === null) return;
  if (impact.coverageStatus === "complete"
      && finite(impact.unpricedDrops, 0) === 0) {
    const standardFallback = cacheContinuityUsesStandardFallback(impact);
    if (standardFallback) {
      container.append(
        document.createTextNode(" "),
        localizedNode(
          "span",
          "",
          "accounting.cacheContinuity.noteStandardFallback",
        ),
      );
    }
    appendCacheContinuityAllowance(container, impact, {
      includeStandardPremium: !standardFallback,
    });
  }
}

function formatCacheContinuityGap(seconds) {
  const value = finite(seconds, 0);
  if (value < 3_600) {
    return t("accounting.cacheContinuity.gapMinutes", {
      value: formatDecimal(value / 60, value % 60 === 0 ? 0 : 1),
    });
  }
  if (value < 86_400) {
    return t("accounting.cacheContinuity.gapHours", {
      value: formatDecimal(value / 3_600, value % 3_600 === 0 ? 0 : 1),
    });
  }
  return t("accounting.cacheContinuity.gapDays", {
    value: formatDecimal(value / 86_400, value % 86_400 === 0 ? 0 : 1),
  });
}

function cacheContinuityConfigurationDescription(row) {
  return t("accounting.cacheContinuity.configuration", {
    model: formatModelName(row?.configuration?.model),
    effort: t(
      `accounting.cacheSwitch.effort.${row?.configuration?.reasoningEffort}`,
    ),
  });
}

let cacheReuseMatrix = null;

function renderAccountingCacheReuseOutcome(impact) {
  const outcome = $("#cache-reuse-outcome");
  const container = $("#cache-reuse-matrix");
  if (!outcome || !container) return;
  outcome.hidden = false;
  cacheReuseMatrix ??= createCacheReuseMatrix({
    container,
    t,
    formatNumber: formatCount,
    formatPercent: (value) => formatPercent(value, 1),
    formatModelName,
    formatMetric: (summary, selectedImpact) => [
      ...cacheReuseMetricLines(summary, selectedImpact, { t, formatCount, formatApiMoney }),
      cacheReuseCoverageNote(selectedImpact, { t, formatCount }),
    ].filter(Boolean),
  });
  cacheReuseMatrix.render({ impact });
}

function renderAccountingCacheContinuityDetails(impact) {
  const disclosure = $("#cache-continuity-details");
  const rows = $("#cache-continuity-rows");
  if (!disclosure || !rows) return;
  cacheDropThreadLinks.cells.continuity = [];
  clear(rows);
  const available = impact?.status === "available";
  disclosure.hidden = !available;
  renderAccountingCacheReuseOutcome(available ? impact : null);
  if (!available) {
    disclosure.open = false;
    renderCacheImpactPagination(
      "cache-continuity",
      cacheContinuityTablePagination,
      paginateCacheImpactRows(
        [],
        cacheContinuityTablePagination,
        "continuity:unavailable",
      ),
    );
    return;
  }
  const recent = Array.isArray(impact.recent) ? impact.recent : [];
  const sampleNote = $("#cache-continuity-sample");
  if (sampleNote) {
    sampleNote.hidden = impact.cacheReadDrops <= recent.length;
    setLocalizedText(sampleNote, "accounting.cacheImpact.bulletSample", {
      shown: formatCount(recent.length), total: formatCount(impact.cacheReadDrops),
    });
  }
  const page = paginateCacheImpactRows(
    recent,
    cacheContinuityTablePagination,
    cacheImpactTableSignature("continuity", impact, recent),
    { preservePage: Boolean($("#overview-details-dialog")?.open) },
  );
  renderCacheImpactPagination(
    "cache-continuity",
    cacheContinuityTablePagination,
    page,
  );
  if (!recent.length) {
    const row = node("tr");
    const cell = localizedNode(
      "td",
      "empty-cell",
      "accounting.cacheContinuity.detailsEmpty",
    );
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const item of page.rows) {
    const row = node("tr");
    row.append(
      cacheDropThreadCell("continuity", item),
      cacheSwitchDataCell(
        "numeric-cell", formatCacheContinuityGap(item.gapSeconds),
        "accounting.cacheContinuity.column.gap",
      ),
      cacheSwitchDataCell(
        "cache-switch-change",
        cacheContinuityConfigurationDescription(item),
        "accounting.cacheContinuity.column.configuration",
      ),
      cacheSwitchDataCell(
        "numeric-cell",
        `${formatCount(item.previousCacheReadTokens)} → ${formatCount(item.currentCacheReadTokens)}`,
        "accounting.cacheContinuity.column.cacheRead",
      ),
      // A drop without a price says so rather than showing a bare dash. Rows
      // carry no pricing status, so "not priced" is the one honest reason.
      item.estimatedPremiumUsd === null
        ? Object.assign(cacheSwitchDataCell(
          "model-api-equivalent data-value-unavailable",
          t("accounting.cacheImpact.notPriced"),
          "accounting.cacheContinuity.column.apiEquivalent",
        ), { title: t("accounting.cacheImpact.notPricedTitle") })
        : cacheSwitchDataCell(
          "model-api-equivalent",
          formatApiMoney(item.estimatedPremiumUsd),
          "accounting.cacheContinuity.column.apiEquivalent",
        ),
    );
    rows.append(row);
  }
}

/**
 * Say WHY the replay-safe accounting artifacts are missing when the rebuild
 * keeps being postponed, instead of leaving bare zero cards. The rebuild
 * defers softly when it would push the app past its memory ceiling; one miss
 * is routine backoff, but a streak with no cache on disk means the reader is
 * looking at an empty cost view with a cause the app knows and was not
 * saying (the 2026-08-19 livelock recurred hourly for a whole afternoon).
 */
/**
 * True while the accounting rebuild has been deferred repeatedly — the state
 * the stale-serve label upgrades to its "being retried" wording.
 */
function accountingRebuildRetrying() {
  return Number.isSafeInteger(accountingRebuildDeferral?.consecutive)
    && accountingRebuildDeferral.consecutive >= 2;
}

/**
 * The prior-version period row backing the cost view while no current source
 * exists, or null. The provenance-bearing block arrives only on the explicit
 * stale channel, so a rendered row is labeled by construction.
 */
function staleAccountingServePeriod(data) {
  const serve = data?.accounting?.staleServe;
  if (serve?.stale !== true || !Array.isArray(serve.periods)) return null;
  return serve.periods.find(
    (period) => period.periodId === activeAccountingPeriod,
  )
    ?? serve.periods.find((period) => period.periodId === "all")
    ?? null;
}

/**
 * The quiet informational label over stale-served figures. Figures from the
 * previous version's cache state their provenance and repeated deferrals,
 * without inferring that a rebuild is currently running. Figures retained from this version's
 * last completed full projection (`lastCompletedAt` set) state only that and
 * their age: refresh activity is the refresh control's to report. Deliberately
 * an annotation, not an alert — the replaced red withheld-cache banner
 * over-alarmed a routine update recalculation.
 */
function renderStaleServeNote(element, active, reason = null, lastCompletedAt) {
  if (!element) return;
  if (!active) {
    element.hidden = true;
    setRawText(element, "");
    return;
  }
  element.hidden = false;
  setLocalizedText(
    element,
    reason === "local_unified_index_schema_newer"
      ? "accounting.staleServe.newerBuild"
      : reason === "current_projection_unavailable"
        ? "accounting.staleServe.lastVerified"
        : lastCompletedAt !== undefined
          ? Number.isFinite(Date.parse(lastCompletedAt ?? ""))
            ? "accounting.staleServe.lastCompleted"
            : "accounting.staleServe.lastCompletedUndated"
          : accountingRebuildRetrying()
            ? "accounting.staleServe.retrying"
            : "accounting.staleServe.recalculating",
    lastCompletedAt === undefined ? {} : { time: retainedResultTimeLabel(lastCompletedAt) },
  );
}

function retainedResultTimeLabel(instant) {
  const timestamp = Date.parse(instant ?? "");
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(getFormattingLocale(), {
    ...(USER_TIME_ZONE === "local time" ? {} : { timeZone: USER_TIME_ZONE }),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function renderAccountingRebuildDeferral(data, { staleServeShown = false } = {}) {
  const element = $("#accounting-rebuild-deferred");
  if (!element) return;
  const deferral = accountingRebuildDeferral;
  const persistent = Number.isSafeInteger(deferral?.consecutive)
    && deferral.consecutive >= 2;
  // With a retained cache the figures still render; the honest-empty copy is
  // for the state where no replay-safe cache exists at all. A stale serve is
  // likewise not an empty view — its own label already folds the retry state
  // in — so the deferral banner stays down rather than doubling the message.
  const cacheMissing = data?.accounting?.accountingCacheStatus === "unavailable";
  const terminalProjection = dashboardAccountingProjection(data).terminal === true;
  if (!persistent || !cacheMissing || staleServeShown || terminalProjection) {
    element.hidden = true;
    setRawText(element, "");
    return;
  }
  element.hidden = false;
  setLocalizedText(element, "accounting.rebuildDeferred.persistent", {
    count: formatNumber(deferral.consecutive),
  });
}

function accountingPriceHeadline(accounting) {
  const amount = finite(accounting.speedApiPriceEquivalentUsd);
  return [
    t("usageSimple.apiEquivalent"),
    t("usageSimple.apiExplanation"),
    amount === null ? "—" : formatApiMoney(amount),
    accounting.speedPricingCoverageStatus === "fully_priced"
      ? "" : t("dashboard.overview.partial"),
  ];
}

function updateUsageSimpleCounts() {
  const label = document.querySelector("#usage-simple-counts");
  if (!label) return;
  const matches = usageSimpleCounts && usageSimpleCountsContext
    && usageSimpleCountsContext.period === reportingWindow?.period
    && usageSimpleCountsContext.toMs === Date.parse(reportingWindow?.endAt ?? "");
  label.hidden = !matches;
  if (!matches) return;
  label.textContent = t("usageSimple.scopeCounts", {
    projects: formatCount(usageSimpleCounts.activeProjects),
    sessions: formatCount(usageSimpleCounts.activeThreads),
  });
}

function renderAccounting(data) {
  const openDialog = $("#overview-details-dialog");
  const scroll = openDialog?.open ? openDialog.scrollTop : null;
  renderAccountingContent(data);
  if (scroll !== null && openDialog.open) openDialog.scrollTop = scroll;
}

function renderAccountingContent(data) {
  const projection = dashboardAccountingProjection(data);
  // The prior-version figures stand in only while the current channels are
  // genuinely empty: no current cache AND no events from any live source for
  // the selected period. The moment a current source serves (unified index or
  // a fresh cache), it wins and the stale label leaves this section.
  const livePeriod = accountingPeriod(data);
  const staleRow = !data.reportingWindow && projection.status !== "available"
      && data?.accounting?.accountingCacheStatus === "unavailable"
      && (livePeriod === null || finite(livePeriod.events, 0) === 0)
    ? staleAccountingServePeriod(data)
    : null;
  const retainedEvidence = projection.status === "retained"
    && ((staleRow !== null
      && (finite(staleRow.events, 0) > 0
        || finite(staleRow.totalTokens, 0) > 0
        || finite(staleRow.apiPriceEquivalentUsd, 0) > 0))
      || (livePeriod !== null
        && (finite(livePeriod.events, 0) > 0
          || finite(livePeriod.totalTokens, 0) > 0
          || finite(livePeriod.apiPriceEquivalentUsd, 0) > 0)));
  // With no previous-version row, the figures are this version's last
  // completed full projection, retained through a deferred or unmatched build.
  renderStaleServeNote(
    $("#accounting-stale-serve"),
    retainedEvidence,
    projection.reason,
    staleRow === null ? projection.retainedAt ?? null : undefined,
  );
  renderAccountingRebuildDeferral(data, {
    staleServeShown: retainedEvidence,
  });
  const accounting = livePeriod;
  if (accounting === null || (projection.status !== "available" && !retainedEvidence)) {
    const unavailableCopy = accounting === null && data.reportingWindow
      ? t("reporting.unavailable") : t(projectionUnavailableCopyKey(data));
    const summary = $("#accounting-summary");
    clear(summary);
    for (const [label, explanation] of [
      [
        t("accounting.projection.metricUnavailable"),
        unavailableCopy,
      ],
      ["Tokens", unavailableCopy],
    ]) {
      const card = node("article", "metric-card compact-metric");
      const metricLabel = node("span", "metric-name");
      metricLabel.append(informationLabel(label, explanation));
      card.append(
        metricLabel,
        node("strong", "metric-value", "—"),
        node("p", "", unavailableCopy),
      );
      summary.append(card);
    }
    renderAccountingComponentBars("#accounting-component-counts", [], {
      emptyMessage: t("accounting.projection.componentsUnavailable"),
      valueFor: () => 0,
      displayValue: () => "—",
    });
    renderAccountingComponentBars("#accounting-component-costs", [], {
      emptyMessage: t("accounting.projection.componentsUnavailable"),
      valueFor: () => 0,
      displayValue: () => "—",
    });
    renderAccountingModels(data.accounting, { unavailable: true });
    const cacheImpactSummary = $("#cache-impact-summary");
    clear(cacheImpactSummary);
    cacheImpactSummary.hidden = true;
    renderAccountingCacheSwitchDetails(null);
    renderAccountingCacheContinuityDetails(null);
    return;
  }
  const summary = $("#accounting-summary");
  clear(summary);
  // Price coverage used to sit here as a third headline metric. It now reads
  // as a caption under the model table instead: with every retained usage
  // change priced at the rate in effect when it occurred, coverage is a
  // reassurance rather than a number worth a card, and when it is not complete
  // the rows that lack a price are the useful thing to be standing next to.
  const fastMode = accounting.fastMode;
  // Stale substitution serves the version-stable Standard-price scalar and
  // labels itself as previous-version output; quota weighting belongs to the
  // current pipeline and is not reconstructed from an old artifact. Figures
  // retained from this version's last completed projection are current-
  // pipeline output and keep its headline, marked by their verified period.
  const headlineRows = projection.status === "retained" && staleRow !== null
    ? [
      [
        t("accounting.staleServe.metricLabel"),
        "A public API-price measuring stick for the usage observed locally. It is not a bill or a subscription limit.",
        finite((staleRow ?? accounting).apiPriceEquivalentUsd, 0) > 0
          ? formatApiMoney((staleRow ?? accounting).apiPriceEquivalentUsd)
          : "—",
        t("accounting.projection.lastVerifiedPeriod", {
          period: localization.translateText((staleRow ?? accounting).periodLabel),
        }),
      ],
      [
        "Tokens",
        "The tokens attached to those usage changes during the selected time period.",
        finite((staleRow ?? accounting).totalTokens, 0) > 0
          ? compact((staleRow ?? accounting).totalTokens)
          : "—",
        t("accounting.projection.lastVerifiedPeriod", {
          period: localization.translateText((staleRow ?? accounting).periodLabel),
        }),
      ],
    ]
    : [
      accountingPriceHeadline(accounting),
      [
        "Tokens",
        "The tokens attached to those usage changes during the selected time period.",
        compact(accounting.totalTokens),
        localization.translateText(accounting.periodLabel)
      ]
    ];
  const currentPeriodNote = localization.translateText(accounting.periodLabel);
  const retainedPeriodNote = projection.status === "retained" && staleRow === null
    ? t("accounting.projection.lastVerifiedPeriod", { period: currentPeriodNote })
    : null;
  for (const [label, explanation, value, periodNote] of headlineRows) {
    const note = retainedEvidence ? retainedPeriodNote ?? periodNote : "";
    const card = node("article", "metric-card compact-metric");
    const metricLabel = node("span", "metric-name");
    metricLabel.textContent = localization.translateText(label);
    metricLabel.title = explanation;
    card.append(
      metricLabel,
      node("strong", "metric-value", value)
    );
    if (note) card.append(node("p", "", note));
    if (summary.children.length === 0 && accounting.speedPricingCoverageStatus !== "fully_priced")
      card.append(localizedNode("small", "annotation", "dashboard.overview.partial"));
    summary.append(card);
  }
  const cacheSwitchImpact = accounting.cacheSwitchImpact;
  const cacheSwitchCard = node("article", "metric-card compact-metric cache-impact-card");
  const cacheSwitchLabel = node("span", "metric-name");
  cacheSwitchLabel.append(informationLabel(
    t("accounting.cacheSwitch.metricLabel"),
    t("accounting.cacheSwitch.metricExplanation"),
  ));
  const cacheSwitchNote = cacheImpactMetricBullets(cacheSwitchImpact, appendCacheSwitchMetricNote);
  cacheSwitchCard.append(
    cacheSwitchLabel,
    rawNode("strong", "metric-value", cacheSwitchMetricValue(cacheSwitchImpact)),
    cacheSwitchNote,
  );
  const cacheImpactSummary = $("#cache-impact-summary");
  clear(cacheImpactSummary);
  cacheImpactSummary.hidden = false;
  cacheImpactSummary.append(cacheSwitchCard);

  const cacheContinuityImpact = accounting.cacheContinuityImpact;
  const cacheContinuityCard = node("article", "metric-card compact-metric cache-impact-card");
  const cacheContinuityLabel = node("span", "metric-name");
  cacheContinuityLabel.append(informationLabel(
    t("accounting.cacheContinuity.metricLabel"),
    t("accounting.cacheContinuity.metricExplanation"),
  ));
  const cacheContinuityNote = cacheImpactMetricBullets(cacheContinuityImpact, appendCacheContinuityMetricNote);
  cacheContinuityCard.append(
    cacheContinuityLabel,
    rawNode(
      "strong",
      "metric-value",
      cacheContinuityMetricValue(cacheContinuityImpact),
    ),
    cacheContinuityNote,
  );
  cacheImpactSummary.append(cacheContinuityCard);

  const componentCountRows = Object.entries(accounting.components ?? {})
    .filter(([key, tokens]) => key !== "input_cache_write_tokens" && tokens > 0)
    .map(([key, tokens]) => ({ key, tokens }))
    .sort((left, right) => right.tokens - left.tokens);
  renderAccountingComponentBars("#accounting-component-counts", componentCountRows, {
    emptyMessage: projection.status === "retained" && staleRow !== null
      ? t("accounting.projection.retainedComponents")
      : "No token-component accounting in this period.",
    valueFor: (row) => row.tokens,
    displayValue: (row) => compact(row.tokens)
  });

  const componentCostRows = Object.entries(accounting.speedComponentCosts ?? {})
    .map(([key, value]) => ({
      key,
      tokens: finite(value?.tokens, 0),
      costUsd: finite(value?.costUsd, 0)
    }))
    .filter((row) => row.key !== "input_cache_write_tokens"
      && (row.key === "output_combined_tokens" ? row.tokens > 0 : row.tokens > 0 || row.costUsd > 0))
    .sort((left, right) => right.costUsd - left.costUsd || right.tokens - left.tokens);
  renderAccountingComponentBars("#accounting-component-costs", componentCostRows, {
    emptyMessage: projection.status === "retained" && staleRow !== null
      ? t("accounting.projection.retainedComponents")
      : "No component costs were priced in this period.",
    valueFor: (row) => row.costUsd,
    displayValue: (row) => row.costUsd > 0
      ? formatApiMoney(row.costUsd)
      : "—",
    titleFor: (row) => `${compact(row.tokens)} tokens`,
  });

  renderAccountingModels(accounting, {
    unavailable: projection.status === "retained" && staleRow !== null,
  });
  renderAccountingCacheSwitchDetails(cacheSwitchImpact);
  renderAccountingCacheContinuityDetails(cacheContinuityImpact);
}

/**
 * Every model identity observed in the period, across both allowance tracks.
 *
 * `byModel` describes the primary Codex pool only, because the separately
 * metered Spark allowance is kept out of that pool's own totals. `modelUsage`
 * is the combined list, each row carrying its own allowance track. Reading
 * only `byModel` is what previously left Spark usage invisible, or collapsed
 * into "Unrecognized model".
 */
function modelUsageRows(accounting) {
  const combined = Array.isArray(accounting?.modelUsage)
    ? accounting.modelUsage
    : [
      ...(accounting?.byModel ?? []),
      ...(accounting?.spark?.byModel ?? []),
    ];
  return combined.map(row => ({
    ...row,
    apiPriceEquivalentUsd: row.speedApiPriceEquivalentUsd ?? null,
    componentCosts: row.speedComponentCosts ?? null,
  })).sort((left, right) => (
    // A separate allowance has no comparable money figure, so those rows
    // cannot be ranked against the primary pool. They sort last.
    Number(modelRowIsSeparateAllowance(left))
      - Number(modelRowIsSeparateAllowance(right))
    || (usageSimpleMetric === "tokens"
      ? finite(right.totalTokens, 0) - finite(left.totalTokens, 0)
      : finite(right.apiPriceEquivalentUsd, 0) - finite(left.apiPriceEquivalentUsd, 0))
    || finite(right.totalTokens, 0) - finite(left.totalTokens, 0)
    || String(left.model ?? "").localeCompare(String(right.model ?? ""))
  ));
}

function modelRowIsSeparateAllowance(row) {
  return row?.allowanceTrack === "spark"
    || row?.apiPriceEquivalentApplicable === false;
}

/**
 * The API-equivalent cell, which used to print one em dash for four different
 * situations. They are not the same fact and a reader has to be able to tell
 * them apart:
 *
 *   separate allowance - Spark is metered against its own pool, so an
 *                        API-price equivalent is not a meaningful figure at
 *                        all, as opposed to a missing one.
 *   no published price - a recognised model OpenAI publishes no price card
 *                        for. Deliberately not priced; not an error.
 *   not priced         - an identifier this build has never reviewed. No
 *                        price is invented for it, and it is not a zero.
 *   not reported       - the row carried no usable number. Malformed input,
 *                        never silently shown as zero.
 *   a real amount      - including an honest, priced $0.00.
 */
/**
 * Whether this row states an API-price equivalent that can be compared with
 * the pool's total at all.
 *
 * The share column has to ask the same question the amount column already
 * asks. A row whose amount reads "No published price" holds no money figure,
 * so its share of the period's money is not zero — it is unknown, and printing
 * "0.0%" beside "No published price" would contradict the cell next to it.
 */
function modelHasComparableCost(row) {
  if (modelRowIsSeparateAllowance(row)) return false;
  if (row?.pricingStatus === "known_unpriced") return false;
  if (row?.pricingStatus === "unrecognized") return false;
  const amount = finite(row?.apiPriceEquivalentUsd);
  return amount !== null && amount >= 0;
}

function modelApiEquivalentCell(row) {
  const cell = node("td", "model-api-equivalent data-value-unavailable");
  if (modelRowIsSeparateAllowance(row)) {
    setLocalizedText(cell, "accounting.model.separateAllowance");
    cell.title = t("accounting.model.separateAllowanceTitle");
    return cell;
  }
  if (row?.pricingStatus === "known_unpriced") {
    setLocalizedText(cell, "accounting.model.noPublishedPrice");
    cell.title = t("accounting.model.noPublishedPriceTitle");
    return cell;
  }
  if (row?.pricingStatus === "unrecognized") {
    // An identifier this build has never reviewed carries no price, and a
    // guessed one would be worse than none. Printing "$0.00" here read as a
    // priced zero, which is a different and untrue claim.
    setLocalizedText(cell, "accounting.model.notPricedUnknown");
    cell.title = t(row.model === "unknown"
      ? "accounting.model.identityUnavailableTitle"
      : "accounting.model.notPricedUnknownTitle");
    return cell;
  }
  const amount = finite(row?.apiPriceEquivalentUsd);
  if (amount === null || amount < 0) {
    setLocalizedText(cell, "accounting.model.notReported");
    cell.title = t("accounting.model.notReportedTitle");
    return cell;
  }
  cell.className = "model-api-equivalent";
  setRawText(cell, formatApiMoney(amount));
  if (amount === 0) cell.title = t("accounting.model.zeroTitle");
  return cell;
}

/**
 * Price coverage as a sentence beside the rows it describes, rather than a
 * headline metric. `null` means the period holds no usage change at all, so
 * there is no coverage claim to make and the caption stays off entirely.
 */
function pricingCoverageNote(accounting) {
  const events = finite(accounting?.events, 0);
  if (events <= 0) return null;
  if (accounting?.speedPricingCoverageStatus && accounting.speedPricingCoverageStatus !== "fully_priced") {
    return t("dashboard.overview.partial");
  }
  if (finite(accounting?.pricingCoverage?.unpricedEvents, 0) <= 0) {
    return null;
  }
  const priced = finite(accounting?.pricingCoverage?.fullyPricedEvents, 0)
    + finite(accounting?.pricingCoverage?.partiallyPricedEvents, 0);
  return t("accounting.pricing.partialCoverage", {
    percent: formatPercent(priced / events * 100, 1),
  });
}

/**
 * The token components a model row can break down into, in reading order:
 * input before output, and within each the cheaper-per-token part first. The
 * label is a key rather than a string so the rows retranslate in place.
 */
const MODEL_COMPONENT_ROWS = Object.freeze([
  ["input_cache_read_tokens", "accounting.model.componentCached"],
  ["input_uncached_tokens", "accounting.model.componentUncached"],
  ["output_text_tokens", "accounting.model.componentOutputText"],
  ["output_reasoning_tokens", "accounting.model.componentReasoning"],
  ["output_combined_tokens", "accounting.model.componentCombined"],
]);

/**
 * A share cell. `null` prints the same withheld glyph the rest of this table
 * uses, so "no denominator to divide by" never renders as an exact 0.0%.
 */
function modelShareCell(part, whole) {
  const share = formatSharePercent(part, whole);
  if (share === null) {
    return localizedNode("td", "numeric-cell model-share", "accounting.model.shareWithheld");
  }
  return rawNode("td", "numeric-cell model-share", share);
}

/**
 * One component of one model, built as a row of the same table rather than a
 * nested grid: same columns, same alignment, one level of indent. Only the
 * denominator differs from the model row above it, and that is stated once in
 * the caption under the table.
 */
function modelComponentRow(model, key, labelKey, totals) {
  const row = node("tr", "model-component-row");
  row.dataset.componentOf = model.model;

  const identity = node("td", "model-identity model-component-identity");
  const swatch = node("span", `component-swatch component-swatch-${key.replace(/_/gu, "-")}`);
  swatch.setAttribute("aria-hidden", "true");
  identity.append(swatch, localizedNode("span", "", labelKey));

  // A usage change carries every component at once, so the count does not
  // divide between them. Withheld with its reason, never shown as zero.
  const events = localizedNode(
    "td",
    "numeric-cell model-component-withheld",
    "accounting.model.componentEventsWithheld",
  );
  events.title = t("accounting.model.componentEventsWithheldTitle");

  const tokens = finite(model.components?.[key], 0);
  const cost = model.componentCosts?.[key] ?? null;

  // A separate allowance carries no comparable money, and a row whose
  // components were never priced carries none either. Both withhold the
  // amount instead of dividing the row total into an invented one.
  let costCell;
  let costShareCell;
  if (!modelHasComparableCost(model) || cost === null || finite(cost.costUsd) === null) {
    costCell = localizedNode(
      "td",
      "numeric-cell model-component-withheld",
      "accounting.model.componentCostWithheld",
    );
    costCell.title = t(
      modelRowIsSeparateAllowance(model)
        ? "accounting.model.separateAllowanceTitle"
        : model.pricingStatus === "known_unpriced"
          ? "accounting.model.noPublishedPriceTitle"
          : model.pricingStatus === "unrecognized"
            ? model.model === "unknown"
              ? "accounting.model.identityUnavailableTitle"
              : "accounting.model.notPricedUnknownTitle"
            : "accounting.model.componentCostWithheldTitle",
    );
    costShareCell = localizedNode(
      "td",
      "numeric-cell model-share",
      "accounting.model.shareWithheld",
    );
  } else {
    costCell = rawNode("td", "numeric-cell", formatApiMoney(finite(cost.costUsd, 0)));
    costShareCell = modelShareCell(finite(cost.costUsd, 0), totals.cost);
  }

  row.append(
    identity,
    events,
    rawNode("td", "numeric-cell", formatCount(tokens)),
    modelRowIsSeparateAllowance(model)
      ? localizedNode("td", "numeric-cell model-share", "accounting.model.shareWithheld")
      : modelShareCell(tokens, totals.tokens),
    costCell,
    costShareCell,
  );
  return row;
}

function renderAccountingModels(accounting, { unavailable = false, preserveCompact = false } = {}) {
  usageSimpleModelAccounting = accounting;
  usageSimpleModelsUnavailable = unavailable;
  if (!preserveCompact) renderUsageSimpleModels(accounting, unavailable);
  const models = $("#accounting-models");
  if (!models) return;
  clear(models);
  const coverage = $("#accounting-price-coverage");
  if (coverage) {
    const note = unavailable ? null : pricingCoverageNote(accounting);
    setRawText(coverage, note ?? "");
    coverage.hidden = note === null;
  }
  const modelRows = unavailable ? [] : modelUsageRows(accounting);
  const page = paginateCacheImpactRows(
    modelRows,
    accountingModelsTablePagination,
    cacheImpactTableSignature("models", accounting, modelRows),
    { preservePage: Boolean($("#overview-details-dialog")?.open) },
  );
  renderCacheImpactPagination(
    "accounting-model",
    accountingModelsTablePagination,
    page,
  );
  if (!modelRows.length) {
    const row = node("tr");
    const cell = localizedNode(
      "td",
      "empty-cell",
      unavailable
        ? "accounting.model.unavailable"
        : "accounting.model.noneInPeriod",
    );
    cell.colSpan = 6;
    row.append(cell);
    models.append(row);
    return;
  }
  // Both share columns are against the primary pool's own totals, so the model
  // rows add up to 100% and each model's components add up to their model. A
  // separately metered row is not part of that pool and withholds both shares,
  // the same rule its money cell already follows.
  const totals = {
    tokens: finite(accounting?.totalTokens, 0),
    cost: finite(accounting?.speedApiPriceEquivalentUsd, 0),
  };
  for (const model of page.rows) {
    const row = node("tr");
    const identity = node("td", "model-identity");
    const presentation = modelUsagePresentation(
      model.pricingStatus === "unrecognized" ? "unknown" : model.model,
    );
    const icon = modelThemeIcon(document, presentation.theme);
    if (icon) {
      icon.classList.add("model-usage-icon", presentation.className);
      identity.append(icon);
    }
    // The unknown aggregate combines missing attribution and unreviewed
    // identifiers. Its label must not claim either cause as established.
    if (model.model === "unknown") {
      const label = localizedNode("span", "", "accounting.model.identityUnavailable");
      label.title = t("accounting.model.identityUnavailableTitle");
      identity.append(label);
    } else if (model.pricingStatus === "unrecognized") {
      identity.append(localizedNode("span", "", "accounting.model.unrecognized"));
    } else {
      // The wire identifier is what the provider reported and what any
      // support conversation will quote, so it stays reachable on hover even
      // though the readable name is what gets printed.
      const name = formatModelName(model.model);
      const label = rawNode("span", "", name);
      if (name !== model.model) label.title = model.model;
      identity.append(label);
    }
    if (modelRowIsSeparateAllowance(model)) {
      // A filled chip on every Spark row shouted the same fact once per row and
      // crowded the identity column. One marker on the name, carrying the same
      // sentence as its expansion and pointing at the standing footnote under
      // the table, says it without competing with the figures.
      const marker = rawNode("abbr", "model-allowance-marker", "*");
      marker.title = t("accounting.model.separateAllowanceTitle");
      identity.append(marker);
    }
    // One formatter for both count columns. Compact notation put "154.9K"
    // beside "74" in the same column, which no reader can compare by eye.
    const separate = modelRowIsSeparateAllowance(model);
    row.append(
      identity,
      rawNode(
        "td",
        "numeric-cell",
        formatCount(model.events, { missing: t("accounting.model.notReported") }),
      ),
      rawNode(
        "td",
        "numeric-cell",
        formatCount(model.totalTokens, { missing: t("accounting.model.notReported") }),
      ),
      separate
        ? localizedNode("td", "numeric-cell model-share", "accounting.model.shareWithheld")
        : modelShareCell(model.totalTokens, totals.tokens),
      modelApiEquivalentCell(model),
      modelHasComparableCost(model)
        ? modelShareCell(model.apiPriceEquivalentUsd, totals.cost)
        : localizedNode("td", "numeric-cell model-share", "accounting.model.shareWithheld"),
    );

    // A row can only be opened when it actually carries a split. Older cached
    // projections have none, and drawing four zeroed rows for them would be a
    // claim the row never made.
    const componentRows = model.components === null || model.components === undefined
      ? []
      : MODEL_COMPONENT_ROWS
        .filter(([key]) => finite(model.components[key], 0) > 0)
        .map(([key, labelKey]) => modelComponentRow(model, key, labelKey, totals));

    if (componentRows.length > 0) {
      const expanded = accountingExpandedModels.has(model.model);
      row.classList.add("model-row-expandable");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-expanded", String(expanded));
      const describe = () => {
        row.setAttribute(
          "aria-label",
          t(
            row.getAttribute("aria-expanded") === "true"
              ? "accounting.model.collapse"
              : "accounting.model.expand",
            { model: model.model === "unknown"
              ? t("accounting.model.identityUnavailable")
              : model.pricingStatus === "unrecognized"
                ? t("accounting.model.unrecognized")
                : formatModelName(model.model) },
          ),
        );
      };
      describe();
      identity.prepend(modelDisclosureCaret());
      for (const componentRow of componentRows) componentRow.hidden = !expanded;
      const toggle = () => {
        const open = row.getAttribute("aria-expanded") === "true";
        row.setAttribute("aria-expanded", String(!open));
        if (open) accountingExpandedModels.delete(model.model);
        else accountingExpandedModels.add(model.model);
        for (const componentRow of componentRows) componentRow.hidden = open;
        describe();
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      });
    }

    models.append(row, ...componentRows);
  }
}

function renderUsageSimpleModels(accounting, unavailable) {
  const host = $("#usage-simple-models");
  if (!host) return;
  clear(host);
  const allRows = unavailable ? [] : modelUsageRows(accounting);
  const rows = allRows.filter(model => (!usageSimpleFilters.model || model.model === usageSimpleFilters.model)
    && (!usageSimpleFilters.search || `${model.model} ${formatModelName(model.model)}`.toLocaleLowerCase().includes(usageSimpleFilters.search.toLocaleLowerCase())))
    .sort((a, b) => usageSimpleMetric === "cost"
      ? (finite(b.apiPriceEquivalentUsd) ?? -1) - (finite(a.apiPriceEquivalentUsd) ?? -1)
      : (finite(b.totalTokens) ?? -1) - (finite(a.totalTokens) ?? -1));
  if (!rows.length) {
    host.append(localizedNode("p", "annotation", unavailable
      ? "accounting.model.unavailable" : "accounting.model.noneInPeriod"));
    if (usageSimpleFilters.search || usageSimpleFilters.model) {
      const clear = node("button", "button button-quiet compact", t("workUsage.clearFilters"));
      clear.type = "button"; clear.addEventListener("click", () => workUsageView.clearFilters()); host.append(clear);
    }
    return;
  }
  const filtered = Boolean(usageSimpleFilters.search || usageSimpleFilters.model);
  const selectedAmounts = rows.map(row => usageSimpleMetric === "cost" ? finite(row.apiPriceEquivalentUsd) : finite(row.totalTokens));
  const total = filtered ? selectedAmounts.some(value => value === null) ? null : selectedAmounts.reduce((sum, value) => sum + value, 0)
    : usageSimpleMetric === "cost" ? finite(accounting?.speedApiPriceEquivalentUsd) : finite(accounting?.totalTokens);
  if (filtered) {
    const line = node("div", "work-usage-filter-result");
    line.append(node("span", "", t("workUsage.filteredResult")), node("strong", "", usageSimpleMetric === "cost" ? formatApiMoney(total) : formatCount(total)));
    const clear = node("button", "button button-quiet compact", t("workUsage.clearFilters"));
    clear.type = "button"; clear.addEventListener("click", () => workUsageView.clearFilters()); line.append(clear); host.append(line);
  }
  for (const model of rows) {
    const button = node("button", "usage-simple-model-row");
    button.type = "button";
    button.dataset.model = model.model;
    button.setAttribute("aria-haspopup", "dialog");
    const label = model.model === "unknown"
      ? t("accounting.model.identityUnavailable") : formatModelName(model.model);
    button.append(node("span", "usage-simple-model-name", label));
    const validCost = modelHasComparableCost(model);
    const amount = usageSimpleMetric === "cost"
      ? validCost ? finite(model.apiPriceEquivalentUsd) : null
      : finite(model.totalTokens);
    const values = node("span", "usage-simple-model-values");
    values.append(node("strong", "", amount === null
      ? modelRowIsSeparateAllowance(model) ? t("accounting.model.separateAllowance")
        : model.pricingStatus === "known_unpriced" ? t("accounting.model.noPublishedPrice")
          : model.pricingStatus === "unrecognized" ? t("accounting.model.notPricedUnknown")
            : t("accounting.model.notReported")
      : usageSimpleMetric === "cost" ? formatApiMoney(amount) : formatCount(amount)));
    const share = amount !== null && !modelRowIsSeparateAllowance(model)
      ? formatSharePercent(amount, total) : null;
    if (usageSimpleMetric === "cost" && amount !== null
        && model.speedPricingCoverageStatus !== "fully_priced") {
      values.append(localizedNode("span", "annotation", "dashboard.overview.partial"));
    }
    button.append(values);
    const track = node("span", "usage-simple-model-track");
    track.setAttribute("aria-hidden", "true");
    const fill = node("span");
    fill.style.width = `${amount !== null && total > 0
      ? Math.min(100, Math.max(0, amount / total * 100)) : 0}%`;
    track.append(fill);
    const proportion = node("span", "work-usage-rank-share");
    proportion.append(track, node("small", "work-usage-muted", share ?? "—"));
    button.append(proportion, node("span", "work-usage-rank-caret", "›"));
    button.addEventListener("click", () => {
      accountingExpandedModels.add(model.model);
      const index = allRows.findIndex(candidate => candidate.model === model.model);
      accountingModelsTablePagination.page = Math.floor(index / CACHE_IMPACT_TABLE_PAGE_SIZE);
      renderAccountingModels(usageSimpleModelAccounting, { unavailable: usageSimpleModelsUnavailable, preserveCompact: true });
      $("#usage-model-details > summary").click();
      const dialog = $("#overview-details-dialog");
      dialog.addEventListener("close", () => {
        const current = [...host.querySelectorAll("button")]
          .find(candidate => candidate.dataset.model === model.model);
        current?.focus({ preventScroll: true });
      }, { once: true });
    });
    host.append(button);
  }
}

/** The affordance that says a model row opens. Decorative; the row is the control. */
function modelDisclosureCaret() {
  const caret = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  caret.setAttribute("class", "model-disclosure-caret");
  caret.setAttribute("viewBox", "0 0 16 16");
  caret.setAttribute("aria-hidden", "true");
  caret.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 3.5 10.5 8 6 12.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  caret.append(path);
  return caret;
}

function fastModeCoverageSentence(fastMode) {
  const coverage = fastMode.coverage;
  if (coverage.totalEvents === 0) {
    return t("accounting.fastMode.noUsage");
  }
  const knownEvents = coverage.observedEvents + coverage.declaredFromConfigEvents;
  const sentences = [t("accounting.fastMode.coverageSummary", {
    known: compact(knownEvents),
    total: compact(coverage.totalEvents),
  })];
  if (coverage.assumedEvents > 0) {
    sentences.push(t("accounting.fastMode.coverageAssumed", {
      count: compact(coverage.assumedEvents),
    }));
  }
  if (coverage.unknownEvents === 0) {
    sentences.push(t("accounting.fastMode.coverageComplete"));
    return sentences.join(" ");
  }
  sentences.push(t("accounting.fastMode.coverageUnknown", {
    count: compact(coverage.unknownEvents),
    percent: coverage.unknownSharePercent === null
      ? "—"
      : formatPercent(coverage.unknownSharePercent, 1),
  }));
  sentences.push(fastMode.unweightedUnknownApiPriceEquivalentUsd > 0
    ? t("accounting.fastMode.coverageUnknownCost", {
      amount: formatApiMoney(fastMode.unweightedUnknownApiPriceEquivalentUsd),
    })
    : t("accounting.fastMode.coverageUnknownExcluded"));
  return sentences.join(" ");
}


function scheduleLocalReadinessPoll(isCurrent) {
  if (!isCurrent()
      || (localCompanionHealth !== null && localOnboarding?.state !== "unavailable"
        && localOnboarding !== null)
      || localReadinessPollTimer !== null || localReadinessPollCount >= 450) return;
  localReadinessPollTimer = window.setTimeout(() => {
    localReadinessPollTimer = null;
    if (!isCurrent()) return;
    localReadinessPollCount += 1;
    void loadLocalDashboardSecondaryState({ isCurrent }).catch(() => {
      scheduleLocalReadinessPoll(isCurrent);
    });
  }, 4_000);
}

async function loadLocalDashboardSecondaryState({ isCurrent, primaryAvailable = true }) {
  const read = async (request, publish = () => {}) => {
    const value = await Promise.resolve().then(request).catch(() => null);
    if (isCurrent()) publish(value);
    return value;
  };
  const health = read(() => localClient.health(), (localHealth) => {
    // A failed read says nothing about the companion. Never replace a health
    // answer that landed with one that did not.
    if (localHealth === null) return;
    localCompanionHealth = localHealth;
    if (dashboard === null) {
      renderDashboardUnavailableState("dashboard-unavailable");
    }
  });
  const onboarding = read(() => localClient.onboarding(), (value) => {
    if (value === null) return;
    renderLocalOnboarding(value);
  });
  const refreshStatusVersion = localRefreshStatusVersion;
  // A one-time fallback for environments without EventSource. An ordinary
  // connected session receives its current state from the event stream.
  const refresh = localProgressEvents.connection() !== "unavailable" ? Promise.resolve(null) : read(() => localClient.refreshStatus(), (refreshState) => {
    if (refreshState === null || refreshStatusVersion !== localRefreshStatusVersion) return;
    accountingRebuildDeferral =
      refreshState?.refresh?.result?.accountingRebuildDeferred ?? null;
    if (refreshState.refresh?.running || ["running", "cancelling"].includes(refreshState.refresh?.status)) {
      void requestRefresh({ observeOnly: true, initialRefresh: refreshState.refresh });
    } else if (primaryAvailable !== false && !dashboardReadFailed) publishRefreshResultNotice(refreshState?.refresh);
    if (dashboard) renderAccounting(dashboard);
  });
  await Promise.all([health, onboarding, refresh]);
  scheduleLocalReadinessPoll(isCurrent);
}

/** Mark the first real local-dashboard render for the native shell. */
let dashboardReadFailed = false;

function markLocalDashboardReady() {
  // The native shell uses this app-owned marker instead of mistaking static
  // hero copy for a loaded evidence view. It contains no data; it means only
  // that the first local dashboard result (available or honestly unavailable)
  // has finished rendering.
  document.documentElement.dataset.localDashboardReady = "true";
}

async function loadLocalDashboard() {
  const previousDashboard = dashboard;
  if (!previousDashboard) renderDesktopEvidenceState("loading");
  const loadToken = ++cacheDropThreadLinks.loadToken;
  const load = {
    previousBusy: activeLocalDashboardLoad?.pending
      ? activeLocalDashboardLoad.previousBusy
      : localActionBusy,
    pending: true,
  };
  activeLocalDashboardLoad = load;
  const isCurrent = () => cacheDropThreadLinks.loadToken === loadToken;
  let primaryAvailable = false;
  localActionBusy = true;
  const button = $("#refresh-button");
  if (localRefreshInProgress) renderRefreshProgress(button, "Loading evidence…");
  else if (button.getAttribute("data-sidebar-refresh") !== "true") setLocalizedText(button, "refresh.progress.connecting");
  updateLocalActionButtons();
  try {
    const loadDashboardData = async () => {
      try {
        return await localClient.load();
      } catch (firstError) {
        if (!isCurrent()) throw firstError;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        if (!isCurrent()) throw firstError;
        try {
          return await localClient.load();
        } catch {
          throw firstError;
        }
      }
    };
    const data = await loadDashboardData();
    if (!isCurrent()) return;
    renderDashboard(data);
    dashboardReadFailed = false;
    // Clear the first-run evidence curtain using the result we actually have,
    // even while the next optional onboarding verdict is still pending.
    renderLocalOnboarding(localOnboarding);
    markLocalDashboardReady();
    primaryAvailable = true;
    dashboardReportPreloader.schedule();
  } catch (error) {
    if (!isCurrent()) return false;
    dashboard = previousDashboard;
    if (error?.name === "AbortError") return false;
    dashboardReadFailed = true;
    if (previousDashboard) {
      try { renderDashboard(previousDashboard); } catch { dashboard = previousDashboard; }
      const failure = dashboardReadFailure(error);
      if (failure) showConnectionNotice({ titleKey: "allowance.simple.loadFailed", copyKey: failure.copyKey, copyValues: {code:failure.code}, kind: "error", showCheck: true });
      setGlobalState("stale", {companionReachable:true});
    } else {
    observationFreshnessClock.stop();
    lastObservationPresentationStatus = null;
    renderLocalOnboarding(localOnboarding);
    renderDashboardUnavailableState(
      localCompanionHealth ? "dashboard-unavailable" : "companion-unavailable",
    );
    markLocalDashboardReady();
    }
  } finally {
    if (activeLocalDashboardLoad === load) {
      load.pending = false;
      localActionBusy = load.previousBusy;
      updateLocalActionButtons();
      if (nativeEvidenceReloadPending && !localRefreshInProgress && !localActionBusy) void reloadLocalEvidenceAfterNativeRefresh();
    }
  }
  if (isCurrent()) {
    // Optional reads never own primary readiness or the action's busy state.
    void loadLocalDashboardSecondaryState({ isCurrent, primaryAvailable }).catch(() => {});
  }
  return primaryAvailable;
}

function renderDashboardSkeleton() {
  closeInformationPopover();
  const forecast = $("#weekly-pace-forecast");
  if (forecast) { forecast.hidden = true; clear(forecast); }
  if ($("#allowance-context")) $("#allowance-context").hidden = true;
  const container = $("#quota-cards");
  clear(container);
  const card = node("article", "metric-card insufficient");
  const header = node("div", "metric-card-header");
  header.append(
    node("span", "metric-name", t("dashboard.unavailable.noLocalEvidence")),
    node("span", "evidence-chip", t("dashboard.unavailable.offline")),
  );
  card.append(
    header,
    node("strong", "metric-value", "—"),
    node("p", "", t("dashboard.unavailable.emptyState")),
  );
  container.append(card);
}

async function loadQuickResultDashboard() {
  const previousDashboard = dashboard;
  const loadToken = ++cacheDropThreadLinks.loadToken;
  const isCurrent = () => cacheDropThreadLinks.loadToken === loadToken;
  try {
    const data = await localClient.load();
    if (!isCurrent()) return;
    renderDashboard(data);
    dashboardReadFailed = false;
    renderLocalOnboarding(localOnboarding);
    dashboardReportPreloader.schedule();
  } catch (error) {
    if (isCurrent()) {
      dashboard = previousDashboard;
      if (error?.name !== "AbortError") dashboardReadFailed = true;
    }
    throw error;
  } finally {
    // This generation replaces any pending startup reads too. Keep optional
    // recovery alive without making native evidence reloads wait for it.
    if (isCurrent()) {
      void loadLocalDashboardSecondaryState({
        isCurrent,
        primaryAvailable: dashboard !== null && dashboard.mode !== "demo",
      }).catch(() => {});
    }
  }
}

function showDemoDashboard() {
  cacheDropThreadLinks.loadToken += 1;
  if (activeLocalDashboardLoad?.pending) {
    localActionBusy = activeLocalDashboardLoad.previousBusy;
  }
  activeLocalDashboardLoad = null;
  renderDashboard(demoDashboard());
  updateLocalActionButtons();
}

/**
 * True when the local history index has discovered more sources than it has
 * indexed — a one-time build or a parser-version reparse is still catching up.
 * Reads the same coverage the top-bar badge uses; demo mode is never pending.
 */
function historyIndexIncomplete() {
  if (!dashboard || dashboard.mode === "demo") return false;
  return currentHistoryContinuationDecision().incomplete;
}

function currentHistoryContinuationDecision() {
  const history = dashboard?.pricing?.historyCoverage
    ?? dashboard?.accounting?.historyCoverage
    ?? null;
  return historyIndexContinuationDecision({
    history,
    generation: dashboard?.accounting?.generation ?? null,
    generationFingerprint:
      dashboard?.accounting?.generationFingerprint ?? null,
    previousReceipt: lastReindexProgressReceipt,
  });
}

function historyProgressReceipt() {
  return currentHistoryContinuationDecision().receipt;
}

/**
 * After an explicit detailed refresh that left the history index incomplete, run the
 * next pass promptly instead of waiting for the sparse auto-cadence, bounded
 * by REINDEX_AUTO_CONTINUE_LIMIT. Stops the moment coverage completes, the
 * user interacts, or the bound is reached (the ordinary cadence then carries
 * the remainder). Never runs in demo mode or while another action is busy.
 */
function scheduleReindexAutoContinuation() {
  if (reindexAutoContinueTimer !== null) {
    clearTimeout(reindexAutoContinueTimer);
    reindexAutoContinueTimer = null;
  }
  const decision = currentHistoryContinuationDecision();
  if (!decision.incomplete) {
    reindexAutoContinuations = 0;
    lastReindexProgressReceipt = null;
    return;
  }
  if (!decision.shouldContinue) return;
  lastReindexProgressReceipt = decision.receipt;
  if (reindexAutoContinuations >= REINDEX_AUTO_CONTINUE_LIMIT) return;
  reindexAutoContinueTimer = setTimeout(() => {
    reindexAutoContinueTimer = null;
    if (localActionBusy || !historyIndexIncomplete()) {
      reindexAutoContinuations = 0;
      return;
    }
    reindexAutoContinuations += 1;
    void requestRefresh({ autoContinue: true, detailed: true });
  }, REINDEX_AUTO_CONTINUE_DELAY_MS);
}

async function requestRefresh({ autoContinue = false, detailed = false, observeOnly = false, initialRefresh = null } = {}) {
  if (!observeOnly && (localRefreshPaused || !localRefreshPauseReady)) return;
  if (localActionBusy || localRefreshObserverActive || localRefreshSubmissionPending) return;
  const previousGlobalState = globalState;
  // Fence continuation against the exact coverage visible before this pass.
  // If the terminal reload presents the same generation/count/byte receipt,
  // scheduleReindexAutoContinuation stops immediately instead of spending the
  // rest of its 40-pass budget on identical work.
  lastReindexProgressReceipt = historyProgressReceipt();
  // A person pressing Refresh restarts the auto-continuation budget; a chained
  // reindex pass keeps counting toward the bound set when it began.
  if (!autoContinue) reindexAutoContinuations = 0;
  if (!localAnalysisAllowed()) {
    showConnectionNotice({
      titleKey: "refresh.preflightTitle",
      copyKey: "refresh.preflightCopy",
      kind: "warning",
      showCheck: true,
      showDemo: !dashboard,
    });
    updateLocalActionButtons();
    return;
  }
  const button = $("#refresh-button");
  const electronRefresh = runsInsideElectronDashboard();
  let refreshAccepted = observeOnly;
  let cancelled = false;
  let quickResultLoaded = false;
  let continuationLimitReached = false;
  let refreshLeaseSession = null;
  let refreshProgressClock = null;
  let sidebarResultKey = "refresh.sidebar.failed";
  let refreshSucceeded = false;
  let observationInterrupted = false;
  let observationExpired = false;
  let observedRefreshId = null;
  let eventCursor = localProgressEvents.cursor();
  localRefreshStatusVersion += 1;
  localRefreshObserverActive = true;
  localActionBusy = true;
  localRefreshSubmissionPending = !observeOnly;
  localRefreshInProgress = observeOnly;
  localRefreshCancelRequested = false;
  if (observeOnly) renderRefreshProgress(button, "Update running…");
  else if (button.getAttribute("data-sidebar-refresh") === "true") setSidebarRefreshSummary("refresh.progress.submitting");
  else setLocalizedText(button, "refresh.progress.submitting");
  updateLocalActionButtons();
  if (observeOnly) setGlobalState("updating");
  try {
    const accepted = observeOnly ? null : await (detailed
      ? localClient.recalculateDetailedAccounting()
      : localClient.refresh());
    initialRefresh = accepted?.refresh ?? initialRefresh;
    refreshAccepted = true;
    localRefreshSubmissionPending = false;
    localRefreshInProgress = true;
    setGlobalState("updating");
    if (electronRefresh && !observeOnly) {
      refreshLeaseSession = createElectronRefreshLease({
        bridge: globalThis.usageMonitorDesktop,
        // Both ordinary overview and explicit detailed requests can calculate
        // usage. Only an actually quota-only run receives quick lease bounds.
        mode: initialRefresh?.mode === "quick" && accepted?.request?.pending !== true ? "quick" : "detailed",
        onState(next) {
          electronRefreshLifecycleState = next;
          if (!localRefreshInProgress) void refreshElectronCadenceHealth();
        },
      });
      // Connection bookkeeping must never delay companion polling. A bounded late
      // start reply is still settled by the lifecycle module after completion.
      void refreshLeaseSession.start();
    }
    refreshProgressClock = startRefreshProgressClock(button, detailed
      ? "Starting detailed accounting…"
      : "Starting local analysis…");
    const pollingBudget = createRefreshPollingBudget();
    let outcome = "running";
    let finalErrorCode = null;
    let finalFailedStep = null;
    let finalFailureCode = null;
    let finalRefreshState = null;
    let timeoutSettlementNoted = false;
    while (pollingBudget.hasTime()
        && ["running", "cancelling"].includes(outcome)) {
      if (!initialRefresh) {
        if (["unavailable", "closed"].includes(localProgressEvents.connection())) {
          observationInterrupted = true;
          throw new Error("Refresh observation unavailable.");
        }
        const remaining = pollingBudget.remainingMs();
        if (remaining <= 0) break;
        const waitController = new AbortController();
        localRefreshObservationWait = waitController;
        try {
          await localProgressEvents.wait(eventCursor, { signal: waitController.signal, timeoutMs: remaining });
        } finally {
          if (localRefreshObservationWait === waitController) localRefreshObservationWait = null;
        }
        if (!pollingBudget.hasTime()) break;
        const nextCursor = localProgressEvents.cursor();
        if (waitController.signal.aborted && nextCursor === eventCursor) continue;
        eventCursor = nextCursor;
        if (localProgressEvents.connection() !== "connected") {
          refreshProgressClock.update("Update running; reconnecting…");
          continue;
        }
      }
      let status;
      try {
        status = initialRefresh ? { refresh: initialRefresh } : await localClient.refreshStatus();
        initialRefresh = null;
      } catch (error) {
        refreshProgressClock.update("Update running; reconnecting…");
        observationInterrupted = true;
        throw error;
      }
      const refresh = status?.refresh ?? {};
      if (refresh.refreshId && refresh.refreshId !== observedRefreshId) {
        observedRefreshId = refresh.refreshId;
        quickResultLoaded = false;
      }
      if (refresh.status === "cancelling") localRefreshCancelRequested = true;
      finalRefreshState = refresh;
      outcome = refresh.status ?? "failed";
      finalErrorCode = refresh.errorCode ?? null;
      finalFailedStep = refresh.failedStep ?? finalFailedStep;
      finalFailureCode = refresh.failureCode ?? finalFailureCode;
      const progress = refresh.progress ?? refresh.result?.indexing ?? null;
      const collectorProgress = progress?.kind === undefined;
      const unifiedIndexScanning = progress?.kind === "unified_index"
        && progress?.status === "scanning"
        && progress?.phase === "rollout_index";
      if ((refresh.quickResultAt || (collectorProgress && progress?.phase === "quick_result"))
          && !quickResultLoaded) {
        try {
          await loadQuickResultDashboard();
          quickResultLoaded = true;
        } catch {
          // Keep polling. The verified quick snapshot can still be loaded when
          // deep accounting finishes, and no partial replacement is invented.
        }
      }
      const accountingStatus = outcome === "running"
        ? refreshAccountingStatus({ progress })
        : null;
      const countedProgress = collectorProgress || unifiedIndexScanning;
      const processed = countedProgress
          && Number.isSafeInteger(progress?.filesProcessed)
        ? progress.filesProcessed : null;
      const selected = countedProgress
          && Number.isSafeInteger(progress?.filesSelected)
        ? progress.filesSelected : null;
      const phase = outcome === "cancelling"
        ? "Stopping safely…"
        : refresh.quota?.status === "running"
          ? "Reading allowance…"
        : accountingStatus !== null ? "Starting detailed accounting…"
        : refresh.usage?.status === "running" ? "Allowance updated; calculating usage…"
        : "Starting local analysis…";
      refreshProgressClock.update(phase, { processed, selected });
      updateLocalActionButtons();
      if (detailed && refresh.mode === "detailed" && refresh.running === false && refreshNeedsContinuation({
        outcome,
        errorCode: refresh.errorCode,
        progress,
      })) {
        if (!pollingBudget.canContinue()) {
          continuationLimitReached = true;
          throw new Error("The bounded continuation limit was reached.");
        }
        try {
          const continuation = await (detailed
            ? localClient.recalculateDetailedAccounting()
            : localClient.refresh());
          initialRefresh = continuation?.refresh ?? null;
          if (continuation?.request?.started === true) {
            pollingBudget.noteContinuation();
            timeoutSettlementNoted = false;
            refreshProgressClock.reset("Continuing local analysis…");
          }
        } catch (error) {
          // A 409 means a timed-out pass is still finishing its durable
          // checkpoint. Keep polling until it becomes resumable.
          if (error?.status !== 409) throw error;
          if (!timeoutSettlementNoted) {
            pollingBudget.noteSettling();
            timeoutSettlementNoted = true;
          }
        }
        outcome = "running";
        continue;
      }
      if (detailed && outcome === "failed"
          && refresh.errorCode === "refresh_timed_out" && refresh.running === true) {
        refreshProgressClock.update("Stopping timed-out analysis…");
        if (!timeoutSettlementNoted) {
          pollingBudget.noteSettling();
          timeoutSettlementNoted = true;
        }
        outcome = "running";
      }
      // A failed timeout receipt can still own a settling writer. Observe it
      // until the controller releases ownership before presenting completion.
      if (refresh.running === true && !["running", "cancelling"].includes(outcome)) outcome = "running";
      // A joined quota-only run is not completion of an accepted usage/detail
      // request. Keep one observer across the controller's bounded follow-up.
      if (refresh.pending !== null && typeof refresh.pending === "object"
          && !["running", "cancelling"].includes(outcome)) outcome = "running";
      if (!["running", "cancelling"].includes(outcome)) {
        const published = localProgressEvents.current()?.refresh;
        if (localProgressEvents.connection() !== "connected" || !published
            || published.refreshId !== refresh.refreshId || published.publication === "running"
            || ["running", "cancelling"].includes(published.status) || published.pending) outcome = "running";
      }
    }
    if (["running", "cancelling"].includes(outcome)) {
      observationInterrupted = true;
      observationExpired = true;
      throw new Error("Refresh observation needs reconnection.");
    }
    if (finalRefreshState?.finishedAt) {
      lastObservedRefreshPublication = `${finalRefreshState.refreshId ?? ""}:${finalRefreshState.quickResultAt ?? ""}:${finalRefreshState.finishedAt}`;
    }
    cancelled = outcome === "cancelled";
    if (cancelled) {
      sidebarResultKey = "refresh.sidebar.cancelled";
      refreshProgressClock.stop();
      refreshProgressClock = null;
      renderRefreshProgress(button, "Loading saved results…");
      await loadLocalDashboard();
      return;
    }
    if (outcome === "failed"
        && finalErrorCode === "refresh_resource_limited") {
      sidebarResultKey = "refresh.resourceTitle";
      refreshProgressClock.stop();
      refreshProgressClock = null;
      renderRefreshProgress(button, "Loading saved results…");
      await loadLocalDashboard();
      showConnectionNotice({
        titleKey: "refresh.resourceTitle",
        copyKey: "refresh.resourceCopy",
        kind: "warning",
      });
      return;
    }
    if (outcome === "degraded") {
      sidebarResultKey = "refresh.sidebar.partial";
      refreshProgressClock.stop();
      refreshProgressClock = null;
      renderRefreshProgress(button, t("refresh.degradedLoading"));
      if (await loadLocalDashboard() === false) return;
      lastReindexProgressReceipt = historyProgressReceipt();
      publishRefreshResultNotice(finalRefreshState);
      return;
    }
    if (outcome !== "succeeded") {
      // The companion stamps failures with a fixed step name and a bounded
      // machine code; carrying them here is the difference between "it did
      // not finish" and something a person can act on.
      const failureDetail = [finalFailedStep, finalFailureCode]
        .filter(Boolean).join(" · ");
      const failure = new Error(failureDetail
        ? `The local refresh failed at: ${failureDetail}.`
        : "The local refresh did not complete successfully.");
      if (finalFailureCode) failure.code = finalFailureCode;
      failure.refreshFailureDetail = failureDetail || null;
      throw failure;
    }
    refreshProgressClock.stop();
    refreshProgressClock = null;
    renderRefreshProgress(button, "Loading updated evidence…");
    if (await loadLocalDashboard() === false) return;
    publishRefreshResultNotice(finalRefreshState);
    refreshSucceeded = true;
    if (detailed && !observeOnly) scheduleReindexAutoContinuation();
  } catch (error) {
    if (observationInterrupted) {
      sidebarResultKey = observationExpired ? "refresh.stage.observationStopped" : "refresh.stage.reconnecting";
      return;
    }
    if (dashboard) {
      const presentation = dashboardObservationPresentation(
        dashboard,
        observationRecency(dashboard),
      );
      setGlobalState(presentation.state, {
        companionReachable: dashboard.mode !== "demo",
      });
    }
    if (!refreshAccepted && error?.status === 409) {
      sidebarResultKey = "refresh.alreadyRunningTitle";
      // Another surface owns the shared controller. In particular, a quick
      // run is not proof that this request's detailed work was accepted. Do
      // not enqueue an escalation or turn a safe conflict into a failure.
      showConnectionNotice({
        titleKey: "refresh.alreadyRunningTitle",
        copyKey: "refresh.alreadyRunningCopy",
        kind: "info",
      });
      return;
    }
    // This was a bare `catch {}`: it printed one of three sentences for every
    // possible cause and discarded the only evidence of which one occurred.
    // That is the same defect this file already fixed for the contribution
    // path, left in place on the product's most important path - so a refresh
    // that failed for a specific, named reason was indistinguishable from one
    // that merely did not finish, and there was nothing to quote when asking
    // for help. `local_refresh` was already a reviewed diagnostic surface with
    // no caller; this is that caller. The three sentences below remain as the
    // fallback for a cause with no fixed copy of its own.
    const described = await describeFailure({
      surface: "local_refresh",
      error,
      fallback: continuationLimitReached
        ? t("refresh.continuationCopy")
        : refreshAccepted
          ? (error?.refreshFailureDetail
            ? t("refresh.failedDetailCopy", { detail: error.refreshFailureDetail })
            : t("refresh.failedCopy"))
        : t("refresh.notStartedCopy"),
    });
    showConnectionNotice({
      title: continuationLimitReached
        ? t("refresh.continuationTitle")
        : refreshAccepted
          ? t("refresh.failedTitle")
        : t("refresh.notStartedTitle"),
      copy: described.text,
      kind: continuationLimitReached ? "warning" : "error",
      showDemo: !dashboard
    });
  } finally {
    refreshProgressClock?.stop();
    if (electronRefresh && refreshAccepted) await refreshLeaseSession?.finish();
    localActionBusy = false;
    localRefreshSubmissionPending = false;
    localRefreshObserverActive = false;
    localRefreshInProgress = observationInterrupted;
    localRefreshCancelRequested = false;
    if (nativeEvidenceReloadPending) void reloadLocalEvidenceAfterNativeRefresh();
    updateLocalActionButtons();
    void refreshElectronCadenceHealth();
    setSidebarRefreshSummary(refreshSucceeded ? "refresh.stage.complete" : sidebarResultKey, { success: refreshSucceeded });
    // Restore verified evidence freshness after settlement. A disconnected
    // observer retains the last confirmed busy state until it can read again.
    const currentDashboardState = dashboard
      ? dashboardObservationPresentation(dashboard, observationRecency(dashboard)).state
      : null;
    const stableState = [currentDashboardState, globalState?.state, previousGlobalState?.state]
      .find((state) => state && state !== "updating");
    const candidateState = dashboardReadFailed ? "stale" : stableState ?? "insufficient";
    setGlobalState(
      candidateState,
      {
        companionReachable: dashboard
          ? dashboard.mode !== "demo"
          : previousGlobalState?.companionReachable ?? false,
      },
    );
  }
}

async function cancelLocalAnalysis() {
  if (!localRefreshInProgress || localRefreshCancelRequested) return;
  localRefreshCancelRequested = true;
  localRefreshObservationWait?.abort();
  updateLocalActionButtons();
  try {
    await localClient.cancelRefresh();
    showConnectionNotice({
      titleKey: "refresh.cancelRequestedTitle",
      copyKey: "refresh.cancelRequestedCopy",
      kind: "info",
    });
  } catch {
    localRefreshCancelRequested = false;
    showConnectionNotice({
      titleKey: "refresh.cancelUnavailableTitle",
      copyKey: "refresh.cancelUnavailableCopy",
      kind: "warning",
      showCheck: true,
    });
  }
  updateLocalActionButtons();
}

async function checkLocalSetup() {
  if (localActionBusy) return;
  localActionBusy = true;
  for (const selector of [
    "#connection-check",
    "#companion-check",
    "#setup-check-again",
  ]) {
    const button = $(selector);
    if (button) setLocalizedText(button, "refresh.progress.checking");
  }
  updateLocalActionButtons();
  try {
    await loadLocalDashboard();
  } finally {
    localActionBusy = false;
    setProductText($("#connection-check"), "Check again");
    setProductText($("#companion-check"), "Check this page again");
    setProductText($("#setup-check-again"), "Check again");
    updateLocalActionButtons();
  }
}

let nativeEvidenceReloadInFlight = false;
let nativeEvidenceReloadPending = false;

/**
 * Re-read the companion's fragments after the native shell finished a refresh.
 *
 * Status observation owns refresh publication in every surface. This legacy
 * shell signal also supports evidence published outside the refresh pipeline.
 */
async function reloadLocalEvidenceAfterNativeRefresh() {
  // A refresh started from this page re-renders on its own completion, and a
  // second overlapping read would only race it.
  if (nativeEvidenceReloadInFlight || localRefreshInProgress || localActionBusy) {
    nativeEvidenceReloadPending = true;
    return;
  }
  nativeEvidenceReloadInFlight = true;
  nativeEvidenceReloadPending = false;
  try {
    await loadQuickResultDashboard();
  } catch (error) {
    const failure = dashboardReadFailure(error);
    if (failure) showConnectionNotice({titleKey:"allowance.simple.loadFailed",copyKey:failure.copyKey,copyValues:{code:failure.code},kind:"error",showCheck:true});
    if (failure) setGlobalState("stale", {companionReachable:true});
  } finally {
    nativeEvidenceReloadInFlight = false;
    if (nativeEvidenceReloadPending && !localActionBusy && !localRefreshInProgress) void reloadLocalEvidenceAfterNativeRefresh();
  }
}

function runsInsideElectronDashboard() {
  return globalThis.window?.usageMonitorDesktop?.version === "v1";
}

// Legacy shell events are observations only. The companion owns startup and
// periodic requests, including when no renderer exists.
function handleElectronAutomaticRefresh(event) {
  const detail = event?.detail;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)
      || Object.getPrototypeOf(detail) !== Object.prototype
      || Reflect.ownKeys(detail).length !== 1
      || !Object.hasOwn(detail, "mode")
      || !["quick", "detailed"].includes(detail.mode)) return;
  void observeOverviewPublication();
}

/**
 * Look one fixed code up in a copy map.
 *
 * Own properties only: a code is an untrusted string, and plain member access
 * would otherwise resolve "constructor" or "toString" to something inherited
 * and render it as copy.
 */
function fixedCopy(map, code) {
  return typeof code === "string" && Object.hasOwn(map, code)
    ? (map === LOCAL_COMPANION_ERROR_COPY ? t(map[code]) : map[code])
    : null;
}

const LOCAL_COMPANION_ERROR_COPY = {
  unsupported_media_type: "refresh.error.unsupported_media_type",
  request_too_large: "refresh.error.request_too_large",
  invalid_json: "refresh.error.invalid_json",
  invalid_request: "refresh.error.invalid_request",
  refresh_in_progress: "refresh.error.refresh_in_progress",
  refresh_not_authorized: "refresh.error.refresh_not_authorized",
  refresh_cancel_not_authorized: "refresh.error.refresh_cancel_not_authorized",
  refresh_not_running: "refresh.error.refresh_not_running",
  app_record_checkpoint_unavailable: "refresh.error.app_record_checkpoint_unavailable",
  diagnostic_note_not_authorized: "refresh.error.diagnostic_note_not_authorized",
  diagnostic_note_not_recorded: "refresh.error.diagnostic_note_not_recorded",
  loopback_required: "refresh.error.loopback_required",
  host_not_allowed: "refresh.error.host_not_allowed",
  method_not_allowed: "refresh.error.method_not_allowed",
  not_found: "refresh.error.not_found",
  internal_error: "refresh.error.internal_error",
  request_failed: "refresh.error.request_failed",
};

/**
 * Turn one failure into honest copy plus a quotable reference.
 *
 * The reference is fresh WebCrypto randomness, never derived from anything the
 * user typed or the service returned. The page waits for the local diagnostics
 * POST and claims the write only after the companion confirms it; when that
 * confirmation fails, the reference remains visible without the write claim,
 * and a companion that answered yet refused the note is reported to the
 * console rather than blending into an unreachable one.
 * The sentence itself always comes from a map written here or from the caller's
 * fallback; no server string is ever rendered.
 */
async function describeFailure({ surface, error, messages = {}, fallback, workUsage }) {
  const reference = createDiagnosticReference();
  const code = diagnosticErrorCode(error?.code);
  const requestId = serviceRequestId(error?.requestId);
  // Some codes classify a family rather than a cause. When the failure knows
  // which member it was, the reference must be able to say so, or looking it
  // up later answers no more than the sentence already did. An absent or
  // malformed detail stays empty and none is filed; the companion accepts only
  // the closed vocabulary it owns, so one it does not recognise is refused
  // aloud through the path below rather than written.
  const detailCode = diagnosticErrorCode(error?.detail?.code);
  let writtenToLocalLog = false;
  // "recorded" | "refused" | "unreachable": a companion that answered without
  // confirming this exact reference refused the note, which is a contract
  // break between this build and the companion; only a request that never got
  // an answer counts as unreachable.
  let localNote = "unreachable";
  try {
    const recorded = await localClient.recordDiagnosticNote({
      reference,
      surface: diagnosticSurface(surface),
      code,
      detail: detailCode,
      requestId,
      ...(workUsage === undefined ? {} : { workUsage })
    });
    writtenToLocalLog = recorded?.status === "recorded"
      && recorded.reference === reference;
    localNote = writtenToLocalLog ? "recorded" : "refused";
  } catch (noteError) {
    // The reference remains useful even when the local companion cannot write
    // its diagnostics log. Do not claim a write that was not confirmed.
    localNote = typeof noteError?.status === "number"
      ? "refused"
      : "unreachable";
  }
  if (localNote === "refused") {
    // Never silent: a running companion that declines this page's own note
    // means the reference shown below cannot be looked up later.
    console.error(
      `Diagnostic note ${reference} was refused by the local companion.`
    );
  }
  const fixedExplanation = fixedCopy(messages, code)
    ?? fixedCopy(LOCAL_COMPANION_ERROR_COPY, code);
  const explanation = fixedExplanation ?? fallback;
  const validatedTrailer = diagnosticReferenceSentence({
    reference,
    requestId,
    writtenToLocalLog,
  });
  const trailer = validatedTrailer === "" ? "" : t(
    writtenToLocalLog
      ? (requestId === "" ? "refresh.diagnostic.logged" : "refresh.diagnostic.serviceLogged")
      : "refresh.diagnostic.reference",
    { reference, requestId },
  );
  return Object.freeze({
    reference,
    requestId,
    code,
    localNote,
    text: trailer === "" ? explanation : `${explanation} ${trailer}`
  });
}

$("#refresh-button").addEventListener("click", () => {
  if (localRefreshInProgress) void cancelLocalAnalysis();
  else void requestRefresh();
});
$("#setup-refresh").addEventListener("click", () => {
  void requestRefresh({ detailed: true });
});
$("#cancel-refresh").addEventListener("click", cancelLocalAnalysis);
$("#open-installed-app").addEventListener("click", openInstalledApp);
$("#connection-check").addEventListener("click", checkLocalSetup);
$("#companion-check").addEventListener("click", checkLocalSetup);
$("#setup-check-again").addEventListener("click", checkLocalSetup);
window.addEventListener("usagemonitor:automatic-refresh", handleElectronAutomaticRefresh);
window.addEventListener("usagemonitor:local-evidence-updated", () => {
  void reloadLocalEvidenceAfterNativeRefresh();
});
$("#demo-button").addEventListener("click", showDemoDashboard);
$("#usage-zoom-in").addEventListener("click", () => {
  if (!dashboard) return;
  zoomUsageTimeline(selectedUsagePoints(dashboard), 1 / TIMELINE_BUTTON_ZOOM_STEP);
});
$("#usage-zoom-out").addEventListener("click", () => {
  if (!dashboard) return;
  zoomUsageTimeline(selectedUsagePoints(dashboard), TIMELINE_BUTTON_ZOOM_STEP);
});
$("#usage-pan-back").addEventListener("click", () => {
  if (!dashboard) return;
  panUsageTimeline(selectedUsagePoints(dashboard), -.2);
});
$("#usage-pan-forward").addEventListener("click", () => {
  if (!dashboard) return;
  panUsageTimeline(selectedUsagePoints(dashboard), .2);
});
$("#usage-reset-zoom").addEventListener("click", () => {
  resetUsageTimelineViewport();
  resetTimelineViewport();
  if (dashboard) { renderUsageTimeline(dashboard); renderTimeline(dashboard); }
});

$("#timeline-zoom-in").addEventListener("click", () => {
  if (!dashboard) return;
  zoomTimeline(selectedTimelinePoints(dashboard).points, 1 / TIMELINE_BUTTON_ZOOM_STEP);
});
$("#timeline-zoom-out").addEventListener("click", () => {
  if (!dashboard) return;
  zoomTimeline(selectedTimelinePoints(dashboard).points, TIMELINE_BUTTON_ZOOM_STEP);
});
$("#timeline-pan-back").addEventListener("click", () => {
  if (!dashboard) return;
  panTimeline(selectedTimelinePoints(dashboard).points, -.2);
});
$("#timeline-pan-forward").addEventListener("click", () => {
  if (!dashboard) return;
  panTimeline(selectedTimelinePoints(dashboard).points, .2);
});
$("#timeline-reset-zoom").addEventListener("click", () => {
  resetTimelineViewport();
  if (dashboard) { renderUsageTimeline(dashboard); renderTimeline(dashboard); }
});
// The exact-windows pager (owner-directed, 2026-08-08). The page index is
// clamped inside the renderer, so a click at either end can never leave the
// row set.
$("#residual-page-prev").addEventListener("click", () => {
  residualTablePage -= 1;
  renderResidualInspectionTable();
});
$("#residual-page-next").addEventListener("click", () => {
  residualTablePage += 1;
  renderResidualInspectionTable();
});
// Same clamped-in-renderer rule for the Allowance page's reset-estimate table.
$("#weekly-table-prev").addEventListener("click", () => {
  weeklyTablePage -= 1;
  renderWeeklyTablePage();
});
$("#weekly-table-next").addEventListener("click", () => {
  weeklyTablePage += 1;
  renderWeeklyTablePage();
});
$("#divergence-page-prev").addEventListener("click", () => {
  divergenceTablePage -= 1;
  renderDivergencePeriodPage();
});
$("#divergence-page-next").addEventListener("click", () => {
  divergenceTablePage += 1;
  renderDivergencePeriodPage();
});
$("#accounting-model-page-prev").addEventListener("click", () => {
  accountingModelsTablePagination.page -= 1;
  renderAccountingModels(
    dashboard === null ? null : accountingPeriod(dashboard),
  );
});
$("#accounting-model-page-next").addEventListener("click", () => {
  accountingModelsTablePagination.page += 1;
  renderAccountingModels(
    dashboard === null ? null : accountingPeriod(dashboard),
  );
});
$("#cache-switch-page-prev").addEventListener("click", () => {
  cacheSwitchTablePagination.page -= 1;
  renderAccountingCacheSwitchDetails(
    dashboard === null ? null : accountingPeriod(dashboard)?.cacheSwitchImpact,
  );
});
$("#cache-switch-page-next").addEventListener("click", () => {
  cacheSwitchTablePagination.page += 1;
  renderAccountingCacheSwitchDetails(
    dashboard === null ? null : accountingPeriod(dashboard)?.cacheSwitchImpact,
  );
});
$("#cache-continuity-page-prev").addEventListener("click", () => {
  cacheContinuityTablePagination.page -= 1;
  renderAccountingCacheContinuityDetails(
    dashboard === null
      ? null
      : accountingPeriod(dashboard)?.cacheContinuityImpact,
  );
});
$("#cache-continuity-page-next").addEventListener("click", () => {
  cacheContinuityTablePagination.page += 1;
  renderAccountingCacheContinuityDetails(
    dashboard === null
      ? null
      : accountingPeriod(dashboard)?.cacheContinuityImpact,
  );
});
$("#usage-group-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-group]");
  if (!button || !dashboard || !usageGroupingsForRange().includes(button.dataset.group)) return;
  activeUsageGrouping = button.dataset.group;
  for (const control of $("#usage-group-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  resetUsageTimelineViewport();
  resetTimelineViewport();
  renderUsageTimeline(dashboard);
  renderTimeline(dashboard);
});
$("#allowance-window-controls")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-window-minutes]");
  if (!button || !dashboard || button.disabled) return;
  const windowMinutes = Number(button.dataset.windowMinutes);
  if (![CODEX_FIVE_HOUR_ALLOWANCE_MINUTES, CODEX_WEEKLY_ALLOWANCE_MINUTES]
      .includes(windowMinutes)) return;
  activeAllowanceWindowMinutes = windowMinutes;
  renderWeekly(dashboard);
});
$("#weekly-plan-select")?.addEventListener("change", (event) => {
  if (!dashboard || !dashboard.weekly.planPopulations.some(
    (population) => population.planType === event.target.value,
  )) return;
  allowancePage?.close();
  activeWeeklyPlanType = event.target.value;
  timelineSeriesMemo = null;
  renderComparison(dashboard);
  resetTimelineViewport();
  renderUsageTimeline(dashboard);
  renderTimeline(dashboard);
  renderWeekly(dashboard);
});
$("#weekly-span-control").addEventListener("input", (event) => {
  if (!dashboard) return;
  activeWeeklyMinimumObservedSpanPp = Math.min(99, Math.max(0, Number(event.target.value)));
  renderWeekly(dashboard);
});

document.addEventListener("click", (event) => {
  const current = activeInformationPopover;
  if (!current) return;
  if (current.button.contains(event.target) || current.popover.contains(event.target)) return;
  closeInformationPopover();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !activeInformationPopover) return;
  event.preventDefault();
  closeInformationPopover({ restoreFocus: true });
});
window.addEventListener("resize", () => {
  if (dashboard && !$("#timeline").inert) scheduleUsageTimelineRender();
  const current = activeInformationPopover;
  if (current) positionInformationPopover(current.popover, current.button);
});
let allowanceChartResizeFrame = null;
window.addEventListener("resize", () => {
  if (allowanceChartResizeFrame !== null) cancelAnimationFrame(allowanceChartResizeFrame);
  allowanceChartResizeFrame = requestAnimationFrame(() => {
    allowanceChartResizeFrame = null;
    const shell = $("#weekly-chart");
    if (!dashboard || !shell || shell.hidden || !shell.getClientRects().length) return;
    const data = allowanceWindowView(dashboard);
    const history = allowanceHistoryChartModel(data);
    drawChart(shell, renderAllowanceHistoryChart(history, data.allowanceWindowDurationMinutes));
  });
});
document.addEventListener("scroll", () => {
  const current = activeInformationPopover;
  if (current) positionInformationPopover(current.popover, current.button);
}, true);

const workUsageView = mountWorkUsageView({
  root: document.querySelector("#projects"), t, renderInformationLabel: informationLabel,
  localProgressEvents,
  sharedReporting: true, reportingWindow: null, compact: true,
  controlsRoot: document.querySelector(".usage-simple-controls"),
  onFilters(filters) {
    usageSimpleFilters = filters;
    renderUsageSimpleModels(usageSimpleModelAccounting, usageSimpleModelsUnavailable);
  },
  async onDiagnostic({ code, workUsage }) {
    const result = await describeFailure({
      surface: "local_refresh", error: { code }, fallback: t("workUsage.error"), workUsage,
    });
    if (result.localNote !== "recorded") throw new Error("work_usage_diagnostic_failed");
    return { reference: result.reference, localNote: result.localNote };
  },
  onSummary(totals, context) {
    if (!context?.filtered) {
      usageSimpleCounts = totals;
      usageSimpleCountsContext = context;
    }
    updateUsageSimpleCounts();
  },
});
for (const button of document.querySelectorAll("[data-usage-metric]")) {
  button.addEventListener("click", () => {
    usageSimpleMetric = button.dataset.usageMetric;
    for (const option of document.querySelectorAll("[data-usage-metric]")) {
      option.setAttribute("aria-pressed", String(option === button));
    }
    workUsageView.setMetric(usageSimpleMetric);
    renderAccountingModels(usageSimpleModelAccounting, { unavailable: usageSimpleModelsUnavailable });
  });
}
const modelPerformance = mountModelPerformance({
  root: document.querySelector("#performance"), client: localClient,
  localProgressEvents,
  t, locale: () => localization.formatLocale(), sharedReporting: true, reportingWindow: null,
});
window.addEventListener("usagemonitor:locale-change", () => {
  modelPerformance.render();
  renderReportingPeriod();
});
mountReportingPeriodDismissal(document);
document.querySelector("#reporting-period-controls").addEventListener("click", event => {
  const button = event.target.closest("button[data-period]");
  if (button) reportingPeriod.select(button.dataset.period);
});
renderReportingPeriod();
const dashboardReportPreloader = createDashboardReportPreloader({ reports: [workUsageView, modelPerformance] });

/**
 * Switch measurement views without rebuilding their data or fetching again.
 *
 * Each destination has one level-1 switch of underline tabs in its page header.
 * A level-1 view may contain a level-2 switch (smaller tabs at the top of its
 * container). The two levels never toggle the same element: level 1 toggles the
 * view's containers, level 2 toggles panels inside one container. Filters stay
 * as labeled controls in `.view-filters`; a view lists the filters it shows.
 */
function mountDashboardLayout({ documentRef, windowRef }) {
  const dialog = documentRef.querySelector("#overview-details-dialog");
  const content = documentRef.querySelector("#overview-details-content");
  const title = documentRef.querySelector("#overview-details-title");
  const main = documentRef.querySelector("#main");
  if (!dialog || !content || !main) return;
  const usage = documentRef.querySelector("#usage-screen");
  const analysisEntries = ["#usage-composition-details", "#usage-cache-details"].map(selector => documentRef.querySelector(selector)).filter(Boolean);
  if (usage && analysisEntries.length === 2) {
    const actions = documentRef.createElement("div");
    actions.className = "usage-simple-analysis-actions";
    actions.dataset.dashboardPage = "usage";
    actions.append(...analysisEntries); usage.append(actions);
  }
  const view = (key, panels, filters = "") => ({ key, panels, filters });
  const planFilter = "#weekly-plan-control, #weekly-plan-note";
  const configurations = [
    { id: "usage", page: "usage", level: 1, root: "#usage-screen", views: [
      view("projects", "#accounting-summary, #projects"),
      view("threads", "#accounting-summary, #projects"),
      view("models", "#accounting-summary, .usage-simple-models-panel"),
    ] },
  ];
  const levelOne = configurations.filter(config => config.level === 1);
  const selections = new Map(configurations.map(config => [config.id, config.views[0].key]));
  let disclosure = null;
  let opener = null;
  let focusedViewButton = null;
  let dialogPage = null;
  let frame = null;

  const restore = () => {
    if (disclosure?.isConnected) {
      disclosure.append(...content.childNodes);
      disclosure.open = false;
    } else content.replaceChildren();
    disclosure = null;
    delete dialog.dataset.disclosure;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
    dialogPage = null;
  };
  documentRef.addEventListener("click", event => {
    const summary = event.target.closest?.("summary");
    const details = summary?.parentElement;
    if (details?.tagName !== "DETAILS" || !main.contains(details) || details.closest?.("dialog")
        || typeof dialog.showModal !== "function") return;
    event.preventDefault();
    disclosure = details;
    dialog.dataset.disclosure = details.id;
    opener = summary;
    dialogPage = documentRef.body.dataset.dashboardPage;
    title.textContent = summary.textContent.trim();
    // Move the actual nodes so incoming measurements/retry handlers remain live.
    content.append(...[...details.children].filter(child => child !== summary));
    details.open = false;
    dialog.showModal();
  });
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", restore);
  documentRef.querySelector("#overview-details-close")?.addEventListener("click", () => dialog.close());
  const refreshNotice = documentRef.querySelector("#connection-notice");
  documentRef.addEventListener("click", event => {
    if (refreshNotice?.open && !refreshNotice.contains(event.target)) refreshNotice.open = false;
  });
  documentRef.addEventListener("keydown", event => {
    if (event.key === "Escape" && refreshNotice?.open) {
      refreshNotice.open = false;
      refreshNotice.querySelector("summary").focus({ preventScroll: true });
    }
  });
  documentRef.addEventListener("focusin", event => {
    focusedViewButton = event.target.dataset?.dashboardView ? event.target : null;
  });

  const choose = (config, key) => {
    // An unknown view falls back to the destination's default.
    const next = config.views.some(item => item.key === key) ? key : config.views[0].key;
    selections.set(config.id, next);
    if (config.id === "usage" && next !== "models") {
      workUsageView.setGrouping(next === "threads" ? "thread" : "project");
    }
    syncViews(config);
    schedule();
    // Hidden charts retain their data. Redraw at the revealed width, without a fetch.
    windowRef.requestAnimationFrame(() => windowRef.dispatchEvent(new Event("resize")));
  };
  documentRef.addEventListener("usagemonitor:page-view", event => {
    const config = levelOne.find(item => item.page === event.detail?.page);
    if (config) choose(config, event.detail.view);
    const usageDetailRoutes = { composition: "#usage-composition-details", diagnostics: "#usage-cache-details" };
    if (event.detail?.page === "usage" && usageDetailRoutes[event.detail.view]) {
      windowRef.requestAnimationFrame(() => {
        documentRef.querySelector(`${usageDetailRoutes[event.detail.view]} > summary`)?.click();
      });
    }
  });

  const buildBar = config => {
    const bar = documentRef.createElement("div");
    bar.className = `dashboard-view-switch ${config.level === 1
      ? "dashboard-view-tabs" : "dashboard-subview-tabs"}`;
    bar.dataset.viewSwitch = config.id;
    bar.setAttribute("role", "group");
    for (const { key } of config.views) {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.dataset.dashboardView = key;
      button.addEventListener("click", () => choose(config, key));
      bar.append(button);
    }
    bar.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const buttons = [...bar.querySelectorAll("button")];
      const index = buttons.indexOf(event.target);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next].focus();
      choose(config, buttons[next].dataset.dashboardView);
    });
    return bar;
  };

  const syncViews = config => {
    const root = documentRef.querySelector(config.root);
    const header = config.level === 1
      ? documentRef.querySelector(`.dashboard-page-header[data-dashboard-page="${config.page}"]`)
      : null;
    const host = config.id === "usage" ? documentRef.querySelector("#usage-simple-views")
      : config.level === 1 ? header
      : config.host ? root?.querySelector(config.host) : root;
    if (!root || !host) return;
    let bar = host.querySelector(`:scope > [data-view-switch="${config.id}"]`);
    if (!bar) {
      bar = buildBar(config);
      if (config.level === 1) {
        host.insertBefore(bar, host.querySelector(":scope > .dashboard-page-status"));
      } else host.insertBefore(bar, host.firstChild);
    }
    const label = t(config.level === 1 ? "dashboard.views.label" : `dashboard.views.${config.label}`);
    if (bar.getAttribute("aria-label") !== label) bar.setAttribute("aria-label", label);
    const selection = selections.get(config.id);
    let visible = false;
    // An element may belong to several views (Usage totals sit above the
    // project, model and composition views), so it is active when the selected
    // view lists it, whatever the other views list.
    const active = new Set();
    const listed = new Set();
    for (const { key, panels, filters } of config.views) {
      const button = [...bar.children].find(child => child.dataset.dashboardView === key);
      const text = t(`dashboard.views.${key}`);
      if (button.textContent !== text) button.textContent = text;
      const pressed = String(key === selection);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
      const elements = [...root.querySelectorAll(panels),
        ...(filters ? root.querySelectorAll(filters) : [])];
      for (const element of elements) {
        listed.add(element);
        if (key === selection) active.add(element);
      }
      if (key === selection) {
        visible = [...root.querySelectorAll(panels)].some(panel => !panel.hidden);
      }
    }
    for (const element of listed) {
      element.toggleAttribute("data-page-view-inactive", !active.has(element));
    }
    let empty = host.querySelector(":scope > .dashboard-view-empty");
    if (config.level === 1) {
      const anchor = config.emptyAfter ? root.querySelector(config.emptyAfter) : header;
      empty = anchor?.nextElementSibling?.classList.contains("dashboard-view-empty")
        ? anchor.nextElementSibling : null;
      if (!empty && anchor) {
        empty = documentRef.createElement("p");
        empty.className = "dashboard-view-empty annotation";
        empty.setAttribute("role", "status");
        // Tracked by the page switch so it never shows on another destination.
        empty.dataset.dashboardPage = config.page;
        anchor.after(empty);
      }
    } else if (!empty) {
      empty = documentRef.createElement("p");
      empty.className = "dashboard-view-empty annotation";
      empty.setAttribute("role", "status");
      host.insertBefore(empty, bar.nextSibling);
    }
    if (empty) {
      const emptyText = t(isElectronDashboard(documentRef, windowRef) && !dashboard
        ? dashboardReadFailed ? "dashboard.unavailable.dashboardTitle" : "refresh.progress.saved"
        : "dashboard.views.empty");
      if (empty.textContent !== emptyText) empty.textContent = emptyText;
      if (empty.hidden !== visible) empty.hidden = visible;
    }
    if (focusedViewButton && !focusedViewButton.isConnected
        && documentRef.body.dataset.dashboardPage === config.page) {
      [...bar.children].find(button => button.dataset.dashboardView === selection)?.focus({ preventScroll: true });
    }
  };

  // Pages keep their natural size; a tall page scrolls (see styles.css).
  const sync = () => {
    frame = null;
    for (const config of configurations) syncViews(config);
    const page = documentRef.body.dataset.dashboardPage;
    if (dialog.open && (dialogPage !== page || !disclosure?.isConnected || disclosure.hidden)) dialog.close();
  };
  const schedule = () => {
    if (frame === null) frame = windowRef.requestAnimationFrame(sync);
  };
  if (windowRef.MutationObserver) {
    const changes = new windowRef.MutationObserver(schedule);
    changes.observe(main, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["hidden", "class", "open"] });
    changes.observe(documentRef.body, { attributes: true,
      attributeFilter: ["data-dashboard-page", "class"] });
  }
  windowRef.addEventListener("usagemonitor:locale-change", schedule);
  // Build the switches now so the page switch below tracks every element that
  // belongs to a destination (including each level-1 empty-view message).
  for (const config of configurations) syncViews(config);
  schedule();
}

// Mount the view switches first: they create elements that belong to a
// destination, and the page switch reads those at mount time. A `#page/view`
// hash then finds the view switch already listening.
const allowancePage = mountAllowancePage({ documentRef: document, t, formatMoney: formatApiMoney,
  formatDetailInstant: value => new Intl.DateTimeFormat(localization.locale(), {year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,timeZoneName:'short'}).format(new Date(value)),
  formatPp, formatPercent, formatInstant: value => formatChartTimestamp(new Date(value).toISOString()),
  formatReset: value => {
    const hours = (Date.parse(value) - Date.now()) / 3_600_000;
    return hours > 0 ? `${formatAllowanceDuration(hours)} ${t("allowance.simple.untilReset")}`
      : t("allowance.resetPassed");
  },
  selectTime: value => trendsHorizonView?.select(value, true),
  stopPlayback: () => trendsHorizonView?.stop(),
  retry: () => dashboardReadFailed ? void loadLocalDashboard() : $("#refresh-button").click(),
});
// Mount after the page controllers: pause publishes its initial state
// synchronously, and updateLocalActionButtons reads allowancePage immediately.
const localRefreshPause = mountLocalRefreshPause({
  button: $("#pause-refresh-button"), summary: $("#sidebar-pause-summary"),
  bridge: runsInsideElectronDashboard() ? globalThis.usageMonitorDesktop : null,
  translate: t,
  onChange: state => {
    localRefreshPaused = state.paused;
    localRefreshPauseReady = state.ready && !state.busy;
    if (state.paused && reindexAutoContinueTimer !== null) {
      clearTimeout(reindexAutoContinueTimer); reindexAutoContinueTimer = null;
    }
    updateLocalActionButtons();
  },
  onError: () => showConnectionNotice({ titleKey: "refresh.pauseFailed", copyKey: "refresh.pauseFailedCopy", kind: "error" }),
});
window.addEventListener("usagemonitor:locale-change", () => localRefreshPause.repaint?.());
window.addEventListener("beforeunload", () => localRefreshPause.teardown());

if (window.usageMonitorDesktop?.version === "v1") {
  void mountSettingsPage({ documentRef: document, windowRef: window, localizer: localization });
}
const desktopXReader = mountDesktopXReader({ documentRef: document, windowRef: window, translate: t, locale: localization.locale() });
mountDashboardLayout({ documentRef: document, windowRef: window });
mountDashboardNavigation({
  documentRef: document,
  windowRef: window,
});

async function bootstrapDashboard() {
  startOverviewPublicationPolling();
  renderDesktopEvidenceState("loading");
  renderSharedInstallerJourney(document, {
    formatLocale: getFormattingLocale(),
    translateMessage: t,
  });
  updateLocalActionButtons();
  await loadLocalDashboard();
  if (localProgressEvents.current()) void observeOverviewPublication();
}

// Observe publication, never trigger refresh here. The companion alone owns
// the configured collection clock, including when the renderer is hidden.
let overviewPublicationReadPending = false;

async function observeOverviewPublication() {
  if (localProgressEvents.current()?.refresh?.publication === "running") return;
  if (overviewPublicationReadPending || localRefreshObserverActive
      || localRefreshSubmissionPending || localActionBusy
      || dashboard?.mode === "demo" || !localAnalysisAllowed()) return;
  overviewPublicationReadPending = true;
  const eventCursor = localProgressEvents.cursor();
  const statusVersion = localRefreshStatusVersion;
  try {
    const status = await localClient.refreshStatus();
    if (statusVersion !== localRefreshStatusVersion) return;
    accountingRebuildDeferral = status?.refresh?.result?.accountingRebuildDeferred ?? null;
    const scheduleError = typeof status?.overviewSchedule?.errorCode === "string"
      ? status.overviewSchedule.errorCode : null;
    const previousScheduleError = lastOverviewScheduleError;
    lastOverviewScheduleError = scheduleError;
    if (scheduleError && scheduleError !== previousScheduleError) {
      showConnectionNotice({ titleKey: "refresh.schedule.failedTitle", copyKey: "refresh.schedule.failedCopy", kind: "warning" });
    }
    const refresh = status?.refresh;
    if (refresh?.running || ["running", "cancelling"].includes(refresh?.status)) {
      await requestRefresh({ observeOnly: true, initialRefresh: refresh });
      return;
    }
    localRefreshInProgress = false;
    localRefreshCancelRequested = false;
    updateLocalActionButtons();
    if (previousScheduleError && !scheduleError) setSidebarRefreshSummary(null);
    const receipt = refresh?.finishedAt
      ? `${refresh.refreshId ?? ""}:${refresh.quickResultAt ?? ""}:${refresh.finishedAt}` : null;
    if (receipt && receipt !== lastObservedRefreshPublication) {
      lastObservedRefreshPublication = receipt;
      if (await loadLocalDashboard() !== false) {
        if (["failed", "cancelled"].includes(refresh.status)) {
          setSidebarRefreshSummary(refresh.status === "cancelled" ? "refresh.sidebar.cancelled" : "refresh.sidebar.failed");
          if (refresh.status === "failed") showConnectionNotice({ titleKey: "refresh.failedTitle", copyKey: "refresh.failedCopy", kind: "error" });
        } else {
          setSidebarRefreshSummary(refresh.status === "degraded" ? "refresh.sidebar.partial" : "refresh.stage.complete", { success: refresh.status === "succeeded" });
          publishRefreshResultNotice(refresh);
        }
      }
    }
    if (scheduleError) setSidebarRefreshSummary("refresh.schedule.failedTitle");
  } catch {
    // A transport read cannot establish that the controller's work failed.
    if (localRefreshInProgress) setSidebarRefreshSummary("refresh.stage.reconnecting");
  } finally {
    overviewPublicationReadPending = false;
    if (localProgressEvents.cursor() !== eventCursor && localProgressEvents.connection() === "connected")
      void observeOverviewPublication();
  }
}

function startOverviewPublicationPolling() {
  if (overviewPublicationPollingStarted) return;
  overviewPublicationPollingStarted = true;
  localProgressEvents.subscribe(event => {
    if (event.connection !== "connected") {
      if (localRefreshInProgress) setSidebarRefreshSummary("refresh.stage.reconnecting");
      return;
    }
    void observeOverviewPublication();
  });
  const resume = () => {
    if (document.visibilityState === "hidden") return;
    if (dashboard) observationFreshnessClock.update(dashboard);
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  window.addEventListener("pagehide", event => { if (!event.persisted) localProgressEvents.close(); });
}

bootstrapDashboard();
