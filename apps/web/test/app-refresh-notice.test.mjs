import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { translate } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("let overviewPublicationReadPending = false;");
const end = source.indexOf("\nbootstrapDashboard();", start);
assert.ok(start >= 0 && end > start, "overview publication polling function is present");
const pollingSource = source.slice(start, end);

test("overview refresh failures use localized safe copy instead of internal codes", async () => {
  for (const locale of ["en-US", "zh-Hans", "es"]) {
    for (const statusName of ["failed", "cancelled"]) {
      const timers = [];
      const notices = [];
      const code = "codex_rollout_generation_ambiguous";
      const context = {
        dashboard: { mode: "local" },
        localRefreshInProgress: false,
        localRefreshObserverActive: false,
        localRefreshStatusVersion: 0,
        localRefreshSubmissionPending: false,
        localActionBusy: false,
        localRefreshCancelRequested: false,
        overviewPublicationPollingStarted: false,
        lastObservedRefreshPublication: null, lastOverviewScheduleError: null,
        updateLocalActionButtons() {},
        setSidebarRefreshSummary() {},
        document: { addEventListener() {} },
        localAnalysisAllowed: () => true,
        localClient: {
          refreshStatus: async () => ({
            refresh: {
              finishedAt: `2026-10-19T10:00:0${statusName === "failed" ? "1" : "2"}.000Z`,
              status: statusName,
              failureCode: code,
              errorCode: "local_index_schema_newer",
            },
          }),
        },
        loadLocalDashboard: async () => true,
        showConnectionNotice: (notice) => notices.push(notice),
        publishRefreshResultNotice() {},
        t: (key, values) => translate(key, values, locale),
        window: {
          addEventListener() {},
          setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return timers.length;
          },
        },
      };

      runInNewContext(`${pollingSource}\nstartOverviewPublicationPolling();`, context);
      assert.equal(timers[0].delay, 2000);
      await timers[0].callback();

      assert.equal(notices.length, statusName === "cancelled" ? 0 : 1);
      if (statusName === "cancelled") continue;
      assert.equal(notices[0].titleKey, "refresh.failedTitle");
      assert.equal(translate(notices[0].titleKey, {}, locale), translate("refresh.failedTitle", {}, locale));
      assert.equal(translate(notices[0].copyKey, {}, locale), translate("refresh.failedCopy", {}, locale));
      assert.equal(notices[0].kind, "error");
      assert.equal(translate(notices[0].copyKey, {}, locale).includes(code), false);
      assert.equal(translate(notices[0].copyKey, {}, locale).includes("local_index_schema_newer"), false);
    }
  }
});


test("publication polling has one owner and foreground recovery only rereads state and age", async () => {
  const timers = [];
  const documentListeners = [];
  const windowListeners = [];
  const ages = [];
  let reads = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const context = {
    dashboard: { mode: "local" }, localRefreshInProgress: false,
    localRefreshObserverActive: false, localRefreshSubmissionPending: false,
    localRefreshStatusVersion: 0, localActionBusy: false,
    overviewPublicationPollingStarted: false, lastObservedRefreshPublication: null, lastOverviewScheduleError: null,
    localAnalysisAllowed: () => true, updateLocalActionButtons() {},
    localClient: { refreshStatus: async () => { reads += 1; return pending; } },
    observationFreshnessClock: { update: data => ages.push(data) },
    document: { visibilityState: "visible", addEventListener: (name, callback) => documentListeners.push({ name, callback }) },
    window: {
      addEventListener: (name, callback) => windowListeners.push({ name, callback }),
      setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    },
  };
  runInNewContext(`${pollingSource}\nstartOverviewPublicationPolling(); startOverviewPublicationPolling();`, context);
  assert.equal(timers.length, 1);
  assert.deepEqual(documentListeners.map(item => item.name), ["visibilitychange"]);
  assert.deepEqual(windowListeners.map(item => item.name), ["focus"]);
  const scheduledPoll = timers[0].callback();
  windowListeners[0].callback();
  documentListeners[0].callback();
  assert.equal(reads, 1, "focus and tab switches cannot overlap a pending status read");
  assert.equal(ages.length, 2, "evidence ages update immediately on return");
  release({ refresh: { status: "idle", running: false } });
  await scheduledPoll;
  assert.equal(timers.length, 2, "the existing observation cadence remains singular");
});


test("scheduler failure is distinct from unreadable status and is deduplicated until recovery", async () => {
  const notices = [];
  const summaries = [];
  let failure = "overview_refresh_schedule_failed";
  let disconnected = false;
  const context = {
    dashboard: { mode: "local" }, localRefreshInProgress: false,
    localRefreshObserverActive: false, localRefreshSubmissionPending: false,
    localRefreshStatusVersion: 0, localActionBusy: false,
    overviewPublicationPollingStarted: false, lastObservedRefreshPublication: null,
    lastOverviewScheduleError: null, localAnalysisAllowed: () => true,
    updateLocalActionButtons() {}, showConnectionNotice: notice => notices.push(notice),
    setSidebarRefreshSummary: key => summaries.push(key),
    localClient: { refreshStatus: async () => {
      if (disconnected) throw new Error("synthetic transport failure");
      return { refresh: { status: "idle", running: false }, overviewSchedule: { errorCode: failure } };
    } },
  };
  runInNewContext(pollingSource, context);
  await context.observeOverviewPublication();
  await context.observeOverviewPublication();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].titleKey, "refresh.schedule.failedTitle");
  assert.equal(notices[0].kind, "warning");
  assert.equal(summaries.at(-1), "refresh.schedule.failedTitle");
  disconnected = true;
  await context.observeOverviewPublication();
  assert.equal(notices.length, 1, "transport failure cannot create a business failure notice");
  assert.equal(context.lastOverviewScheduleError, failure, "a missing read cannot establish scheduler recovery");
  disconnected = false;
  failure = null;
  await context.observeOverviewPublication();
  assert.equal(context.lastOverviewScheduleError, null);
  assert.equal(summaries.at(-1), null);
});
