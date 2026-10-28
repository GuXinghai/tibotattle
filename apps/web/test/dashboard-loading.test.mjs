import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const declaration = name => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "mu"))[0];

function harness(desktop) {
  const elements = [true, true, false].map(nav => ({
    hidden: true, attributes: {},
    hasAttribute: name => nav && name === "data-nav",
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  const controls = [{ disabled: false }, { disabled: true }];
  const status = { hidden: false };
  const chartStates = [];
  const context = createContext({
    window: {}, isElectronDashboard: () => desktop, allowancePage: {setLoadState:state=>chartStates.push(state)},
    pendingEvidenceControls: new Map(),
    document: {
      body: { classList: { remove() {}, add() {} } },
      querySelectorAll: selector => selector === "[data-requires-evidence]" ? elements
        : selector === "[data-dashboard-load-status]" ? [status] : controls,
    },
    $: () => ({}), isLoopbackDashboard: () => true,
    setLocalizedText: (element, key) => { element.key = key; },
  });
  for (const name of ["setJourneyState", "renderDesktopEvidenceState"]) runInContext(declaration(name), context);
  return { context, elements, controls, status, chartStates };
}

test("desktop keeps navigation through loading, failure, retry and ready; controls retain their owners' disabled state", () => {
  const { context, elements, controls, status, chartStates } = harness(true);
  for (const state of ["loading", "error", "loading"]) {
    context.renderDesktopEvidenceState(state);
    context.setJourneyState("first-run");
    assert.ok(elements.every(element => !element.hidden));
    assert.ok(controls.every(control => control.disabled));
    assert.equal(status.key, state === "error" ? "dashboard.unavailable.dashboardTitle" : "refresh.stage.localData");
    assert.equal(elements[2].attributes["aria-busy"], String(state === "loading"));
  }
  context.renderDesktopEvidenceState("ready");
  assert.equal(status.hidden, true);
  assert.deepEqual(controls.map(control => control.disabled), [false, true]);
  assert.equal(context.pendingEvidenceControls.size, 0);
  assert.deepEqual(chartStates, ['loading','error','loading','ready']);
});

test("browser evidence visibility keeps its existing first-run and local-ready rules", () => {
  const { context, elements, controls } = harness(false);
  context.renderDesktopEvidenceState("loading");
  assert.deepEqual(controls.map(control => control.disabled), [false, true]);
  context.setJourneyState("first-run");
  assert.ok(elements.every(element => element.hidden));
  context.setJourneyState("local-ready");
  assert.ok(elements.every(element => !element.hidden));
});
