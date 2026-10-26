import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mountWindowBackground, normalizeHexColor, rgbToHex, validBackgroundResponse, WINDOW_BACKGROUND_PRESETS } from "../public/window-background.js";
import { translate } from "../public/localization.js";
test("background labels reach the browser localization facade in all shipped locales", () => {
  assert.equal(translate("background.title", {}, "zh-Hans"), "窗口背景");
  assert.equal(translate("background.preset.sky", {}, "en-US"), "Sky");
  assert.equal(translate("background.reset", {}, "es"), "Restaurar fondo predeterminado");
});
test("background color entry validates both directions and rejects partial or injectable values", () => {
  assert.equal(normalizeHexColor(" f0f9ff "), "#F0F9FF");
  assert.equal(rgbToHex([240, "249", 255]), "#F0F9FF");
  for (const v of ["", "#FFF", "#GGGGGG", "url(x)"]) assert.equal(normalizeHexColor(v), null);
  for (const v of [["", 0, 0], [-1, 0, 0], [256, 0, 0], [1.5, 2, 3]]) assert.equal(rgbToHex(v), null);
  assert.equal(WINDOW_BACKGROUND_PRESETS.length, 8);
});
test("background bridge responses only permit opaque imported resource URLs and valid fields", () => {
  const value = { status: "ready", background: { color: "#FFFFFF", mask: 35, imageUrl: null } };
  assert.ok(validBackgroundResponse(value));
  assert.ok(validBackgroundResponse({ ...value, background: { ...value.background, imageUrl: "usagemonitor-background://image/12345678-1234-4234-8234-123456789abc" } }));
  for (const imageUrl of ["https://remote.invalid/x.png", "file:///private/x.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,\";x"]) assert.ok(!validBackgroundResponse({ ...value, background: { ...value.background, imageUrl } }));
});
test("background CSS keeps one fixed cover layer and explicitly transparent reset states", async () => {
  const css = await readFile(new URL("../public/window-background.css", import.meta.url), "utf8");
  assert.match(css, /position: fixed; inset: 0; z-index: -1/u);
  assert.match(css, /background-size: var\(--window-background-viewport-image-size, cover\)/u);
  assert.match(css, /::-webkit-scrollbar-thumb \{\s*background: rgb\(0 0 0 \/ \.05\)/u);
  assert.match(css, /::-webkit-scrollbar-thumb:hover \{\s*background: rgb\(0 0 0 \/ \.60\)/u);
  assert.doesNotMatch(css, /electron-dashboard\):hover|electron-dashboard \*:hover/u);
  assert.match(css, /background-reset:is\(:hover,:active,:disabled,:focus\) \{ background: transparent/u);
});

test("floating copies share only the imported image, track cover coordinates and scrolling, and dispose listeners", async () => {
  const style = () => {
    const values = new Map();
    return { setProperty: (key, value) => values.set(key, value), getPropertyValue: key => values.get(key) ?? "" };
  };
  const root = { style: style(), toggleAttribute() {} };
  let layerWidth = 800;
  const layer = { style: style(), setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: layerWidth, height: 600 }), remove() {} };
  const surface = { style: style(), clientLeft: 1, clientTop: 1, scrollLeft: 0, scrollTop: 0,
    getClientRects: () => [1], getBoundingClientRect: () => ({ left: 200, top: 120 }) };
  const picker = { style: style() };
  let image, disconnected = false, command, unsubscribed = false;
  const images = [];
  const background = { color: "#F0F9FF", mask: 35, imageUrl: "usagemonitor-background://image/12345678-1234-4234-8234-123456789abc" };
  const listeners = new Map(), frames = new Map();
  let nextFrame = 0;
  const windowRef = {
    innerWidth: 800, innerHeight: 600,
    usageMonitorDesktop: { version: "v1", getWindowBackground: async () => ({ status: "ready", background: { ...background } }), onCommand: callback => { command = callback; return () => { unsubscribed = true; }; } },
    MutationObserver: class { observe() {} disconnect() { disconnected = true; } },
    Image: class {
      constructor() { image = this; images.push(this); this.naturalWidth = 1000; this.naturalHeight = 600; }
      decode() { return new Promise((resolve, reject) => { this.decoded = resolve; this.failed = reject; }); }
    },
    getComputedStyle: () => ({ height: "211.333px", boxSizing: "border-box", paddingTop: "5px", paddingBottom: "5px", borderTopWidth: "0.666667px", borderBottomWidth: "0.666667px" }),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  const documentRef = { readyState: "interactive", documentElement: root, body: { prepend() {} }, querySelector: () => null,
    createElement: () => layer, querySelectorAll: selector => selector === "select:open" ? [picker] : [surface] };
  const mounted = await mountWindowBackground({ documentRef, windowRef });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  assert.equal(root.style.getPropertyValue("--window-background-mask"), 0);
  assert.equal(layer.style.backgroundImage, "none");
  assert.equal(root.style.getPropertyValue("--window-background-copy-image"), "none");
  assert.equal(image.src, undefined, "wallpaper cannot hold up the document load gate");
  const documentLoaded = listeners.get("load"); listeners.delete("load");
  documentRef.readyState = "complete"; documentLoaded();
  const loading = image.onload();
  assert.equal(layer.style.backgroundImage, "none", "a loaded but undecoded image stays hidden");
  image.decoded(); await loading; flush();
  assert.equal(root.style.getPropertyValue("--window-background-mask"), 0.35);
  assert.equal(picker.style.getPropertyValue("--window-background-picker-height"), "200px");
  assert.equal(root.style.getPropertyValue("--window-background-copy-image"), `url("${image.src}")`);
  assert.equal(surface.style.getPropertyValue("--window-background-copy-size"), "1000px 600px");
  assert.equal(surface.style.getPropertyValue("--window-background-copy-position"), "-301px -121px");
  assert.equal(root.style.getPropertyValue("--window-background-viewport-image-position"), "-100px 0px");
  // A scrollbar changes the document/layer width, not the window wallpaper.
  layerWidth = 785;
  listeners.get("resize")(); flush();
  assert.equal(root.style.getPropertyValue("--window-background-viewport-image-position"), "-100px 0px");
  assert.equal(surface.style.getPropertyValue("--window-background-copy-position"), "-301px -121px");
  // Resizing the window still recalculates cover for the background and copies.
  windowRef.innerWidth = 1200;
  listeners.get("resize")(); flush();
  assert.equal(root.style.getPropertyValue("--window-background-viewport-image-size"), "1200px 720px");
  assert.equal(root.style.getPropertyValue("--window-background-viewport-image-position"), "0px -60px");
  assert.equal(surface.style.getPropertyValue("--window-background-copy-position"), "-201px -181px");
  surface.scrollTop = 200;
  listeners.get("scroll")(); flush();
  assert.equal(surface.style.getPropertyValue("--window-background-copy-scroll-y"), "200px");
  // Coalesce bursts of layout changes, without a perpetual animation loop.
  listeners.get("resize")(); listeners.get("resize")();
  assert.equal(frames.size, 1); flush(); assert.equal(frames.size, 0);
  assert.equal(typeof command, "function");
  // A failed image leaves the saved color and does not change persisted settings.
  background.imageUrl = "usagemonitor-background://image/22345678-1234-4234-8234-123456789abc";
  command({ command: "windowBackground" }); await Promise.resolve();
  const failed = image.onload(); image.failed(new Error("synthetic decode failure")); await failed;
  assert.equal(layer.style.backgroundImage, "none");
  assert.equal(root.style.getPropertyValue("--window-background-color"), "#F0F9FF");
  assert.equal(root.style.getPropertyValue("--window-background-mask"), 0);
  // A late image cannot overwrite a more recent selection.
  background.imageUrl = "usagemonitor-background://image/32345678-1234-4234-8234-123456789abc";
  command({ command: "windowBackground" }); await Promise.resolve();
  const obsolete = image, obsoleteLoad = obsolete.onload();
  background.imageUrl = "usagemonitor-background://image/42345678-1234-4234-8234-123456789abc";
  command({ command: "windowBackground" }); await Promise.resolve();
  obsolete.decoded(); await obsoleteLoad;
  assert.equal(layer.style.backgroundImage, "none");
  const disposedLoad = image.onload();
  mounted.teardown();
  image.decoded(); await disposedLoad;
  assert.equal(layer.style.backgroundImage, "none", "teardown invalidates pending decoding");
  assert.equal(disconnected, true); assert.equal(unsubscribed, true);
  assert.equal(listeners.size, 0); assert.equal(frames.size, 0);
});
