import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mountLocalRefreshPause } from "../public/local-refresh-pause.js";
const flush = () => new Promise(setImmediate);
function fixture(overrides = {}) {
  const attrs = new Map(), handlers = new Map(), glyphs = [{}, {}], states = [], errors = [];
  const button = { hidden: true, disabled: true, setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key),
    querySelector: key => ({ toggleAttribute: (_, value) => { glyphs[key === "[data-pause-glyph]" ? 0 : 1].hidden = value; } }),
    addEventListener: (key, handler) => handlers.set(key, handler), removeEventListener: key => handlers.delete(key) };
  const summary = {}; let saved = false, writes = 0, command;
  const bridge = { getSettings: async () => ({ settings: { refreshPaused: saved } }),
    setRefreshPaused: async paused => { writes++; saved = paused; return { settings: { refreshPaused: saved } }; },
    onCommand: listener => { command = listener; return () => { command = null; }; }, ...overrides };
  const control = mountLocalRefreshPause({ button, summary, bridge, translate: key => key,
    onChange: state => states.push(state), onError: () => errors.push(true) });
  return { button, summary, attrs, glyphs, states, errors, control, click: () => handlers.get("click")?.(),
    get writes() { return writes; }, command: value => command?.(value) };
}
test("pause icon precedes refresh; saved state paints resume and mutations are serialized", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="pause-refresh-button"') < html.indexOf('id="refresh-button"'));
  assert.doesNotMatch(html, /Rhetrion · not affiliated/u);
  const view = fixture(); assert.equal(view.button.disabled, true); await flush();
  assert.equal(view.button.disabled, false);
  const first = view.click(); view.click(); await first;
  assert.equal(view.writes, 1); assert.equal(view.attrs.get("aria-pressed"), "true");
  assert.equal(view.attrs.get("aria-label"), "refresh.resume");
  assert.equal(view.summary.hidden, false); assert.equal(view.glyphs[0].hidden, true);
  await view.click(); assert.equal(view.summary.hidden, true); view.control.teardown();
});
test("delayed reads cannot overwrite a newer acknowledged pause", async () => {
  let read, calls = 0;
  const view = fixture({ getSettings: () => ++calls === 1 ? Promise.resolve({ settings: { refreshPaused: false } })
    : new Promise(resolve => { read = resolve; }) });
  await flush(); const pending = view.control.reload();
  await view.click(); read({ settings: { refreshPaused: false } }); await pending;
  assert.equal(view.attrs.get("aria-pressed"), "true"); view.control.teardown();
});
test("save/application failure is shown and persisted state is re-read", async () => {
  let saved = false;
  const view = fixture({ getSettings: async () => ({ settings: { refreshPaused: saved } }),
    setRefreshPaused: async () => { saved = true; throw new Error("synthetic propagation failure"); } });
  await flush(); await view.click();
  assert.equal(view.errors.length, 1); assert.equal(view.attrs.get("aria-pressed"), "true");
  view.control.teardown();
});
test("unread state keeps controls disabled; disposal ignores late results", async () => {
  const failed = fixture({ getSettings: async () => { throw new Error("synthetic read failure"); } });
  await flush(); assert.equal(failed.button.disabled, true); assert.equal(failed.errors.length, 1); failed.control.teardown();
  let resolve;
  const late = fixture({ getSettings: () => new Promise(done => { resolve = done; }) });
  const count = late.states.length; late.control.teardown(); resolve({ settings: { refreshPaused: true } });
  await flush(); assert.equal(late.states.length, count);
});
