import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  isElectronDashboard,
  resolveDesktopAppearance,
  resolveElectronStartupAppearance,
} from "../public/desktop-appearance.js";

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
