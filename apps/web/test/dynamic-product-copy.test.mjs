import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { evidenceWarningLocalization, translate, translateLegacyText } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function productionFunction(name) {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "mu"));
  assert.ok(match, name);
  return match[0];
}
function element(tag = "span", className = "", textContent = "") {
  return { tag, className, textContent, children: [], dataset: {}, attributes: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; }, addEventListener() {} };
}

test("retired deferred-history copy is not rendered while unknown text retains the raw boundary", () => {
  const retiredWarning = ["Local history indexing", " has no published aggregate. Complete historical totals are unavailable."].join("");
  for (const locale of ["zh-Hans", "en-US", "es", "zh-Hans"]) {
    const list = element("ul");
    const context = createContext({ EVIDENCE_WARNING_ROUTES: [], EVIDENCE_WARNING_FALLBACK: "#warnings",
      EVIDENCE_WARNING_PROGRESS: /still/u, EVIDENCE_WARNING_INFORMATIONAL: /loading|indexing/u,
      $: () => list, node: element, clear: target => { target.children = []; }, evidenceWarningLocalization,
      setLocalizedText(target, key, values) { target.textContent = translate(key, values, locale); },
      setRawText(target, text) { target.textContent = text; target.setAttribute("data-i18n-skip", ""); },
    });
    runInContext(productionFunction("evidenceWarningTarget") + "\n" + productionFunction("renderEvidenceWarnings"), context);
    context.renderEvidenceWarnings({ warnings: [retiredWarning,
      "History indexing has no complete aggregate available. Complete historical totals remain unavailable.", "Ready"] });
    assert.equal(list.children.length, 1, "the retired deferred notice and redundant indexing notice are omitted");
    assert.equal(list.children[0].textContent, "Ready");
    assert.equal(list.children[0].attributes["data-i18n-skip"], "");
  }
});

test("information labels translate visible text, help text and accessible names together", () => {
  for (const locale of ["en-US", "zh-Hans", "es"]) {
    const context = createContext({
      localization: { translateText: value => translateLegacyText(value, locale) },
      t: (key, values) => translate(key, values, locale), node: element,
      document: { createDocumentFragment: () => element("fragment"), createTextNode: textContent => ({ textContent }) },
    });
    runInContext(productionFunction("informationLabel"), context);
    const result = context.informationLabel("Time intervals", "The number of displayed hour, day, or week intervals.");
    assert.equal(result.children[0].textContent, translateLegacyText("Time intervals", locale));
    assert.equal(result.children[1].dataset.informationExplanation,
      translateLegacyText("The number of displayed hour, day, or week intervals.", locale));
    if (locale === "zh-Hans") assert.doesNotMatch(result.children[1].attributes["aria-label"], /Time intervals/u);
  }
});

test("component labels translate only the closed product vocabulary", () => {
  const mapping = source.match(/const COMPONENT_LABELS = Object\.freeze\(\{[\s\S]*?\}\);/u)?.[0];
  assert.ok(mapping);
  const context = createContext({ localization: { translateText: value => translateLegacyText(value, "zh-Hans") }, humanize: String });
  runInContext(mapping + "\n" + productionFunction("componentLabel"), context);
  assert.equal(context.componentLabel("input_cache_read_tokens"), "缓存输入");
  assert.equal(context.componentLabel("output_reasoning_tokens"), "推理输出");
  assert.equal(context.componentLabel("output_combined_tokens"), "输出（无法拆分）");
  assert.equal(context.componentLabel("constructor"), "constructor");
});

test("retained last-completed figures state their age, never background work", () => {
  for (const locale of ["en-US", "zh-Hans", "es"]) {
    const note = { ...element("p"), hidden: true, removeAttribute() {} };
    const context = createContext({
      USER_TIME_ZONE: "UTC", getFormattingLocale: () => locale, accountingRebuildRetrying: () => false,
      setLocalizedText(target, key, values) { target.key = key; target.textContent = translate(key, values, locale); },
      setRawText(target, text) { target.textContent = text; },
    });
    runInContext(productionFunction("renderStaleServeNote") + "\n" + productionFunction("retainedResultTimeLabel"), context);

    context.renderStaleServeNote(note, true, "local_unified_index_deferred", "2026-10-14T03:16:50.776Z");
    assert.equal(note.key, "accounting.staleServe.lastCompleted");
    assert.equal(note.hidden, false);
    assert.doesNotMatch(note.textContent, /\{time\}/u);
    assert.notEqual(note.textContent, translate("accounting.staleServe.recalculating", {}, locale));

    context.renderStaleServeNote(note, true, "local_unified_index_deferred", null);
    assert.equal(note.key, "accounting.staleServe.lastCompletedUndated");

    // Provenance cannot infer that a rebuild is running after a failed refresh.
    context.renderStaleServeNote(note, true, "local_unified_index_deferred");
    assert.equal(note.key, "accounting.staleServe.recalculating");
    assert.doesNotMatch(note.textContent, /recalculating now|正在重新计算|recalculando ahora/u);
    context.accountingRebuildRetrying = () => true;
    context.renderStaleServeNote(note, true, "local_unified_index_deferred");
    assert.equal(note.key, "accounting.staleServe.retrying");
    assert.doesNotMatch(note.textContent, /being retried|正在重试|se está reintentando/u);
  }
});
