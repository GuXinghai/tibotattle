import { mountExampleInsights } from "./feature-insights.js";
import { mountExampleWeek } from "./feature-week.js";
// Entry point for the public website.
//
// The website introduces the Windows app, offers its verified installer, and
// renders the live community allowance and daily activity series. All three
// work with no local companion. Everything that needs the companion — the
// personal dashboard, contribution preparation and upload, hosted sign-in,
// participant deletion — is deliberately absent here and lives in the Windows
// app's own window, so this page can never show a control that cannot work.
//
// Every rendering routine below is imported, not copied: the install card and
// the community view are the same modules the in-app dashboard entry uses.

import { wirePaceDemo } from "./feature-tour.js";
import {
  COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY,
  PublicCommunityClient,
  normalizeCommunityDailySeries,
  projectCommunityDailyPayloadForCache,
} from "./community-data.js";
import { createCommunityRefresh } from "./community-refresh.js";
import { createLastKnownGoodStore } from "./last-known-good.js";
import {
  renderCommunityAllowanceSection,
  renderCommunityDailySeries,
} from "./community-view.js";
import {
  renderInstallerAssurance,
  renderInstallerJourney,
} from "./install-cta.js";
import { createBrowserLocalization, translate } from "./localization.js";
import {
  getFormattingLocale,
  setFormattingLocale,
  setMessageLocale,
} from "./ui-format.js";

const localization = createBrowserLocalization();
setFormattingLocale(localization.formatLocale());
setMessageLocale(localization.locale());
// Resolve generated copy from the document language at render time. The
// browser localizer updates that attribute before emitting its locale-change
// event, which keeps a rerender from observing a stale closure during a live
// picker change.
const t = (key, values = {}) => translate(
  key,
  values,
  typeof document === "undefined"
    ? localization.locale()
    : document.documentElement?.lang ?? localization.locale(),
);

const $ = (selector) => document.querySelector(selector);
const publicErrorCodePattern =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;
const publicRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let lastCommunityDailyPayload = null;
let lastCommunityAllowancePayload = null;
let lastCommunityDailyFailure = null;
// Retained-evidence provenance for whatever each section is currently
// showing, or null when it is showing a live answer.
let lastCommunityDailyCache = null;
let lastCommunityAllowanceCache = null;
let communityDailySettled = false;
// The allowance range selection: 30 calendar days or null for the whole
// published series. Re-rendering is purely client-side — the year window is
// already fetched — so a range change never issues a request.
let allowanceRangeDays = 30;
let allowanceView = "aggregate";
let allowanceDialogReturnFocus = null;
const communityClient = new PublicCommunityClient();
// One request feeds both community views, so one cache serves both. The
// projection stores only what this reader already validated and rendered, and
// the schema identity refuses a payload written by a deploy whose contracts
// differ from this one's.
const communityPayloadCache = createLastKnownGoodStore({
  key: "community-daily",
  schemaVersion: COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY,
  project: projectCommunityDailyPayloadForCache,
});

/**
 * The age a view states is computed when it renders, not when the payload was
 * published to it: a range, view or language change re-renders minutes later,
 * and an age frozen at publish time would then be a wrong one.
 */
function currentCacheProvenance(cache) {
  const fetchedMs = Date.parse(cache?.fetchedAt ?? "");
  return Number.isFinite(fetchedMs)
    ? { fetchedAt: cache.fetchedAt, ageMs: Math.max(0, Date.now() - fetchedMs) }
    : null;
}

function publicErrorCode(candidate) {
  return typeof candidate === "string" && publicErrorCodePattern.test(candidate)
    ? candidate
    : "";
}

function publicRequestId(candidate) {
  return typeof candidate === "string" && publicRequestIdPattern.test(candidate)
    ? candidate
    : "";
}

/**
 * The compact hero link describes the reader-facing daily-series state, not
 * transport health. The detailed safe state copy stays in the disclosure.
 */
export function setPublicDailyPresentation(documentRef, state, {
  failed = false,
  cached = false,
} = {}) {
  const hero = documentRef.querySelector("#community-daily-hero");
  // Retained evidence is neither live nor absent, so it gets its own compact
  // label. It never claims the series is unavailable while figures from it are
  // on the page, and it never claims the series is available either.
  const presentation = cached
    ? [t(state === "published"
      ? "community.daily.seriesCached"
      : state === "none_published"
        ? "community.daily.noneYet"
        : "community.daily.seriesUnavailable"), false]
    : failed || state === "service_unavailable"
      ? [t("community.daily.seriesUnavailable"), false]
      : {
        published: [t("community.daily.seriesAvailable"), true],
        none_published: [t("community.daily.noneYet"), false],
      }[state] ?? [t("community.daily.seriesUnavailable"), false];
  if (hero) hero.textContent = presentation[0];
  // The hero dot's green heartbeat means "live evidence loaded", so it keys
  // off the same presentation truthiness as the detailed disclosure.
  const heroLink = hero?.closest?.(".community-inline") ?? null;
  if (heroLink) {
    heroLink.setAttribute("data-live", presentation[1] ? "true" : "false");
  }
}

export function renderPublicInstallerJourney(documentRef = document) {
  // Static Electron links are generated from the reviewed plan.
  if (documentRef.querySelector('meta[name="usage-monitor-electron-stable"]')?.content === "true") return null;
  const select = (selector) => documentRef.querySelector(selector);
  const release = renderInstallerJourney(documentRef, {
    compactDetails: true,
    showUnavailableAction: true,
    showReleaseLinks: false,
    formatLocale: getFormattingLocale(),
    translateMessage: t,
  });
  const checksumCopy = select("#installer-sha256-copy");
  if (checksumCopy) {
    if (release) checksumCopy.dataset.checksum = release.sha256;
    else delete checksumCopy.dataset.checksum;
  }
  const checksumFallback = select("#installer-sha256");
  if (checksumFallback) {
    checksumFallback.textContent = release?.sha256 ?? "";
    checksumFallback.hidden = true;
  }
  renderInstallerAssurance(documentRef, release);
  const headerDownloadLabel = select("#header-download-label");
  if (headerDownloadLabel) {
    headerDownloadLabel.dataset.i18n = "installer.headerDownload";
    headerDownloadLabel.textContent = t("installer.headerDownload");
  }
  return release;
}

const installerChecksumPattern = /^[a-f0-9]{64}$/u;

export async function copyInstallerChecksum(checksum, clipboard) {
  if (
    typeof checksum !== "string"
    || !installerChecksumPattern.test(checksum)
    || typeof clipboard?.writeText !== "function"
  ) return false;
  try {
    await clipboard.writeText(checksum);
    return true;
  } catch {
    return false;
  }
}

function selectInstallerChecksum() {
  const checksum = $(`#installer-sha256`);
  const selection = window.getSelection?.();
  const range = document.createRange?.();
  if (!checksum || !selection || !range) return;
  checksum.hidden = false;
  range.selectNodeContents(checksum);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderInstallerChecksumCopyState(state = "idle") {
  const button = $(`#installer-sha256-copy`);
  const label = $(`#installer-sha256-copy-label`);
  const status = $(`#installer-sha256-copy-status`);
  const fallback = $(`#installer-sha256`);
  if (!button || !label || !status || !fallback) return;
  const presentation = {
    copied: ["installer.sha256.copied", "installer.sha256.copySuccess"],
    failed: ["installer.sha256.copy", "installer.sha256.copyFailure"],
    idle: ["installer.sha256.copy", null],
  }[state] ?? ["installer.sha256.copy", null];
  button.dataset.copyState = state;
  label.dataset.i18n = presentation[0];
  label.textContent = t(presentation[0]);
  status.textContent = presentation[1] ? t(presentation[1]) : "";
  fallback.hidden = state !== "failed"
    || !installerChecksumPattern.test(fallback.textContent);
}

function wireInstallerChecksumCopy() {
  const button = $(`#installer-sha256-copy`);
  if (!button || button.dataset.copyBound === "true") return;
  button.dataset.copyBound = "true";
  renderInstallerChecksumCopyState("idle");
  button.addEventListener("click", async () => {
    button.disabled = true;
    const copied = await copyInstallerChecksum(
      button.dataset.checksum ?? "",
      navigator.clipboard,
    );
    button.disabled = false;
    if (!copied) selectInstallerChecksum();
    renderInstallerChecksumCopyState(copied ? "copied" : "failed");
  });
}

function renderCommunityAllowanceResult(payload, cache = lastCommunityAllowanceCache) {
  const container = $("#community-allowance-result");
  if (!container) return "service_unavailable";
  const state = renderCommunityAllowanceSection({
    documentRef: document,
    container,
    sourceContainer: $("#community-allowance-source-summary"),
    headingNode: $("#community-allowance-heading"),
    heroNode: $("[data-i18n=\"community.allowance.heroCopy\"], [data-i18n=\"community.allowance.heroCopyLegacy\"]"),
    stateNode: $("#community-allowance-state"),
    payload,
    rangeDays: allowanceRangeDays,
    view: allowanceView,
    cache: currentCacheProvenance(cache),
  });
  updateAllowanceDialogAvailability(state);
  if ($("#community-allowance-dialog")?.open) {
    renderCommunityAllowanceDialogResult(payload, cache);
  }
  return state;
}

function renderCommunityAllowanceDialogResult(payload, cache = lastCommunityAllowanceCache) {
  const container = $("#community-allowance-dialog-result");
  if (!container) return "service_unavailable";
  return renderCommunityAllowanceSection({
    documentRef: document,
    container,
    payload,
    rangeDays: allowanceRangeDays,
    view: allowanceView,
    cache: currentCacheProvenance(cache),
  });
}

function allowanceDialogSupported() {
  const dialog = $("#community-allowance-dialog");
  return typeof dialog?.showModal === "function"
    && typeof dialog?.close === "function";
}

function updateAllowanceDialogAvailability(state) {
  const launcher = $("#community-allowance-expand");
  const dialog = $("#community-allowance-dialog");
  // Empty/stale tabs stay inside an already-open dialog: users can switch back,
  // and the close action retains its visible return-focus target.
  if (dialog?.open) return;
  const available = state === "published" && allowanceDialogSupported();
  if (launcher) launcher.hidden = !available;
}

function syncAllowanceRangeControls() {
  for (const controls of document.querySelectorAll("[data-allowance-view-controls]")) {
    for (const candidate of controls.querySelectorAll("button[data-allowance-view]")) {
      const active = candidate.dataset.allowanceView === allowanceView;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    }
  }
  for (const controls of document.querySelectorAll("[data-allowance-range-controls]")) {
    for (const candidate of controls.querySelectorAll("button[data-range-days]")) {
      const candidateRange = candidate.dataset.rangeDays === ""
        ? null
        : Number(candidate.dataset.rangeDays);
      const active = candidateRange === allowanceRangeDays;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-pressed", String(active));
    }
  }
}

function selectAllowanceRange(value) {
  const rangeDays = value === "" ? null : Number(value);
  if (rangeDays !== null && rangeDays !== 30) return;
  allowanceRangeDays = rangeDays;
  syncAllowanceRangeControls();
  if (communityDailySettled) {
    renderCommunityAllowanceResult(lastCommunityAllowancePayload);
  }
}

function wireAllowanceRangeControls() {
  for (const controls of document.querySelectorAll("[data-allowance-view-controls]")) {
    if (controls.dataset.allowanceViewBound === "true") continue;
    controls.dataset.allowanceViewBound = "true";
    controls.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button[data-allowance-view]");
      if (!button || !controls.contains(button)
          || !["aggregate", "plans", "models"].includes(button.dataset.allowanceView)) return;
      allowanceView = button.dataset.allowanceView;
      syncAllowanceRangeControls();
      if (communityDailySettled) renderCommunityAllowanceResult(lastCommunityAllowancePayload);
    });
  }
  for (const controls of document.querySelectorAll("[data-allowance-range-controls]")) {
    if (controls.dataset.allowanceRangeBound === "true") continue;
    controls.dataset.allowanceRangeBound = "true";
    controls.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button[data-range-days]");
      if (!button || !controls.contains(button)) return;
      selectAllowanceRange(button.dataset.rangeDays);
    });
  }
  syncAllowanceRangeControls();
}

function wireAllowanceDialog() {
  const launcher = $("#community-allowance-expand");
  const dialog = $("#community-allowance-dialog");
  const closeButton = $("#community-allowance-dialog-close");
  if (!launcher || !dialog || !closeButton || !allowanceDialogSupported()) {
    if (launcher) launcher.hidden = true;
    return;
  }
  launcher.addEventListener("click", () => {
    if (!communityDailySettled || dialog.open) return;
    renderCommunityAllowanceDialogResult(lastCommunityAllowancePayload);
    syncAllowanceRangeControls();
    allowanceDialogReturnFocus = launcher;
    dialog.showModal();
    document.documentElement.classList.add("community-chart-modal-open");
    closeButton.focus();
  });
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    dialog.close();
  });
  dialog.addEventListener("close", () => {
    document.documentElement.classList.remove("community-chart-modal-open");
    if (!allowanceDialogReturnFocus?.hidden) {
      allowanceDialogReturnFocus?.focus?.();
    }
    allowanceDialogReturnFocus = null;
  });
}

function renderCommunityDailyResult({
  payload, failure = null, cache = null, refreshAllowance = true,
}) {
  if (refreshAllowance) renderCommunityAllowanceResult(lastCommunityAllowancePayload);
  const container = $("#community-daily-result");
  const state = renderCommunityDailySeries({
    documentRef: document,
    container,
    stateNode: $("#community-daily-state"),
    payload,
    cache: currentCacheProvenance(cache),
    // Null until the hero host exists, which keeps the figures in place on any
    // page that does not offer one.
    summaryContainer: $("#community-contribution-summary"),
  });
  $("#community").dataset.communityState = state;
  setPublicDailyPresentation(document, state, {
    failed: failure !== null,
    cached: cache !== null,
  });
  if (failure === null) return state;
  // Only the fixed, content-free identifiers the service itself returned are
  // repeated back. This page files no diagnostic note: there is no local
  // companion here to file one with.
  const code = publicErrorCode(failure?.code);
  const requestId = publicRequestId(failure?.requestId);
  // With retained figures on screen the renderer has already led with the
  // notice that says so; repeating "could not be loaded" above a rendered
  // chart would read as a contradiction. The service's own identifiers are
  // still repeated back either way.
  const sentences = cache === null ? [t("community.daily.failedLoad")] : [];
  if (code !== "") sentences.push(t("community.reportedCause", { code: code.replace(/_/gu, " ") }));
  if (requestId !== "") sentences.push(t("community.serviceReference", { reference: requestId }));
  if (sentences.length === 0) return state;
  const note = document.createElement("p");
  note.className = "annotation";
  note.textContent = sentences.join(" ");
  container.append(note);
  return state;
}

function publishCommunityDailySeries({ payload, failure }) {
  // Three states, resolved once for both views: a live answer (remembered
  // here whether or not it changed anything, so the recorded moment means
  // "last confirmed live"), the payload this browser already holds, or an
  // honest nothing. Nothing is inferred on any of the three paths.
  const resolved = communityPayloadCache.resolve({ payload, failure });
  const cache = resolved.state === "cached"
    ? { fetchedAt: resolved.fetchedAt }
    : null;
  // Only a live answer may repeat itself unchanged. Retained figures re-render
  // because their stated age has moved on, and an age that stops moving is a
  // false claim about how old they are.
  if (resolved.state === "live" && communityDailySettled
      && lastCommunityDailyCache === null
      && resolved.failure === null && lastCommunityDailyFailure === null
      && JSON.stringify(resolved.payload) === JSON.stringify(lastCommunityDailyPayload)) return;
  // A null payload renders the fixed "service unavailable" state, which is
  // separate from a service that answered and has published nothing yet. Keep
  // the settled failure too so a language switch rerenders its safe copy.
  const nextAllowance = selectCommunityAllowancePayload(
    lastCommunityAllowancePayload, resolved.payload,
  );
  // Provenance travels with the observation it describes: when the
  // activity-only rule keeps the previous allowance answer, that answer keeps
  // its own freshness label rather than inheriting this response's.
  const nextAllowanceCache = nextAllowance === resolved.payload
    ? cache
    : lastCommunityAllowanceCache;
  const refreshAllowance = !communityDailySettled
    || nextAllowance !== lastCommunityAllowancePayload
    || nextAllowanceCache !== lastCommunityAllowanceCache;
  lastCommunityDailyPayload = resolved.payload;
  lastCommunityAllowancePayload = nextAllowance;
  lastCommunityAllowanceCache = nextAllowanceCache;
  lastCommunityDailyCache = cache;
  lastCommunityDailyFailure = resolved.failure;
  communityDailySettled = true;
  renderCommunityDailyResult({
    payload: resolved.payload, failure: resolved.failure, cache, refreshAllowance,
  });
}

// An activity-only fallback is not proof that the allowance was withdrawn.
// Keep the two observations separate: no old activity/revision is copied into
// a newer response, and the next confirmed empty/updating answer clears it.
export function selectCommunityAllowancePayload(previous, payload) {
  if (payload?.allowanceReadState === "temporarily_unavailable"
      && ["published", "none_published"].includes(normalizeCommunityDailySeries(payload).state)) return previous;
  return payload;
}

if (typeof document !== "undefined") {
  wirePaceDemo(document, t);
  // The tour's cache section shows the illustration first and swaps in the
  // measured curve if the hosted lane has published one. The read is the same
  // public daily endpoint the rest of the page already uses.
  mountExampleInsights(document, t, async () => {
    const payload = await communityClient.communityDaily({ nowMs: Date.now() });
    return payload?.cacheRetention ?? null;
  });
  mountExampleWeek(document.querySelector("#week-demo"), t);
  renderPublicInstallerJourney();
  wireInstallerChecksumCopy();
  wireAllowanceRangeControls();
  wireAllowanceDialog();
  const refresh = createCommunityRefresh({
    read: options => communityClient.communityDaily(options),
    publish: publishCommunityDailySeries,
    visible: () => document.visibilityState !== "hidden",
  });
  refresh.start();
  document.addEventListener("visibilitychange", () => refresh.visibilityChanged());
  window.addEventListener("pagehide", () => refresh.stop());
  window.addEventListener("pageshow", () => refresh.start());
  window.addEventListener("tibotattle:locale-change", (event) => {
    setFormattingLocale(event.detail?.formatLocale ?? localization.formatLocale());
    setMessageLocale(event.detail?.locale ?? localization.locale());
    renderPublicInstallerJourney();
    renderInstallerChecksumCopyState(
      $("#installer-sha256-copy")?.dataset.copyState ?? "idle",
    );
    if (communityDailySettled) {
      renderCommunityDailyResult({
        payload: lastCommunityDailyPayload,
        failure: lastCommunityDailyFailure,
        cache: lastCommunityDailyCache,
      });
    }
    localization.localizeTree();
  });
}
