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

test("refresh notice popover stays inside the viewport", () => {
  const start = source.indexOf("function refreshNoticeLeft(");
  const end = source.indexOf("\n}\n\nfunction positionRefreshNotice", start) + 2;
  assert.ok(start >= 0 && end > start, "refresh notice positioning helper is present");
  const context = {};
  runInNewContext(`${source.slice(start, end)}
    result = [
      refreshNoticeLeft({ right: 143.42 }, 420, 958),
      refreshNoticeLeft({ right: 900 }, 420, 958),
      refreshNoticeLeft({ right: 950 }, 420, 958),
      refreshNoticeLeft({ right: 300 }, 368, 400),
    ];`, context);
  assert.deepEqual([...context.result], [16, 480, 522, 16]);
});

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
        localProgressEvents: { current: () => null, cursor: () => 0, connection: () => "connected" },
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

      runInNewContext(pollingSource, context);
      await context.observeOverviewPublication();

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


test("publication events have one owner and returning to the foreground only updates age", async () => {
  const timers = [];
  const documentListeners = [];
  const windowListeners = [];
  const ages = [];
  let reads = 0;
  const subscriptions = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const context = {
    dashboard: { mode: "local" }, localRefreshInProgress: false,
    localRefreshObserverActive: false, localRefreshSubmissionPending: false,
    localRefreshStatusVersion: 0, localActionBusy: false,
    overviewPublicationPollingStarted: false, lastObservedRefreshPublication: null, lastOverviewScheduleError: null,
    localProgressEvents: { subscribe: fn => subscriptions.push(fn), current: () => null, cursor: () => 0,
      connection: () => "connected", close() {} },
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
  assert.equal(timers.length, 0);
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(documentListeners.map(item => item.name), ["visibilitychange"]);
  assert.deepEqual(windowListeners.map(item => item.name), ["focus", "pagehide"]);
  subscriptions[0]({ connection: "connected" });
  windowListeners[0].callback();
  documentListeners[0].callback();
  assert.equal(reads, 1, "focus and tab switches cannot overlap a pending status read");
  assert.equal(ages.length, 2, "evidence ages update immediately on return");
  release({ refresh: { status: "idle", running: false } });
  await new Promise(setImmediate);
  assert.equal(timers.length, 0, "no periodic publication polling is scheduled");
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
    localProgressEvents: { current: () => null, cursor: () => 0, connection: () => "connected" },
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
