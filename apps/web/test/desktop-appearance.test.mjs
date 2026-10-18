import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  isElectronDashboard,
  resolveDesktopAppearance,
  resolveElectronStartupAppearance,
} from "../public/desktop-appearance.js";

test("sidebar footer keeps icon-only refresh immediately above Settings", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const sidebar = html.match(/<aside class="dashboard-sidebar"[\s\S]*?<\/aside>/u)?.[0];
  assert.ok(sidebar);
  const refresh = sidebar.indexOf('id="refresh-button"');
  const settings = sidebar.indexOf('id="electron-settings-button"');
  assert.ok(refresh > sidebar.indexOf('</nav>') && settings > refresh);
  assert.match(sidebar, /id="refresh-button"[^>]*aria-describedby="sidebar-refresh-summary"[^>]*><svg/u);
  assert.match(sidebar, /id="sidebar-refresh-summary"[^>]*role="status"[^>]*hidden/u);
  const header = html.match(/<header class="topbar"[\s\S]*?<\/header>/u)?.[0];
  assert.doesNotMatch(header, /id="(?:refresh-button|electron-settings-button)"/u);
});

test("neutral dashboard themes retain readable text, selected controls and chart marks", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const usage = await readFile(new URL("../public/usage-simple.css", import.meta.url), "utf8");
  const section = styles.slice(styles.indexOf("/* Neutral dashboard roles"));
  const palettes = [...section.matchAll(/(?:^|\n)(?::root|html\[data-theme="dark"\]) \{([^}]+)\}/gu)]
    .map(match => Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*(#[\da-f]+);/gu)].map(m => [m[1],m[2]])));
  assert.equal(palettes.length, 2);
  const luminance = hex => {
    let raw=hex.slice(1); if(raw.length===3) raw=[...raw].map(c=>c+c).join("");
    const channels=[0,2,4].map(i=>parseInt(raw.slice(i,i+2),16)/255).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);
    return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
  };
  const contrast=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (values[0]+0.05)/(values[1]+0.05);};
  for(const palette of palettes) {
    for(const bg of ["neutral-page","neutral-surface","neutral-hover"]) {
      for(const fg of ["neutral-ink","neutral-muted"]) assert.ok(contrast(palette[fg],palette[bg])>=4.5,`${fg} on ${bg}`);
    }
    assert.ok(contrast(palette["neutral-ink"],palette["neutral-track"])>=3);
    // Workload names are large text, and colours supplement explicit labels.
    for(const level of ["heavy","medium","light"]) assert.ok(contrast(palette[`workload-${level}`],palette["neutral-surface"])>=3,level);
  }
  assert.doesNotMatch(section,/color-scheme:\s*light|var\(--panel[,)]/u);
  assert.doesNotMatch(usage,/(?:color|background|border(?:-bottom)?):[^;{}]*#[\da-f]{3,8}/iu);
  assert.match(usage,/input::placeholder\s*\{\s*color:var\(--neutral-muted\);\s*opacity:1;/u);
});

// Owner direction (2026-10-18): the app renders white/black/grey and keeps the
// workload red/yellow/green as the only hue. The site and operator console keep
// their own palettes, so this checks only the app-scoped rules and the two
// app-only sheets.
test("app-scoped chrome stays achromatic outside the workload tokens", async () => {
  const [styles, tray, settings, matrix, performance] = await Promise.all([
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/electron-tray-popup.css", import.meta.url), "utf8"),
    readFile(new URL("../public/electron-settings.css", import.meta.url), "utf8"),
    readFile(new URL("../public/cache-reuse-matrix.css", import.meta.url), "utf8"),
    readFile(new URL("../public/model-performance.css", import.meta.url), "utf8"),
  ]);
  const scopedAppRules = (css) =>
    [...css.matchAll(/body:not\(\.community-site\):not\(\.admin-operator-page\)[^}]*\}/gu)]
      .map((match) => match[0])
      .join("\n");
  const channels = (literal) => {
    if (literal.startsWith("#")) {
      let raw = literal.slice(1);
      if (raw.length === 3) raw = [...raw].map((c) => c + c).join("");
      return [0, 2, 4].map((index) => parseInt(raw.slice(index, index + 2), 16));
    }
    return literal.match(/[\d.]+/gu).slice(0, 3).map(Number);
  };
  const assertAchromatic = (css, where) => {
    for (const literal of css.match(/#[\da-f]{3,8}\b|rgba?\([^)]*\)/giu) ?? []) {
      const [red, green, blue] = channels(literal);
      assert.ok(red === green && green === blue, `${where} keeps a hue: ${literal}`);
    }
  };

  assertAchromatic(scopedAppRules(styles), "dashboard app chrome");
  assertAchromatic(scopedAppRules(matrix), "cache matrix app chrome");
  assertAchromatic(scopedAppRules(performance), "model performance app chrome");
  assertAchromatic(tray, "tray popup");
  assertAchromatic(settings, "settings window");
  // The workload classification is the one hue the app keeps.
  assert.match(styles, /--workload-heavy: #dc2626;/u);
  assert.match(styles, /--workload-light: #4ade80;/u);
});

function documentWithMarker(marked) {
  return {
    documentElement: {
      classList: { contains: (value) => marked && value === "electron-dashboard" },
    },
    body: { classList: { contains: () => false } },
  };
}

function windowWithScheme({ dark, bridge = true } = {}) {
  return {
    ...(bridge ? { tibotattleDesktop: { version: "v1" } } : {}),
    matchMedia(query) {
      assert.equal(query, "(prefers-color-scheme: dark)");
      return { matches: dark };
    },
  };
}

test("desktop appearance resolves system and forced preferences", () => {
  assert.equal(resolveDesktopAppearance("system", {
    windowRef: windowWithScheme({ dark: true }),
  }), "dark");
  assert.equal(resolveDesktopAppearance("system", {
    windowRef: windowWithScheme({ dark: false }),
  }), "light");
  assert.equal(resolveDesktopAppearance("dark", {
    windowRef: windowWithScheme({ dark: false }),
  }), "dark");
  assert.equal(resolveDesktopAppearance("light", {
    windowRef: windowWithScheme({ dark: true }),
  }), "light");
  assert.equal(resolveDesktopAppearance("sepia", {
    windowRef: windowWithScheme({ dark: true }),
  }), null);
});

test("system appearance fails safely to light when matchMedia is unavailable", () => {
  assert.equal(resolveDesktopAppearance("system", { windowRef: {} }), "light");
  assert.equal(resolveDesktopAppearance("system", {
    windowRef: { matchMedia() { throw new Error("unavailable"); } },
  }), "light");
});

test("startup appearance follows Chromium only inside Electron", () => {
  const publicDocument = documentWithMarker(false);
  assert.equal(isElectronDashboard(publicDocument, windowWithScheme({
    dark: true,
    bridge: false,
  })), false);
  assert.equal(resolveElectronStartupAppearance({
    documentRef: publicDocument,
    windowRef: windowWithScheme({ dark: true, bridge: false }),
  }), null);

  assert.equal(resolveElectronStartupAppearance({
    documentRef: publicDocument,
    windowRef: windowWithScheme({ dark: true }),
  }), "dark");
  assert.equal(resolveElectronStartupAppearance({
    documentRef: documentWithMarker(true),
    windowRef: windowWithScheme({ dark: false, bridge: false }),
  }), "light");
});
