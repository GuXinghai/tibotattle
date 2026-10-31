/** Small, presentation-only tray surface. Accounting stays in the companion. */
import { CODEX_FIVE_HOUR_ALLOWANCE_MINUTES, CODEX_WEEKLY_ALLOWANCE_MINUTES,
  isPrimaryCodexQuotaWindow, LocalCompanionClient } from "./data-client.js";
import { createBrowserLocalization, translate } from "./localization.js";
import { observationRecency } from "./dashboard-ui.js";
import { formatAge, formatNumber, setFormattingLocale, setMessageLocale } from "./ui-format.js";
import { normalizeOverviewWorkload } from "./overview-workload.js";

export const TRAY_POPUP_SCHEMA_VERSION = "electron-tray-popup-v2";
export const TRAY_POPUP_ACTIONS = Object.freeze(["open"]);
const DEFAULT_ALLOWANCE_STALE_AFTER_SECONDS = 30 * 60;
const TRAY_POPUP_MAIN_STATUSES = new Set(["starting", "analyzing", "fresh", "stale", "insufficient", "unavailable"]);
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, maximum = 80) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    return "";
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) return "";
  }
  return value;
}

function nonNegativeNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function boundedPercent(value) {
  const number = nonNegativeNumber(value);
  return number === null || number > 100 ? null : number;
}

function instantMs(value) {
  if (value instanceof Date) {
    const ms = value.valueOf();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const NORMAL_CODEX_ALLOWANCE_DURATIONS = Object.freeze([
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
]);
const NORMAL_CODEX_ALLOWANCE_DURATION_SET = new Set(NORMAL_CODEX_ALLOWANCE_DURATIONS);

/**
 * The popup has its own small admission boundary because the generic dashboard
 * normalizer preserves several display-only quota fields independently. Keep
 * the compact lanes aligned with the native reader: an inconsistent or
 * overlong provider window is unavailable, never rounded into a percentage.
 */
function canonicalAllowanceInstant(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : null;
}

function normalCodexAllowanceCandidate(window, nowMs) {
  const durationMinutes = window?.durationMinutes;
  if (!isObject(window)
      || !isPrimaryCodexQuotaWindow(window)
      || !NORMAL_CODEX_ALLOWANCE_DURATION_SET.has(durationMinutes)) return null;
  const usedPercent = boundedPercent(window.usedPercent);
  const remainingPercent = boundedPercent(window.remainingPercent);
  const observedAt = canonicalAllowanceInstant(window.observedAt);
  const resetAt = canonicalAllowanceInstant(window.resetAt);
  const observedAtMs = instantMs(observedAt);
  const resetAtMs = instantMs(resetAt);
  if (usedPercent === null || remainingPercent === null
      || Math.abs((usedPercent + remainingPercent) - 100) > 0.001
      || observedAtMs === null || resetAtMs === null
      || observedAtMs > nowMs
      || resetAtMs <= observedAtMs
      || resetAtMs - observedAtMs > durationMinutes * 60_000) return null;
  // Unknown legacy slot values remain admissible but can never outrank the
  // provider's explicit primary slot. The bounded form exists only for a
  // deterministic internal tie-break and never reaches the rendered DTO.
  const slot = boundedText(window.slot, 80);
  return Object.freeze({
    durationMinutes,
    preferredSlot: slot === "primary",
    remainingPercent,
    observedAt,
    observedAtMs,
    resetAt,
    resetAtMs,
    status: ["live", "stale"].includes(window.status) ? window.status : "unavailable",
    stableKey: [slot, resetAt, observedAt, String(remainingPercent)].join("\0"),
  });
}

function normalCodexAllowanceCandidateWins(candidate, prior) {
  if (prior === undefined) return true;
  if (candidate.preferredSlot !== prior.preferredSlot) return candidate.preferredSlot;
  if (candidate.observedAtMs !== prior.observedAtMs) {
    return candidate.observedAtMs > prior.observedAtMs;
  }
  return candidate.stableKey < prior.stableKey;
}

/**
 * Select exactly one structurally valid normal Codex lane for each duration.
 * This deliberately precedes freshness display checks: a stale explicit
 * primary does not authorize silently borrowing a sibling lane.
 */
function selectNormalCodexAllowanceLanes(data, nowMs) {
  const selected = new Map();
  for (const window of Array.isArray(data?.quotaWindows) ? data.quotaWindows : []) {
    const candidate = normalCodexAllowanceCandidate(window, nowMs);
    if (candidate === null) continue;
    const prior = selected.get(candidate.durationMinutes);
    if (normalCodexAllowanceCandidateWins(candidate, prior)) {
      selected.set(candidate.durationMinutes, candidate);
    }
  }
  return Object.freeze(NORMAL_CODEX_ALLOWANCE_DURATIONS
    .map((durationMinutes) => selected.get(durationMinutes))
    .filter((candidate) => candidate !== undefined));
}


function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createTrayPopupProjection(data = {}, { now = Date.now() } = {}) {
  const nowMs = instantMs(now) ?? Date.now();
  const staleAfterSeconds = nonNegativeNumber(data?.freshness?.staleAfterSeconds)
    ?? DEFAULT_ALLOWANCE_STALE_AFTER_SECONDS;
  const recency = observationRecency({ ...data, freshness: { ...data?.freshness, staleAfterSeconds } }, nowMs);
  const source = data?.freshness?.status ?? data?.state;
  const status = ["offline", "demo"].includes(source) ? source
    : recency.status === "current" ? "live" : recency.status === "stale" ? "stale" : "insufficient";
  const freshness = { status, latestObservedAt: recency.latestObservedAt, ageSeconds: recency.ageSeconds, staleAfterSeconds };
  const selected = selectNormalCodexAllowanceLanes(data, nowMs);
  // Preserve the existence of a reported but invalid lane; absence alone never means zero.
  const reported = new Set((Array.isArray(data?.quotaWindows) ? data.quotaWindows : [])
    .filter(x => isObject(x) && isPrimaryCodexQuotaWindow(x) && NORMAL_CODEX_ALLOWANCE_DURATION_SET.has(x.durationMinutes))
    .map(x => x.durationMinutes));
  const allowances = NORMAL_CODEX_ALLOWANCE_DURATIONS.filter(x => reported.has(x)).map(durationMinutes => {
    const lane = selected.find(x => x.durationMinutes === durationMinutes);
    const live = status === "live" && lane?.status === "live"
      && nowMs - lane.observedAtMs <= staleAfterSeconds * 1000 && lane.resetAtMs > nowMs;
    return { durationMinutes, state: live ? "available"
      : lane && (status === "stale" || lane.status === "stale" || nowMs - lane.observedAtMs > staleAfterSeconds * 1000 || lane.resetAtMs <= nowMs) ? "stale" : "unknown",
      remainingPercent: live ? Math.round(lane.remainingPercent) : null,
      resetAt: live ? lane.resetAt : null,
      resetInSeconds: live ? (lane.resetAtMs - nowMs) / 1000 : null };
  });
  // The dashboard's canonical normalizer is the sole admission for both rates.
  const workload = normalizeOverviewWorkload(data?.workload);
  const generatedAt = instantMs(workload?.generatedAt);
  const timely = generatedAt !== null && generatedAt <= nowMs
    && nowMs - generatedAt <= Math.min(15 * 60, staleAfterSeconds) * 1000
    && !["offline", "demo"].includes(status);
  const recent = (value, windowMinutes) => {
    const available = timely && value?.state === "available" && nonNegativeNumber(value.usdPerHour) !== null;
    return { windowMinutes, state: available ? "available" : "unknown",
      usdPerHour: available ? value.usdPerHour : null,
      level: available && ["light", "medium", "heavy"].includes(value.level) ? value.level : null,
      inferred: available && value.inferred === true };
  };
  return deepFreeze({ schemaVersion: TRAY_POPUP_SCHEMA_VERSION, state: status, freshness, allowances,
    workload: { current: recent(workload?.current, 15), trend: recent(workload?.trend, 60) } });
}

export function requestTrayPopupAction(bridge, action) {
  if (arguments.length !== 2 || !TRAY_POPUP_ACTIONS.includes(action) || typeof bridge?.requestAction !== "function") return false;
  try { bridge.requestAction(action); return true; } catch { return false; }
}

function defaultText(key, values = {}) { return translate(key, values); }
function textNode(documentRef, value, className) {
  const node = documentRef.createElement("span"); node.textContent = value;
  if (className) node.className = className;
  return node;
}
function setElementText(documentRef, id, value) {
  const node = documentRef.getElementById(id); if (node) node.textContent = value;
}
function headerFreshnessCopy(freshness, t, mainStatus = null) {
  if (mainStatus === "starting") return t("electron.trayCompact.starting");
  if (mainStatus === "analyzing") return t("electron.trayPopover.headerUpdating");
  if (freshness.status === "live" && freshness.ageSeconds !== null) return t("electron.trayPopover.headerUpdated", { age: formatAge(freshness.ageSeconds) });
  return t("electron.trayCompact." + (freshness.status === "stale" ? "stale" : freshness.status === "offline" ? "offline" : freshness.status === "demo" ? "demo" : "noObservation"));
}
function resetCountdown(seconds, t, numberFormatter) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return t("electron.trayPopover.resetUnavailable");
  }
  const totalMinutes = Math.max(1, Math.floor(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes % (24 * 60) / 60);
  const minutes = totalMinutes % 60;
  const count = (value) => numberFormatter(value, { maximumFractionDigits: 0 });
  if (days > 0) {
    return t("electron.trayPopover.resetDaysHours", {
      days: count(days),
      hours: count(hours),
    });
  }
  if (hours > 0) {
    return t("electron.trayPopover.resetHoursMinutes", {
      hours: count(hours),
      minutes: count(minutes),
    });
  }
  return t("electron.trayPopover.resetMinutes", { minutes: count(minutes) });
}

function mainTrayPresentation(model) {
  try {
    if (!isObject(model)
        || !TRAY_POPUP_MAIN_STATUSES.has(model.status)
        || typeof model.refreshEnabled !== "boolean") return null;
    return Object.freeze({
      status: model.status,
      // Native never enables a refresh while it is starting or analyzing,
      // even if a malformed event tries to claim otherwise.
      refreshEnabled: model.refreshEnabled
        && !["starting", "analyzing"].includes(model.status),
    });
  } catch {
    return null;
  }
}


export function renderTrayPopup(documentRef, projection, {
  t = defaultText, bridge = globalThis.window?.usageMonitorTrayPopover,
  mainModel = null, numberFormatter = formatNumber,
} = {}) {
  if (!documentRef || typeof documentRef.getElementById !== "function") throw new TypeError("A document is required to render the tray popup.");
  const presentation = mainTrayPresentation(mainModel);
  const list = documentRef.getElementById("allowance-lanes");
  const rows = projection.allowances;
  if (list) {
    list.replaceChildren();
    // A wholly unknown pool needs one honest status, not two empty quota shells.
    for (const row of rows.some(x => x.state === "available") ? rows : []) {
      const article = documentRef.createElement("div"); article.className = "tray-allowance";
      const label = t(row.durationMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES ? "electron.trayCompact.fiveHour" : "electron.trayCompact.weekly");
      const value = documentRef.createElement("strong");
      value.textContent = row.state === "available" ? numberFormatter(row.remainingPercent, { maximumFractionDigits: 0 }) + "%" : "—";
      const reset = row.state === "available" ? t("electron.trayCompact.reset", { time: resetCountdown(row.resetInSeconds, t, numberFormatter) })
        : t(row.state === "stale" ? "electron.trayCompact.stale" : "electron.trayCompact.unknown");
      article.append(textNode(documentRef, label), value, textNode(documentRef, reset, "tray-reset"));
      list.append(article);
    }
  }
  const unavailable = documentRef.getElementById("allowance-unavailable");
  if (unavailable) {
    unavailable.hidden = rows.some(x => x.state === "available");
    unavailable.textContent = t("electron.trayCompact." + (projection.state === "offline" ? "offline" : rows.some(x => x.state === "stale") || projection.state === "stale" ? "stale" : "unknown"));
  }
  for (const [name, field] of [["short", "current"], ["trend", "trend"]]) {
    const item = projection.workload[field];
    setElementText(documentRef, `tray-${name}-level`, item.level ? t(`workload.level.${item.level}`) : "—");
    setElementText(documentRef, `tray-${name}-value`, item.state === "available"
      ? (field === "trend" ? "≈ " : "") + t("electron.trayCompact.money", { value: numberFormatter(item.usdPerHour, { maximumFractionDigits: 2 }) }) + (item.inferred ? " *" : "") : "—");
  }
  const freshnessCopy = headerFreshnessCopy(projection.freshness, t, presentation?.status);
  setElementText(documentRef, "tray-popup-freshness", freshnessCopy);
  setElementText(documentRef, "tray-popup-live", freshnessCopy);
  setElementText(documentRef, "tray-popup-open-label", t("electron.trayCompact.open"));
  for (const button of documentRef.querySelectorAll?.("[data-action]") ?? []) {
    button.disabled = button.dataset.action !== "open" || typeof bridge?.requestAction !== "function";
  }
  return projection;
}

export function observeTrayPopupContentHeight({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
} = {}) {
  const root = documentRef?.getElementById?.("tray-popup");
  const bridge = windowRef?.usageMonitorTrayPopover;
  const ResizeObserverImpl = windowRef?.ResizeObserver ?? globalThis.ResizeObserver;
  if (!root || typeof bridge?.reportContentHeight !== "function"
      || typeof ResizeObserverImpl !== "function") return () => {};
  let lastReportedHeight = null;
  const report = () => {
    let height;
    try {
      height = Math.ceil(root.getBoundingClientRect().height);
    } catch {
      return;
    }
    if (!Number.isSafeInteger(height) || height < 1 || height === lastReportedHeight) {
      return;
    }
    lastReportedHeight = height;
    try {
      bridge.reportContentHeight(height);
    } catch {
      // The bridge can disappear while this transient renderer closes.
    }
  };
  let observer;
  try {
    observer = new ResizeObserverImpl(report);
    observer.observe(root);
    report();
  } catch {
    try {
      observer?.disconnect?.();
    } catch {
      // A failed observer setup has no usable lifecycle to preserve.
    }
    return () => {};
  }
  return () => {
    try {
      observer.disconnect();
    } catch {
      // The page can already be gone when Electron closes its transient view.
    }
  };
}

export async function bootstrapTrayPopup({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  client = new LocalCompanionClient(),
} = {}) {
  if (!documentRef || !windowRef) return null;
  const localization = createBrowserLocalization({ windowRef, documentRef });
  setFormattingLocale(localization.formatLocale());
  setMessageLocale(localization.locale());
  const bridge = windowRef.usageMonitorTrayPopover;
  const requiresMainModel = typeof bridge?.onModel === "function";
  let mainModel = null;
  let data = null;
  let loadSequence = 0;
  let loadInFlight = null;
  let loadPending = false;
  const hasNativeVisibility = typeof bridge?.getVisibility === "function";
  const isVisible = () => {
    if (hasNativeVisibility) {
      try {
        return bridge.getVisibility() === true;
      } catch {
        // A native visibility read that fails cannot prove that the popup is
        // visible, so keep the transient surface closed until the host says so.
        return false;
      }
    }
    return documentRef.visibilityState !== "hidden";
  };
  const render = () => {
    const projection = createTrayPopupProjection(data ?? {});
    renderTrayPopup(documentRef, projection, {
      t: localization.t,
      bridge,
      mainModel,
    });
    return projection;
  };
  const loadData = async () => {
    const sequence = ++loadSequence;
    try {
      const next = await client.load();
      if (sequence === loadSequence) data = next;
    } catch {
      // A transport failure cannot leave a prior successful snapshot looking live.
      if (sequence === loadSequence) data = { ...data, state: "offline", freshness: { ...data?.freshness, status: "offline" } };
    }
    if (sequence !== loadSequence) return;
    render();
    // Main-process smoke and UI checks wait for the first bounded companion
    // read rather than mistaking the loading shell for a populated surface.
    documentRef.documentElement?.setAttribute("data-tray-popup-ready", "true");
  };
  const requestLoad = () => {
    if (!isVisible()) {
      loadPending = true;
      return Promise.resolve(null);
    }
    if (loadInFlight !== null) {
      loadPending = true;
      return loadInFlight;
    }
    loadPending = false;
    const promise = loadData();
    loadInFlight = promise;
    void promise.finally(() => {
      if (loadInFlight !== promise) return;
      loadInFlight = null;
      if (loadPending && isVisible()) {
        loadPending = false;
        void requestLoad();
      }
    }).catch(() => {});
    return promise;
  };
  render();
  const stopContentHeightObserver = observeTrayPopupContentHeight({
    windowRef,
    documentRef,
  });
  windowRef.addEventListener?.("pagehide", stopContentHeightObserver, { once: true });
  for (const button of documentRef.querySelectorAll?.("[data-action]") ?? []) {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      const action = button.dataset.action;
      requestTrayPopupAction(bridge, action);
    });
  }
  if (requiresMainModel) {
    bridge.onModel((nextModel) => {
      // Lifecycle copy updates immediately, without starting hidden reads.
      mainModel = mainTrayPresentation(nextModel);
      render();
      // The model is a lifecycle signal only. A hidden popup does not issue
      // requests; visibility/opening below coalesces one refresh instead.
      loadPending = true;
      if (isVisible()) void requestLoad();
    });
  }
  const onVisibilityChange = () => {
    if (isVisible()) {
      // A visible transition represents a fresh popup presentation, even if
      // no companion model event arrived while the window was hidden.
      loadPending = true;
      void requestLoad();
    } else {
      loadPending = true;
    }
  };
  documentRef.addEventListener?.("visibilitychange", onVisibilityChange);
  if (typeof bridge?.onVisibility === "function") {
    bridge.onVisibility(() => onVisibilityChange());
  }
  windowRef.addEventListener?.("usagemonitor:locale-change", () => {
    setMessageLocale(localization.locale());
    setFormattingLocale(localization.formatLocale());
    render();
  });
  await requestLoad();
  return data;
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  void bootstrapTrayPopup();
}
