import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_COMMAND_CHANNEL,
  createDesktopCommand,
  validateDesktopCommand,
} from "../desktop-command.js";

test("desktop commands contain only the fixed presentation vocabulary", () => {
  assert.equal(DESKTOP_COMMAND_CHANNEL, "tibotattle:desktop-command:v1");
  assert.deepEqual(createDesktopCommand("refresh"), { command: "refresh" });
  assert.deepEqual(createDesktopCommand("automaticRefresh", "quick"), {
    command: "automaticRefresh",
    mode: "quick",
  });
  assert.deepEqual(createDesktopCommand("automaticRefresh", "detailed"), {
    command: "automaticRefresh",
    mode: "detailed",
  });
  assert.deepEqual(createDesktopCommand("dashboardSection", "overview"), {
    command: "dashboardSection",
    section: "overview",
  });
  assert.deepEqual(createDesktopCommand("dashboardSection", "usage"), {
    command: "dashboardSection",
    section: "usage",
  });
  assert.deepEqual(createDesktopCommand("dashboardSection", "allowance"), {
    command: "dashboardSection",
    section: "allowance",
  });
  assert.deepEqual(createDesktopCommand("dashboardSection", "performance"), {
    command: "dashboardSection",
    section: "performance",
  });
  assert.deepEqual(createDesktopCommand("language", "zh-Hans"), {
    command: "language",
    value: "zh-Hans",
  });
  assert.deepEqual(createDesktopCommand("sidebar", true), {
    command: "sidebar",
    collapsed: true,
  });
  assert.equal(Object.isFrozen(createDesktopCommand("sidebar", false)), true);
  assert.deepEqual(createDesktopCommand("appearance", "dark", "dark"), {
    command: "appearance",
    preference: "dark",
    resolvedTheme: "dark",
  });
  assert.equal(Object.isFrozen(createDesktopCommand("refresh")), true);
  assert.deepEqual(createDesktopCommand("windowFullscreen", true), { command: "windowFullscreen", fullscreen: true });
  assert.deepEqual(createDesktopCommand("windowFullscreen", false), { command: "windowFullscreen", fullscreen: false });
});

test("desktop commands reject selectors, paths, URLs, extra keys, and prototypes", () => {
  for (const value of [
    null,
    { command: "windowFullscreen", fullscreen: "true" },
    { command: "windowFullscreen", fullscreen: true, action: "quit" },
    { command: "refresh", selector: "#refresh-button" },
    { command: "automaticRefresh", mode: "quick", reason: "unexpected" },
    { command: "automaticRefresh", mode: "background" },
    { command: "dashboardSection", section: "#allowance" },
    { command: "dashboardSection", section: "#usage" },
    { command: "dashboardSection", section: "usage", search: "unexpected" },
    { command: "dashboardSection", section: "performance", extra: true },
    { command: "dashboardSection", section: "allowance", path: "/private/secret" },
    ...["weekly", "timeline", "accounting", "projects", "community"].map((section) => ({
      command: "dashboardSection",
      section,
    })),
    { command: "hostedSignInReturn" },
    { command: "shareCardDownloadCompleted", filename: "2026-09-28-19-15-tibotattle-results.png" },
    { command: "shareCardDownloadFailed" },
    { command: "navigate", value: "https://attacker.example" },
    { command: "language", value: "fr" },
    { command: "language", value: "en", path: "/tmp/private" },
    { command: "sidebar", collapsed: true, path: "/tmp/private" },
    { command: "sidebar", collapsed: "true" },
    { command: "appearance", preference: "dark", resolvedTheme: "sepia" },
    { command: "appearance", preference: "sepia", resolvedTheme: "dark" },
    Object.assign(Object.create(null), { command: "refresh" }),
  ]) {
    assert.throws(() => validateDesktopCommand(value), TypeError);
  }
  assert.throws(() => createDesktopCommand("dashboardSection"), TypeError);
  assert.throws(() => createDesktopCommand("automaticRefresh"), TypeError);
  assert.throws(() => createDesktopCommand("automaticRefresh", "background"), TypeError);
  assert.throws(
    () => createDesktopCommand("automaticRefresh", "quick", "unexpected"),
    TypeError,
  );
  assert.throws(() => createDesktopCommand("sidebar"), TypeError);
  assert.throws(() => createDesktopCommand("appearance", "dark"), TypeError);
});
