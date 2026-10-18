import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { translate } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("function startOverviewPublicationPolling() {");
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
          setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return timers.length;
          },
        },
      };

      runInNewContext(`${pollingSource}\nstartOverviewPublicationPolling();`, context);
      assert.equal(timers[0].delay, 2000);
      await timers[0].callback();

      assert.equal(notices.length, 1);
      assert.equal(notices[0].title, translate("refresh.failedTitle", {}, locale));
      assert.equal(notices[0].copy, translate("refresh.failedCopy", {}, locale));
      assert.equal(notices[0].kind, "error");
      assert.equal(notices[0].copy.includes(code), false);
      assert.equal(notices[0].copy.includes("local_index_schema_newer"), false);
    }
  }
});
