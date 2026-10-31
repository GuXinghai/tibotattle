import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TRAY_DEFAULTS, normalizeTrayPreferences, validTrayPreferences } from "../public/electron-tray-preferences.js";
import { createTraySettingsController } from "../public/electron-tray-settings.js";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

class Element {
  constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.classList = { toggle() {} }; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(k, f) { this.listeners.set(k, f); }
  removeEventListener(k) { this.listeners.delete(k); }
  querySelector(selector) { return this.all().find((n) => selector.startsWith("#") ? n.id === selector.slice(1) : selector.startsWith("[data-tray-move=") ? n.dataset.trayMove === selector.split('"')[1] : false) ?? null; }
  all() { return [this, ...this.children.flatMap((child) => child.all?.() ?? [])]; }
  focus() { this.doc.activeElement = this; }
  async dispatch(type) { this.listeners.get(type)?.({ target: this }); await new Promise((resolve) => setImmediate(resolve)); }
}
function documentFixture() {
  const document = { createElement(tag) { return new Element(tag, this); }, querySelector(selector) { return this.root.querySelector(selector); }, getElementById(id) { return this.querySelector(`#${id}`); } };
  document.root = document.createElement("div"); document.root.id = "settings-tray-controls";
  return document;
}
function text(element) { return element.all().map((node) => node.textContent).join(" "); }

test("renderer admits only the exact tray schema and enforces meaningful usage content", () => {
  assert.equal(validTrayPreferences(TRAY_DEFAULTS), true);
  for (const invalid of [{ ...TRAY_DEFAULTS, schemaVersion: 2 }, { ...TRAY_DEFAULTS, extra: true }, { ...TRAY_DEFAULTS, sections: ["usage", "usage"] }, { ...TRAY_DEFAULTS, metrics: ["requests"] }, { ...TRAY_DEFAULTS, showChart: false, metrics: [] }, { ...TRAY_DEFAULTS, preset: "both", barMetric: "reset" }]) assert.equal(validTrayPreferences(invalid), false);
  assert.equal(validTrayPreferences({ ...TRAY_DEFAULTS, sections: [], metrics: [], showChart: false }), true);
  const copy = normalizeTrayPreferences(TRAY_DEFAULTS); copy.sections.pop();
  assert.equal(TRAY_DEFAULTS.sections.length, 3);
});

test("settings saves full preferences, undoes and restores without optimistic persistence claims", async () => {
  const doc = documentFixture();
  const calls = [];
  const bridge = { async setTrayPreferences(tray) { calls.push(tray); return { settings: { tray } }; }, async restoreTrayDefaults() { return { settings: { tray: TRAY_DEFAULTS } }; } };
  const controller = createTraySettingsController({ documentRef: doc, bridge });
  controller.update({ tray: TRAY_DEFAULTS });
  const preset = doc.getElementById("tray-preset");
  preset.value = "both"; await preset.dispatch("change");
  assert.equal(calls.at(-1).preset, "both");
  assert.equal(calls.at(-1).barMetric, "remaining");
  assert.match(text(doc.root), /preferences saved/);
  const undo = doc.root.all().find((n) => n.textContent === "Undo last change");
  await undo.dispatch("click");
  assert.equal(calls.at(-1).preset, "weekly");
  assert.equal(undo.disabled, true);
  preset.value = "five-hour"; await preset.dispatch("change");
  await doc.root.all().find((n) => n.textContent === "Restore tray defaults").dispatch("click");
  assert.equal(preset.value, "weekly");
  controller.teardown();
});

test("a rejected save retains confirmed values and readable error; newer settings remain read only", async () => {
  const doc = documentFixture();
  const controller = createTraySettingsController({ documentRef: doc, bridge: { async setTrayPreferences() { throw new Error("private path must never render"); }, async restoreTrayDefaults() { return { settings: { tray: TRAY_DEFAULTS } }; } } });
  controller.update({ tray: TRAY_DEFAULTS });
  const preset = doc.getElementById("tray-preset"); preset.value = "both";
  await preset.dispatch("change");
  assert.equal(preset.value, "weekly");
  assert.match(text(doc.root), /Could not save/);
  assert.doesNotMatch(text(doc.root), /private path/);
  controller.update({ tray: TRAY_DEFAULTS, traySettingsStatus: "future" });
  assert.equal(preset.disabled, true);
  assert.equal(doc.root.all().find((n) => n.textContent === "Restore tray defaults").disabled, true);
  assert.match(text(doc.root), /newer version of the app/);
});


test("preview states are isolated examples and partial allowances never borrow the available lane", async () => {
  const doc = documentFixture();
  const controller = createTraySettingsController({ documentRef: doc, bridge: { async setTrayPreferences() {}, async restoreTrayDefaults() {} } });
  controller.update({ tray: { ...TRAY_DEFAULTS, preset: "both" } });
  const previewState = doc.root.all().find((n) => n.tagName === "select" && n.children.some((c) => c.value === "partial"));
  previewState.value = "partial"; await previewState.dispatch("change");
  assert.match(text(doc.root), /5h —/);
  assert.match(text(doc.root), /7d 8%/);
  assert.match(text(doc.root), /Example data only/);
});


test("every customization message is present in each shipped language", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ["title", "saveFailed", "cachePercent", "platformTooltip", "example", "future"]) {
      const id = `electron.trayCustomization.${key}`;
      assert.notEqual(translate(id, { value: 80 }, locale), id);
    }
  }
});

test("tray customization uses the shared Settings typography instead of browser defaults", async () => {
  const css = await readFile(new URL("../public/electron-settings.css", import.meta.url), "utf8");
  assert.match(css, /settings-panel\[data-settings-panel="tray"\][\s\S]*?font-family: var\(--sans\)/u);
  assert.match(css, /\.settings-tray-group legend[\s\S]*?font-family: var\(--sans\)/u);
  assert.match(css, /\.settings-tray-checkbox[\s\S]*?font-family: var\(--sans\)/u);
  assert.match(css, /\.settings-tray-preview h3[\s\S]*?font-family: var\(--sans\)/u);
  assert.doesNotMatch(css, /settings-tray-(?:section-row|totals|preview-popup|example-chart)/u);
  assert.doesNotMatch(css, /#267466/u);
  const iconRule = css.match(/\.settings-tray-preview-icon\s*\{([^}]+)\}/u)?.[1] ?? "";
  assert.match(iconRule, /background: transparent/u);
  assert.match(iconRule, /color: #242424/u);
});


test("platforms without tray titles hide text controls but retain tooltip selection", () => {
  const doc = documentFixture();
  const controller = createTraySettingsController({ documentRef: doc, bridge: { async setTrayPreferences() {}, async restoreTrayDefaults() {} } });
  controller.update({ tray: TRAY_DEFAULTS, trayCapabilities: { title: false } });
  const metric = doc.getElementById("tray-barMetric");
  assert.equal(doc.root.all().find((n) => n.tagName === "label" && n.children.includes(metric)).hidden, true);
  assert.match(text(doc.root), /Tooltip information/);
  assert.match(text(doc.root), /Text beside the icon isn't available/);
  const preview = doc.root.all().find((n) => n.className === "settings-tray-preview-bar");
  assert.equal(preview.children.length, 1);
  assert.equal(preview.title, "7d 8%");
  controller.update({ tray: TRAY_DEFAULTS, trayCapabilities: { title: true } });
  assert.equal(doc.root.all().find((n) => n.tagName === "label" && n.children.includes(metric)).hidden, false);
});

test("tray preview opens only in a modal and closes without changing saved preferences", async () => {
  const doc = documentFixture(); let writes=0;
  const controller = createTraySettingsController({documentRef:doc,bridge:{async setTrayPreferences(){writes++;},async restoreTrayDefaults(){writes++;}}});
  const dialog=doc.root.all().find((node)=>node.tagName==="dialog");
  let open=false; dialog.showModal=()=>{open=true;}; dialog.close=()=>{open=false;};
  const button=doc.root.children[0]; assert.equal(button.tagName,"button");
  await button.dispatch("click"); assert.equal(open,true);
  await dialog.children[0].dispatch("click"); assert.equal(open,false);
  assert.equal(writes,0);
  await button.dispatch("click"); controller.teardown(); assert.equal(open,false);
});

test("settings omit retired popup and meter controls while preserving saved bytes on tooltip edits",async()=>{
 const doc=documentFixture();const writes=[];const tray={...TRAY_DEFAULTS,sections:['cache','usage'],metrics:['cost'],density:'compact',showChart:false};
 const controller=createTraySettingsController({documentRef:doc,bridge:{async setTrayPreferences(value){writes.push(value);return {settings:{tray:value}};},async restoreTrayDefaults(){}}});controller.update({tray});
 for(const id of ['tray-density','tray-historyRange','tray-section-usage','tray-iconMode','tray-meterWindow'])assert.equal(doc.getElementById(id),null);
 const mode=doc.getElementById('tray-preset');mode.value='both';await mode.dispatch('change');
 for(const field of ['sections','metrics','density','showChart','iconMode','meterWindow','emphasizeLow'])assert.deepEqual(writes[0][field],tray[field]);
});
